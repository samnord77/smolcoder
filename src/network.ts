// The "models on other machines" flows, driven from the model picker in both
// UIs: search the network, type an address, and manage what was added. Nobody
// edits a file or runs a command — hosts are saved for them.
//
// A machine found by a search is never used until the user picks it: smolcoder
// sends source code to the server it talks to and runs the tool calls that
// come back, so choosing a host is choosing to trust it.

import { loadConfig, type SavedHost, updateConfig } from "./config";
import { identifyServer, probeHosts, type ServerInfo } from "./detect";
import { addHost, hostLabel, isPrivateHost, type ParsedAddress, parseAddress, removeHost, renameHost, setHostApiKey } from "./hosts";
import { type FoundHost, localSubnets, type Subnet, scanSubnets } from "./netscan";
import type { SelectOption } from "./ui";

/** The slice of a UI these flows need — the TUI and the web channel both fit. */
export interface FlowUI {
  select(title: string, options: SelectOption[]): Promise<number | null>;
  prompt(title: string, placeholder?: string): Promise<string | null>;
  status(s: string): void;
  warn(s: string): void;
  startSpinner(label: string): void;
  stopSpinner(): void;
  /** esc / the stop button while a flow waits. Unset before a session exists. */
  onCancel?: (() => void) | null;
}

const BACKEND_NAMES = { ollama: "Ollama", lmstudio: "LM Studio" } as const;

function describeServers(servers: { backend: keyof typeof BACKEND_NAMES; models: number }[]): string {
  return servers.map((s) => `${BACKEND_NAMES[s.backend]} · ${s.models} modèle${s.models > 1 ? "s" : ""}`).join(" + ");
}

/** Why a search or an address can come up empty. Both servers only listen to
 * their own machine until told otherwise, which is the usual reason. */
export function notFoundHelp(platform: NodeJS.Platform = process.platform): string {
  return (
    "Un serveur de modèles ne répond aux autres machines que si on l'y autorise. Sur la machine qui héberge les modèles :\n" +
    "  · Ollama : activez « Expose Ollama to the network » dans ses réglages (Linux ou sans interface : définissez OLLAMA_HOST=0.0.0.0 et redémarrez-le).\n" +
    "  · LM Studio : onglet Developer → Local Server → activez « Serve on Local Network ».\n" +
    "  · Windows : autorisez le serveur dans le pare-feu pour les réseaux privés quand on vous le demande.\n" +
    (platform === "darwin"
      ? "Sur ce Mac : Réglages Système → Confidentialité et sécurité → Réseau local doit autoriser votre application de terminal, sinon rien n'est visible sur le réseau.\n"
      : "") +
    "Les machines sur un VPN ou un autre réseau ne sont pas analysées — utilisez « Saisir une adresse » pour celles-ci."
  );
}

function save(hosts: SavedHost[]): SavedHost[] {
  return updateConfig({ hosts }).hosts ?? [];
}

async function confirmOutsideNetwork(ui: FlowUI, hostname: string, url: string): Promise<boolean> {
  if (url.startsWith("https://") || isPrivateHost(hostname)) return true;
  ui.warn(
    `${hostname} est hors de votre réseau et la connexion est en http non chiffré : votre code et vos prompts voyageraient en clair.`
  );
  return (await ui.select(`Ajouter ${hostname} quand même ?`, [{ label: "Annuler" }, { label: "L'ajouter quand même" }])) === 1;
}

/** "Enter an address": returns true when a host was added. */
async function enterAddress(ui: FlowUI, replace?: SavedHost): Promise<boolean> {
  const typed = await ui.prompt("Adresse de la machine", "192.168.1.50, gpu-box.local ou https://…");
  if (!typed) return false;
  let parsed: ParsedAddress;
  try {
    parsed = parseAddress(typed);
  } catch (err: any) {
    ui.warn(String(err?.message ?? err));
    return false;
  }
  ui.startSpinner(`vérification de ${parsed.hostname}`);
  // A public host (OpenRouter, a gateway…) needs its bearer key before the
  // model list will answer. Private/loopback hosts are never asked for one.
  // Esc keeps whatever the replaced entry already stored; an empty line clears it.
  let apiKey: string | undefined = replace?.apiKey;
  if (!isPrivateHost(parsed.hostname)) {
    const key = await ui.prompt(`Clé API pour ${parsed.hostname} (facultatif — Entrée pour aucune)`);
    if (key !== null) apiKey = key.trim() || undefined;
  }
  const found = (await Promise.all(parsed.urls.map((u) => identifyServer(u, 4000, apiKey)))).filter((s): s is ServerInfo => !!s);
  ui.stopSpinner();
  if (!found.length) {
    ui.warn(`Rien n'a répondu sur ${parsed.hostname} en tant qu'Ollama ou LM Studio.`);
    ui.status(notFoundHelp());
    return false;
  }
  if (!(await confirmOutsideNetwork(ui, parsed.hostname, found[0].baseUrl))) return false;
  let hosts = loadConfig().hosts ?? [];
  if (replace) hosts = removeHost(hosts, replace.address);
  save(addHost(hosts, { address: parsed.address, ...(replace?.name ? { name: replace.name } : {}), ...(apiKey ? { apiKey } : {}) }));
  ui.status(
    `· ajouté ${replace?.name ?? parsed.hostname} — ${describeServers(found.map((s) => ({ backend: s.backend, models: s.models.length })))}`
  );
  return true;
}

function savedAddressesOf(found: FoundHost, hosts: SavedHost[]): boolean {
  const mine = [found.ip, found.name, ...found.servers.map((s) => s.url)].filter(Boolean).map((s) => String(s).toLowerCase());
  return hosts.some((h) => mine.includes(h.address.toLowerCase()));
}

/** "Search my network": returns true when at least one host was added. */
async function searchNetwork(ui: FlowUI, subnets: Subnet[], replace?: SavedHost): Promise<boolean> {
  const range = subnets.map((s) => s.cidr).join(" et ");
  let lastTenth = -1;
  ui.startSpinner(`recherche sur ${range}`);
  const found = await scanSubnets(subnets, {
    onProgress: (done, total) => {
      const tenth = Math.floor((done / total) * 10);
      if (tenth === lastTenth || tenth >= 10) return;
      lastTenth = tenth;
      ui.startSpinner(`recherche sur ${range} · ${tenth * 10}%`);
    },
  });
  ui.stopSpinner();
  if (!found.length) {
    ui.warn(`Aucun Ollama ou LM Studio trouvé sur ${range}.`);
    ui.status(notFoundHelp());
    return false;
  }

  let added = false;
  for (;;) {
    const hosts = loadConfig().hosts ?? [];
    const options: SelectOption[] = found.map((f) => {
      const known = savedAddressesOf(f, hosts);
      return {
        label: f.name ? `${f.name} (${f.ip})` : f.ip,
        hint: describeServers(f.servers) + (known ? " · déjà ajouté" : ""),
        current: known,
      };
    });
    if (added) options.push({ label: "Terminé" });
    const pick = await ui.select(added ? "Ajouter une autre machine ?" : "Trouvé sur votre réseau — choisissez-en un à utiliser", options);
    if (pick === null || pick >= found.length) return added;
    const f = found[pick];
    if (savedAddressesOf(f, hosts)) {
      ui.status(`· ${f.name ?? f.ip} est déjà ajouté`);
      continue;
    }
    // The name survives the router handing out a new IP; fall back to the IP.
    const base = replace ? removeHost(hosts, replace.address) : hosts;
    save(addHost(base, { address: f.name ?? f.ip, ...(replace?.name ? { name: replace.name } : {}) }));
    ui.status(`· ajouté ${replace?.name ?? f.name ?? f.ip} — ${describeServers(f.servers)}`);
    added = true;
    if (replace || found.every((x) => savedAddressesOf(x, loadConfig().hosts ?? []))) return true;
  }
}

/** The entry point behind "Find models on my network…". Returns true when the
 * host list changed, so the caller can look for models again. `replace`
 * swaps a stale entry for whatever is picked, keeping its name. */
export async function findModelsOnNetwork(ui: FlowUI, replace?: SavedHost): Promise<boolean> {
  const subnets = localSubnets();
  const options: SelectOption[] = [
    ...(subnets.length
      ? [{ label: "Rechercher sur mon réseau", hint: `${subnets.map((s) => s.cidr).join(", ")} — cherche Ollama et LM Studio` }]
      : []),
    { label: "Saisir une adresse", hint: "IP, nom ou URL — aussi pour les VPN et autres réseaux" },
  ];
  if (!subnets.length) ui.status("· cet ordinateur n'est sur aucun réseau local analysable — vous pouvez quand même saisir une adresse");
  const pick = await ui.select("Trouver des modèles sur un autre ordinateur", options);
  if (pick === null) return false;
  return subnets.length && pick === 0 ? searchNetwork(ui, subnets, replace) : enterAddress(ui, replace);
}

/** "Network hosts…": see what each added machine serves, rename or remove
 * it, or look for it again when its address changed. Returns true when the
 * list changed. */
export async function manageHosts(ui: FlowUI): Promise<boolean> {
  let changed = false;
  for (;;) {
    const hosts = loadConfig().hosts ?? [];
    if (!hosts.length) {
      if (!changed) ui.status("· aucun hôte réseau ajouté pour l'instant");
      return changed;
    }
    ui.startSpinner("vérification des hôtes");
    const statuses = await probeHosts(hosts);
    ui.stopSpinner();
    const pick = await ui.select(
      "Hôtes réseau",
      statuses.map((s) => ({
        label: hostLabel(s.host),
        hint:
          (s.host.name ? `${s.host.address} · ` : "") +
          (s.servers.length
            ? describeServers(s.servers.map((x) => ({ backend: x.backend, models: x.models.length })))
            : "injoignable pour l'instant"),
      }))
    );
    if (pick === null) return changed;
    const { host, servers } = statuses[pick];
    const actions: { label: string; hint?: string; run: "rename" | "remove" | "refind" | "apikey" }[] = [
      { label: "Renommer", run: "rename" },
      {
        label: "Clé API",
        hint: host.apiKey
          ? "une clé est définie — collez pour la remplacer, vide pour la retirer"
          : "pour les passerelles hébergées (OpenRouter…)",
        run: "apikey",
      },
      { label: "Retirer", run: "remove" },
    ];
    if (!servers.length) actions.push({ label: "Le rechercher à nouveau", hint: "son adresse a peut-être changé", run: "refind" });
    const act = await ui.select(
      hostLabel(host),
      actions.map(({ label, hint }) => ({ label, hint }))
    );
    if (act === null) continue;
    if (actions[act].run === "rename") {
      const name = await ui.prompt(`Nouveau nom pour ${hostLabel(host)}`, hostLabel(host));
      if (name) {
        save(renameHost(hosts, host.address, name));
        changed = true;
      }
    } else if (actions[act].run === "apikey") {
      const key = await ui.prompt(`Clé API pour ${hostLabel(host)} — collez pour remplacer, vide pour retirer`);
      if (key !== null) {
        const clean = key.trim();
        save(setHostApiKey(hosts, host.address, clean || undefined));
        ui.status(clean ? `· clé API enregistrée pour ${hostLabel(host)}` : `· clé API retirée pour ${hostLabel(host)}`);
        changed = true;
      }
    } else if (actions[act].run === "remove") {
      save(removeHost(hosts, host.address));
      ui.status(`· retiré ${hostLabel(host)}`);
      changed = true;
    } else if (await findModelsOnNetwork(ui, host)) {
      changed = true;
    }
  }
}

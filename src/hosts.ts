// Network hosts: other machines that serve models. People add them from the
// model picker by searching the network or typing an address, so everything
// here accepts loose input ("192.168.1.50", "gpu-box.local", "box:1234",
// "https://llm.example.com") and works out the rest.

import type { SavedHost } from "./config";

export const OLLAMA_PORT = 11434;
export const LMSTUDIO_PORT = 1234;

export interface ParsedAddress {
  /** Normalized form to save. */
  address: string;
  /** Host part, for display. */
  hostname: string;
  /** Server URLs to try. A bare host means "both usual ports"; anything more
   * specific names exactly one server. */
  urls: string[];
}

/** Parse what someone typed into the address box. Throws a plain-English
 * error for input that cannot be a server address. */
export function parseAddress(input: string): ParsedAddress {
  let text = String(input ?? "").trim();
  if (!text) throw new Error("Saisissez l'adresse de la machine qui exécute vos modèles.");
  if (/\s/.test(text)) throw new Error("Une adresse ne peut pas contenir d'espaces.");
  // \\server\share or //server/share is a file share, not a model server: URL
  // parsing silently rewrites it to http://server/share and the app would then
  // probe a machine the user never meant to add.
  if (/^[\\/]{2}[^/\\]/.test(text) && !/^https?:/i.test(text))
    throw new Error(
      `"${text.slice(0, 40)}" est un partage de fichiers, pas un serveur. Saisissez une IP ou un nom comme 192.168.1.50 ou gpu-box.local.`
    );
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (schemeMatch && !/^https?$/i.test(schemeMatch[1])) throw new Error("Seules les adresses http:// et https:// fonctionnent ici.");
  if (schemeMatch && text.length === schemeMatch[0].length) throw new Error("L'adresse a besoin d'un nom d'hôte ou d'une IP.");
  text = text.replace(/\/+$/, "");
  // A bare IPv6 address needs brackets before it can carry a port.
  if (!schemeMatch && !text.startsWith("[") && (text.match(/:/g) ?? []).length > 1) text = `[${text}]`;
  let url: URL;
  try {
    url = new URL(schemeMatch ? text : `http://${text}`);
  } catch {
    throw new Error(
      `"${input.trim()}" n'est pas une adresse à laquelle je peux me connecter. Essayez une IP comme 192.168.1.50 ou un nom comme gpu-box.local.`
    );
  }
  if (url.username || url.password) throw new Error("Laissez les noms d'utilisateur et mots de hors de l'adresse.");
  if (!url.hostname) throw new Error("L'adresse a besoin d'un nom d'hôte ou d'une IP.");
  if (/^(0\.0\.0\.0|\[::\])$/.test(url.hostname))
    throw new Error("0.0.0.0 est l'adresse d'écoute d'un serveur, pas celle pour l'atteindre. Utilisez l'IP ou le nom de cette machine.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const pathPart = url.pathname.replace(/\/+$/, "");
  // URL drops a default port ("box:80"), so look at the text for one too.
  const portTyped = /:\d+$/.test(text.replace(/^\[[^\]]*\]/, ""));
  if (schemeMatch || portTyped || pathPart) {
    // A path on a bare IP (v4, v6, decimal) is never a reverse proxy prefix:
    // it is a typed URL like http://169.254.169.254/latest/meta-data/ that
    // would make identifyServer fetch attacker-chosen paths (SSRF). Strip it
    // so only fixed /api/... routes are probed. DNS names keep their path
    // (https://llm.example.com/ollama served behind a prefix).
    const looksIp = /^[0-9.]+$/.test(hostname) || hostname.includes(":") || /^\d+$/.test(hostname);
    const safePath = looksIp ? "" : pathPart === "/" ? "" : pathPart;
    const base = `${url.protocol}//${url.host}${safePath}`;
    return { address: base, hostname, urls: [base] };
  }
  return { address: url.hostname, hostname, urls: [`http://${url.host}:${OLLAMA_PORT}`, `http://${url.host}:${LMSTUDIO_PORT}`] };
}

/** Server URLs for a saved host; empty when the entry is unusable. */
export function hostUrls(host: SavedHost): string[] {
  try {
    return parseAddress(host.address).urls;
  } catch {
    return [];
  }
}

export function hostLabel(host: SavedHost): string {
  if (host.name) return host.name;
  try {
    return parseAddress(host.address).hostname;
  } catch {
    return host.address;
  }
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Add a host, or update the name / API key of one that is already there.
 * An omitted or empty apiKey keeps whatever the entry already stored, so a
 * plain rename never wipes a saved key. */
export function addHost(hosts: SavedHost[], host: SavedHost): SavedHost[] {
  const at = hosts.findIndex((h) => sameAddress(h.address, host.address));
  if (at < 0) return [...hosts, host];
  return hosts.map((h, i) =>
    i === at
      ? {
          ...h,
          ...(host.name ? { name: host.name } : {}),
          ...(host.apiKey?.trim() ? { apiKey: host.apiKey.trim() } : {}),
        }
      : h
  );
}

/** Set (non-empty) or clear (empty) a saved host's API key. */
export function setHostApiKey(hosts: SavedHost[], address: string, key: string | undefined): SavedHost[] {
  const clean = key?.trim();
  return hosts.map((h) => {
    if (!sameAddress(h.address, address)) return h;
    if (!clean) {
      const { apiKey: _gone, ...rest } = h;
      return rest;
    }
    return { ...h, apiKey: clean };
  });
}

export function removeHost(hosts: SavedHost[], address: string): SavedHost[] {
  return hosts.filter((h) => !sameAddress(h.address, address));
}

export function renameHost(hosts: SavedHost[], address: string, name: string): SavedHost[] {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 40);
  return hosts.map((h) => (sameAddress(h.address, address) ? (clean ? { ...h, name: clean } : { address: h.address }) : h));
}

/** True for addresses that stay inside a home or office network (and for
 * names, which we cannot judge). Used to warn before sending code over plain
 * http to somewhere on the internet. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(":")) return h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  // Single-label and .local/.lan/.home names resolve inside the network.
  return !h.includes(".") || /\.(local|lan|home|internal|localdomain|home\.arpa|ts\.net)$/.test(h);
}

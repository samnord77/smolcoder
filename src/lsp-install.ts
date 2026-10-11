// Language-server auto-install: detect what is missing and install it into
// user-level caches (npx cache, pip --user, rustup, go install) — never into
// the project itself. The TypeScript peer dependency is reported, not
// installed (it belongs to the project's package.json). Every step reports
// one line; nothing here throws.
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { LSP_LANGS, lspAvailability, serverDefForLang } from "./lsp-pro";
import { findCommand, resolveCommand } from "./mcp";

const INSTALL_TIMEOUT_MS = 120_000;

export interface InstallStep {
  lang: string;
  ok: boolean;
  detail: string;
}

function run(cmd: string[], cwd: string): { code: number; out: string } {
  try {
    const exe = resolveCommand(cmd[0]);
    // npm, npx, yarn... sont des .cmd sur Windows : spawnSync les refuse sans
    // shell (EINVAL) et l install echouait avant de commencer. La ligne
    // complete est alors passee a cmd.exe, comme pour les serveurs LSP.
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(exe);
    const q = String.fromCharCode(34);
    const line =
      q +
      exe.replace(/["]/g, "") +
      q +
      " " +
      cmd
        .slice(1)
        .map((a) => q + a.replace(/["]/g, "") + q)
        .join(" ");
    const r = useShell
      ? spawnSync(line, { cwd, encoding: "utf8", timeout: INSTALL_TIMEOUT_MS, windowsHide: true, maxBuffer: 2 * 1024 * 1024, shell: true })
      : spawnSync(exe, cmd.slice(1), {
          cwd,
          encoding: "utf8",
          timeout: INSTALL_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 2 * 1024 * 1024,
        });
    if (r.error) return { code: 1, out: String((r.error as any)?.message ?? r.error).slice(0, 300) };
    return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(-500) };
  } catch (err: any) {
    return { code: 1, out: String(err?.message ?? err).slice(0, 300) };
  }
}

/** Dossier npm gere par smolcoder pour les serveurs de langage bases sur
 * node. Pas de -g (souvent ecrit dans Program Files, donc admin requis) et
 * pas de PATH a modifier : binSearchDirs() connait ce dossier et les
 * serveurs demarres le retrouvent aussi. SMOLCODER_LSP_PREFIX le deplace
 * pour les tests. */
const lspNpmPrefix = (): string => process.env.SMOLCODER_LSP_PREFIX || path.join(os.homedir(), ".smolcoder", "lsp-npm");

function installCommands(lang: string): string[][] {
  switch (lang) {
    case "typescript":
      return [["npx", "-y", "typescript-language-server", "--version"]];
    case "python":
      return [
        ["python", "-m", "pip", "install", "--user", "python-lsp-server"],
        ["pip", "install", "--user", "python-lsp-server"],
        ["py", "-m", "pip", "install", "--user", "python-lsp-server"],
      ];
    case "rust":
      return [["rustup", "component", "add", "rust-analyzer"]];
    case "go":
      return [["go", "install", "golang.org/x/tools/gopls@latest"]];
    case "html":
    case "markdown":
    case "css":
    case "scss":
    case "less":
    case "json":
      // Un seul paquet embarque tous les serveurs vscode (html, markdown,
      // css/scss/less, json). Installe dans le cache utilisateur smolcoder.
      return [["npm", "i", "--prefix", lspNpmPrefix(), "vscode-langservers-extracted"]];
    case "yaml":
      return [["npm", "i", "--prefix", lspNpmPrefix(), "yaml-language-server"]];
    case "bash":
      return [["npm", "i", "--prefix", lspNpmPrefix(), "bash-language-server"]];
    case "dockerfile":
      return [["npm", "i", "--prefix", lspNpmPrefix(), "dockerfile-language-server-nodejs"]];
    case "sql":
      return [["npm", "i", "--prefix", lspNpmPrefix(), "sql-language-server"]];
    case "graphql":
      return [["npm", "i", "--prefix", lspNpmPrefix(), "graphql-language-service-cli"]];
    case "php":
      return [["npm", "i", "--prefix", lspNpmPrefix(), "intelephense"]];
    default:
      return [];
  }
}

/** Extra honesty for TypeScript: the server needs a `typescript` peer
 * resolvable from the workspace — report it, never install it. */
function tsPeerNote(cwd: string): string {
  try {
    require.resolve("typescript", { paths: [cwd] });
    return "";
  } catch {
    return " Note: this project has no resolvable `typescript` package — run `npm i -D typescript` here for full checking.";
  }
}

function serverResolves(def: { candidates: string[][] }): string | null {
  for (const [exe] of def.candidates) {
    // findCommand, not resolveCommand: resolveCommand echoes its input back
    // when the binary is missing, so this used to report every language as
    // "already installed" and the installer would never install anything.
    if (findCommand(exe)) return exe;
  }
  return null;
}

/** Install one language server if missing. Best effort, fully reported. */
export function installLspServer(lang: string, cwd: string): InstallStep {
  const def = serverDefForLang(lang);
  if (!def) return { lang, ok: false, detail: `Unknown language "${lang}" — choose: ${LSP_LANGS.join(", ")}.` };
  const already = serverResolves(def);
  if (already) {
    const peer = lang === "typescript" ? tsPeerNote(cwd) : "";
    return { lang, ok: true, detail: `Already installed (${already}).${peer}` };
  }
  const cmds = installCommands(lang);
  let last = "no installer known for this language";
  for (const cmd of cmds) {
    const r = run(cmd, cwd);
    last = r.out.split("\n").filter(Boolean).slice(-2).join(" / ").slice(0, 200) || `exit ${r.code}`;
    if (r.code !== 0) continue;
    const now = serverResolves(def);
    if (now) {
      const peer = lang === "typescript" ? tsPeerNote(cwd) : "";
      return { lang, ok: true, detail: `Installed via \`${cmd.join(" ")}\`.${peer}` };
    }
    return {
      lang,
      ok: false,
      detail: `Installé mais introuvable au démarrage (${last}). Cherché dans le PATH et les dossiers usuels (Python Scripts, cache npm smolcoder…). Si le binaire est ailleurs, ajoutez son dossier au PATH puis réessayez.`,
    };
  }
  return { lang, ok: false, detail: `Échec de l'installation (${last}). ${def.installHint}` };
}

/** One-line status per language, with the exact fix when missing. */
export function lspDoctor(): string {
  const rows = lspAvailability();
  const lines = rows.map((r) => `${r.ok ? "✓" : "✗"} ${r.lang}${r.ok ? "" : ` — ${r.hint}`}`);
  const missing = rows.filter((r) => !r.ok).map((r) => r.lang);
  return [
    "Language servers:",
    ...lines,
    missing.length
      ? `Fix: run symbols {"action": "setup", "lang": "${missing[0]}"} (or "all") — installs into user caches, never into your project.`
      : "All four are ready.",
  ].join("\n");
}

/** Install one language ("python") or every missing one ("all"). */
export function setupLsp(root: string, lang: string): string {
  const want = String(lang ?? "")
    .trim()
    .toLowerCase();
  const langs = want === "all" || !want ? [...LSP_LANGS] : [want];
  if (!want || want === "all") {
    const missing = lspAvailability()
      .filter((r) => !r.ok)
      .map((r) => r.lang);
    if (!missing.length) return "Les quatre serveurs de langage sont déjà installés.";
    return missing
      .map((l) => installLspServer(l, root))
      .map((r) => `${r.ok ? "✓" : "✗"} ${r.lang}: ${r.detail}`)
      .join("\n");
  }
  const r = installLspServer(langs[0], root);
  return `${r.ok ? "✓" : "✗"} ${r.lang}: ${r.detail}`;
}

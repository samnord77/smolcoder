// Décisions d'approbation du mode auto (auto-pilote).
//
// En mode édition, toute commande qui sort de l'espace de travail ouvre une
// question y/n. Le mode auto garde cette question pour tout ce qui agit, mais
// laisse filer sans demander les commandes manifestement en lecture seule —
// consulter un fichier ailleurs, lire un log git, montrer une version d'outil.
//
// Un faux « safe » exécuterait une commande hors workspace sans approbation :
// la liste blanche est donc volontairement étroite, le premier mot de la
// commande doit y figurer, et n'importe quel caractère de chaînage, pipe,
// redirection ou substitution ( `; & | $ > < backtick parenthèses` ) force la
// question. Le backslash reste permis : sur Windows c'est un séparateur de
// chemin, pas un métacaractère.

export type CommandRisk = "safe" | "ask";

/** Chaînage, pipes, redirections, substitution de commande : l'emportent sur
 * tout le reste (le backslash n'en fait pas partie, cf. en-tête). */
const CHAINING = /[;&|`$<>(){}\n\r]/;

/** Options de find/ripgrep qui exécutent ou suppriment : une commande
 * autrement en lecture devient « ask ». */
const DESTRUCTIVE_ARGS = /(^|\s)-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)(\s|$)/;

/** Programmes qui ne font que lire ou consulter, quels que soient leurs
 * arguments (hors chaînage, cf. CHAINING et DESTRUCTIVE_ARGS). Les noms
 * PowerShell en tiret sont comparés en minuscules. */
const SAFE_PROGRAMS = new Set([
  // listage et lecture de fichiers
  "ls",
  "dir",
  "tree",
  "cat",
  "type",
  "head",
  "tail",
  "wc",
  "find",
  "findstr",
  "rg",
  "grep",
  "stat",
  "file",
  "du",
  "df",
  "realpath",
  "readlink",
  "get-content",
  "get-childitem",
  "get-item",
  "get-itemproperty",
  "get-filehash",
  "select-string",
  "measure-object",
  "resolve-path",
  "test-path",
  // recherche de programmes et lecture système
  "where",
  "where.exe",
  "which",
  "get-command",
  "pwd",
  "get-location",
  "whoami",
  "hostname",
  "uname",
  "ipconfig",
  "ifconfig",
  "systeminfo",
  "ver",
  "sw_vers",
  "get-process",
  "get-date",
  "get-computerinfo",
  "nvidia-smi",
  "echo",
  "write-output",
]);

/** Sous-commandes git strictement en lecture. */
const SAFE_GIT_SUB = new Set([
  "status",
  "log",
  "diff",
  "show",
  "reflog",
  "ls-files",
  "blame",
  "describe",
  "shortlog",
  "rev-parse",
  "rev-list",
  "cat-file",
  "ls-tree",
  "for-each-ref",
  "count-objects",
  "whatchanged",
  "diff-tree",
  "diff-files",
  "grep",
  "name-rev",
  "var",
]);

/** Outils à la forme unique de version/aide : `node --version`, `python -h`… */
const VERSION_TOOLS = new Set([
  "node",
  "python",
  "python3",
  "py",
  "pip",
  "pip3",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "tsc",
  "cargo",
  "rustc",
  "go",
  "java",
  "javac",
  "dotnet",
  "gh",
  "uv",
  "poetry",
  "conda",
]);
const VERSION_ARG = /^\s*(--version|-v|-V|--help|-h)\s*$/;

/**
 * Classe une commande hors workspace : « safe » quand elle est en lecture
 * seule de façon évidente (le mode auto l'exécute sans demander), « ask »
 * sinon (question y/n habituelle). Jamais plus permissif qu'un humain qui
 * lit la commande ; en cas de doute, « ask ».
 */
export function classifyCommand(command: string): CommandRisk {
  const trimmed = command.trim();
  if (!trimmed || CHAINING.test(trimmed) || DESTRUCTIVE_ARGS.test(trimmed)) return "ask";
  const parts = trimmed.split(/\s+/);
  const program = (parts[0] ?? "").toLowerCase();
  const rest = parts.slice(1);

  if (SAFE_PROGRAMS.has(program)) return "safe";

  if (program === "git") {
    const sub = (rest[0] ?? "").toLowerCase();
    const args = rest.slice(1);
    if (SAFE_GIT_SUB.has(sub)) return "safe";
    if (sub === "branch") {
      return args.every((a) => ["-a", "-r", "-v", "-vv", "--all", "--remote", "--verbose", "--list", "--show-current"].includes(a))
        ? "safe"
        : "ask";
    }
    if (sub === "remote") return args.every((a) => ["-v", "--verbose", "show"].includes(a)) ? "safe" : "ask";
    if (sub === "stash") return args.length === 0 || ["list", "show"].includes(args[0].toLowerCase()) ? "safe" : "ask";
    if (sub === "config")
      return args.length > 0 && ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(args[0]) ? "safe" : "ask";
    return "ask";
  }

  if (VERSION_TOOLS.has(program)) return rest.length === 1 && VERSION_ARG.test(rest[0]) ? "safe" : "ask";

  return "ask";
}

// ---------------------------------------------------------------------------
// Commandes dangereuses : elles demandent TOUJOURS une confirmation humaine,
// même à l'intérieur du dossier de travail et en mode edit/auto — réécrire
// l'histoire d'un dépôt, publier un paquet, effacer un disque, éteindre la
// machine. Un « always » sur le programme ne les couvre jamais : on redemande
// à chaque fois. Retourne la raison (français) ou null.
// ---------------------------------------------------------------------------

interface DangerRule {
  re: RegExp;
  reason: string;
}

const DANGER_RULES: DangerRule[] = [
  {
    re: /\bgit\s+push\b[^\n]*(?:--force\S*|(?:^|\s)-f(?:\s|$)|--mirror|--delete)/i,
    reason: "réécrit ou supprime l'histoire du dépôt distant (git push --force/--mirror/--delete)",
  },
  {
    re: /\bgit\s+reset\b[^\n]*--hard\b/i,
    reason: "jette des modifications non committées (git reset --hard)",
  },
  {
    re: /\bgit\s+clean\b[^\n]*(?:--force|(?:^|\s)-[a-zA-Z]*f[a-zA-Z]*(?:\s|$))/i,
    reason: "supprime définitivement des fichiers non suivis (git clean -f)",
  },
  {
    re: /\b(?:npm|pnpm|yarn|bun)\s+publish\b/i,
    reason: "publie un paquet (définitif pour la version publiée)",
  },
  {
    re: /\b(?:gh|cargo)\s+(?:release|publish)\b/i,
    reason: "publie une version (gh/cargo release)",
  },
  {
    re: /\btwine\s+upload\b|\bdotnet\s+nuget\s+push\b/i,
    reason: "téléverse un paquet vers un registre (twine/nuget)",
  },
  {
    re: /\|\s*(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd|iex|invoke-expression)\b/i,
    reason: "exécute du code reçu par un pipe, sans relecture (… | sh)",
  },
  {
    re: /\b(?:invoke-expression|iex)\b\s*[("]/i,
    reason: "exécute du code arbitraire (Invoke-Expression/iex)",
  },
  {
    re: /\b(?:diskpart|mkfs(?:\.\w+)?)\b/i,
    reason: "efface ou reformate un disque (diskpart/mkfs)",
  },
  {
    re: /\bformat(?:\.com)?\s+[a-z]:/i,
    reason: "formate un disque (format X:)",
  },
  {
    re: /\b(?:shutdown|restart-computer|stop-computer)\b/i,
    reason: "éteint ou redémarre la machine",
  },
  {
    re: /\bremove-item\b(?=[^\n]*-recurse)(?=[^\n]*-force)/i,
    reason: "supprime récursivement sans confirmation (Remove-Item -Recurse -Force)",
  },
];

export function classifyDanger(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  for (const rule of DANGER_RULES) {
    if (rule.re.test(trimmed)) return rule.reason;
  }
  // rm -rf visant une racine ou le dossier personnel : effacement massif.
  if (/\brm\b(?=[^\n]*\s-[a-zA-Z]*r)(?=[^\n]*\s-[a-zA-Z]*f)/i.test(trimmed)) {
    if (/(?:^|\s)(?:\/|~|\$HOME|[A-Za-z]:[\\/]?)(?:\s|$)/.test(trimmed)) {
      return "efface récursivement une racine ou le dossier personnel (rm -rf)";
    }
  }
  return null;
}

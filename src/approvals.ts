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

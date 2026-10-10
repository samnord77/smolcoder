// Terminal auto-repair helpers (Plan Puissance, Pilier 2): a bounded error text
// for the AI prompt, and the source file implicated by a stack trace. Pure and
// synchronous so the desktop renderer can use them through the preload bridge
// and the test suite can cover them directly.

/** Extensions we are willing to open from a crash trace. */
export const TRACE_EXT = "(?:ts|js|jsx|tsx|mjs|cjs|py|rs|go|java|c|cc|cpp|h|hpp|json|html|css|md|sh)";

/** Workspace folders whose paths are always safe to open relatively. */
const RELATIVE_ROOTS = "src|test|tests|desktop|scripts|lib|app|pages|packages";
// A path begins after a frame opening, a quote or whitespace, never after a
// slash: that keeps URL fragments such as http://host/app.ts out of the match.
const BOUNDARY = "(?:^|[(\\s\"'=,])";
const PATH_CHARS = '[^\\n:*?"<>|]{1,240}';
// Generated output and bundled dependencies are never the file to repair.
const SKIP_PATH = /(?:^|\/)(?:node_modules|dist|build|coverage|\.git|app\.asar)(?:\/|$)/i;

const ABSOLUTE_HIT = new RegExp(`${BOUNDARY}((?:[A-Za-z]:[\\\\/]|/)${PATH_CHARS}\\.${TRACE_EXT}(?![A-Za-z0-9_]))`, "gi");
const RELATIVE_HIT = new RegExp(`${BOUNDARY}((?:${RELATIVE_ROOTS})[\\\\/]${PATH_CHARS}\\.${TRACE_EXT}(?![A-Za-z0-9_]))`, "gi");
// Python reports `File "src/app.py", line 12` without any folder root.
const QUOTED_HIT = new RegExp(`File\\s+"([^"\\n]{1,240}\\.${TRACE_EXT}(?![A-Za-z0-9_]))`, "gi");

interface TraceHit {
  index: number;
  path: string;
}

function collectHits(text: string): TraceHit[] {
  const hits: TraceHit[] = [];
  const scan = (re: RegExp) => {
    re.lastIndex = 0;
    let match = re.exec(text);
    while (match) {
      const found = (match[1] || "").trim().replace(/\\/g, "/");
      if (found) hits.push({ index: match.index, path: found });
      if (match.index === re.lastIndex) re.lastIndex += 1;
      match = re.exec(text);
    }
  };
  scan(ABSOLUTE_HIT);
  scan(RELATIVE_HIT);
  scan(QUOTED_HIT);
  return hits.sort((a, b) => a.index - b.index);
}

function normalizeRoot(root?: string): string {
  return String(root ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function isUnder(root: string, target: string): boolean {
  if (!root) return false;
  const windows = /^[A-Za-z]:\//.test(root);
  const left = windows ? root.toLowerCase() : root;
  const right = windows ? target.toLowerCase() : target;
  return right === left || right.startsWith(`${left}/`);
}

/**
 * First actionable source path of a crash trace, or null. Absolute hits are
 * only returned when they live under `root`, then converted to the exact
 * workspace-relative path the editor opens directly. Never throws.
 */
export function extractSourcePath(errorText: string, root?: string): string | null {
  const text = String(errorText ?? "").slice(0, 20000);
  if (!text) return null;
  const workspaceRoot = normalizeRoot(root);
  for (const hit of collectHits(text)) {
    if (SKIP_PATH.test(hit.path)) continue;
    const absolute = /^[A-Za-z]:\//.test(hit.path) || hit.path.startsWith("/");
    if (absolute && workspaceRoot) {
      if (isUnder(workspaceRoot, hit.path)) {
        const relative = hit.path.slice(workspaceRoot.length + 1);
        if (relative) return relative;
      }
      continue;
    }
    return hit.path;
  }
  return null;
}

/** The error context sent to the AI: the command plus a bounded output trace. */
export function buildTermErrorText(cmd: string, output?: string, errText?: string): string {
  const pieces: string[] = [];
  const command = String(cmd ?? "")
    .trim()
    .slice(0, 1000);
  if (command) pieces.push(`Commande : ${command}`);
  const trace = [output, errText].filter(Boolean).join("\n").trim().slice(0, 4000);
  if (trace) pieces.push(`Sortie :\n${trace}`);
  return pieces.join("\n\n");
}

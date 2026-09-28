// Workspace code index: fast offline symbol search (functions, classes,
// interfaces, types…) across TypeScript, Python, Rust, Go, Java, PHP, Ruby
// and shell files. Dependency-free — plain regex extractors over a bounded
// file walk, cached in .smol/codeindex.json so the first search builds it
// and the next ones answer instantly. The agent uses it to find "where is
// X defined" without burning model context on full-text grep.
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveInWorkspace } from "./sandbox";

export interface CodeSymbol {
  name: string;
  kind: string;
  /** Path relative to the workspace, forward slashes. */
  file: string;
  /** 1-based line number. */
  line: number;
  detail?: string;
}

export interface IndexStats {
  files: number;
  symbols: number;
  ms: number;
  updatedAt: number;
}

const INDEX_VERSION = 1;
const MAX_FILES = 3000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SYMBOLS = 60000;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".idea",
  ".vscode",
  ".smol",
  ".c3",
  ".scratch",
]);

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "with", "return", "else", "do", "try", "finally"]);

interface Rule {
  kind: string;
  /** First capture group = the symbol name (second group when prefixed). */
  re: RegExp;
  group: number;
  prefix?: RegExp;
}

interface LangRules {
  exts: string[];
  rules: Rule[];
}

function tsRules(): Rule[] {
  return [
    { kind: "function", re: /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, group: 1 },
    { kind: "function", re: /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, group: 1 },
    { kind: "class", re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, group: 1 },
    { kind: "interface", re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, group: 1 },
    { kind: "type", re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, group: 1 },
    { kind: "enum", re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, group: 1 },
    { kind: "function", re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function)/, group: 1 },
    { kind: "variable", re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, group: 1 },
    {
      kind: "method",
      re: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::\s*[^{;=]+)?\{/,
      group: 1,
    },
  ];
}

const LANGS: LangRules[] = [
  { exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"], rules: tsRules() },
  {
    exts: [".py"],
    rules: [
      { kind: "function", re: /^\s*def\s+([A-Za-z_]\w*)\s*\(/, group: 1 },
      { kind: "class", re: /^\s*class\s+([A-Za-z_]\w*)/, group: 1 },
    ],
  },
  {
    exts: [".rs"],
    rules: [
      { kind: "function", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?fn\s+([A-Za-z_]\w*)/, group: 1 },
      { kind: "struct", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, group: 1 },
      { kind: "enum", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, group: 1 },
      { kind: "trait", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, group: 1 },
      { kind: "module", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/, group: 1 },
    ],
  },
  {
    exts: [".go"],
    rules: [
      { kind: "function", re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, group: 1 },
      { kind: "type", re: /^\s*type\s+([A-Za-z_]\w*)/, group: 1 },
    ],
  },
  {
    exts: [".java", ".cs", ".kt"],
    rules: [
      {
        kind: "class",
        re: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+|abstract\s+|sealed\s+|final\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/,
        group: 1,
      },
      {
        kind: "method",
        re: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+|virtual\s+|override\s+|async\s+)*[\w<>[\],\s]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|=>)?/,
        group: 1,
      },
    ],
  },
  {
    exts: [".php"],
    rules: [
      { kind: "function", re: /^\s*function\s+([A-Za-z_]\w*)\s*\(/, group: 1 },
      { kind: "class", re: /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/, group: 1 },
    ],
  },
  {
    exts: [".rb"],
    rules: [
      { kind: "function", re: /^\s*def\s+([A-Za-z_]\w*[?!]?)/, group: 1 },
      { kind: "class", re: /^\s*(?:class|module)\s+([A-Za-z_:]\w*)/, group: 1 },
    ],
  },
  {
    exts: [".sh", ".bash", ".zsh"],
    rules: [{ kind: "function", re: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\s*\)/, group: 1 }],
  },
];

function rulesFor(ext: string): Rule[] {
  for (const lang of LANGS) {
    if (lang.exts.includes(ext)) return lang.rules;
  }
  return [];
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function extractSymbols(rel: string, text: string): CodeSymbol[] {
  const rules = rulesFor(path.extname(rel).toLowerCase());
  if (!rules.length) return [];
  const out: CodeSymbol[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].slice(0, 500);
    for (const rule of rules) {
      const m = rule.re.exec(line);
      if (!m) continue;
      const name = (m[rule.group] ?? "").trim();
      if (!name || KEYWORDS.has(name) || name.length > 120) continue;
      out.push({ name, kind: rule.kind, file: rel, line: i + 1 });
      break; // one symbol per line keeps the index clean
    }
    if (out.length > 4000) break;
  }
  return out;
}

export function scanWorkspace(root: string): { symbols: CodeSymbol[]; files: number } {
  const symbols: CodeSymbol[] = [];
  let files = 0;
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (files >= MAX_FILES || symbols.length >= MAX_SYMBOLS) return { symbols, files };
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) {
          if (!(e.name === ".smol" || e.name === ".c3")) continue;
          else continue;
        }
        stack.push(abs);
      } else if (e.isFile()) {
        if (!rulesFor(path.extname(e.name).toLowerCase()).length) continue;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
        let buf: Buffer;
        try {
          buf = fs.readFileSync(abs);
        } catch {
          continue;
        }
        if (looksBinary(buf)) continue;
        files++;
        const rel = path.relative(root, abs).split(path.sep).join("/");
        try {
          for (const s of extractSymbols(rel, buf.toString("utf8"))) symbols.push(s);
        } catch {
          /* skip unreadable file */
        }
      }
    }
  }
  return { symbols, files };
}

// ---------------------------------------------------------------------------
// Index with disk cache
// ---------------------------------------------------------------------------

function cachePath(root: string): string {
  return path.join(root, ".smol", "codeindex.json");
}

export class CodeIndex {
  private symbols: CodeSymbol[] = [];
  private stats: IndexStats = { files: 0, symbols: 0, ms: 0, updatedAt: 0 };

  constructor(private root: string) {}

  refresh(): IndexStats {
    const started = Date.now();
    const { symbols, files } = scanWorkspace(this.root);
    this.symbols = symbols;
    this.stats = { files, symbols: symbols.length, ms: Date.now() - started, updatedAt: Date.now() };
    try {
      fs.mkdirSync(path.dirname(cachePath(this.root)), { recursive: true });
      fs.writeFileSync(
        cachePath(this.root),
        JSON.stringify({ version: INDEX_VERSION, updatedAt: this.stats.updatedAt, stats: this.stats, symbols })
      );
    } catch {
      /* cache is best effort — the in-memory index still works */
    }
    return this.stats;
  }

  loadCache(): boolean {
    try {
      const raw = JSON.parse(fs.readFileSync(cachePath(this.root), "utf8"));
      if (raw?.version !== INDEX_VERSION || !Array.isArray(raw?.symbols)) return false;
      this.symbols = raw.symbols.filter(
        (s: any) => s && typeof s.name === "string" && typeof s.file === "string" && typeof s.line === "number"
      );
      this.stats = {
        files: Number(raw.stats?.files) || 0,
        symbols: this.symbols.length,
        ms: 0,
        updatedAt: Number(raw.updatedAt) || 0,
      };
      return this.symbols.length > 0;
    } catch {
      return false;
    }
  }

  /** Ranked search: exact match first, then prefix, then substring. */
  search(query: string, limit = 30): CodeSymbol[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const cap = Math.min(Math.max(1, Math.floor(limit) || 30), 100);
    const exact: CodeSymbol[] = [];
    const prefix: CodeSymbol[] = [];
    const sub: CodeSymbol[] = [];
    for (const s of this.symbols) {
      const name = s.name.toLowerCase();
      if (name === q) exact.push(s);
      else if (name.startsWith(q)) prefix.push(s);
      else if (name.includes(q)) sub.push(s);
      if (exact.length + prefix.length + sub.length >= cap * 3) break;
    }
    return [...exact, ...prefix, ...sub].slice(0, cap);
  }

  symbolsIn(relPath: string): CodeSymbol[] {
    let abs: string;
    try {
      abs = resolveInWorkspace(this.root, relPath);
    } catch {
      return [];
    }
    const rel = path.relative(this.root, abs).split(path.sep).join("/");
    return this.symbols.filter((s) => s.file === rel);
  }

  getStats(): IndexStats {
    return { ...this.stats };
  }

  isEmpty(): boolean {
    return this.symbols.length === 0;
  }
}

const indexes = new Map<string, CodeIndex>();

export function indexFor(root: string): CodeIndex {
  let idx = indexes.get(root);
  if (!idx) {
    idx = new CodeIndex(root);
    indexes.set(root, idx);
  }
  return idx;
}

/** Test hook: drop cached indexes. */
export function clearIndexCache(): void {
  indexes.clear();
}

function fmtSym(s: CodeSymbol): string {
  return `${s.name} (${s.kind}) — ${s.file}:${s.line}${s.detail ? ` — ${s.detail}` : ""}`;
}

export interface IndexQuery {
  action?: unknown;
  query?: unknown;
  path?: unknown;
  limit?: unknown;
}

const INDEX_ACTIONS = ["search", "file", "stats", "refresh"];

/** Answer one index question. refresh needs canRefresh (it writes the
 * cache); search/file/stats are pure reads. Never throws. */
export function queryIndex(root: string, args: IndexQuery, opts?: { canRefresh?: boolean; canWrite?: boolean }): string {
  const action = String(args.action ?? "");
  if (!INDEX_ACTIONS.includes(action)) {
    return `Error: action must be one of ${INDEX_ACTIONS.map((a) => `"${a}"`).join(", ")}. Example: {"action": "search", "query": "Agent"}`;
  }
  const idx = indexFor(root);
  if (action === "refresh") {
    if (opts?.canRefresh === false || opts?.canWrite === false) {
      return "Error: rebuilding the index writes the cache — unavailable in read-only mode. Switch to edit mode to refresh.";
    }
    const st = idx.refresh();
    return `Index rebuilt: ${st.files} files, ${st.symbols} symbols in ${st.ms} ms.`;
  }
  if (idx.isEmpty() && !idx.loadCache()) idx.refresh();
  if (action === "stats") {
    const st = idx.getStats();
    const age = st.updatedAt ? `${Math.max(0, Math.round((Date.now() - st.updatedAt) / 1000))}s ago` : "just now";
    return `Index: ${st.files} files, ${st.symbols} symbols (built ${age}).`;
  }
  if (action === "file") {
    const rel = typeof args.path === "string" ? args.path : "";
    if (!rel) return 'Error: file needs a path. Example: {"action": "file", "path": "src/agent.ts"}';
    const found = idx.symbolsIn(rel);
    if (!found.length) return `No indexed symbols in "${rel}" (file may be unindexed or use an unsupported language).`;
    return found.slice(0, 50).map(fmtSym).join("\n");
  }
  const q = typeof args.query === "string" ? args.query : "";
  if (!q.trim()) return 'Error: search needs a query. Example: {"action": "search", "query": "Agent"}';
  const limit = Number(args.limit) || 30;
  const found = idx.search(q, limit);
  if (!found.length)
    return `No symbol matching "${q.trim().slice(0, 80)}". Try a shorter name or {"action": "refresh"} after adding files.`;
  return found.map(fmtSym).join("\n");
}

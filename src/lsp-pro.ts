// Pro language intelligence: persistent multi-language LSP servers with rich
// actions (hover, definition, references, diagnostics, rename, completion,
// signature help, workspace symbols, quick fixes).
//
// This module never touches src/lsp.ts: the legacy one-shot querySymbols()
// keeps serving the four classic TypeScript actions with byte-identical
// messages (tests assert them), while queryCode() routes everything else —
// Python, Rust, Go and the new actions — through a cached LspManager that
// starts each server ONCE per workspace and reuses it (open, query, keep).
// Zero new dependencies: JSON-RPC with Content-Length framing over stdio,
// exactly like the existing client.
//
// Config (env only, no password anywhere):
//   SMOLCODER_LSP_DISABLE=1 — every query answers "désactivé", nothing spawns.
//   SMOLCODER_LSP_COMMAND="..." — overrides the TypeScript server command.
//   SMOLCODER_LSP_PYTHON="pylsp" / SMOLCODER_LSP_RUST="rust-analyzer" /
//   SMOLCODER_LSP_GO="gopls" — per-language command overrides (space-separated).
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { encodeLsp, isTsLike, lspDisabled, querySymbols, splitCommand } from "./lsp";
import { findCommand, resolveCommand } from "./mcp";
import { resolveInWorkspace } from "./sandbox";

export { splitCommand };

// ---------------------------------------------------------------------------
// Server catalog
// ---------------------------------------------------------------------------

export interface LspServerDef {
  lang: string;
  languageId: string;
  exts: string[];
  /** Tried in order; the first command that starts wins. */
  candidates: string[][];
  installHint: string;
}

function envCandidate(name: string): string[][] {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return [];
  const parts = splitCommand(raw);
  return parts.length ? [parts] : [];
}

function tsCandidates(): string[][] {
  const raw = (process.env.SMOLCODER_LSP_COMMAND ?? "").trim();
  if (raw) {
    const parts = splitCommand(raw);
    if (parts.length) return [parts];
  }
  return [["npx", "typescript-language-server", "--stdio"]];
}

export const LSP_LANGS = [
  "typescript",
  "python",
  "rust",
  "go",
  "java",
  "kotlin",
  "scala",
  "csharp",
  "fsharp",
  "cpp",
  "c",
  "objective-c",
  "objective-cpp",
  "ruby",
  "php",
  "perl",
  "lua",
  "swift",
  "dart",
  "html",
  "css",
  "scss",
  "less",
  "json",
  "yaml",
  "toml",
  "markdown",
  "rst",
  "bash",
  "powershell",
  "fish",
  "dockerfile",
  "sql",
  "graphql",
  "protobuf",
  "haskell",
  "elixir",
];

/** Fresh on every call so env overrides apply even when set late (tests). */
export function serverDefForLang(lang: string): LspServerDef | null {
  switch (String(lang)) {
    case "typescript":
      return {
        lang,
        languageId: "typescript",
        exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
        candidates: tsCandidates(),
        installHint: "Install once with: npx -y typescript-language-server --version",
      };
    case "python":
      return {
        lang,
        languageId: "python",
        exts: [".py"],
        candidates: [
          ...envCandidate("SMOLCODER_LSP_PYTHON"),
          ["pylsp"],
          ["pyright-langserver", "--stdio"],
          ["basedpyright-langserver", "--stdio"],
        ],
        installHint: "Install once with: pip install python-lsp-server  (or: npm i -g pyright)",
      };
    case "rust":
      return {
        lang,
        languageId: "rust",
        exts: [".rs"],
        candidates: [...envCandidate("SMOLCODER_LSP_RUST"), ["rust-analyzer"]],
        installHint: "Install rust-analyzer and put it on PATH (https://rust-analyzer.github.io)",
      };
    case "go":
      return {
        lang,
        languageId: "go",
        exts: [".go"],
        candidates: [...envCandidate("SMOLCODER_LSP_GO"), ["gopls"]],
        installHint: "Install once with: go install golang.org/x/tools/gopls@latest",
      };
    case "java":
      return {
        lang,
        languageId: "java",
        exts: [".java"],
        candidates: [...envCandidate("SMOLCODER_LSP_JAVA"), ["jdtls"]],
        installHint: "Install jdtls (Eclipse JDT Language Server) from https://github.com/eclipse-jdtls/eclipse.jdt.ls",
      };
    case "kotlin":
      return {
        lang,
        languageId: "kotlin",
        exts: [".kt", ".kts"],
        candidates: [...envCandidate("SMOLCODER_LSP_KOTLIN"), ["kotlin-language-server"]],
        installHint: "Install kotlin-language-server from https://github.com/fwcd/kotlin-language-server",
      };
    case "scala":
      return {
        lang,
        languageId: "scala",
        exts: [".scala", ".sbt"],
        candidates: [...envCandidate("SMOLCODER_LSP_SCALA"), ["metals"]],
        installHint: "Install metals (Scala language server) from https://scalameta.org/metals/",
      };
    case "csharp":
      return {
        lang,
        languageId: "csharp",
        exts: [".cs"],
        candidates: [...envCandidate("SMOLCODER_LSP_CSHARP"), ["csharp-ls"]],
        installHint: "Install csharp-ls from https://github.com/razzmatazz/csharp-language-server",
      };
    case "fsharp":
      return {
        lang,
        languageId: "fsharp",
        exts: [".fs", ".fsx", ".fsi"],
        candidates: [...envCandidate("SMOLCODER_LSP_FSHARP"), ["fsautocomplete"]],
        installHint: "Install fsautocomplete from https://github.com/fsharp/fsautocomplete",
      };
    case "cpp":
      return {
        lang,
        languageId: "cpp",
        exts: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
        candidates: [...envCandidate("SMOLCODER_LSP_CPP"), ["clangd"]],
        installHint: "Install clangd from https://clangd.llvm.org/",
      };
    case "c":
      return {
        lang,
        languageId: "c",
        exts: [".c", ".h"],
        candidates: [...envCandidate("SMOLCODER_LSP_C"), ["clangd"]],
        installHint: "Install clangd from https://clangd.llvm.org/",
      };
    case "objective-c":
      return {
        lang,
        languageId: "objective-c",
        exts: [".m"],
        candidates: [...envCandidate("SMOLCODER_LSP_OBJC"), ["clangd"]],
        installHint: "Install clangd from https://clangd.llvm.org/",
      };
    case "objective-cpp":
      return {
        lang,
        languageId: "objective-cpp",
        exts: [".mm"],
        candidates: [...envCandidate("SMOLCODER_LSP_OBJCPP"), ["clangd"]],
        installHint: "Install clangd from https://clangd.llvm.org/",
      };
    case "ruby":
      return {
        lang,
        languageId: "ruby",
        exts: [".rb", ".rbw", ".rake", ".gemspec"],
        candidates: [...envCandidate("SMOLCODER_LSP_RUBY"), ["solargraph", "stdio"], ["ruby-lsp"]],
        installHint: "Install solargraph (gem install solargraph) or ruby-lsp (gem install ruby-lsp)",
      };
    case "php":
      return {
        lang,
        languageId: "php",
        exts: [".php", ".phtml", ".php8"],
        candidates: [...envCandidate("SMOLCODER_LSP_PHP"), ["intelephense", "--stdio"]],
        installHint: "Install intelephense (npm i -g intelephense) or phpactor (composer global require phpactor/phpactor)",
      };
    case "perl":
      return {
        lang,
        languageId: "perl",
        exts: [".pl", ".pm", ".pod", ".t"],
        candidates: [...envCandidate("SMOLCODER_LSP_PERL"), ["perl-lsp"]],
        installHint: "Install perl-lsp (cpanm Perl::LanguageServer)",
      };
    case "lua":
      return {
        lang,
        languageId: "lua",
        exts: [".lua"],
        candidates: [...envCandidate("SMOLCODER_LSP_LUA"), ["lua-language-server"]],
        installHint: "Install lua-language-server from https://github.com/LuaLS/lua-language-server",
      };
    case "swift":
      return {
        lang,
        languageId: "swift",
        exts: [".swift"],
        candidates: [...envCandidate("SMOLCODER_LSP_SWIFT"), ["sourcekit-lsp"]],
        installHint: "Install sourcekit-lsp (included with Xcode on macOS, or https://github.com/apple/sourcekit-lsp)",
      };
    case "dart":
      return {
        lang,
        languageId: "dart",
        exts: [".dart"],
        candidates: [...envCandidate("SMOLCODER_LSP_DART"), ["dart", "language-server"]],
        installHint: "Install Dart SDK (includes dart language-server) from https://dart.dev/get-dart",
      };
    case "html":
      return {
        lang,
        languageId: "html",
        exts: [".html", ".htm", ".xhtml"],
        candidates: [...envCandidate("SMOLCODER_LSP_HTML"), ["vscode-html-language-server", "--stdio"]],
        installHint: "Install vscode-langservers-extracted (npm i -g vscode-langservers-extracted)",
      };
    case "css":
      return {
        lang,
        languageId: "css",
        exts: [".css"],
        candidates: [...envCandidate("SMOLCODER_LSP_CSS"), ["vscode-css-language-server", "--stdio"]],
        installHint: "Install vscode-langservers-extracted (npm i -g vscode-langservers-extracted)",
      };
    case "scss":
      return {
        lang,
        languageId: "scss",
        exts: [".scss", ".sass"],
        candidates: [...envCandidate("SMOLCODER_LSP_SCSS"), ["vscode-css-language-server", "--stdio"]],
        installHint: "Install vscode-langservers-extracted (npm i -g vscode-langservers-extracted)",
      };
    case "less":
      return {
        lang,
        languageId: "less",
        exts: [".less"],
        candidates: [...envCandidate("SMOLCODER_LSP_LESS"), ["vscode-css-language-server", "--stdio"]],
        installHint: "Install vscode-langservers-extracted (npm i -g vscode-langservers-extracted)",
      };
    case "json":
      return {
        lang,
        languageId: "json",
        exts: [".json", ".jsonc"],
        candidates: [...envCandidate("SMOLCODER_LSP_JSON"), ["vscode-json-language-server", "--stdio"]],
        installHint: "Install vscode-langservers-extracted (npm i -g vscode-langservers-extracted)",
      };
    case "yaml":
      return {
        lang,
        languageId: "yaml",
        exts: [".yaml", ".yml"],
        candidates: [...envCandidate("SMOLCODER_LSP_YAML"), ["yaml-language-server", "--stdio"]],
        installHint: "Install yaml-language-server (npm i -g yaml-language-server)",
      };
    case "toml":
      return {
        lang,
        languageId: "toml",
        exts: [".toml"],
        candidates: [...envCandidate("SMOLCODER_LSP_TOML"), ["taplo", "lsp", "stdio"]],
        installHint: "Install taplo (cargo install taplo-cli --features lsp)",
      };
    case "markdown":
      return {
        lang,
        languageId: "markdown",
        exts: [".md", ".markdown", ".mdx"],
        candidates: [...envCandidate("SMOLCODER_LSP_MARKDOWN"), ["vscode-markdown-language-server", "--stdio"]],
        installHint: "Install vscode-langservers-extracted (npm i -g vscode-langservers-extracted)",
      };
    case "rst":
      return {
        lang,
        languageId: "restructuredtext",
        exts: [".rst", ".rest"],
        candidates: [...envCandidate("SMOLCODER_LSP_RST"), ["rst-language-server"]],
        installHint: "Install rst-language-server (pip install rst-language-server)",
      };
    case "bash":
      return {
        lang,
        languageId: "shell",
        exts: [".sh", ".bash", ".bashrc", ".bash_profile", ".profile"],
        candidates: [...envCandidate("SMOLCODER_LSP_BASH"), ["bash-language-server", "stdio"]],
        installHint: "Install bash-language-server (npm i -g bash-language-server)",
      };
    case "powershell":
      return {
        lang,
        languageId: "powershell",
        exts: [".ps1", ".psm1", ".psd1"],
        candidates: [...envCandidate("SMOLCODER_LSP_POWERSHELL"), ["powershell-editor-services"]],
        installHint: "Install PowerShell Editor Services (built into PowerShell 7+)",
      };
    case "fish":
      return {
        lang,
        languageId: "fish",
        exts: [".fish"],
        candidates: [...envCandidate("SMOLCODER_LSP_FISH"), ["fish-lsp"]],
        installHint: "Install fish-lsp from https://github.com/ndonfris/fish-lsp",
      };
    case "dockerfile":
      return {
        lang,
        languageId: "dockerfile",
        exts: ["Dockerfile", ".dockerfile"],
        candidates: [...envCandidate("SMOLCODER_LSP_DOCKERFILE"), ["dockerfile-language-server-nodejs", "--stdio"]],
        installHint: "Install dockerfile-language-server-nodejs (npm i -g dockerfile-language-server-nodejs)",
      };
    case "sql":
      return {
        lang,
        languageId: "sql",
        exts: [".sql"],
        candidates: [...envCandidate("SMOLCODER_LSP_SQL"), ["sql-language-server", "up", "--method", "stdio"]],
        installHint: "Install sql-language-server (npm i -g sql-language-server)",
      };
    case "graphql":
      return {
        lang,
        languageId: "graphql",
        exts: [".graphql", ".gql"],
        candidates: [...envCandidate("SMOLCODER_LSP_GRAPHQL"), ["graphql-lsp"]],
        installHint: "Install graphql-lsp (npm i -g graphql-language-service-cli)",
      };
    case "protobuf":
      return {
        lang,
        languageId: "protobuf",
        exts: [".proto"],
        candidates: [...envCandidate("SMOLCODER_LSP_PROTOBUF"), ["protolint", "lsp"]],
        installHint: "Install protolint (go install github.com/yoheimuta/protolint/cmd/protolint@latest)",
      };
    case "haskell":
      return {
        lang,
        languageId: "haskell",
        exts: [".hs", ".lhs"],
        candidates: [...envCandidate("SMOLCODER_LSP_HASKELL"), ["haskell-language-server-wrapper", "--lsp"]],
        installHint: "Install haskell-language-server from https://haskell-language-server.readthedocs.io/",
      };
    case "elixir":
      return {
        lang,
        languageId: "elixir",
        exts: [".ex", ".exs"],
        candidates: [...envCandidate("SMOLCODER_LSP_ELIXIR"), ["elixir-ls"]],
        installHint: "Install elixir-ls from https://github.com/elixir-lsp/elixir-ls",
      };
    default:
      return null;
  }
}

/** Which server owns a file, by extension. Null = unsupported language. */
export function serverForFile(filePath: string): LspServerDef | null {
  const ext = path.extname(String(filePath)).toLowerCase();
  for (const lang of LSP_LANGS) {
    const def = serverDefForLang(lang);
    if (def?.exts.includes(ext)) return def;
  }
  return null;
}

export function supportedLspExts(): string[] {
  const out: string[] = [];
  for (const lang of LSP_LANGS) {
    const def = serverDefForLang(lang);
    if (def) out.push(...def.exts);
  }
  return out;
}

export interface LspAvailability {
  lang: string;
  ok: boolean;
  hint: string;
}

/** Instant honesty check: resolve each executable, never spawn. */
export function lspAvailability(): LspAvailability[] {
  return LSP_LANGS.map((lang) => {
    const def = serverDefForLang(lang)!;
    for (const [exe] of def.candidates) {
      // findCommand, NOT resolveCommand: resolveCommand echoes its input back
      // when the binary is missing, so using it here would report every
      // language as installed and the panel would lie to the user.
      if (findCommand(exe)) return { lang, ok: true, hint: def.installHint };
    }
    return { lang, ok: false, hint: def.installHint };
  });
}

// ---------------------------------------------------------------------------
// Protocol helpers
// ---------------------------------------------------------------------------

export function lspUri(abs: string): string {
  return `file:///${abs.replace(/\\/g, "/").replace(/^\//, "")}`;
}

export function lspRootUri(root: string): string {
  return `file:///${root.replace(/\\/g, "/").replace(/^\//, "")}`;
}

/**
 * JavaScript files must be opened as "javascript", never "typescript": the
 * TypeScript server would otherwise type-check plain .js against the strict
 * tsconfig and report bogus implicit-any / redeclare errors on legacy files.
 */
export function docLanguageId(def: LspServerDef, abs: string): string {
  if (def.lang === "typescript") {
    return /\.(?:js|jsx|mjs|cjs)$/i.test(abs) ? "javascript" : "typescript";
  }
  return def.languageId;
}

/** Loose URI compare: servers normalize drive case and escapes. */
export function normLspUri(u: string): string {
  try {
    u = decodeURIComponent(u);
  } catch {
    /* keep raw */
  }
  return u.replace(/\\/g, "/").toLowerCase();
}

const LSP_TIMEOUT_MS = 30_000;
const RESULT_CAP = 4000;

interface RpcPending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** One persistent server connection. Diagnostics are kept per document URI
 * so a single process can serve every file of its language. */
export class RpcClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, RpcPending>();
  private buf = Buffer.alloc(0);
  private diagByUri = new Map<string, any[]>();
  private dead: Error | null = null;
  private watched: string;

  constructor(
    private workspace: string,
    watchUri: string
  ) {
    this.watched = watchUri;
  }

  get watchedUri(): string {
    return this.watched;
  }

  watch(uri: string): void {
    this.watched = uri;
  }

  async start(cmd: string[]): Promise<void> {
    const [rawExe, ...rest] = cmd;
    const exe = resolveCommand(rawExe);
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(exe);
    await new Promise<void>((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = useShell
          ? spawn(`"${exe.replace(/"/g, "")}" ${rest.map((s) => `"${s.replace(/"/g, "")}"`).join(" ")}`, {
              cwd: this.workspace,
              stdio: ["pipe", "pipe", "ignore"],
              windowsHide: true,
              shell: true,
            })
          : spawn(exe, rest, { cwd: this.workspace, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      } catch (err: any) {
        reject(new Error(`could not start language server (${exe}): ${err?.message ?? err}`));
        return;
      }
      this.proc = proc;
      proc.stdout?.on("data", (d: Buffer) => this.ingest(d));
      proc.on("error", (err) => this.failAll(new Error(`language server failed to start: ${err.message}`)));
      proc.on("close", (code) => this.failAll(new Error(`language server exited (code ${code})`)));
      this.request("initialize", {
        processId: process.pid,
        rootUri: lspRootUri(this.workspace),
        capabilities: { textDocument: { publishDiagnostics: { relatedInformation: true, versionSupport: true } } },
      })
        .then(() => {
          this.notify("initialized", {});
          resolve();
        })
        .catch(reject);
    });
  }

  private failAll(err: Error): void {
    if (this.dead) return;
    this.dead = err;
    this.pending.forEach((p) => {
      clearTimeout(p.timer);
      p.reject(err);
    });
    this.pending.clear();
  }

  private ingest(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > 8_000_000) {
      this.failAll(new Error("language server sent too much data"));
      return;
    }
    for (;;) {
      const headEnd = this.buf.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      const head = this.buf.slice(0, headEnd).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(head);
      if (!m) {
        this.buf = this.buf.slice(headEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      if (this.buf.length < headEnd + 4 + len) return;
      const body = this.buf.slice(headEnd + 4, headEnd + 4 + len).toString("utf8");
      this.buf = this.buf.slice(headEnd + 4 + len);
      let msg: any;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      if (msg?.method === "textDocument/publishDiagnostics" && typeof msg?.params?.uri === "string") {
        this.diagByUri.set(normLspUri(msg.params.uri), msg.params.diagnostics ?? []);
        continue;
      }
      if (msg?.id !== undefined && this.pending.has(Number(msg.id))) {
        const p = this.pending.get(Number(msg.id))!;
        this.pending.delete(Number(msg.id));
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(String(msg.error?.message ?? "LSP error")));
        else p.resolve(msg.result);
      }
    }
  }

  notify(method: string, params: any): void {
    try {
      this.proc?.stdin?.write(encodeLsp(JSON.stringify({ jsonrpc: "2.0", method, params })));
    } catch {
      /* best effort */
    }
  }

  request(method: string, params: any, timeoutMs = LSP_TIMEOUT_MS): Promise<any> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`language server timed out on ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc?.stdin?.write(encodeLsp(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
      } catch (err: any) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`could not write to language server: ${err?.message ?? err}`));
      }
    });
  }

  takeDiag(uri: string): any[] {
    const key = normLspUri(uri);
    const out = this.diagByUri.get(key) ?? [];
    this.diagByUri.delete(key);
    return out;
  }

  get alive(): boolean {
    return this.proc !== null && this.dead === null;
  }

  close(): void {
    try {
      this.notify("shutdown", undefined);
      this.proc?.stdin?.end();
    } catch {
      /* ignore */
    }
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function fmtLoc(root: string, uri: string, range: any): string {
  try {
    const p = decodeURIComponent(new URL(uri).pathname);
    const rel = path.relative(root, p).split(path.sep).join("/");
    const line = (range?.start?.line ?? 0) + 1;
    return `${rel}:${line}`;
  } catch {
    return String(uri).slice(0, 120);
  }
}

function fmtLocList(root: string, res: any): string {
  const arr = Array.isArray(res) ? res : res ? [res] : [];
  const locs = arr
    .map((l) => {
      const inner = l?.location ?? l;
      const uri = inner?.uri ?? l?.targetUri ?? "";
      const range = inner?.range ?? l?.targetSelectionRange ?? l?.targetRange;
      return uri ? fmtLoc(root, uri, range) : "";
    })
    .filter(Boolean)
    .slice(0, 20);
  return locs.length ? locs.join("\n") : "Aucun résultat à cette position.";
}

function fmtHoverText(res: any): string {
  if (!res) return "Aucune info de survol à cette position.";
  const c = res.contents;
  const text =
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.map((x) => (typeof x === "string" ? x : (x?.value ?? ""))).join("\n")
        : (c?.value ?? "");
  const clean = String(text).trim().slice(0, RESULT_CAP);
  return clean || "Aucune info de survol à cette position.";
}

function fmtDiagList(root: string, uri: string, diags: any[]): string {
  if (!diags.length) return "Aucun diagnostic — le fichier est syntaxiquement propre.";
  return diags
    .slice(0, 20)
    .map((d) => {
      const sev = d?.severity === 1 ? "error" : d?.severity === 2 ? "warning" : "info";
      return `${fmtLoc(root, uri, d?.range)} [${sev}] ${String(d?.message ?? "")
        .split("\n")[0]
        .slice(0, 200)}`;
    })
    .join("\n");
}

const COMPLETION_KINDS: Record<number, string> = {
  1: "text",
  2: "method",
  3: "function",
  4: "constructor",
  5: "field",
  6: "variable",
  7: "class",
  8: "interface",
  9: "module",
  10: "property",
  11: "unit",
  12: "value",
  13: "enum",
  14: "keyword",
  15: "snippet",
  16: "color",
  17: "file",
  18: "reference",
  19: "folder",
  20: "enum-member",
  21: "constant",
  22: "struct",
  23: "event",
  24: "operator",
  25: "type-param",
};

function fmtCompletion(res: any): string {
  const items = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
  if (!items.length) return "Aucune complétion à cette position.";
  return items
    .slice(0, 30)
    .map((it: any) => {
      const label = String(it?.label ?? "?").slice(0, 80);
      const kind = COMPLETION_KINDS[Number(it?.kind)] ?? "";
      const detail = String(it?.detail ?? it?.documentation ?? "")
        .split("\n")[0]
        .slice(0, 80);
      return `- ${label}${kind ? ` (${kind})` : ""}${detail ? ` — ${detail}` : ""}`;
    })
    .join("\n");
}

function fmtSignature(res: any): string {
  const sigs = Array.isArray(res?.signatures) ? res.signatures : [];
  if (!sigs.length) return "Aucune aide de signature à cette position.";
  const active = typeof res?.activeSignature === "number" ? res.activeSignature : 0;
  return sigs
    .slice(0, 5)
    .map((s: any, i: number) => {
      const label = String(s?.label ?? "").slice(0, 300);
      const doc = typeof s?.documentation === "string" ? s.documentation : String(s?.documentation?.value ?? "").split("\n")[0];
      return `${i === active ? "▶ " : "  "}${label}${doc ? `\n  ${doc.slice(0, 200)}` : ""}`;
    })
    .join("\n");
}

function uriToAbs(root: string, uri: string): string | null {
  try {
    const p = decodeURIComponent(new URL(uri).pathname);
    // file:///C:/... or file:///home/... — strip the leading slash on Windows.
    const noLead = process.platform === "win32" && /^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p;
    const abs = path.resolve(root, path.relative(root, noLead));
    return abs;
  } catch {
    return null;
  }
}

/** Render a WorkspaceEdit as reviewable file:line replacements with the
 * current line shown, so the model can verify before applying anything. */
function fmtWorkspaceEdit(root: string, edit: any): string {
  type One = { uri: string; line: number; oldLine: string; newText: string };
  const ones: One[] = [];
  const push = (uri: string, e: any) => {
    if (!uri || !e?.range) return;
    const abs = uriToAbs(root, uri);
    let oldLine = "";
    if (abs) {
      try {
        const lines = fs.readFileSync(abs, "utf8").split("\n");
        oldLine = (lines[e.range.start.line] ?? "").trim().slice(0, 120);
      } catch {
        /* unreadable — show the edit anyway */
      }
    }
    let rel = uri;
    try {
      rel = path
        .relative(root, decodeURIComponent(new URL(uri).pathname))
        .split(path.sep)
        .join("/");
    } catch {
      /* keep raw uri */
    }
    ones.push({
      uri: rel,
      line: (e.range.start.line ?? 0) + 1,
      oldLine,
      newText: String(e.newText ?? "")
        .split("\n")[0]
        .slice(0, 120),
    });
  };
  if (edit && typeof edit === "object") {
    if (Array.isArray(edit.documentChanges)) {
      for (const dc of edit.documentChanges) {
        const uri = dc?.textDocument?.uri ?? "";
        for (const e of dc?.edits ?? []) push(uri, e);
      }
    } else if (edit.changes && typeof edit.changes === "object") {
      for (const [uri, arr] of Object.entries<any>(edit.changes)) {
        for (const e of Array.isArray(arr) ? arr : []) push(uri, e);
      }
    }
  }
  if (!ones.length) return "Le serveur n'a proposé aucune modification.";
  return ones
    .slice(0, 20)
    .map((o) => `${o.uri}:${o.line}: "${o.oldLine}" → "${o.newText}"`)
    .join("\n");
}

function fmtCodeActions(res: any): string {
  const arr = Array.isArray(res) ? res : [];
  if (!arr.length) return "Aucune correction rapide proposée à cette position.";
  return arr
    .slice(0, 15)
    .map((a: any) => `- ${String(a?.title ?? "untitled").slice(0, 120)}${a?.kind ? ` (${a.kind})` : ""}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Persistent manager
// ---------------------------------------------------------------------------

export const CODE_ACTIONS = ["hover", "def", "refs", "diag", "rename", "completion", "signature", "wsymbol", "quickfix", "setup"];

export interface CodeQuery {
  action?: unknown;
  path?: unknown;
  line?: unknown;
  col?: unknown;
  new_text?: unknown;
  query?: unknown;
  lang?: unknown;
}

interface LiveServer {
  def: LspServerDef;
  client: RpcClient;
  lastUsed: number;
}

interface OpenDoc {
  version: number;
  languageId: string;
}

const IDLE_MS = 5 * 60 * 1000;
const MAX_FILE_BYTES = 1024 * 1024;

function num1(v: unknown): number {
  return Math.max(1, Number(v) || 1) - 1;
}

export class LspManager {
  private servers = new Map<string, LiveServer>();
  private starting = new Map<string, Promise<LiveServer>>();
  private docs = new Map<string, OpenDoc>();

  constructor(private root: string) {}

  serverCount(): number {
    return this.servers.size;
  }

  openDocCount(): number {
    return this.docs.size;
  }

  private sweepIdle(): void {
    const now = Date.now();
    const idle: string[] = [];
    this.servers.forEach((live, lang) => {
      if (now - live.lastUsed > IDLE_MS) idle.push(lang);
    });
    for (const lang of idle) {
      const live = this.servers.get(lang);
      this.servers.delete(lang);
      if (!live) continue;
      try {
        live.client.close();
      } catch {
        /* ignore */
      }
    }
  }

  private async ensureServer(def: LspServerDef, signal?: AbortSignal): Promise<LiveServer> {
    this.sweepIdle();
    const live = this.servers.get(def.lang);
    if (live?.client.alive) {
      live.lastUsed = Date.now();
      return live;
    }
    if (live) this.servers.delete(def.lang);
    const ongoing = this.starting.get(def.lang);
    if (ongoing) return ongoing;
    const p = this.startServer(def, signal);
    this.starting.set(def.lang, p);
    try {
      const s = await p;
      this.servers.set(def.lang, s);
      return s;
    } finally {
      this.starting.delete(def.lang);
    }
  }

  private async startServer(def: LspServerDef, signal?: AbortSignal): Promise<LiveServer> {
    if (signal?.aborted) throw new Error("cancelled before starting");
    let lastErr = "no candidate command";
    for (const cmd of def.candidates) {
      if (!cmd.length) continue;
      try {
        resolveCommand(cmd[0]);
      } catch {
        lastErr = `command not found: ${cmd[0]}`;
        continue;
      }
      const client = new RpcClient(this.root, "");
      try {
        await client.start(cmd);
        return { def, client, lastUsed: Date.now() };
      } catch (err: any) {
        try {
          client.close();
        } catch {
          /* ignore */
        }
        lastErr = String(err?.message ?? err).slice(0, 160);
      }
      if (signal?.aborted) throw new Error("cancelled while starting");
    }
    throw new Error(lastErr);
  }

  private async ensureDoc(live: LiveServer, abs: string, uri: string, def: LspServerDef, signal?: AbortSignal): Promise<void> {
    const text = fs.readFileSync(abs, "utf8");
    const known = this.docs.get(uri);
    live.client.watch(uri);
    if (!known) {
      const languageId = docLanguageId(def, abs);
      live.client.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
      this.docs.set(uri, { version: 1, languageId });
    } else {
      const version = known.version + 1;
      live.client.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
      known.version = version;
    }
    // python servers only publish diagnostics after a change, never on open.
    live.client.notify("textDocument/didChange", {
      textDocument: { uri, version: (this.docs.get(uri)?.version ?? 1) + 1 },
      contentChanges: [{ text }],
    });
    const doc = this.docs.get(uri);
    if (doc) doc.version += 1;
    if (signal?.aborted) throw new Error("cancelled after opening");
  }

  /** One symbol question. Never throws: failures are coaching strings. */
  async query(raw: CodeQuery, signal?: AbortSignal): Promise<string> {
    if (lspDisabled()) {
      return "Error: symbols est désactivé (SMOLCODER_LSP_DISABLE=1). Retirez cette variable pour réactiver l'intelligence de code.";
    }
    const action = String(raw.action ?? "");
    if (action === "wsymbol") {
      return this.workspaceSymbol(String(raw.query ?? ""), String(raw.lang ?? "typescript"), signal);
    }
    if (!CODE_ACTIONS.includes(action)) {
      return `Error: l'action doit être l'une de ${CODE_ACTIONS.map((a) => `"${a}"`).join(", ")}. Exemple : {"action": "hover", "path": "src/agent.ts", "line": 10, "col": 15}`;
    }
    const rel = typeof raw.path === "string" ? raw.path : "";
    if (!rel)
      return `Error: le chemin est requis. Exemple : {"action": "${action}", "path": "src/agent.ts"${action === "diag" ? "" : ', "line": 10, "col": 15'}}`;
    let abs: string;
    try {
      abs = resolveInWorkspace(this.root, rel);
    } catch (err: any) {
      return `Error: ${err?.message ?? err}`;
    }
    const def = serverForFile(abs);
    if (!def) {
      return `Error: "${rel}" n'est pas un langage pris en charge — l'intelligence de code fonctionne sur ${supportedLspExts().join(", ")}.`;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return `Error: le fichier "${rel}" n'existe pas.`;
    }
    if (!stat.isFile()) return `Error: "${rel}" est un dossier, pas un fichier.`;
    if (stat.size > MAX_FILE_BYTES) return `Error: "${rel}" est trop volumineux pour les requêtes de symboles (limite 1 Mo).`;
    if (signal?.aborted) return "Error: requête symbols annulée avant le démarrage.";
    if (action === "rename") {
      const newName = typeof raw.new_text === "string" ? raw.new_text.trim() : "";
      if (!newName || /[\s,;]/.test(newName)) {
        return 'Error: rename a besoin de new_text avec le nouveau nom. Exemple : {"action": "rename", "path": "src/a.ts", "line": 3, "col": 5, "new_text": "total"}';
      }
    }

    let live: LiveServer;
    try {
      live = await this.ensureServer(def, signal);
    } catch (err: any) {
      return `Error: le serveur de langage ${def.lang} est indisponible (${String(err?.message ?? err).slice(0, 160)}). ${def.installHint}`;
    }
    const uri = lspUri(abs);
    try {
      await this.ensureDoc(live, abs, uri, def, signal);
    } catch (err: any) {
      return `Error: impossible d'ouvrir "${rel}" sur le serveur de langage (${String(err?.message ?? err).slice(0, 160)}).`;
    }
    if (signal?.aborted) return "Error: requête symbols annulée.";
    const pos = { line: num1(raw.line), character: num1(raw.col) };
    const docId = { uri };
    try {
      switch (action) {
        case "hover":
          return fmtHoverText(await live.client.request("textDocument/hover", { textDocument: docId, position: pos }));
        case "def":
          return fmtLocList(this.root, await live.client.request("textDocument/definition", { textDocument: docId, position: pos }));
        case "refs":
          return fmtLocList(
            this.root,
            await live.client.request("textDocument/references", {
              textDocument: docId,
              position: pos,
              context: { includeDeclaration: true },
            })
          );
        case "diag": {
          let diags: any[];
          try {
            diags = await this.fetchDiagnostics(live, uri, signal);
          } catch {
            return "Error: requête symbols annulée.";
          }
          return fmtDiagList(this.root, uri, diags);
        }
        case "rename": {
          const newName = String(raw.new_text).trim();
          const edit = await live.client.request("textDocument/rename", { textDocument: docId, position: pos, newName });
          return fmtWorkspaceEdit(this.root, edit);
        }
        case "completion":
          return fmtCompletion(await live.client.request("textDocument/completion", { textDocument: docId, position: pos }));
        case "signature":
          return fmtSignature(
            await live.client.request("textDocument/signatureHelp", {
              textDocument: docId,
              position: pos,
              context: { triggerKind: 1 },
            })
          );
        case "quickfix": {
          const range = { start: pos, end: pos };
          return fmtCodeActions(
            await live.client.request("textDocument/codeAction", { textDocument: docId, range, context: { diagnostics: [] } })
          );
        }
        default:
          return `Error: l'action doit être l'une de ${CODE_ACTIONS.map((a) => `"${a}"`).join(", ")}.`;
      }
    } catch (err: any) {
      if (signal?.aborted || (err as any)?.name === "AbortError") return "Error: requête symbols annulée.";
      return `Error: la requête symbols a échoué (${String(err?.message ?? err).slice(0, 200)}).`;
    }
  }

  /** Wait for the server's async diagnostics for one open document.
   * Throws Error("cancelled") when the signal aborts. */
  private async fetchDiagnostics(live: LiveServer, uri: string, signal?: AbortSignal): Promise<any[]> {
    try {
      await live.client.request("textDocument/hover", {
        textDocument: { uri },
        position: { line: 0, character: 0 },
      });
    } catch {
      return live.client.takeDiag(uri);
    }
    const deadline = Date.now() + 8000;
    let diags = live.client.takeDiag(uri);
    while (!diags.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      if (signal?.aborted) throw new Error("cancelled");
      diags = [...diags, ...live.client.takeDiag(uri)];
    }
    return diags;
  }

  /** Structured diagnostics for IDE panels: rows carry file/line/severity
   * for click-to-jump, plus the human-readable text. Never throws. */
  async diagStructured(rel: string, signal?: AbortSignal): Promise<{ text: string; diagnostics: StructuredDiag[] }> {
    const none = (text: string): { text: string; diagnostics: StructuredDiag[] } => ({ text, diagnostics: [] });
    if (lspDisabled()) return none("Error: symbols est désactivé (SMOLCODER_LSP_DISABLE=1).");
    if (typeof rel !== "string" || !rel) {
      return none('Error: le chemin est requis. Exemple : {"action": "diag", "path": "src/agent.ts"}');
    }
    let abs: string;
    try {
      abs = resolveInWorkspace(this.root, rel);
    } catch (err: any) {
      return none(`Error: ${err?.message ?? err}`);
    }
    const def = serverForFile(abs);
    if (!def) {
      return none(
        `Error: "${rel}" n'est pas un langage pris en charge — l'intelligence de code fonctionne sur ${supportedLspExts().join(", ")}.`
      );
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return none(`Error: le fichier "${rel}" n'existe pas.`);
    }
    if (!stat.isFile()) return none(`Error: "${rel}" est un dossier, pas un fichier.`);
    if (stat.size > MAX_FILE_BYTES) return none(`Error: "${rel}" est trop volumineux pour les requêtes de symboles (limite 1 Mo).`);
    if (signal?.aborted) return none("Error: requête symbols annulée avant le démarrage.");
    let live: LiveServer;
    try {
      live = await this.ensureServer(def, signal);
    } catch (err: any) {
      return none(
        `Error: le serveur de langage ${def.lang} est indisponible (${String(err?.message ?? err).slice(0, 160)}). ${def.installHint}`
      );
    }
    const uri = lspUri(abs);
    try {
      await this.ensureDoc(live, abs, uri, def, signal);
    } catch (err: any) {
      return none(`Error: impossible d'ouvrir "${rel}" sur le serveur de langage (${String(err?.message ?? err).slice(0, 160)}).`);
    }
    let diags: any[];
    try {
      diags = await this.fetchDiagnostics(live, uri, signal);
    } catch {
      return none("Error: requête symbols annulée.");
    }
    const relNorm = path.relative(this.root, abs).split(path.sep).join("/");
    const diagnostics: StructuredDiag[] = diags.slice(0, 50).map((d: any) => ({
      path: relNorm,
      line: (d?.range?.start?.line ?? 0) + 1,
      col: (d?.range?.start?.character ?? 0) + 1,
      severity: d?.severity === 1 ? "error" : d?.severity === 2 ? "warning" : "info",
      message: String(d?.message ?? "")
        .split("\n")[0]
        .slice(0, 300),
    }));
    return { text: fmtDiagList(this.root, uri, diags), diagnostics };
  }

  private async workspaceSymbol(query: string, lang: string, signal?: AbortSignal): Promise<string> {
    const q = query.trim().slice(0, 100);
    if (!q) return 'Error: wsymbol a besoin d\'une requête. Exemple : {"action": "wsymbol", "query": "Agent", "lang": "typescript"}';
    const def = serverDefForLang(lang) ?? serverDefForLang("typescript")!;
    let live: LiveServer;
    try {
      live = await this.ensureServer(def, signal);
    } catch (err: any) {
      return `Error: le serveur de langage ${def.lang} est indisponible (${String(err?.message ?? err).slice(0, 160)}). ${def.installHint}`;
    }
    if (signal?.aborted) return "Error: requête symbols annulée.";
    try {
      const res = await live.client.request("workspace/symbol", { query: q });
      const arr = Array.isArray(res) ? res : [];
      if (!arr.length) return `Aucun symbole d'espace de travail correspondant à "${q}".`;
      return arr
        .slice(0, 20)
        .map((s: any) => {
          const inner = s?.location ?? s;
          const name = String(s?.name ?? "?").slice(0, 80);
          const kind = String(s?.kind ?? "");
          return `${name}${kind ? ` [${kind}]` : ""} @ ${fmtLoc(this.root, inner?.uri ?? "", inner?.range)}`;
        })
        .join("\n");
    } catch (err: any) {
      return `Error: la recherche de symboles d'espace de travail a échoué (${String(err?.message ?? err).slice(0, 200)}).`;
    }
  }

  shutdown(): void {
    this.servers.forEach((live) => {
      try {
        live.client.close();
      } catch {
        /* ignore */
      }
    });
    this.servers.clear();
    this.docs.clear();
    this.starting.clear();
  }
}

// ---------------------------------------------------------------------------
// Entry point used by the symbols tool
// ---------------------------------------------------------------------------

const managers = new Map<string, LspManager>();

export function managerFor(root: string): LspManager {
  let m = managers.get(root);
  if (!m) {
    m = new LspManager(root);
    managers.set(root, m);
  }
  return m;
}

/** Test/exit hook: close every cached server. */
export function closeLspManagers(): void {
  managers.forEach((m) => {
    try {
      m.shutdown();
    } catch {
      /* ignore */
    }
  });
  managers.clear();
}

if (typeof process !== "undefined" && typeof process.on === "function") {
  try {
    process.on("exit", () => closeLspManagers());
  } catch {
    /* non-node host */
  }
}

const LEGACY_TS_ACTIONS = new Set(["hover", "def", "refs", "diag"]);

/** Answer one code-intelligence question in any supported language. Legacy
 * TypeScript hover/def/refs/diag go through the original one-shot client so
 * its messages stay byte-identical; everything else uses the persistent
 * manager. Never throws. */
export async function queryCode(root: string, args: CodeQuery, signal?: AbortSignal): Promise<string> {
  const action = String((args as any)?.action ?? "");
  if (!CODE_ACTIONS.includes(action)) {
    return `Error: l'action doit être l'une de ${CODE_ACTIONS.map((a) => `"${a}"`).join(", ")}. Exemple : {"action": "hover", "path": "src/agent.ts", "line": 10, "col": 15}`;
  }
  if (action === "setup") {
    return "Error: setup installe des logiciels — utilisez l'outil symbols en mode édition, ou lancez /doctor install dans n'importe quelle session.";
  }
  const rel = typeof (args as any)?.path === "string" ? (args as any).path : "";
  if (!rel && action !== "wsymbol") {
    return `Error: le chemin est requis. Exemple : {"action": "${action}", "path": "src/agent.ts"${action === "diag" ? "" : ', "line": 10, "col": 15'}}`;
  }
  let lang: string | null = null;
  if (rel) {
    try {
      lang = serverForFile(resolveInWorkspace(root, rel))?.lang ?? (isTsLike(rel) ? "typescript" : null);
    } catch {
      lang = null;
    }
  } else if (typeof (args as any)?.lang === "string") {
    lang = (args as any).lang;
  }
  if (lang === "typescript" && LEGACY_TS_ACTIONS.has(action)) {
    return querySymbols(root, args as any, signal);
  }
  return managerFor(root).query(args, signal);
}

export interface StructuredDiag {
  path: string;
  line: number;
  col: number;
  severity: string;
  message: string;
}

/** Structured file diagnostics for IDE panels (web review, desktop).
 * Never throws: failures come back as text with empty rows. */
export async function queryDiagStructured(
  root: string,
  relPath: string,
  signal?: AbortSignal
): Promise<{ text: string; diagnostics: StructuredDiag[] }> {
  return managerFor(root).diagStructured(relPath, signal);
}

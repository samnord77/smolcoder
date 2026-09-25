// Minimal LSP client for real code intelligence (hover, definition,
// references, diagnostics) via typescript-language-server --stdio.
// Zero new dependencies: JSON-RPC with Content-Length framing over stdio.
// One server per call (open, query, close) — slow but stateless and safe.
// Only TypeScript-flavored files; anything else is refused with coaching.
//
// Config (no password anywhere, env only):
//   SMOLCODER_LSP_DISABLE=1 — the symbols tool answers "désactivé", no spawn.
//   SMOLCODER_LSP_COMMAND="npx typescript-language-server --stdio" — custom
//   server command (space-separated, no shell).
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { resolveInWorkspace, SandboxError } from "./sandbox";
import { resolveCommand } from "./mcp";

export function lspDisabled(): boolean {
  return process.env.SMOLCODER_LSP_DISABLE === "1";
}

function lspCommand(): string[] {
  const raw = (process.env.SMOLCODER_LSP_COMMAND ?? "").trim();
  if (raw) return raw.split(/\s+/);
  return ["npx", "typescript-language-server", "--stdio"];
}

const LSP_TIMEOUT_MS = 60_000;
const RESULT_CAP = 4000;

const TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

export function isTsLike(filePath: string): boolean {
  return TS_EXTS.has(path.extname(filePath).toLowerCase());
}

/** Exported for tests: encode one LSP message. */
export function encodeLsp(body: string): Buffer {
  const payload = Buffer.from(body, "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8"), payload]);
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

class LspClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = Buffer.alloc(0);
  private diagnostics: any[] = [];
  private dead: Error | null = null;

  constructor(
    private workspace: string,
    private fileUri: string
  ) {}

  async start(): Promise<void> {
    const [rawExe, ...rest] = lspCommand();
    const exe = resolveCommand(rawExe);
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(exe);
    const q = (s: string) => `"${s.replace(/"/g, "")}"`;
    const cmd = useShell ? [q(exe), ...rest.map(q)].join(" ") : exe;
    await new Promise<void>((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = useShell
          ? spawn(cmd, { cwd: this.workspace, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: true })
          : spawn(exe, rest, {
              cwd: this.workspace,
              stdio: ["pipe", "pipe", "ignore"],
              windowsHide: true,
            });
      } catch (err: any) {
        reject(new Error(`could not start typescript-language-server: ${err?.message ?? err}`));
        return;
      }
      this.proc = proc;
      proc.stdout?.on("data", (d: Buffer) => this.ingest(d));
      proc.on("error", (err) => this.failAll(new Error(`language server failed to start: ${err.message}`)));
      proc.on("close", (code) => this.failAll(new Error(`language server exited (code ${code})`)));
      // URIs always use forward slashes: backslashes become a broken UNC path.
      const rootUri = `file:///${this.workspace.replace(/\\/g, "/").replace(/^\//, "")}`;
      this.request("initialize", {
        processId: process.pid,
        rootUri,
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
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
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
      // Servers may normalize the URI (lowercase drive, %3A escapes).
      if (msg?.method === "textDocument/publishDiagnostics" && sameFile(msg?.params?.uri, this.fileUri)) {
        this.diagnostics = msg.params.diagnostics ?? [];
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

  takeDiagnostics(): any[] {
    const out = this.diagnostics;
    this.diagnostics = [];
    return out;
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

function toUri(abs: string): string {
  return `file:///${abs.replace(/\\/g, "/").replace(/^\//, "")}`;
}

/** Compare document URIs loosely: servers normalize case and escapes. */
function sameFile(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const norm = (u: string): string => {
    try {
      u = decodeURIComponent(u);
    } catch {
      /* keep raw */
    }
    return u.replace(/\\/g, "/").toLowerCase();
  };
  return norm(a) === norm(b);
}

function fmtLoc(root: string, uri: string, range: any): string {
  try {
    const p = decodeURIComponent(new URL(uri).pathname);
    const rel = path.relative(root, p).split(path.sep).join("/");
    const line = (range?.start?.line ?? 0) + 1;
    return `${rel}:${line}`;
  } catch {
    return uri.slice(0, 120);
  }
}

function fmtHover(res: any): string {
  if (!res) return "No hover info at that position.";
  const c = res.contents;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : x?.value ?? "")).join("\n") : c?.value ?? "";
  const clean = String(text).trim().slice(0, RESULT_CAP);
  return clean || "No hover info at that position.";
}

function fmtLocList(root: string, res: any): string {
  const arr = Array.isArray(res) ? res : res ? [res] : [];
  const locs = arr
    .map((l) => {
      const uri = l?.uri ?? l?.targetUri ?? "";
      const range = l?.range ?? l?.targetSelectionRange ?? l?.targetRange;
      return uri ? fmtLoc(root, uri, range) : "";
    })
    .filter(Boolean)
    .slice(0, 20);
  return locs.length ? locs.join("\n") : "No result at that position.";
}

function fmtDiagnostics(root: string, uri: string, diags: any[]): string {
  if (!diags.length) return "No diagnostics — the file parses clean.";
  return diags
    .slice(0, 20)
    .map((d) => {
      const line = (d?.range?.start?.line ?? 0) + 1;
      const sev = d?.severity === 1 ? "error" : d?.severity === 2 ? "warning" : "info";
      return `${fmtLoc(root, uri, d?.range)} [${sev}] ${String(d?.message ?? "").split("\n")[0].slice(0, 200)}`;
    })
    .join("\n");
}

export type SymbolAction = "hover" | "def" | "refs" | "diag";

/** Answer one symbol question about a workspace file. Never throws: every
 * failure is a coaching error string. Line/col are 1-based. */
export async function querySymbols(
  root: string,
  args: { action?: unknown; path?: unknown; line?: unknown; col?: unknown },
  signal?: AbortSignal
): Promise<string> {
  if (lspDisabled()) {
    return "Error: symbols is désactivé (SMOLCODER_LSP_DISABLE=1). Unset it to re-enable hover/def/refs/diag.";
  }
  const action = String(args.action ?? "");
  if (!["hover", "def", "refs", "diag"].includes(action)) {
    return 'Error: action must be one of "hover", "def", "refs", "diag". Example: {"action": "hover", "path": "src/agent.ts", "line": 10, "col": 15}';
  }
  const rel = typeof args.path === "string" ? args.path : "";
  let abs: string;
  try {
    abs = resolveInWorkspace(root, rel || ".");
  } catch (err: any) {
    return `Error: ${err?.message ?? err}`;
  }
  if (!isTsLike(abs)) {
    return `Error: "${rel}" is not a TypeScript/JavaScript file — symbols work on .ts, .tsx, .js, .jsx, .mjs, .cjs.`;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return `Error: file "${rel}" does not exist.`;
  }
  if (!stat.isFile()) return `Error: "${rel}" is a folder, not a file.`;
  if (stat.size > 1024 * 1024) return `Error: "${rel}" is too large for symbol queries (1 MB limit).`;
  if (signal?.aborted) return "Error: symbols query cancelled before starting.";

  const client = new LspClient(root, toUri(abs));
  try {
    await client.start();
  } catch (err: any) {
    client.close();
    return `Error: language server unavailable (${String(err?.message ?? err).slice(0, 160)}). Install once with: npx -y typescript-language-server --version`;
  }
  try {
    const text = fs.readFileSync(abs, "utf8");
    const doc = { uri: toUri(abs), languageId: "typescript", version: 1, text };
    client.notify("textDocument/didOpen", { textDocument: doc });
    // This server version only publishes diagnostics after a change, never
    // on open — re-send the same text as version 2 to trigger them.
    client.notify("textDocument/didChange", {
      textDocument: { uri: doc.uri, version: 2 },
      contentChanges: [{ text }],
    });
    if (action === "diag") {
      // Fail fast when the server is dead, then wait for its async
      // diagnostics until the deadline (a clean file just stays silent).
      try {
        await client.request("textDocument/hover", {
          textDocument: { uri: toUri(abs) },
          position: { line: 0, character: 0 },
        });
      } catch {
        return fmtDiagnostics(root, toUri(abs), client.takeDiagnostics());
      }
      const deadline = Date.now() + 8000;
      let diags: any[] = [...client.takeDiagnostics()];
      while (!diags.length && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
        if (signal?.aborted) return "Error: symbols query cancelled.";
        diags = [...diags, ...client.takeDiagnostics()];
      }
      return fmtDiagnostics(root, toUri(abs), diags);
    }
    const line = Math.max(1, Number(args.line) || 1) - 1;
    const col = Math.max(1, Number(args.col) || 1) - 1;
    const params = { textDocument: { uri: toUri(abs) }, position: { line, character: col } };
    if (signal?.aborted) return "Error: symbols query cancelled.";
    if (action === "hover") return fmtHover(await client.request("textDocument/hover", params));
    if (action === "def") return fmtLocList(root, await client.request("textDocument/definition", params));
    return fmtLocList(root, await client.request("textDocument/references", { ...params, context: { includeDeclaration: true } }));
  } catch (err: any) {
    if (signal?.aborted || (err as any)?.name === "AbortError") return "Error: symbols query cancelled.";
    return `Error: symbols query failed (${String(err?.message ?? err).slice(0, 200)}).`;
  } finally {
    client.close();
  }
}

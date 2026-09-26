// MCP client: use the SAME external servers as any MCP host (filesystem,
// browser, mail, sheets…) from inside smolcoder. Zero new dependencies:
// plain JSON-RPC 2.0 over stdio for local programs, Streamable HTTP for
// remote addresses — wired exactly like the big assistants.
//
// Trust model: servers are listed by YOU in `.smol/mcp.json` (workspace) or
// `~/.smolcoder/mcp.json` (your machine) — nothing is auto-installed. Secrets
// stay in your environment (`"Bearer ${MY_KEY}"`), never in files. Every call
// in edit mode asks first (like outside commands); bypass runs without asking;
// headless -p refuses. Server config example lives in docs/plugins.md.
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { shellEnv } from "./tools/shell";

export interface McpServerConfig {
  name: string;
  /** Local program to launch (stdio). Optional when `url` is set. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Remote Streamable-HTTP address. Optional when `command` is set. */
  url?: string;
  /** Extra request headers (`${VAR}` expands from your environment). */
  headers?: Record<string, string>;
  /** Per-call deadline. Default 60s. */
  timeoutMs?: number;
  /** `false` = ignoré par list/call, affiché "désactivé" par status(). */
  enabled?: boolean;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TOOLS = 50;

/** Folders where Node/npm (and a few common tools) live, tried after PATH so
 * MCP servers keep starting when smolcoder is launched from a shell, an IDE or
 * a shortcut whose PATH is missing Node entirely. */
function fallbackBinDirs(): string[] {
  const out: string[] = [];
  const push = (p: string | undefined) => {
    if (p && p.trim()) out.push(p.trim());
  };
  push(path.dirname(process.execPath)); // node.exe's own folder
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const roaming = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  push(path.join(pf, "nodejs"));
  push(path.join(pf86, "nodejs"));
  push(path.join(local, "Programs", "nodejs"));
  push(path.join(local, "Programs", "node"));
  push(path.join(local, "fnm"));
  push(path.join(roaming, "npm")); // global npm bin (npx.cmd, npm.cmd)
  push(path.join(roaming, "nvm"));
  push(path.join(local, "pnpm"));
  push(path.join(local, "Yarn", "bin"));
  push(path.join(local, "Microsoft", "WindowsApps")); // winget/store shims
  push(path.join(roaming, "Python", "Scripts"));
  push(path.join(local, "Programs", "Python", "Scripts"));
  return out;
}

/** True when `full` is an existing regular file we may try to spawn. */
function isRunnableFile(full: string): boolean {
  try {
    return fs.statSync(full).isFile();
  } catch {
    return false;
  }
}

/** Windows cannot spawn `npx` directly (it is `npx.cmd` on PATH). Resolve
 * extension-less commands against PATH, the caller's PATH separator rules and
 * the usual install folders, in that order. Exported for tests. */
export function resolveCommand(cmd: string): string {
  if (process.platform !== "win32" || /[\\/]/.test(cmd) || /\.[A-Za-z0-9]+$/.test(cmd)) return cmd;
  const fromExt = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^\.[a-z0-9]+$/.test(e));
  // .cmd first: npx/npm/yarn wrappers are .cmd, the tests and real configs rely on it.
  const exts = [".cmd", ".exe", ".bat", ".ps1", ...fromExt].filter((e, i, all) => all.indexOf(e) === i);
  const inheritedPath = process.env.PATH ?? process.env.Path ?? "";
  const dirs = [...inheritedPath.split(path.delimiter), ...fallbackBinDirs()]
    .map((d) => d.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const seen = new Set<string>();
  for (const ext of exts) {
    for (const dir of dirs) {
      const full = path.join(dir, cmd + ext);
      const key = full.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (isRunnableFile(full)) return full;
    }
  }
  return cmd;
}

/** User-scope servers (your machine), merged under the workspace ones.
 * SMOLCODER_MCP_CONFIG points tests at a scratch file. */
export function globalMcpConfigPath(): string {
  return process.env.SMOLCODER_MCP_CONFIG || path.join(os.homedir(), ".smolcoder", "mcp.json");
}

/** Workspace `.smol/mcp.json` wins on name clash; merged list capped at 40. */
export function loadMcpConfig(workspace: string): McpServerConfig[] {
  const merged = new Map<string, McpServerConfig>();
  for (const s of readServerList(globalMcpConfigPath())) merged.set(s.name.toLowerCase(), s);
  for (const s of readServerList(path.join(workspace, ".smol", "mcp.json"))) {
    merged.set(s.name.toLowerCase(), s);
  }
  return [...merged.values()].slice(0, 40);
}

/** Expand `${VAR}` from your environment (secrets never live in files). */
export function expandEnvVars(s: string): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "");
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function readServerList(file: string): McpServerConfig[] {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.servers) ? raw.servers : [];
    const out: McpServerConfig[] = [];
    for (const s of list) {
      if (!s || typeof s !== "object") continue;
      if (typeof s.name !== "string" || !NAME_RE.test(s.name.trim())) continue;
      const entry: McpServerConfig = { name: s.name.trim() };
      const hasCommand = typeof s.command === "string" && s.command.trim();
      const hasUrl = typeof s.url === "string" && isHttpUrl(s.url.trim());
      if (!hasCommand && !hasUrl) continue;
      if (hasCommand) entry.command = (s.command as string).trim();
      if (hasUrl) entry.url = (s.url as string).trim();
      if (Array.isArray(s.args) && s.args.every((a: unknown) => typeof a === "string")) entry.args = s.args;
      if (s.env && typeof s.env === "object" && !Array.isArray(s.env)) {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(s.env)) if (typeof v === "string") env[k] = v;
        if (Object.keys(env).length) entry.env = env;
      }
      if (s.headers && typeof s.headers === "object" && !Array.isArray(s.headers)) {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(s.headers)) if (typeof v === "string") headers[k] = v;
        if (Object.keys(headers).length) entry.headers = headers;
      }
      if (Number.isSafeInteger(s.timeoutMs) && s.timeoutMs > 0) {
        entry.timeoutMs = Math.min(s.timeoutMs, 300_000);
      }
      if (typeof s.enabled === "boolean") entry.enabled = s.enabled;
      out.push(entry);
      if (out.length >= 30) break;
    }
    return out;
  } catch {
    return [];
  }
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface McpToolInfo {
  name: string;
  description?: string;
}

/** One server, local program or remote address: handshake on first use,
 * then list/call. Remote speaks Streamable HTTP (plain JSON or SSE). */
export class McpClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private ready: Promise<void> | null = null;
  private dead: Error | null = null;
  private sessionId: string | null = null;

  constructor(
    private cfg: McpServerConfig,
    private workspace?: string
  ) {}

  /** Remote when an address is set and no program overrides it. */
  private get remote(): boolean {
    return !this.cfg.command && !!this.cfg.url;
  }

  private ensure(): Promise<void> {
    if (this.ready) return this.ready;
    if (this.remote) {
      this.ready = (async () => {
        try {
          await this.remoteRequest(
            "initialize",
            {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "smolcoder", version: "1" },
            },
            this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
          );
          await this.remoteNotify("notifications/initialized");
        } catch (err) {
          this.ready = null;
          throw err;
        }
      })();
      return this.ready;
    }
    this.ready = this.spawn();
    return this.ready;
  }

  private spawn(): Promise<void> {
    const command = this.cfg.command;
    if (!command) {
      return Promise.reject(new Error(`MCP server "${this.cfg.name}" has no program to launch.`));
    }
    return new Promise((resolve, reject) => {
      let proc: ChildProcess;
      try {
        // Windows .cmd/.bat wrappers (npx, …) cannot be spawned directly
        // with pipes (EINVAL) — run them through the shell with each
        // argument safely quoted. Config values are yours, like run_command.
        const resolved = resolveCommand(command);
        const args = this.cfg.args ?? [];
        const opts = {
          env: { ...shellEnv(), ...(this.cfg.env ?? {}) },
          stdio: ["pipe", "pipe", "ignore"] as ["pipe", "pipe", "ignore"],
          windowsHide: true,
          // Relative paths in args (like ".") resolve in the workspace.
          // Normalized: Windows spawn rejects forward-slash cwd with ENOENT.
          ...(this.workspace ? { cwd: path.normalize(this.workspace) } : {}),
        };
        proc =
          process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)
            ? spawn([resolved, ...args].map((a) => (/[\s&|<>^"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(" "), { ...opts, shell: true })
            : spawn(resolved, args, opts);
      } catch (err: any) {
        reject(new Error(`could not start MCP server "${this.cfg.name}": ${err?.message ?? err}`));
        return;
      }
      this.proc = proc;
      proc.stdout?.on("data", (d: Buffer) => this.ingest(d.toString("utf8")));
      proc.on("error", (err) => this.failAll(new Error(`MCP server "${this.cfg.name}" failed to start: ${err.message}`)));
      proc.on("close", (code) => this.failAll(new Error(`MCP server "${this.cfg.name}" exited (code ${code})`)));
      this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smolcoder", version: "1" },
      })
        .then(() => {
          this.notify("notifications/initialized");
          resolve();
        })
        .catch(reject);
    });
  }

  private failAll(err: Error): void {
    this.dead = err;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private ingest(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > 4_000_000) {
      this.failAll(new Error(`MCP server "${this.cfg.name}" sent too much data`));
      return;
    }
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg?.id !== undefined && this.pending.has(Number(msg.id))) {
        const p = this.pending.get(Number(msg.id))!;
        this.pending.delete(Number(msg.id));
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(String(msg.error?.message ?? "MCP error")));
        else p.resolve(msg.result);
      }
    }
  }

  private notify(method: string): void {
    if (this.remote) {
      void this.remoteNotify(method);
      return;
    }
    try {
      this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
    } catch {
      /* best effort */
    }
  }

  /** POST one JSON-RPC message to a remote address (plain JSON or SSE
   * answer). Servers may pin a session id header for follow-up calls. */
  private async remotePost(
    payload: any,
    timeoutMs: number
  ): Promise<{ status: number; text: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      for (const [k, v] of Object.entries(this.cfg.headers ?? {})) headers[k.toLowerCase()] = expandEnvVars(v);
      if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
      const res = await fetch(this.cfg.url as string, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      return { status: res.status, text: await res.text().catch(() => "") };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Pick the reply matching our id out of a plain-JSON or SSE body. */
  private pickReply(text: string, id: number): any {
    const candidates: any[] = [];
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
      try {
        candidates.push(JSON.parse(trimmed));
      } catch {
        /* try SSE below */
      }
    }
    let block: string[] = [];
    const flush = (): void => {
      if (block.length) {
        try {
          candidates.push(JSON.parse(block.join("\n")));
        } catch {
          /* ignore partial events */
        }
        block = [];
      }
    };
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith(":")) {
        flush();
        continue;
      }
      if (t.startsWith("data:")) block.push(t.slice(5).trim());
      else flush();
    }
    flush();
    const hit = candidates.find((m) => m && (m.id === id || String(m.id) === String(id)));
    if (hit) {
      if (hit.error) throw new Error(String(hit.error?.message ?? "MCP error"));
      return hit.result;
    }
    const err = candidates.find((m) => m?.error);
    if (err) throw new Error(String(err.error?.message ?? "MCP error"));
    throw new Error(`MCP server "${this.cfg.name}" sent no answer`);
  }

  private async remoteRequest(method: string, params: any, timeoutMs: number): Promise<any> {
    const id = this.nextId++;
    let out: { status: number; text: string };
    try {
      out = await this.remotePost({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    } catch (err: any) {
      if (err?.name === "AbortError") throw new Error(`MCP server "${this.cfg.name}" timed out on ${method}`);
      throw new Error(`could not reach MCP server "${this.cfg.name}": ${String(err?.message ?? err).slice(0, 160)}`);
    }
    if (out.status === 401 || out.status === 403) {
      throw new Error(`MCP server "${this.cfg.name}" refused the key (HTTP ${out.status}). Check your API key.`);
    }
    if (out.status === 404) throw new Error(`MCP server "${this.cfg.name}" not found (HTTP 404). Check the address.`);
    if (out.status < 200 || out.status >= 300) {
      throw new Error(`MCP server "${this.cfg.name}" answered HTTP ${out.status}.`);
    }
    if (!out.text.trim()) throw new Error(`MCP server "${this.cfg.name}" sent an empty answer.`);
    return this.pickReply(out.text, id);
  }

  private async remoteNotify(method: string): Promise<void> {
    try {
      await this.remotePost({ jsonrpc: "2.0", method }, 15000);
    } catch {
      /* best effort */
    }
  }

  request(method: string, params?: any, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
    if (this.remote) return this.remoteRequest(method, params, timeoutMs);
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server "${this.cfg.name}" timed out on ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (err: any) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`could not write to MCP server "${this.cfg.name}": ${err?.message ?? err}`));
      }
    });
  }

  async listTools(): Promise<McpToolInfo[]> {
    await this.ensure();
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4 && out.length < MAX_TOOLS; page++) {
      const res = await this.request("tools/list", cursor ? { cursor } : {}, this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      for (const t of res?.tools ?? []) {
        if (t && typeof t.name === "string") out.push({ name: t.name, ...(typeof t.description === "string" ? { description: t.description } : {}) });
        if (out.length >= MAX_TOOLS) break;
      }
      cursor = typeof res?.nextCursor === "string" ? res.nextCursor : undefined;
      if (!cursor) break;
    }
    return out;
  }

  async callTool(tool: string, args: Record<string, any>, signal?: AbortSignal): Promise<string> {
    await this.ensure();
    if (signal?.aborted) throw signal.reason;
    const res = await this.request("tools/call", { name: tool, arguments: args }, this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (signal?.aborted) throw signal.reason;
    const parts: string[] = [];
    let failed = false;
    for (const c of res?.content ?? []) {
      if (c && typeof c.text === "string") parts.push(c.text);
      else if (c && typeof c.data === "string") parts.push(`[data ${c.mimeType ?? "blob"}: ${c.data.slice(0, 200)}…]`);
    }
    if (res?.isError) failed = true;
    const body = parts.join("\n").slice(0, 9000) || "(empty result)";
    return `${failed ? "Error: " : ""}${body}`;
  }

  close(): void {
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}

/** Lazy bridge stored on the ToolContext: connects on first use so startup
 * never waits for a switched-off server. */
export interface McpBridge {
  configured(): McpServerConfig[];
  list(): Promise<string>;
  call(server: string, tool: string, argsJson: string, signal?: AbortSignal): Promise<string>;
  /** Fast parallel health check for /mcp (green/red lights + tool counts). */
  status(timeoutMs?: number): Promise<McpStatusRow[]>;
  /** Short diagnostic (timeout 8000): outils listés ou erreur exacte. */
  debugServer(name: string): Promise<string>;
  closeAll(): void;
}

export interface McpStatusRow {
  name: string;
  ok: boolean;
  tools?: string[];
  error?: string;
}

export function createMcpBridge(workspace: string): McpBridge {
  const clients = new Map<string, McpClient>();
  const of = (name: string): { cfg: McpServerConfig; client: McpClient } | null => {
    const cfg = loadMcpConfig(workspace).find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!cfg) return null;
    let client = clients.get(cfg.name);
    if (!client) {
      client = new McpClient(cfg, workspace);
      clients.set(cfg.name, client);
    }
    return { cfg, client };
  };
  return {
    configured: () => loadMcpConfig(workspace),
    async list(): Promise<string> {
      const cfgs = loadMcpConfig(workspace).filter((c) => c.enabled !== false);
      if (!cfgs.length) {
        return 'No MCP servers configured. Add them in `.smol/mcp.json` (see docs/plugins.md), e.g. [{"name": "files", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]}].';
      }
      const rows: string[] = [];
      for (const c of cfgs) {
        const found = of(c.name);
        if (!found) continue;
        try {
          const tools = await found.client.listTools();
          rows.push(`${c.name} (${tools.length} tools): ${tools.map((t) => t.name).join(", ") || "none"}`);
        } catch (err: any) {
          rows.push(`${c.name}: unreachable (${String(err?.message ?? err).slice(0, 120)})`);
          found.client.close();
          clients.delete(c.name);
        }
      }
      return rows.join("\n") || "No MCP servers answered.";
    },
    async call(server, tool, argsJson, signal): Promise<string> {
      if (!server.trim()) {
        return 'Error: server is required. Pass server "?" to list servers and their tools.';
      }
      if (server === "?") return this.list();
      if (!tool.trim()) {
        return 'Error: tool is required. Example: {"server": "files", "tool": "read_file", "args": "{\\"path\\": \\"notes.txt\\"}"}';
      }
      const cfgOnly = loadMcpConfig(workspace).find((s) => s.name.toLowerCase() === server.toLowerCase());
      if (cfgOnly?.enabled === false) {
        return `Error: MCP server "${cfgOnly.name}" désactivé (enabled: false). Mettez "enabled": true dans .smol/mcp.json pour le réactiver.`;
      }
      const found = of(server);
      if (!found) {
        return `Error: no MCP server named "${server}". Configured: ${loadMcpConfig(workspace).map((s) => s.name).join(", ") || "none"}. See docs/plugins.md.`;
      }
      let args: Record<string, any> = {};
      const raw = (argsJson ?? "").trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return 'Error: args must be a JSON object in a string. Example: {"server": "files", "tool": "read_file", "args": "{\\"path\\": \\"notes.txt\\"}"}';
          }
          args = parsed;
        } catch (e: any) {
          return `Error: args is not valid JSON (${String(e?.message ?? e).slice(0, 100)}).`;
        }
      }
      try {
        return await found.client.callTool(tool, args, signal);
      } catch (err: any) {
        found.client.close();
        clients.delete(found.cfg.name);
        return `Error: ${String(err?.message ?? err).slice(0, 400)}`;
      }
    },
    closeAll(): void {
      for (const c of clients.values()) c.close();
      clients.clear();
    },
    async status(timeoutMs = 8000): Promise<McpStatusRow[]> {
      const cfgs = loadMcpConfig(workspace);
      const one = async (cfg: McpServerConfig): Promise<McpStatusRow> => {
        if (cfg.enabled === false) return { name: cfg.name, ok: false, error: "désactivé (enabled: false)" };
        const found = of(cfg.name);
        if (!found) return { name: cfg.name, ok: false, error: "not configured" };
        try {
          const tools = await Promise.race([
            found.client.listTools(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("too slow to answer")), timeoutMs)),
          ]);
          return { name: cfg.name, ok: true, tools: tools.map((t) => t.name) };
        } catch (err: any) {
          found.client.close();
          clients.delete(found.cfg.name);
          return { name: cfg.name, ok: false, error: String(err?.message ?? err).slice(0, 120) };
        }
      };
      return Promise.all(cfgs.map(one));
    },
    async debugServer(name: string): Promise<string> {
      const needle = (name ?? "").trim().toLowerCase();
      if (!needle) {
        return `Error: usage /mcp debug <nom> — ex. /mcp debug files. Configured: ${loadMcpConfig(workspace).map((s) => s.name).join(", ") || "none"}.`;
      }
      const cfg = loadMcpConfig(workspace).find((s) => s.name.toLowerCase() === needle);
      if (!cfg) {
        return `Error: no MCP server named "${name}". Configured: ${loadMcpConfig(workspace).map((s) => s.name).join(", ") || "none"}. See docs/plugins.md.`;
      }
      const where = cfg.command
        ? `command "${cfg.command}${cfg.args?.length ? " " + cfg.args.join(" ") : ""}"`
        : `url "${cfg.url ?? ""}"`;
      const disabledNote = cfg.enabled === false ? " (désactivé — test forcé malgré enabled: false)" : "";
      const probe = new McpClient({ ...cfg, timeoutMs: 8000 }, workspace);
      try {
        const tools = await Promise.race([
          probe.listTools(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("too slow to answer (timeout 8000ms)")), 8000)),
        ]);
        const detail = tools.length ? `${tools.length} tools: ${tools.map((t) => t.name).join(", ")}` : "0 tools";
        return `${cfg.name}${disabledNote}: OK via ${where} — ${detail}.`;
      } catch (err: any) {
        return `${cfg.name}${disabledNote}: ECHEC via ${where} — ${String(err?.message ?? err).slice(0, 400)}`;
      } finally {
        try {
          probe.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

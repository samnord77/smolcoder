// Minimal Debug Adapter Protocol (DAP) client: run a program under a real
// debugger, hit breakpoints, read the stack and variables, step once, and
// get a readable transcript back. Zero new dependencies.
//
// Transports: stdio (spawn the adapter) and TCP socket (spawn a listener
// like `debugpy --listen` or `dlv dap`, then connect). The adapter command
// lives in the workspace, next to the MCP pattern: `.smol/debug.json`.
// Example for Python (debugpy speaks DAP over a socket):
//   {"transport":"socket","spawn":["python","-m","debugpy","--listen","5678",
//    "--wait-for-client","app.py"],"port":5678,"request":"attach",
//    "breakpoints":[{"path":"app.py","lines":[12]}]}
// Example for a stdio adapter:
//   {"transport":"stdio","adapter":["my-dap-adapter"],"request":"launch",
//    "program":"app.js","breakpoints":[{"path":"app.js","lines":[5]}]}
// No config, no mock: the tool answers with setup coaching. Never throws.
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { encodeLsp } from "./lsp";
import { resolveCommand } from "./mcp";
import { resolveInWorkspace } from "./sandbox";
import { binSearchDirs } from "./util";

const _DEFAULT_BUDGET_MS = 60_000;
const TRANSCRIPT_CAP = 6000;

interface DapPending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DapEvent {
  event: string;
  body?: any;
}

/** Windows cannot spawn a `.cmd`/`.bat` shim directly (EINVAL). The DAP
 * adapter is a real program (node, python, dlv…), so prefer the `.exe` that
 * sits next to the shim instead of the wrapper npm/npx leave on PATH. */
function spawnableExe(rawExe: string): string {
  const exe = resolveCommand(rawExe);
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(exe)) return exe;
  const name = path.basename(exe).replace(/\.[^.]+$/, "");
  for (const dir of binSearchDirs()) {
    for (const ext of [".exe", ".com"]) {
      const cand = path.join(dir, name + ext);
      try {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
      } catch {
        /* dossier introuvable : on continue */
      }
    }
  }
  return exe;
}

/** DAP connection over stdio or TCP. Framing is identical to LSP
 * (Content-Length headers), so encodeLsp is reused. */
export class DapClient {
  private proc: ChildProcess | null = null;
  private socket: net.Socket | null = null;
  private seq = 0;
  private pending = new Map<number, DapPending>();
  private buf = Buffer.alloc(0);
  private events: DapEvent[] = [];
  private dead: Error | null = null;

  /** Spawn a stdio adapter. */
  async startStdio(cmd: string[], cwd: string): Promise<void> {
    const [rawExe, ...rest] = cmd;
    const exe = spawnableExe(rawExe);
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(exe);
    const quoted = [exe, ...rest].map((a) => (/[\s&|<>^"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(" ");
    await new Promise<void>((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = spawn(useShell ? quoted : exe, useShell ? [] : rest, {
          cwd,
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
          ...(useShell ? { shell: true } : {}),
        });
      } catch (err: any) {
        reject(new Error(`impossible de démarrer l’adaptateur de débogage (${exe}) : ${err?.message ?? err}`));
        return;
      }
      this.proc = proc;
      proc.stdout?.on("data", (d: Buffer) => this.ingest(d));
      proc.on("error", (err) => this.failAll(new Error(`debug adapter failed to start: ${err.message}`)));
      proc.on("close", (code) => this.failAll(new Error(`debug adapter exited (code ${code})`)));
      resolve();
    });
  }

  /** Connect to a TCP DAP server (already listening). */
  async connectSocket(host: string, port: number, timeoutMs = 10_000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host, port });
      const timer = setTimeout(() => {
        try {
          sock.destroy();
        } catch {
          /* ignore */
        }
        reject(new Error(`timed out connecting to debug adapter ${host}:${port}`));
      }, timeoutMs);
      sock.on("connect", () => {
        clearTimeout(timer);
        this.socket = sock;
        resolve();
      });
      sock.on("data", (d: Buffer) => this.ingest(d));
      sock.on("error", (err) => {
        clearTimeout(timer);
        if (!this.socket) reject(new Error(`could not connect to debug adapter ${host}:${port} (${err.message})`));
        else this.failAll(new Error(`debug adapter socket error: ${err.message}`));
      });
      sock.on("close", () => {
        if (this.socket) this.failAll(new Error("debug adapter closed the connection"));
      });
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
      this.failAll(new Error("debug adapter sent too much data"));
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
      if (msg?.type === "event" && typeof msg?.event === "string") {
        this.events.push({ event: msg.event, body: msg.body });
        if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
        continue;
      }
      if (msg?.type === "response" && typeof msg?.request_seq === "number" && this.pending.has(msg.request_seq)) {
        const p = this.pending.get(msg.request_seq)!;
        this.pending.delete(msg.request_seq);
        clearTimeout(p.timer);
        if (msg.success === false) p.reject(new Error(String(msg.message ?? `request ${msg.command} failed`)));
        else p.resolve(msg.body ?? {});
      }
    }
  }

  private write(raw: string): void {
    const data = encodeLsp(raw);
    try {
      if (this.proc?.stdin) this.proc.stdin.write(data);
      else if (this.socket) this.socket.write(data);
    } catch (err: any) {
      throw new Error(`could not write to debug adapter: ${err?.message ?? err}`);
    }
  }

  request(command: string, args?: any, timeoutMs = 20_000): Promise<any> {
    if (this.dead) return Promise.reject(this.dead);
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`debug adapter timed out on ${command}`));
      }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
      try {
        this.write(JSON.stringify({ seq, type: "request", command, arguments: args }));
      } catch (err: any) {
        this.pending.delete(seq);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  takeEvents(): DapEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  close(): void {
    try {
      this.proc?.stdin?.end();
    } catch {
      /* ignore */
    }
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.proc = null;
    this.socket = null;
  }
}

// ---------------------------------------------------------------------------
// Session runner
// ---------------------------------------------------------------------------

export interface DebugBreakpoint {
  path: string;
  lines: number[];
}

export interface DebugPlan {
  request: "launch" | "attach";
  launchArgs?: Record<string, any>;
  program?: string;
  programArgs?: string[];
  breakpoints: DebugBreakpoint[];
  budgetMs: number;
}

function fmtValue(v: any): string {
  if (v === null || v === undefined) return "?";
  if (typeof v === "object") return String(v.value ?? v.name ?? "?").slice(0, 80);
  return String(v).slice(0, 80);
}

/** Drive one bounded session: initialize → launch/attach → breakpoints →
 * run → capture the first stop (stack + variables) → continue → transcript.
 * The client must already be connected. Exported for tests (mock adapter). */
export async function runDebugSession(client: DapClient, plan: DebugPlan, root: string): Promise<string> {
  const lines: string[] = [];
  const say = (s: string) => {
    if (lines.join("\n").length < TRANSCRIPT_CAP) lines.push(s);
  };
  const deadline = Date.now() + plan.budgetMs;
  const left = () => Math.max(1000, deadline - Date.now());

  await client.request(
    "initialize",
    {
      clientID: "smolcoder",
      adapterID: "smolcoder",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
    },
    left()
  );
  if (plan.request === "attach") {
    await client.request("attach", plan.launchArgs ?? {}, left());
  } else {
    await client.request("launch", plan.launchArgs ?? { program: plan.program, args: plan.programArgs ?? [], noDebug: false }, left());
  }
  let verified = 0;
  let wanted = 0;
  for (const bp of plan.breakpoints) {
    let abs: string;
    try {
      abs = resolveInWorkspace(root, bp.path);
    } catch {
      continue;
    }
    const clean = bp.lines.filter((n) => Number.isSafeInteger(n) && n >= 1).slice(0, 10);
    wanted += clean.length;
    if (!clean.length) continue;
    try {
      const res = await client.request(
        "setBreakpoints",
        { source: { name: path.basename(abs), path: abs }, breakpoints: clean.map((line) => ({ line })) },
        left()
      );
      const bps = Array.isArray(res?.breakpoints) ? res.breakpoints : [];
      for (const b of bps) if (b?.verified) verified++;
    } catch (err: any) {
      say(`! breakpoints refused for ${bp.path}: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }
  say(`breakpoints: ${verified}/${wanted} verified`);
  try {
    await client.request("configurationDone", {}, left());
  } catch {
    /* some adapters proceed without it */
  }

  let stops = 0;
  let done = false;
  while (!done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    for (const ev of client.takeEvents()) {
      if (ev.event === "output" && typeof ev.body?.output === "string") {
        const t = ev.body.output.trim();
        if (t) say(`out: ${t.slice(0, 300)}`);
      } else if (ev.event === "stopped") {
        stops++;
        const reason = String(ev.body?.reason ?? "unknown");
        const threadId = Number(ev.body?.threadId) || 1;
        say(`▶ stopped (${reason})`);
        try {
          const stack = await client.request("stackTrace", { threadId, startFrame: 0, levels: 5 }, left());
          const frames = Array.isArray(stack?.stackFrames) ? stack.stackFrames : [];
          for (const f of frames.slice(0, 5)) {
            const src = f?.source?.path ? path.relative(root, String(f.source.path)).split(path.sep).join("/") : "?";
            say(`  at ${String(f?.name ?? "?").slice(0, 80)} ${src}:${Number(f?.line) || 0}`);
          }
          if (frames[0]) {
            const scopes = await client.request("scopes", { frameId: frames[0].id }, left());
            const first = Array.isArray(scopes?.scopes) ? scopes.scopes[0] : null;
            if (first) {
              const vars = await client.request("variables", { variablesReference: first.variablesReference, count: 20 }, left());
              const arr = Array.isArray(vars?.variables) ? vars.variables : [];
              for (const v of arr.slice(0, 20)) {
                say(`  ${String(v?.name ?? "?").slice(0, 40)} = ${fmtValue(v?.value)}`);
              }
            }
          }
        } catch (err: any) {
          say(`! inspection failed: ${String(err?.message ?? err).slice(0, 120)}`);
        }
        if (stops >= 3) {
          say("(stop limit reached — disconnecting)");
          done = true;
          break;
        }
        try {
          await client.request(stops === 1 ? "next" : "continue", { threadId }, left());
          if (stops === 1) say("(stepped once, resuming)");
        } catch {
          done = true;
          break;
        }
      } else if (ev.event === "terminated" || ev.event === "exited") {
        const code = ev.body?.exitCode;
        say(code !== undefined ? `■ program exited (code ${code})` : "■ program terminated");
        done = true;
        break;
      }
    }
  }
  if (!done) say("(time budget reached — disconnecting)");
  try {
    await client.request("disconnect", { terminateDebuggee: true }, 5000);
  } catch {
    /* already gone */
  }
  return lines.join("\n") || "(empty debug transcript)";
}

// ---------------------------------------------------------------------------
// Config + entry point
// ---------------------------------------------------------------------------

export interface DebugConfig {
  transport?: unknown;
  adapter?: unknown;
  spawn?: unknown;
  host?: unknown;
  port?: unknown;
  request?: unknown;
  program?: unknown;
  args?: unknown;
  launch?: unknown;
  breakpoints?: unknown;
  budgetSec?: unknown;
}

function loadDebugConfig(root: string): { cfg: DebugConfig | null; error: string | null } {
  const file = path.join(root, ".smol", "debug.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { cfg: null, error: null };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { cfg: null, error: "debug.json must contain a JSON object." };
    }
    return { cfg: parsed as DebugConfig, error: null };
  } catch (err: any) {
    return { cfg: null, error: `debug.json n’est pas un JSON valide (${err?.message ?? err}).` };
  }
}

const DEBUG_SETUP_HELP = `No debugger configured yet. Create .smol/debug.json in this workspace, for example for Python (debugpy speaks DAP over a socket):
{"transport":"socket","spawn":["python","-m","debugpy","--listen","5678","--wait-for-client","app.py"],"port":5678,"request":"attach","breakpoints":[{"path":"app.py","lines":[12]}]}
Or for a stdio adapter:
{"transport":"stdio","adapter":["my-dap-adapter"],"request":"launch","program":"app.js","breakpoints":[{"path":"app.js","lines":[5]}]}
Then call debug again with {"action": "run"}. Install the adapter first (pip install debugpy, or your language's DAP server).`;

export interface DebugQuery {
  action?: unknown;
  budgetSec?: unknown;
}

/** Entry point for the debug tool. Needs canWrite (it runs code). Never throws. */
export async function queryDebug(root: string, args: DebugQuery, opts?: { canWrite?: boolean }, signal?: AbortSignal): Promise<string> {
  if (opts?.canWrite === false) {
    return "Error: le débogage exécute du code — indisponible en mode lecture seule. Passez d’abord en mode édition.";
  }
  const action = String(args.action ?? "run");
  if (action !== "run") {
    return 'Error: l’action doit être "run". Exemple : {"action": "run"} (configurez d’abord dans .smol/debug.json).';
  }
  if (signal?.aborted) return "Error: débogage annulé avant le démarrage.";
  const { cfg, error } = loadDebugConfig(root);
  if (error) return `Error: ${error}`;
  if (!cfg) return DEBUG_SETUP_HELP;

  const transport = cfg.transport === "socket" ? "socket" : "stdio";
  const request = cfg.request === "attach" ? "attach" : "launch";
  const budgetMs = Math.min(Math.max(10, Number(cfg.budgetSec) || 60), 300) * 1000;

  const breakpoints: DebugBreakpoint[] = [];
  if (Array.isArray(cfg.breakpoints)) {
    for (const b of cfg.breakpoints.slice(0, 5)) {
      if (b && typeof b.path === "string") {
        breakpoints.push({
          path: b.path,
          lines: Array.isArray(b.lines) ? b.lines.map(Number).filter((n: number) => Number.isSafeInteger(n)) : [],
        });
      }
    }
  }

  const plan: DebugPlan = {
    request,
    launchArgs: cfg.launch && typeof cfg.launch === "object" ? (cfg.launch as Record<string, any>) : undefined,
    program: typeof cfg.program === "string" ? cfg.program : undefined,
    programArgs: Array.isArray(cfg.args) ? cfg.args.map(String).slice(0, 20) : [],
    breakpoints,
    budgetMs,
  };

  const client = new DapClient();
  let spawned: ChildProcess | null = null;
  try {
    if (transport === "socket") {
      const spawnCmd = Array.isArray(cfg.spawn) ? cfg.spawn.map(String) : [];
      if (!spawnCmd.length) {
        return 'Error: le transport socket a besoin de "spawn" (la commande d’écoute). Exemple : {"transport":"socket","spawn":["python","-m","debugpy","--listen","5678","app.py"],"port":5678}';
      }
      const port = Number(cfg.port);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        return 'Error: le transport socket a besoin d’un "port" valide. Exemple : {"port": 5678}';
      }
      const host = typeof cfg.host === "string" && cfg.host ? cfg.host : "127.0.0.1";
      try {
        const [exe, ...rest] = spawnCmd;
        spawned = spawn(resolveCommand(exe), rest, { cwd: root, stdio: "ignore", windowsHide: true });
      } catch (err: any) {
        return `Error: impossible de lancer l’écouteur de débogage (${err?.message ?? err}).`;
      }
      const t0 = Date.now();
      let connected = false;
      let lastErr = "";
      while (Date.now() - t0 < 15_000) {
        if (signal?.aborted) return "Error: débogage annulé en attendant l’adaptateur.";
        try {
          await client.connectSocket(host, port, 1000);
          connected = true;
          break;
        } catch (err: any) {
          lastErr = String(err?.message ?? err).slice(0, 120);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (!connected)
        return `Error: l’écouteur de débogage n’a jamais ouvert ${host}:${port} (${lastErr}). Vérifiez la commande de démarrage.`;
    } else {
      const adapter = Array.isArray(cfg.adapter) ? cfg.adapter.map(String) : [];
      if (!adapter.length) {
        return 'Error: le transport stdio a besoin de "adapter" (la commande). Exemple : {"transport":"stdio","adapter":["my-dap-adapter"],"request":"launch"}';
      }
      try {
        await client.startStdio(adapter, root);
      } catch (err: any) {
        return `Error: ${err?.message ?? err}`;
      }
    }
    if (signal?.aborted) return "Error: débogage annulé.";
    return await runDebugSession(client, plan, root);
  } catch (err: any) {
    if (signal?.aborted || (err as any)?.name === "AbortError") return "Error: débogage annulé.";
    return `Error: échec de la session de débogage (${String(err?.message ?? err).slice(0, 300)}).`;
  } finally {
    try {
      client.close();
    } catch {
      /* ignore */
    }
    try {
      spawned?.kill();
    } catch {
      /* ignore */
    }
  }
}

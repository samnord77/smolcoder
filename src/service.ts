// Background service: runs the scheduled /routine prompts even when no app
// window, hub or TUI is open. One service per user, tracked by a small record
// file; every run is a REAL headless agent turn (`node dist/index.js <ws> -p
// <prompt>`), never a simulated one. Started by `smol service start` (or
// automatically when the app boots and routines exist), stopped by
// `smol service stop`, optionally installed at logon with `smol service
// install` (real Windows scheduled task).

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_DIR } from "./config";
import { describeCadence, type Routine, RoutineBook } from "./routines";
import { WorkspaceStore, writeAtomic } from "./web/store";

const VERSION = require("../package.json").version as string;

/** Default cadence of the tick loop (overridable: tests, advanced users). */
const TICK_DEFAULT_MS = 30_000;
/** One routine run is a full agent turn: allow a long one, then stop it. */
const ROUTINE_TIMEOUT_MS = 45 * 60_000;
/** Keep the service log small: rotate once it passes this size. */
const LOG_MAX_BYTES = 2 * 1024 * 1024;
/** How many claimed routines a single tick may start (bound per tick). */
const MAX_PER_TICK = 10;
/** Captured per-run output is bounded too (log lines only keep a tail). */
const OUTPUT_CAP = 20_000;

export interface ServiceRecord {
  pid: number;
  startedAt: number;
  version: string;
}

export interface ServiceStatus {
  running: boolean;
  pid?: number;
  startedAt?: number;
  version?: string;
  /** A record file exists but its process is gone (crash / hard kill). */
  stale: boolean;
}

export interface ServiceTarget {
  workspace: string;
  routines: Routine[];
}

export interface ExecResult {
  code: number;
  output: string;
}

/** Runs one routine: the real executor spawns a headless agent turn; tests
 * inject a scripted executor through tickOnce/runServiceLoop options. */
export type RoutineExecutor = (
  workspace: string,
  prompt: string,
  context: { timeoutMs: number; log: (line: string) => void }
) => Promise<ExecResult>;

// The data directory is resolved per call (SMOLCODER_DATA_DIR points tests at
// a scratch directory; never read the real ~/.smolcoder from a test).
function dataDir(): string {
  return process.env.SMOLCODER_DATA_DIR || DATA_DIR;
}

export function serviceFilePath(): string {
  return path.join(dataDir(), "service.json");
}

export function serviceLogPath(): string {
  return path.join(dataDir(), "service.log");
}

export function readServiceRecord(): ServiceRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(serviceFilePath(), "utf8"));
    const pid = Number(raw?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    return { pid, startedAt: Number(raw?.startedAt) || 0, version: String(raw?.version ?? "") };
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function serviceStatus(): ServiceStatus {
  const rec = readServiceRecord();
  if (!rec) return { running: false, stale: false };
  if (!isProcessAlive(rec.pid)) return { running: false, stale: true };
  return { running: true, pid: rec.pid, startedAt: rec.startedAt, version: rec.version, stale: false };
}

function removeServiceRecord(): void {
  try {
    fs.unlinkSync(serviceFilePath());
  } catch {
    /* already gone */
  }
}

/** Append one line to the service log; rotates the file when it gets big. */
export function appendServiceLog(line: string): void {
  try {
    const dir = dataDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = serviceLogPath();
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) {
        fs.rmSync(`${file}.1`, { force: true });
        fs.renameSync(file, `${file}.1`);
      }
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* the service must never die on a log write */
  }
}

/** Workspaces that have at least one routine (any state) — the service's job list. */
export function serviceTargets(): ServiceTarget[] {
  const out: ServiceTarget[] = [];
  let entries: { path: string }[] = [];
  try {
    entries = new WorkspaceStore(dataDir()).list();
  } catch {
    return out;
  }
  for (const entry of entries) {
    try {
      if (!fs.existsSync(entry.path) || !fs.statSync(entry.path).isDirectory()) continue;
      const routines = new RoutineBook(entry.path).listSorted();
      if (routines.length > 0) out.push({ workspace: entry.path, routines });
    } catch {
      /* unreadable workspace: skip, never crash the loop */
    }
  }
  return out;
}

/** Start the service as a detached process. Idempotent: an already-running
 * service is reported, not duplicated. Waits briefly for its record file. */
export function startServiceDetached(): { ok: boolean; message: string } {
  const cur = serviceStatus();
  if (cur.running) return { ok: true, message: `service déjà actif (pid ${cur.pid}).` };
  if (cur.stale) removeServiceRecord();
  fs.mkdirSync(dataDir(), { recursive: true });
  const entry = path.resolve(__dirname, "index.js");
  const child = spawn(process.execPath, [entry, "service", "run"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: dataDir(),
    env: process.env,
  });
  child.unref();
  // The child boots the full CLI (it may refresh dist on a stale build), so
  // allow a generous window instead of failing a slow first start.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rec = readServiceRecord();
    if (rec && isProcessAlive(rec.pid)) {
      return { ok: true, message: `service démarré (pid ${rec.pid}). Journal : ${serviceLogPath()}` };
    }
    sleepSync(150);
  }
  return {
    ok: false,
    message: `le service n'a pas confirmé son démarrage — vérifiez le journal : ${serviceLogPath()}`,
  };
}

/** Stop the service: signal it, wait for it to die, clean the record. */
export function stopService(): { ok: boolean; message: string } {
  const rec = readServiceRecord();
  if (!rec) return { ok: true, message: "service déjà arrêté." };
  if (!isProcessAlive(rec.pid)) {
    removeServiceRecord();
    return { ok: true, message: "service déjà arrêté (trace périmée nettoyée)." };
  }
  try {
    process.kill(rec.pid);
  } catch (error: any) {
    return { ok: false, message: `impossible d'arrêter le pid ${rec.pid} : ${String(error?.message ?? error)}` };
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isProcessAlive(rec.pid)) sleepSync(100);
  if (isProcessAlive(rec.pid)) {
    return { ok: false, message: `le pid ${rec.pid} est toujours vivant après l'arrêt demandé.` };
  }
  removeServiceRecord();
  return { ok: true, message: "service arrêté." };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The real executor: one full headless agent turn for the routine prompt. */
export async function executeRoutine(
  workspace: string,
  prompt: string,
  context: { timeoutMs: number; log: (line: string) => void }
): Promise<ExecResult> {
  const entry = path.resolve(__dirname, "index.js");
  return new Promise((resolve) => {
    let output = "";
    const cap = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > OUTPUT_CAP) output = output.slice(-OUTPUT_CAP);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [entry, workspace, "-p", prompt], {
        cwd: workspace,
        windowsHide: true,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error: any) {
      resolve({ code: -1, output: String(error?.message ?? error) });
      return;
    }
    const timer = setTimeout(() => {
      context.log(`routine : temps limite dépassé (${Math.round(context.timeoutMs / 60000)} min) — arrêt du tour.`);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve({ code: -1, output: `${output}\n[temps limite dépassé]` });
    }, context.timeoutMs);
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `${output}\n${String(error)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });
}

export interface ServiceTickOptions {
  exec?: RoutineExecutor;
  now?: () => number;
  log?: (line: string) => void;
  maxPerTick?: number;
}

/** One pass: claim every due routine of every target and run it for real. */
export async function tickOnce(options: ServiceTickOptions = {}): Promise<number> {
  const exec = options.exec ?? executeRoutine;
  const log = options.log ?? appendServiceLog;
  const now = options.now ?? (() => Date.now());
  const maxPerTick = options.maxPerTick ?? MAX_PER_TICK;
  let ran = 0;
  for (const target of serviceTargets()) {
    const book = new RoutineBook(target.workspace);
    let claimed = 0;
    while (claimed < maxPerTick) {
      let due: Routine | null = null;
      try {
        due = await book.claimDue(now());
      } catch (error: any) {
        log(`lecture des routines impossible dans ${target.workspace} : ${String(error?.message ?? error)}`);
        break;
      }
      if (!due) break;
      claimed++;
      ran++;
      log(`⏰ ${target.workspace} — routine (${describeCadence(due.cadence)}) : ${due.prompt.slice(0, 100)}`);
      const result = await exec(target.workspace, due.prompt, { timeoutMs: ROUTINE_TIMEOUT_MS, log });
      const status = result.code === 0 ? "ok" : result.code === -1 ? "erreur (interrompue)" : `erreur (code ${result.code})`;
      try {
        await book.markResult(due.id, status);
      } catch {
        /* result recorded on the next successful write; the run itself happened */
      }
      const tail = result.output.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
      log(`   → ${status}${tail ? ` — ${tail.slice(0, 200)}` : ""}`);
    }
  }
  return ran;
}

export interface ServiceLoopOptions {
  tickMs?: number;
  exec?: RoutineExecutor;
  log?: (line: string) => void;
}

/** The service loop itself: owns the record file, ticks until told to stop. */
export async function runServiceLoop(options: ServiceLoopOptions = {}): Promise<void> {
  const log = options.log ?? appendServiceLog;
  const envTick = Number(process.env.SMOLCODER_SERVICE_TICK_MS);
  const tickMs = Math.max(1000, Number.isFinite(envTick) && envTick > 0 ? envTick : (options.tickMs ?? TICK_DEFAULT_MS));
  const cur = readServiceRecord();
  if (cur && cur.pid !== process.pid && isProcessAlive(cur.pid)) {
    log(`un service tourne déjà (pid ${cur.pid}) — le doublon s'arrête.`);
    return;
  }
  fs.mkdirSync(dataDir(), { recursive: true });
  writeAtomic(serviceFilePath(), JSON.stringify({ pid: process.pid, startedAt: Date.now(), version: VERSION }));
  log(`service démarré (pid ${process.pid}, tick ${tickMs} ms, v${VERSION}).`);
  let stopping = false;
  const shutdown = (why: string) => {
    if (stopping) return;
    stopping = true;
    log(`arrêt du service (${why}).`);
    removeServiceRecord();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  while (!stopping) {
    try {
      await tickOnce({ exec: options.exec, log });
    } catch (error: any) {
      log(`tick : ${String(error?.message ?? error)}`);
    }
    await sleep(tickMs);
  }
}

/** Real Windows scheduled task so the service survives a logoff/logon. */
function serviceTaskName(): string {
  return process.env.SMOLCODER_SERVICE_TASK || "Smolcoder Service";
}

export function installServiceAtLogon(): { ok: boolean; message: string } {
  if (process.platform !== "win32") {
    return {
      ok: false,
      message: "le démarrage automatique est disponible sous Windows uniquement (schtasks) — utilisez `smol service start` ici.",
    };
  }
  const entry = path.resolve(__dirname, "index.js");
  const cmd = `"${process.execPath}" "${entry}" service run`;
  try {
    execFileSync("schtasks", ["/Create", "/F", "/TN", serviceTaskName(), "/SC", "ONLOGON", "/TR", cmd], {
      windowsHide: true,
      stdio: "pipe",
    });
    return {
      ok: true,
      message: `tâche planifiée « ${serviceTaskName()} » installée : le service démarrera à chaque ouverture de session.`,
    };
  } catch (error: any) {
    const stderr = String(error?.stderr ?? "").trim();
    return { ok: false, message: `création de la tâche refusée : ${stderr || String(error?.message ?? error)}` };
  }
}

export function uninstallServiceAtLogon(): { ok: boolean; message: string } {
  if (process.platform !== "win32") {
    return { ok: false, message: "disponible sous Windows uniquement (schtasks)." };
  }
  try {
    execFileSync("schtasks", ["/Delete", "/F", "/TN", serviceTaskName()], { windowsHide: true, stdio: "pipe" });
    return { ok: true, message: `tâche planifiée « ${serviceTaskName()} » supprimée.` };
  } catch (error: any) {
    const stderr = String(error?.stderr ?? "").trim();
    if (/cannot find|introuvable|does not exist/i.test(stderr)) {
      return { ok: true, message: `tâche planifiée « ${serviceTaskName()} » déjà absente.` };
    }
    return { ok: false, message: `suppression refusée : ${stderr || String(error?.message ?? error)}` };
  }
}

/** Boot hook for the app (TUI/web): make sure the service runs when the user
 * has routines. Returns a one-line notice to print, or null when silent. */
export function ensureServiceRunningForRoutines(): string | null {
  try {
    const targets = serviceTargets();
    if (targets.length === 0) return null;
    if (serviceStatus().running) return null;
    const res = startServiceDetached();
    return `service d'arrière-plan : ${res.message}`;
  } catch {
    return null;
  }
}

function formatStamp(ms: number): string {
  if (!ms) return "?";
  return new Date(ms).toLocaleString();
}

/** Human report for `smol service status` / `smol service list`. */
export function formatServiceReport(detailed = false): string {
  const status = serviceStatus();
  const targets = serviceTargets();
  const total = targets.reduce((n, t) => n + t.routines.length, 0);
  const lines: string[] = [];
  lines.push("Service d'arrière-plan Smolcoder");
  if (status.running) {
    lines.push(`  état     : actif (pid ${status.pid}, démarré ${formatStamp(status.startedAt ?? 0)})`);
  } else {
    lines.push(`  état     : arrêté${status.stale ? " (trace périmée — sera nettoyée au prochain démarrage)" : ""}`);
  }
  lines.push(`  dossiers : ${targets.length} avec routines (${total} au total)`);
  for (const target of targets) {
    const nextAt = target.routines.map((r) => r.next).sort((a, b) => a - b)[0];
    lines.push(`    · ${target.workspace} — ${target.routines.length} routine(s), prochaine : ${formatStamp(nextAt)}`);
    if (detailed) {
      for (const routine of target.routines) {
        const state = routine.enabled ? "" : " [désactivée]";
        const last = routine.lastStatus ? ` · dernier : ${routine.lastStatus}` : "";
        lines.push(
          `        - ${routine.prompt.slice(0, 80)} (${describeCadence(routine.cadence)}, prochaine ${formatStamp(routine.next)})${state}${last}`
        );
      }
    }
  }
  if (targets.length === 0) {
    lines.push("  (aucun dossier avec des routines — créez-en avec /routine dans l'app)");
  }
  lines.push(`  journal  : ${serviceLogPath()}`);
  if (!status.running && targets.length > 0) {
    lines.push(
      "  → `smol service start` pour les faire tourner même app fermée, `smol service install` pour démarrer à l'ouverture de session."
    );
  }
  try {
    const raw = fs.readFileSync(serviceLogPath(), "utf8").trim().split(/\r?\n/);
    const tail = raw.slice(-5);
    if (tail.length > 0) {
      lines.push("  dernières lignes du journal :");
      for (const line of tail) lines.push(`    ${line}`);
    }
  } catch {
    /* no log yet */
  }
  return lines.join("\n");
}

/** CLI entry point: `smol service start|stop|status|list|run|install|uninstall`. */
export async function runServiceCli(sub: string[]): Promise<void> {
  const cmd = (sub[0] || "status").toLowerCase();
  if (cmd === "start") {
    const res = startServiceDetached();
    console.log(res.message);
    if (!res.ok) process.exitCode = 1;
  } else if (cmd === "stop") {
    const res = stopService();
    console.log(res.message);
    if (!res.ok) process.exitCode = 1;
  } else if (cmd === "status" || cmd === "list") {
    console.log(formatServiceReport(cmd === "list"));
  } else if (cmd === "run") {
    await runServiceLoop();
  } else if (cmd === "install") {
    const res = installServiceAtLogon();
    console.log(res.message);
    if (!res.ok) process.exitCode = 1;
  } else if (cmd === "uninstall") {
    const res = uninstallServiceAtLogon();
    console.log(res.message);
    if (!res.ok) process.exitCode = 1;
  } else {
    console.error(`Commande service inconnue « ${cmd} ». Utilisez start, stop, status, list, run, install ou uninstall.`);
    process.exitCode = 1;
  }
}

// The web hub: what `smol --web` serves. One local HTTP server hosting many
// sessions across many workspaces — the browser page shows them in a sidebar
// and can start, resume, switch between, close and delete them. All sessions
// share one SSE stream (events are tagged with a session id) and one random
// URL token; the server binds to loopback only.
//
// Sessions are saved under ~/.smolcoder/sessions/ as they run, so the sidebar
// survives a restart and any past session can be resumed. A second
// `smol --web` started elsewhere finds the running hub through
// ~/.smolcoder/web.json and adds its folder there instead of starting a
// second server.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "../agent";
import { type Attachment, classifyUpload, extOf, MAX_UPLOAD_BYTES, mimeForExt, safeName } from "../attachments";
import { queryIndex } from "../codeindex";
import { DATA_DIR, loadConfig } from "../config";
import { ContextManager } from "../context";
import { applyOp, type CrdOp, docFromText } from "../crdt";
import { EventBus } from "../events";
import {
  gitApplyHunk,
  gitBlame,
  gitCommit,
  gitDiffFiles,
  gitRevertFile,
  gitStage,
  gitStageLines,
  gitStatusMap,
  gitSyncStatus,
  gitUnstage,
} from "../git";
import { appendSmolLog, readRecentLogs } from "../logger";
import { installLspServer } from "../lsp-install";
import { LSP_LANGS, lspAvailability, queryCode, queryDiagStructured, serverDefForLang } from "../lsp-pro";
import { loadMcpConfig, setMcpEnabled } from "../mcp";
import { Plan } from "../plan";
import { resolveInWorkspace, SandboxError } from "../sandbox";
import { noBackendsMessage, prepareModel, Session, type SessionPrefs, type SessionSnapshot, setupWithoutLocalModels } from "../session";
import { describeSkills, readDelegateStats } from "../skills";
import { buildStatusReport, invalidateBuildCheck, runBuildCheck } from "../status";
import { delegatePrompt, loadSubagentRoles, type SubagentRole } from "../subagents";
import { CoworkBoard } from "../tools/cowork";
import type { ToolContext } from "../tools/index";
import { findLiveShell, liveShellList } from "../tools/shell";
import type { AgentUI } from "../ui";
import { tryFetchJson } from "../util";
import { workspaceDiagnostics } from "../workspace-diagnostics";
import { searchWorkspace } from "../workspace-search";
import { type Event, SessionChannel, uploadUrl } from "./channel";
import { renderEditDiff } from "./diff";
import { PAGE_HTML } from "./page";
import { type SessionMeta, SessionStore, WorkspaceStore, workspaceKey } from "./store";
import { collectSessionOverview } from "./system-metrics";
import { Terminal } from "./terminal";

export type SessionFactory = (ui: SessionChannel, workspace: string, prefs: SessionPrefs, planKey?: string) => Promise<Session>;

/** Session ids are short hex and upload ids are 16 hex chars. Both end up in
 * file paths under the data folder, so nothing else is accepted. */
const SESSION_ID_RE = /^[a-z0-9_-]{1,64}$/i;
const UPLOAD_ID_RE = /^[a-f0-9]{16}$/;
const WEB_FILE_CAP = 512 * 1024;
const WEB_TREE_CAP = 800;
/** Limite du listing @fichier (mention composer). */
const WEB_FILES_CAP = 4000;

/** A NUL byte in the first 4 KB marks a binary file: treating it as text
 * (read or write) would corrupt it. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
/** Sous-dossiers ignorés par le listing @fichier (blocage perf). */
const AT_FILE_SKIP = /^(node_modules|dist|build|coverage|out|target|\.next|\.nuxt|\.turbo|\.cache|vendor)$/i;
/** Budget d'une passe MCP rapide. Mesure locale : à 20 000 ms tout le monde
 * sauf « browse » (cold start uvx) répond, donc 30 000 ms laisse la marge aux
 * premiers lancements npx sans retarder l'affichage du Centre de Contrôle. */
const MCP_PROBE_MS = 30_000;

/** Durée de validité d'une réponse MCP servie depuis le cache. */
const MCP_TTL_MS = 60_000;

/** État transitoire des serveurs MCP : la configuration du dossier existe déjà,
 * mais la session (donc son pont MCP) n'est pas encore née. Sans ce repli, le
 * Centre de Contrôle affichait « 0/0 joignables · aucun serveur configuré »
 * pendant tout le démarrage, ce qui est faux : chaque serveur configuré repart
 * ici en « démarrage… » (ambre) et le vrai sondage reprend dès que la session
 * a créé son pont. */
type PendingMcpRow = { name: string; ok: boolean; tools?: unknown[]; error?: string; retrying?: boolean };

function pendingMcpRows(workspace: string): PendingMcpRow[] {
  return loadMcpConfig(workspace).map((cfg) =>
    cfg.enabled === false
      ? { name: cfg.name, ok: false, error: "désactivé (enabled: false)" }
      : { name: cfg.name, ok: false, retrying: true }
  );
}

export interface HubOptions {
  port: number;
  /** Interface to listen on. Default "127.0.0.1" (this machine only).
   * "0.0.0.0" exposes the LAN — the ?k= token stays the only key (no password). */
  host?: string;
  prefs: SessionPrefs;
  help: string;
  version: string;
  dataDir?: string;
  /** Builds a live Session for a workspace (tests inject a fake). */
  factory?: SessionFactory;
  /** No stdout chatter (tests). */
  quiet?: boolean;
}

interface Live {
  id: string;
  workspace: string;
  channel: SessionChannel;
  session: Session | null;
  meta: SessionMeta;
  error: string | null;
  /** Snapshot to restore when a failed start is retried. */
  pendingRestore: SessionSnapshot | null;
  terminals: Map<string, Terminal>;
  /** Files uploaded for the next message, by id, until that message is sent. */
  uploads: Map<string, Attachment>;
  saveTimer: NodeJS.Timeout | null;
  saving: boolean;
  dirty: boolean;
  /** Set when the user deleted the session: never write it back. */
  discard: boolean;
  /** Model-written title attempts so far (bounded). */
  titleTries: number;
  /** The user renamed it by hand: never overwrite that. */
  titleByUser: boolean;
  saveFailed?: boolean;
}

// ---- the running-hub record -----------------------------------------------

export interface HubRecord {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
  /** Code version that started it — a second `smol --web` warns instead of
   * silently attaching new folders to an outdated hub. */
  version?: string;
}

const HUB_FILE = "web.json";

export function readHubRecord(dataDir = DATA_DIR): HubRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dataDir, HUB_FILE), "utf8"));
    if (r && typeof r.port === "number" && typeof r.token === "string") return r;
  } catch {
    /* none */
  }
  return null;
}

function writeHubRecord(rec: HubRecord, dataDir: string): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, HUB_FILE);
    fs.writeFileSync(file, JSON.stringify(rec), { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort on Windows */
    }
  } catch {
    /* non-fatal: a second smol --web will just start its own server */
  }
}

function clearHubRecord(pid: number, dataDir: string): void {
  const rec = readHubRecord(dataDir);
  if (rec && rec.pid === pid) {
    try {
      fs.unlinkSync(path.join(dataDir, HUB_FILE));
    } catch {
      /* gone */
    }
  }
}

/** Is the hub a previous invocation recorded still answering? */
export async function pingHub(rec: HubRecord): Promise<boolean> {
  const r = await tryFetchJson(`http://127.0.0.1:${rec.port}/ping?k=${rec.token}`, undefined, 1500);
  return !!r?.ok;
}

/** Version + boot time of the running hub (null when unreachable). */
export async function hubVersion(rec: HubRecord): Promise<{ version: string; startedAt: number } | null> {
  try {
    const r = await tryFetchJson(`http://127.0.0.1:${rec.port}/ping?k=${rec.token}`, undefined, 1500);
    if (!r?.ok) return null;
    return {
      version: typeof r.version === "string" ? r.version : "?",
      startedAt: typeof r.startedAt === "number" ? r.startedAt : 0,
    };
  } catch {
    return null;
  }
}

/** Ask a running hub to add a workspace (and optionally start a session). */
export function askHubToOpen(rec: HubRecord, workspace: string, start: boolean): Promise<{ id?: string; path?: string } | null> {
  return tryFetchJson(
    `http://127.0.0.1:${rec.port}/workspaces/add?k=${rec.token}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: workspace, start }),
    },
    5000
  );
}

// ---- helpers ----------------------------------------------------------------

function tilde(p: string): string {
  const home = os.homedir();
  const same = process.platform === "win32" ? p.slice(0, home.length).toLowerCase() === home.toLowerCase() : p.startsWith(home);
  return same ? `~${p.slice(home.length).replace(/\\/g, "/")}` : p;
}

function expandHome(s: string): string {
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
  return s;
}

const PROJECT_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "AGENTS.md", "pom.xml", "Gemfile"];
function isProject(dir: string): boolean {
  return PROJECT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)));
}

let rootsCache: { at: number; roots: string[] } | null = null;
function listRoots(): string[] {
  if (rootsCache && Date.now() - rootsCache.at < 60_000) return rootsCache.roots;
  let roots: string[];
  if (process.platform === "win32") {
    roots = [];
    for (let i = 67; i <= 90; i++) {
      // C: through Z:; A:/B: are floppy letters and slow to probe
      const r = `${String.fromCharCode(i)}:\\`;
      try {
        if (fs.existsSync(r)) roots.push(r);
      } catch {
        /* skip */
      }
    }
  } else {
    roots = ["/"];
  }
  rootsCache = { at: Date.now(), roots };
  return roots;
}

const SKIP_DIRS = /^(node_modules|\$recycle\.bin|system volume information|windows|program files( \(x86\))?|programdata|appdata)$/i;

/** Folder listing for the "open folder" picker. Exported for tests. */
export function browseDir(input: string | null | undefined): Record<string, any> {
  const home = os.homedir();
  const target = input?.trim() ? path.resolve(expandHome(input.trim())) : home;
  const roots = listRoots();
  const base = { path: target, display: tilde(target), home, roots };
  let st: fs.Stats;
  try {
    st = fs.statSync(target);
  } catch {
    return { ...base, error: `not a folder: ${target}`, parent: path.dirname(target), dirs: [] };
  }
  if (!st.isDirectory()) return { ...base, error: `not a folder: ${target}`, parent: path.dirname(target), dirs: [] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err: any) {
    return { ...base, error: `cannot read ${target}: ${err?.message ?? err}`, parent: path.dirname(target), dirs: [] };
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .slice(0, 500)
    .map((e) => {
      const full = path.join(target, e.name);
      let project = false;
      try {
        project = isProject(full);
      } catch {
        /* unreadable */
      }
      return { name: e.name, path: full, project };
    });
  const parent = path.dirname(target);
  return { ...base, parent: parent === target ? null : parent, dirs, project: isProject(target) };
}

/** Flat list of workspace-relative paths for the "@file" composer mention.
 * Read-only, depth-limited and capped so a huge monorepo cannot stall the
 * browser; symlinks are never followed (readdir Dirent says isSymbolicLink). */
export function listWorkspaceFiles(root: string): string[] {
  const out: string[] = [];
  const stack: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: "", depth: 0 }];
  while (stack.length && out.length < WEB_FILES_CAP) {
    const cur = stack.pop();
    if (!cur) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= WEB_FILES_CAP) break;
      if (e.name.startsWith(".") || AT_FILE_SKIP.test(e.name)) continue;
      if (e.isDirectory()) {
        if (cur.depth >= 8) continue;
        stack.push({ dir: path.join(cur.dir, e.name), rel: cur.rel ? `${cur.rel}/${e.name}` : e.name, depth: cur.depth + 1 });
      } else if (e.isFile()) {
        out.push(cur.rel ? `${cur.rel}/${e.name}` : e.name);
      }
    }
  }
  out.sort();
  return out;
}

function defaultFactory(help: string): SessionFactory {
  return async (ui, workspace, prefs, planKey) => {
    const cfg = loadConfig();
    let chosen: Awaited<ReturnType<typeof prepareModel>> = null;
    try {
      chosen = await prepareModel(prefs, cfg, (label) => ui.startSpinner(label));
    } finally {
      // A thrown config error must never leave the spinner frozen: the page
      // would look hung while the real cause is only a missing model server.
      ui.stopSpinner();
    }
    // Nothing on this computer: the page offers to look on the network.
    if (!chosen) chosen = await setupWithoutLocalModels(ui, prefs);
    if (!chosen) throw new Error(noBackendsMessage());
    return new Session(ui, { workspace, chosen, prefs, cfg, help, hubRec: null, planKey });
  };
}

/** System prompt for the bounded inline-edit agent: read-only tools, one
 * fenced replacement block out, nothing written anywhere (the user applies
 * the preview explicitly). */
const INLINE_SYSTEM = `You are a precise, professional code-editing assistant (Cursor-style inline editor). You receive one marked section of one file plus an instruction.
Rules: read the file section first if you need context; respect domain business logic and clean architecture; reply with ONLY one fenced code block containing the COMPLETE replacement lines — no prose, no explanations, no second block.`;

/** Swallow every UI callback: inline edits must not pollute the transcript. */
function silentUI(): AgentUI {
  const noop = () => {};
  return {
    token: noop,
    thinking: noop,
    toolCall: noop,
    toolResult: noop,
    println: noop,
    status: noop,
    warn: noop,
    error: noop,
    startSpinner: noop,
    stopSpinner: noop,
    confirmCommand: async () => "no" as const,
    turnEnd: noop,
    planUpdated: noop,
  };
}

// ---- the hub ----------------------------------------------------------------

export class WebHub {
  readonly authToken: string;
  readonly dataDir: string;
  port: number;

  private server: http.Server | null = null;
  private clients = new Set<http.ServerResponse>();
  /** Read-only followers: one SSE stream per shared session. */
  private sharedClients = new Set<{ res: http.ServerResponse; sid: string }>();
  /** Share tokens: token -> session id (read-only live follow). */
  private shares = new Map<string, { sid: string; createdAt: number }>();
  /** Presence: session id -> viewer name -> last ping. */
  private viewers = new Map<string, Map<string, number>>();
  /** Live cursors: session id -> name -> file + line (30s expiry, no persist). */
  private cursors = new Map<string, Map<string, { name: string; path: string; line: number; at: number }>>();
  /** Collab docs: workspace + path -> CRDT chars (rebuilt from disk on open). */
  private editDocs = new Map<string, { chars: any[]; seen: string[]; version: number; at: number }>();
  /** Inline-edit jobs: op id -> status (polled, single consumer). */
  private inlineJobs = new Map<string, { at: number; status: string; result?: any; error?: string }>();
  private live = new Map<string, Live>();
  /** Dernier état MCP connu, par dossier : le Centre de Contrôle lit ceci
   * immédiatement pendant que le sondage (jusqu'à 30 s) tourne en tâche de
   * fond. Sans ce cache, chaque /status attendait le sondage complet et toute
   * l'interface se figeait (une seule ligne, interrupteurs inertes, outils
   * jamais rafraîchis). */
  private mcpSnap = new Map<string, { rows: PendingMcpRow[]; at: number }>();
  /** Une seule passe de sondage MCP à la fois. */
  private mcpBusy = new Set<string>();
  private metas = new Map<string, SessionMeta>();
  private store: SessionStore;
  private workspaces: WorkspaceStore;
  private factory: SessionFactory;
  private hubTimer: NodeJS.Timeout | null = null;
  private termCounter = 0;
  private stopped = false;
  /** Wall-clock boot time, exposed so the UI can show staleness. */
  private bootedAt = Date.now();

  constructor(private opts: HubOptions) {
    this.port = opts.port;
    this.dataDir = opts.dataDir ?? DATA_DIR;
    // Lien stable : le token survit aux redémarrages (fichier 0600 déjà
    // existant). Fini les liens morts à chaque redémarrage.
    let prev: HubRecord | null = null;
    try {
      prev = readHubRecord(this.dataDir);
    } catch {
      /* none */
    }
    this.authToken =
      prev && typeof prev.token === "string" && prev.token.length >= 8 ? prev.token : crypto.randomBytes(9).toString("base64url");
    this.store = new SessionStore(this.dataDir);
    this.workspaces = new WorkspaceStore(this.dataDir);
    for (const m of this.store.listMetas()) this.metas.set(m.id, m);
    this.factory = opts.factory ?? defaultFactory(opts.help);
  }

  url(): string {
    return `http://127.0.0.1:${this.port}/?k=${this.authToken}`;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.route(req, res));
      this.server = server;
      server.once("error", reject);
      server.listen(this.opts.port, this.opts.host || "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") this.port = addr.port;
        writeHubRecord(
          { port: this.port, token: this.authToken, pid: process.pid, startedAt: this.bootedAt, version: this.opts.version },
          this.dataDir
        );
        resolve();
      });
    });
  }

  /** Synchronous teardown for exit paths: save what has something to save,
   * kill background tasks and terminals, drop the running-hub record. */
  shutdownSync(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const live of this.live.values()) {
      if (live.saveTimer) clearTimeout(live.saveTimer);
      try {
        if (!live.discard && live.session && live.channel.title) this.saveSync(live);
      } catch {
        /* best effort */
      }
      live.session?.taskManager.killAll();
      try {
        live.session?.toolCtx.mcp?.closeAll();
      } catch {
        /* best effort */
      }
      for (const t of live.terminals.values()) t.close();
    }
    clearHubRecord(process.pid, this.dataDir);
    for (const c of this.clients) c.end();
    this.server?.close();
  }

  close(): void {
    this.shutdownSync();
  }

  private log(s: string): void {
    if (!this.opts.quiet) console.log(s);
    appendSmolLog("info", s);
  }

  // ---- sessions ---------------------------------------------------------------

  addWorkspace(p: string): void {
    this.workspaces.add(p);
    this.changed();
  }

  /** Start a new session in a workspace; returns its id right away while the
   * model is detected and loaded in the background. */
  openSession(workspace: string): string {
    const id = crypto.randomBytes(4).toString("hex");
    this.workspaces.add(workspace);
    const now = Date.now();
    const live = this.makeLive(id, { id, workspace, title: "", createdAt: now, updatedAt: now });
    void this.spawn(live, null);
    this.changed();
    return id;
  }

  /** Bring a saved session back to life (or retry one that failed to start). */
  resumeSession(id: string): boolean {
    const existing = this.live.get(id);
    if (existing) {
      if (existing.error) void this.spawn(existing, existing.pendingRestore);
      return true;
    }
    const meta = this.metas.get(id);
    if (!meta) return false;
    const body = this.store.loadBody(id);
    const live = this.makeLive(id, meta);
    live.channel.title = meta.title;
    if (body) {
      live.channel.restoreReplay(body.events);
      for (const ev of live.channel.replay) this.send(ev);
    }
    this.workspaces.add(meta.workspace);
    void this.spawn(live, body?.snapshot ?? null);
    this.changed();
    return true;
  }

  closeSession(id: string): boolean {
    const live = this.live.get(id);
    if (!live) return false;
    if (!live.session) {
      // Still starting (or failed to start): there is no loop to unwind.
      live.channel.close();
      this.dropLive(live);
      return true;
    }
    live.channel.cancel();
    live.channel.requestExit();
    return true;
  }

  deleteSession(id: string): void {
    const live = this.live.get(id);
    if (live) {
      live.discard = true;
      this.closeSession(id);
    }
    this.store.delete(id);
    this.metas.delete(id);
    try {
      fs.rmSync(this.uploadsDir(id), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    this.changed();
  }

  renameSession(id: string, title: string): void {
    title = title.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!title) return;
    const live = this.live.get(id);
    if (live) {
      live.channel.title = title;
      live.meta.title = title;
      live.titleByUser = true;
      live.channel.pushState();
      this.scheduleSave(live);
    }
    const meta = this.metas.get(id);
    if (meta) {
      meta.title = title;
      try {
        this.store.saveMeta(meta);
      } catch {
        /* non-fatal */
      }
    }
    this.changed();
  }

  /** Forget a workspace and delete its saved sessions. Returns an error
   * message when it still has open sessions. */
  removeWorkspace(p: string): string | null {
    const key = workspaceKey(p);
    for (const live of this.live.values()) {
      if (workspaceKey(live.workspace) === key) return "close its open sessions first";
    }
    for (const m of [...this.metas.values()]) {
      if (workspaceKey(m.workspace) === key) {
        this.store.delete(m.id);
        this.metas.delete(m.id);
      }
    }
    this.workspaces.remove(p);
    this.changed();
    return null;
  }

  private makeLive(id: string, meta: SessionMeta): Live {
    const channel = new SessionChannel(id, {
      send: (ev) => this.send(ev),
      changed: () => this.changed(),
      touched: (sid) => this.touched(sid),
    });
    const live: Live = {
      id,
      workspace: meta.workspace,
      channel,
      session: null,
      meta,
      error: null,
      pendingRestore: null,
      terminals: new Map(),
      uploads: new Map(),
      saveTimer: null,
      saving: false,
      dirty: false,
      discard: false,
      // A saved session already has a name; only fresh ones get one written.
      titleTries: meta.title ? 99 : 0,
      titleByUser: false,
    };
    this.live.set(id, live);
    return live;
  }

  /** After the first turn: replace the verbatim first-message title with a
   * short model-written one. Bounded retries, never over a manual rename. */
  private async autoTitle(live: Live): Promise<void> {
    if (!live.session || live.titleByUser || live.titleTries >= 2) return;
    live.titleTries++;
    const title = await live.session.suggestTitle();
    if (!title || live.titleByUser || live.channel.closed || this.live.get(live.id) !== live) return;
    live.channel.title = title;
    live.meta.title = title;
    live.channel.pushState();
    this.changed();
    this.scheduleSave(live);
  }

  private async spawn(live: Live, restore: SessionSnapshot | null): Promise<void> {
    live.error = null;
    live.pendingRestore = restore;
    live.channel.phase = "starting";
    this.changed();
    let prefs: SessionPrefs = this.opts.prefs;
    if (restore) {
      // A saved bypass mode is not inherited silently, same as the config:
      // the user re-enables it per session.
      const mode = restore.mode === "bypass" ? "edit" : (restore.mode ?? prefs.mode);
      prefs = {
        ...prefs,
        mode,
        backend: restore.backend,
        model: restore.model ?? prefs.model,
        baseUrl: restore.baseUrl,
        effort: restore.effort !== undefined ? restore.effort : prefs.effort,
      };
    }
    try {
      let session: Session;
      try {
        session = await this.factory(live.channel, live.workspace, prefs, live.id);
      } catch (firstErr: any) {
        // Si le modèle précis de l'ancienne session est introuvable, repli immédiat sur le modèle par défaut actuel
        if (restore && (prefs.model !== this.opts.prefs.model || prefs.backend !== this.opts.prefs.backend)) {
          const fallbackPrefs = {
            ...prefs,
            model: this.opts.prefs.model,
            backend: this.opts.prefs.backend,
            baseUrl: this.opts.prefs.baseUrl,
          };
          session = await this.factory(live.channel, live.workspace, fallbackPrefs, live.id);
          live.channel.warn(
            `Le modèle enregistré (${restore.model || "inconnu"}) n'était plus disponible — session reprise avec ${session.chosen.id}`
          );
        } else {
          throw firstErr;
        }
      }
      if (live.channel.closed || this.live.get(live.id) !== live) {
        session.taskManager.killAll();
        return;
      }
      live.session = session;
      session.onExit = () => this.sessionEnded(live.id);
      session.onTurnDone = () => void this.autoTitle(live);
      live.channel.getState = () => session.state();
      if (restore) session.restore(restore);
      live.meta.model = session.chosen.id;
      live.meta.backend = session.chosen.backend;
      session.announce();
      if (restore) {
        live.channel.status(
          `· session resumed${restore.mode === "bypass" ? " in edit mode (bypass is not restored)" : ""} — earlier command approvals are not remembered`
        );
      }
      this.log(`  ● ${live.id} · ${tilde(live.workspace)} · ${session.chosen.id}`);
      this.changed();
      session.run().catch((err) => live.channel.error(String(err?.message ?? err)));
    } catch (err: any) {
      live.error = String(err?.message ?? err);
      live.channel.phase = "error";
      live.channel.error(live.error);
      live.channel.warn("Start a backend, then click this session in the sidebar to retry.");
      this.changed();
    }
  }

  private sessionEnded(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    if (!live.discard && live.session && live.channel.title) {
      try {
        this.saveSync(live);
      } catch {
        /* best effort */
      }
    }
    this.dropLive(live);
    this.log(`  ○ ${id} closed`);
  }

  private dropLive(live: Live): void {
    if (live.saveTimer) {
      clearTimeout(live.saveTimer);
      live.saveTimer = null;
    }
    for (const t of live.terminals.values()) t.close();
    live.terminals.clear();
    if (this.live.get(live.id) === live) this.live.delete(live.id);
    this.send({ t: "closed", sid: live.id });
    this.changed();
  }

  // ---- saving -----------------------------------------------------------------

  private touched(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    live.meta.updatedAt = Date.now();
    this.scheduleSave(live);
  }

  private scheduleSave(live: Live): void {
    live.dirty = true;
    if (live.saveTimer) return;
    live.saveTimer = setTimeout(() => {
      live.saveTimer = null;
      void this.save(live);
    }, 1500);
  }

  private async save(live: Live): Promise<void> {
    // Untitled sessions (nothing sent yet) are not worth a file.
    if (!live.session || live.discard || !live.channel.title) return;
    if (live.saving) {
      live.dirty = true;
      return;
    }
    live.saving = true;
    live.dirty = false;
    try {
      live.meta.title = live.channel.title;
      this.metas.set(live.id, live.meta);
      this.store.saveMeta(live.meta);
      await this.store.saveBody(live.id, { snapshot: live.session.snapshot(), events: live.channel.replay });
      live.saveFailed = false;
    } catch (err: any) {
      if (!live.saveFailed) {
        live.saveFailed = true;
        live.channel.warn(
          `Session could not be saved: ${err?.message ?? err}. Keep this session open and check free disk space and permissions.`
        );
      }
    }
    live.saving = false;
    if (live.dirty) this.scheduleSave(live);
  }

  private saveSync(live: Live): void {
    if (!live.session) return;
    live.meta.title = live.channel.title;
    this.metas.set(live.id, live.meta);
    this.store.saveMeta(live.meta);
    this.store.saveBodySync(live.id, { snapshot: live.session.snapshot(), events: live.channel.replay });
  }

  // ---- terminals --------------------------------------------------------------

  openTerminal(sid: string): { tid: string; cwd: string } | null {
    const live = this.live.get(sid);
    if (!live) return null;
    const tid = `t${++this.termCounter}`;
    this.send({ t: "termopen", sid, tid, cwd: live.workspace });
    const term = new Terminal(
      tid,
      live.workspace,
      {
        output: (text) => this.send({ t: "term", sid, tid, s: text }),
        done: (code, cwd) => this.send({ t: "termdone", sid, tid, code, cwd }),
      },
      live.workspace
    );
    live.terminals.set(tid, term);
    this.changed();
    return { tid, cwd: term.cwd };
  }

  closeTerminal(sid: string, tid: string): void {
    const live = this.live.get(sid);
    const t = live?.terminals.get(tid);
    if (!live || !t) return;
    t.close();
    live.terminals.delete(tid);
    this.send({ t: "termclosed", sid, tid });
    this.changed();
  }

  // ---- broadcasting -----------------------------------------------------------

  private send(ev: Event): void {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const c of this.clients) c.write(line);
    // Read-only followers only get events tagged with their session id —
    // the hub snapshot (all workspaces) never leaks to a share token.
    const sid = (ev as any)?.sid;
    if (typeof sid === "string" && sid) {
      this.sharedClients.forEach((s) => {
        if (s.sid !== sid) return;
        try {
          s.res.write(line);
        } catch {
          /* closed — removed on req close */
        }
      });
    }
  }

  /** Coalesced: many status flips in one tick produce one snapshot. */
  private changed(): void {
    if (this.hubTimer) return;
    this.hubTimer = setTimeout(() => {
      this.hubTimer = null;
      this.send(this.snapshot());
    }, 25);
  }

  /** What the sidebar shows. Exported through the SSE stream and /ping. */
  snapshot(): Event {
    const groups = new Map<string, { path: string; sessions: any[]; last: number }>();
    const group = (p: string) => {
      const key = workspaceKey(p);
      let g = groups.get(key);
      if (!g) {
        g = { path: p, sessions: [], last: 0 };
        groups.set(key, g);
      }
      return g;
    };
    for (const w of this.workspaces.list()) {
      const g = group(w.path);
      g.last = Math.max(g.last, w.lastOpened);
    }
    for (const m of this.metas.values()) {
      if (this.live.has(m.id)) continue;
      group(m.workspace).sessions.push({
        id: m.id,
        title: m.title,
        status: "stored",
        live: false,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        model: m.model,
        terminals: [],
      });
    }
    for (const l of this.live.values()) {
      group(l.workspace).sessions.push({
        id: l.id,
        title: l.channel.title || l.meta.title,
        status: l.channel.phase,
        live: true,
        createdAt: l.meta.createdAt,
        updatedAt: l.meta.updatedAt,
        model: l.meta.model,
        terminals: [...l.terminals.values()].map((t) => ({ tid: t.id, cwd: t.cwd })),
        viewers: this.sessionViewers(l.id),
        plan: typeof (l.session as any)?.planLine === "function" ? (l.session as any).planLine() : null,
        editing: this.sessionEditing(l.id),
      });
    }
    const workspaces = [...groups.values()]
      .map((g) => {
        g.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
        const last = Math.max(g.last, ...g.sessions.map((s) => s.updatedAt));
        return { path: g.path, name: path.basename(g.path) || g.path, display: tilde(g.path), last, sessions: g.sessions };
      })
      .sort((a, b) => b.last - a.last);
    return { t: "hub", home: os.homedir(), sep: path.sep, version: this.opts.version, startedAt: this.bootedAt, workspaces };
  }

  /** Names watching a session right now (pings older than 60s are pruned). */
  private sessionViewers(sid: string): string[] {
    const now = Date.now();
    const map = this.viewers.get(sid);
    if (!map) return [];
    const out: string[] = [];
    map.forEach((seen, name) => {
      if (now - seen > 60_000) map.delete(name);
      else out.push(name);
    });
    if (!map.size) this.viewers.delete(sid);
    return out.sort().slice(0, 20);
  }

  /** Who is editing which file right now (cursors younger than 30s). */
  private sessionEditing(sid: string): Array<{ name: string; path: string; line: number }> {
    const now = Date.now();
    const map = this.cursors.get(sid);
    if (!map) return [];
    const out: Array<{ name: string; path: string; line: number }> = [];
    map.forEach((c, name) => {
      if (now - c.at > 30_000) map.delete(name);
      else out.push({ name, path: c.path, line: c.line });
    });
    if (!map.size) this.cursors.delete(sid);
    return out.slice(0, 10);
  }

  // ---- http ---------------------------------------------------------------------

  /** Value of the HttpOnly cookie that keeps the HTML preview authorized after
   * ?k= has been stripped from its URL. The previewed HTML runs on this
   * origin, so it must never be able to read the hub token itself. */
  private previewGrant(): string {
    return crypto.createHmac("sha256", this.authToken).update("preview").digest("hex");
  }

  /** Value of the HttpOnly cookie that re-authorizes the app after the client
   * strips ?k= from the address bar. Without it F5 (and any clean bookmark)
   * would come back as 403: the token is gone from the URL, and the page has
   * not run yet to attach it to its requests. It carries an HMAC, never the
   * token itself, and SameSite=Strict keeps other origins from sending it. */
  private webGrant(): string {
    return crypto.createHmac("sha256", this.authToken).update("web").digest("hex");
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    // req.url is attacker-controlled: forms like "//" throw here and, without
    // this guard, took the whole hub process down with no token required.
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad request");
      return;
    }
    // The workspace HTML preview renders inside the app's iframe; nothing else
    // on this origin may be framed.
    res.setHeader("X-Frame-Options", url.pathname === "/workspace/preview" ? "SAMEORIGIN" : "DENY");
    const origin = req.headers.origin;
    // Same-machine spellings always pass; when listening on the LAN, the
    // browser's own host:port (Host header) passes too — the ?k= token
    // remains the only key, no password involved.
    const host = String(req.headers.host ?? "");
    const sameOrigin =
      !origin ||
      origin === `http://127.0.0.1:${this.port}` ||
      origin === `http://localhost:${this.port}` ||
      (host !== "" && origin === `http://${host}`);
    // Once the preview exchanged ?k= for its HttpOnly cookie, that cookie alone
    // re-authorizes /workspace/preview (Path-scoped: it never travels to any
    // other endpoint).
    const cookieList = String(req.headers.cookie ?? "")
      .split(/;\s*/)
      .filter(Boolean);
    const previewAuth = url.pathname === "/workspace/preview" && cookieList.includes(`smpv=${this.previewGrant()}`);
    // ?k= on this request, or the cookie minted by an earlier one: the client
    // drops ?k= from the address bar right after boot, so a reload must still
    // be able to get in. Cookie checks stay behind sameOrigin.
    const kOk = url.searchParams.get("k") === this.authToken && sameOrigin;
    const cookieAuth = sameOrigin && cookieList.includes(`smolk=${this.webGrant()}`);
    if (!kOk && !cookieAuth && !previewAuth) {
      // Share links carry their own secret (the share token): viewers never
      // see the hub token. Every /shared endpoint re-validates it.
      const sharedPath = url.pathname === "/shared" || url.pathname === "/shared/ping";
      if (!sharedPath) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("forbidden — open smolcoder's printed URL (it includes the session key)");
        return;
      }
    }
    if (kOk) {
      res.setHeader("Set-Cookie", `smolk=${this.webGrant()}; Path=/; HttpOnly; SameSite=Strict`);
    }
    const json = (code: number, body: any) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET") {
      switch (url.pathname) {
        case "/":
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(PAGE_HTML);
          return;
        case "/ping":
          json(200, { ok: true, pid: process.pid, version: this.opts.version, startedAt: this.bootedAt });
          return;
        case "/logs":
          json(200, { logs: readRecentLogs(200, url.searchParams.get("workspace") || undefined) });
          return;
        case "/events":
          this.sse(req, res);
          return;
        case "/shared":
          this.sharedSse(req, res, url);
          return;
        case "/shared/ping": {
          try {
            json(200, this.sharedPing(String(url.searchParams.get("k") ?? ""), String(url.searchParams.get("name") ?? "")));
          } catch (err: any) {
            json(403, { error: String(err?.message ?? err).slice(0, 300) });
          }
          return;
        }
        case "/fs":
          json(200, browseDir(url.searchParams.get("path")));
          return;
        case "/upload":
          this.serveUpload(res, url);
          return;
        case "/workspace/tree": {
          try {
            json(200, this.workspaceTree(url.searchParams.get("sid"), url.searchParams.get("path")));
          } catch (err: any) {
            json(200, { entries: [], path: url.searchParams.get("path") || ".", error: String(err?.message ?? err) });
          }
          return;
        }
        case "/workspace/search": {
          const sid = String(url.searchParams.get("sid") ?? "");
          const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
          if (!live) {
            json(404, { error: "no such session" });
            return;
          }
          try {
            json(
              200,
              searchWorkspace(live.workspace, String(url.searchParams.get("q") ?? ""), {
                path: String(url.searchParams.get("path") ?? "."),
                maxMatches: 200,
              })
            );
          } catch (err: any) {
            json(400, { error: String(err?.message ?? err) });
          }
          return;
        }
        case "/workspace/files": {
          const sid = String(url.searchParams.get("sid") ?? "");
          const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
          const meta = this.metas.get(sid);
          const ws = live?.workspace ?? meta?.workspace;
          if (!ws) {
            json(404, { error: "no such session or workspace" });
            return;
          }
          try {
            json(200, { files: listWorkspaceFiles(ws) });
          } catch (err: any) {
            json(200, { files: [], error: String(err?.message ?? err).slice(0, 300) });
          }
          return;
        }
        case "/workspace/diagnostics": {
          const sid = String(url.searchParams.get("sid") ?? "");
          const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
          if (!live) {
            json(404, { error: "no such session" });
            return;
          }
          void workspaceDiagnostics(live.workspace, url.searchParams.get("path"))
            .then((result) => json(200, result))
            .catch((err: any) => json(400, { error: String(err?.message ?? err).slice(0, 500) }));
          return;
        }
        case "/code/lsp": {
          const sid = String(url.searchParams.get("sid") ?? "");
          const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
          if (!live) {
            json(404, { error: "no such session" });
            return;
          }
          const num = (v: string | null): number | undefined => {
            const n = Number(v);
            return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
          };
          void queryCode(live.workspace, {
            action: url.searchParams.get("action") ?? "diag",
            path: url.searchParams.get("path") ?? undefined,
            line: num(url.searchParams.get("line")),
            col: num(url.searchParams.get("col")),
            new_text: url.searchParams.get("new_text") ?? undefined,
            query: url.searchParams.get("query") ?? undefined,
            lang: url.searchParams.get("lang") ?? undefined,
          })
            .then((result) => json(200, { result }))
            .catch((err: any) => json(400, { error: String(err?.message ?? err).slice(0, 500) }));
          return;
        }
        case "/code/symbols": {
          const sid = String(url.searchParams.get("sid") ?? "");
          const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
          if (!live) {
            json(404, { error: "no such session" });
            return;
          }
          try {
            const q = String(url.searchParams.get("q") ?? "");
            json(200, { result: queryIndex(live.workspace, q ? { action: "search", query: q } : { action: "stats" }) });
          } catch (err: any) {
            json(400, { error: String(err?.message ?? err).slice(0, 500) });
          }
          return;
        }
        case "/code/availability": {
          try {
            // exts lets the page route any catalogue language to its server
            // instead of hardcoding a short list of extensions.
            json(200, {
              servers: lspAvailability().map((a) => ({
                ...a,
                exts: serverDefForLang(a.lang)?.exts ?? [],
              })),
            });
          } catch (err: any) {
            json(400, { error: String(err?.message ?? err).slice(0, 500) });
          }
          return;
        }
        case "/code/diag-structured": {
          const sid = String(url.searchParams.get("sid") ?? "");
          const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
          if (!live) {
            json(404, { error: "no such session" });
            return;
          }
          const rel = String(url.searchParams.get("path") ?? "");
          if (!rel) {
            json(400, { error: "path is required" });
            return;
          }
          void queryDiagStructured(live.workspace, rel)
            .then((result) => json(200, result))
            .catch((err: any) => json(400, { error: String(err?.message ?? err).slice(0, 500) }));
          return;
        }
        case "/code/diff": {
          const sid = String(url.searchParams.get("sid") ?? "");
          const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
          if (!live) {
            json(404, { error: "no such session" });
            return;
          }
          try {
            json(200, gitDiffFiles(live.workspace, url.searchParams.get("staged") === "1"));
          } catch (err: any) {
            json(400, { error: String(err?.message ?? err).slice(0, 500) });
          }
          return;
        }
        case "/git/status": {
          const sid = String(url.searchParams.get("sid") ?? "");
          const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
          if (!live) {
            json(404, { error: "no such session" });
            return;
          }
          json(200, { sync: gitSyncStatus(live.workspace) });
          return;
        }
        case "/session/overview": {
          const sid = String(url.searchParams.get("sid") ?? "");
          const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
          if (!live) {
            json(404, { error: "no such session" });
            return;
          }
          void collectSessionOverview(live.workspace, live.session?.taskManager.runningSummary().length ?? 0)
            .then((overview) => json(200, overview))
            .catch((err: any) => json(500, { error: String(err?.message ?? err).slice(0, 300) }));
          return;
        }
        case "/git/blame": {
          const sid = String(url.searchParams.get("sid") ?? "");
          const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
          if (!live) {
            json(404, { error: "no such session" });
            return;
          }
          const file = String(url.searchParams.get("path") ?? "");
          const line = Number(url.searchParams.get("line"));
          if (!file) {
            json(400, { error: "path is required" });
            return;
          }
          const result = gitBlame(live.workspace, file, Number.isInteger(line) && line > 0 ? line : undefined);
          if (result.startsWith("Error:")) json(400, { error: result });
          else json(200, { result });
          return;
        }
        case "/shell/live": {
          // What the offload card counts down against: real deadlines.
          json(200, { items: liveShellList() });
          return;
        }
        case "/code/inline/result": {
          const id = String(url.searchParams.get("id") ?? "");
          const job = this.inlineJobs.get(id);
          if (!job) {
            json(404, { error: "unknown edit job" });
            return;
          }
          if (job.status === "running" && Date.now() - job.at > 10 * 60 * 1000) {
            this.inlineJobs.delete(id);
            json(200, { status: "error", error: "edit job expired" });
            return;
          }
          if (job.status === "running") {
            json(200, { status: "running" });
            return;
          }
          this.inlineJobs.delete(id);
          if (job.status === "done") json(200, { status: "done", ...(job.result ?? {}) });
          else json(200, { status: "error", error: job.error ?? "edit failed" });
          return;
        }
        case "/plan": {
          const sid = String(url.searchParams.get("sid") ?? "");
          const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
          if (!live) {
            json(404, { error: "no such session" });
            return;
          }
          try {
            json(200, this.planView(live));
          } catch (err: any) {
            json(400, { error: String(err?.message ?? err).slice(0, 500) });
          }
          return;
        }
        case "/edit/doc": {
          const sid = String(url.searchParams.get("sid") ?? "");
          const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
          if (!live) {
            json(404, { error: "no such session" });
            return;
          }
          try {
            const rel = String(url.searchParams.get("path") ?? "");
            const rec = this.editDocs.get(this.editKey(live.workspace, rel));
            if (!rec) throw new Error("open the file for collaboration first (open it in the editor)");
            json(200, { version: rec.version, chars: rec.chars });
          } catch (err: any) {
            json(400, { error: String(err?.message ?? err).slice(0, 500) });
          }
          return;
        }
        case "/workspace/file":
          this.workspaceFile(res, url);
          return;
        case "/workspace/asset":
          this.workspaceAsset(res, url);
          return;
        case "/workspace/preview": {
          const sid = String(url.searchParams.get("sid") ?? "");
          const rel = String(url.searchParams.get("path") ?? "");
          const kOk = url.searchParams.get("k") === this.authToken && sameOrigin;
          const cookieOk = String(req.headers.cookie ?? "")
            .split(/;\s*/)
            .includes(`smpv=${this.previewGrant()}`);
          if (!kOk && !cookieOk) {
            json(403, { error: "forbidden" });
            return;
          }
          const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
          if (!live) {
            json(404, { error: "no such session" });
            return;
          }
          if (kOk) {
            // Swap the hub token in the URL for an HttpOnly cookie: the page
            // we are about to serve is user HTML running on this origin, and
            // location.search would hand it the full hub key.
            res.writeHead(302, {
              "set-cookie": `smpv=${this.previewGrant()}; Path=/workspace/preview; HttpOnly; SameSite=Strict`,
              location: `/workspace/preview?sid=${encodeURIComponent(sid)}&path=${encodeURIComponent(rel)}`,
            });
            res.end();
            return;
          }
          try {
            const abs = resolveInWorkspace(live.workspace, rel);
            const st = fs.statSync(abs);
            if (!st.isFile() || st.size > 2 * 1024 * 1024) throw new Error("preview file must be a regular file under 2 MB");
            const ext = path.extname(abs).toLowerCase();
            if (![".html", ".htm"].includes(ext)) throw new Error("only HTML files can be previewed locally");
            res.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "content-security-policy": "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
              "x-content-type-options": "nosniff",
            });
            res.end(fs.readFileSync(abs));
          } catch (err: any) {
            json(400, { error: String(err?.message ?? err).slice(0, 500) });
          }
          return;
        }
        case "/status":
          this.statusReport(url)
            .then((r) => json(200, r))
            .catch((err) => json(200, { error: String(err?.message ?? err) }));
          return;

        default:
          res.writeHead(404);
          res.end();
          return;
      }
    }
    if (req.method === "POST") {
      if (url.pathname === "/upload") {
        this.receiveUpload(req, res, url);
        return;
      }
      // Accumulate raw chunks: coercing Buffer→string per chunk would cut any
      // multi-byte UTF-8 character that straddles a chunk boundary.
      const chunks: Buffer[] = [];
      let bodyBytes = 0;
      let tooLarge = false;
      req.on("data", (d: Buffer) => {
        bodyBytes += d.length;
        if (bodyBytes > 1_000_000) {
          // Reply 413 once and keep draining: destroy() cut the socket before
          // the response flushed, so the client only saw a connection reset.
          if (!tooLarge) {
            tooLarge = true;
            chunks.length = 0;
            res.writeHead(413, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "request body too large (1 MB max)" }));
          }
          return;
        }
        chunks.push(d);
      });
      req.on("end", async () => {
        if (tooLarge) return;
        const body = Buffer.concat(chunks).toString("utf8");
        let data: any = {};
        try {
          data = body ? JSON.parse(body) : {};
        } catch {
          json(400, { error: "invalid JSON body" });
          return;
        }
        try {
          json(200, (await this.handlePost(url.pathname, data)) ?? {});
        } catch (err: any) {
          json(400, { error: String(err?.message ?? err) });
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  }

  private sse(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const write = (ev: Event) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    write(this.snapshot());
    for (const l of this.live.values()) {
      for (const ev of l.channel.replay) write(ev);
      write(l.channel.stateEvent());
      for (const t of l.terminals.values()) {
        write({ t: "termopen", sid: l.id, tid: t.id, cwd: t.cwd });
        if (t.buffer) write({ t: "term", sid: l.id, tid: t.id, s: t.buffer });
      }
    }
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
  }

  /** Read-only live follow: the session replay plus its future events, and
   * nothing else — no sidebar, no terminals of other sessions, no control. */
  private sharedSse(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const token = String(url.searchParams.get("k") ?? "");
    const share = this.shares.get(token);
    if (!share) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("unknown or expired share — ask the owner for a fresh link");
      return;
    }
    // The link alone is enough: the session comes from the token itself.
    const sid = String(url.searchParams.get("sid") ?? "") || share.sid;
    const live = share.sid === sid && SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
    if (!live) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("unknown or expired share — ask the owner for a fresh link");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const write = (ev: Event) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    write({ t: "shared", sid: live.id, title: live.channel.title || live.meta.title });
    for (const ev of live.channel.replay) write(ev);
    write(live.channel.stateEvent());
    const entry = { res, sid: live.id };
    this.sharedClients.add(entry);
    req.on("close", () => this.sharedClients.delete(entry));
  }

  /** Mint a read-only follow token for a live session. */
  private shareSession(sid: string): { token: string } {
    if (!SESSION_ID_RE.test(sid) || !this.live.has(sid)) throw new Error("no such session");
    const token = crypto.randomBytes(16).toString("hex");
    this.shares.set(token, { sid, createdAt: Date.now() });
    if (this.shares.size > 50) {
      const first = this.shares.keys().next();
      if (!first.done) this.shares.delete(first.value);
    }
    return { token };
  }

  /** A viewer announces itself; presence shows in the sidebar snapshot. */
  private sharedPing(token: string, name: string): { sid: string } {
    const share = this.shares.get(String(token ?? ""));
    if (!share || !this.live.has(share.sid)) {
      throw new Error("unknown or expired share — ask the owner for a fresh link");
    }
    const viewer =
      String(name ?? "")
        .trim()
        .slice(0, 40) || "anonymous";
    let map = this.viewers.get(share.sid);
    if (!map) {
      map = new Map();
      this.viewers.set(share.sid, map);
    }
    map.set(viewer, Date.now());
    this.changed();
    return { sid: share.sid };
  }

  // ---- attachments ---------------------------------------------------------

  private uploadsDir(sid: string): string {
    return path.join(this.dataDir, "uploads", sid);
  }

  /** One file for a live session, sent as the raw request body with the name
   * in the query string (a pasted screenshot has no name; the page makes one). */
  private receiveUpload(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const reply = (code: number, body: any) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const sid = String(url.searchParams.get("sid") ?? "");
    const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
    if (!live) {
      reply(404, { error: "no such session" });
      req.resume();
      return;
    }
    const name = safeName(url.searchParams.get("name"));
    const mime = String(req.headers["content-type"] ?? "application/octet-stream")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (d: Buffer) => {
      if (failed) return;
      size += d.length;
      if (size > MAX_UPLOAD_BYTES) {
        if (!failed) {
          failed = true;
          reply(413, { error: `"${name}" is larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB upload limit.` });
          // No req.destroy(): destroying right after replying reset the socket
          // before the 413 flushed. Drain the rest instead.
        }
        return;
      }
      chunks.push(d);
    });
    req.on("end", () => {
      if (failed) return;
      const bytes = Buffer.concat(chunks);
      const verdict = classifyUpload(name, mime, bytes);
      if ("error" in verdict) {
        reply(415, { error: verdict.error });
        return;
      }
      const id = crypto.randomBytes(8).toString("hex");
      const dir = this.uploadsDir(sid);
      const file = path.join(dir, `${id}.${extOf(name, mime)}`);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, bytes);
      } catch (err: any) {
        reply(500, { error: `could not store the upload: ${err?.message ?? err}` });
        return;
      }
      const att: Attachment = { id, name, kind: verdict.kind, mime: verdict.mime, size: bytes.length, path: file };
      live.uploads.set(id, att);
      const model = live.session?.chosen;
      const warning =
        att.kind === "image" && model?.vision === false
          ? `${model.id} cannot see images — switch to a vision-capable model with /models`
          : undefined;
      reply(200, { id, name, kind: att.kind, size: att.size, url: uploadUrl(sid, id), ...(warning ? { warning } : {}) });
    });
  }

  /** A stored upload, for the page's thumbnails and "open" links. */
  private serveUpload(res: http.ServerResponse, url: URL): void {
    const sid = String(url.searchParams.get("sid") ?? "");
    const id = String(url.searchParams.get("id") ?? "");
    const file = SESSION_ID_RE.test(sid) && UPLOAD_ID_RE.test(id) ? this.findUpload(sid, id) : null;
    if (!file) {
      res.writeHead(404);
      res.end();
      return;
    }
    // The upload can be deleted between lookup and open (session removed
    // mid-load): without try/error handlers either step killed the hub.
    try {
      res.writeHead(200, { "content-type": mimeForExt(path.extname(file).slice(1)), "content-length": fs.statSync(file).size });
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    fs.createReadStream(file)
      .on("error", () => res.destroy())
      .pipe(res);
  }

  private findUpload(sid: string, id: string): string | null {
    const dir = this.uploadsDir(sid);
    try {
      const entry = fs.readdirSync(dir).find((f) => f.startsWith(`${id}.`));
      return entry ? path.join(dir, entry) : null;
    } catch {
      return null;
    }
  }

  /** The user took a chip off the composer: forget the file. */
  private removeUpload(live: Live, id: string): void {
    const att = live.uploads.get(id);
    live.uploads.delete(id);
    const file = att?.path ?? (UPLOAD_ID_RE.test(id) ? this.findUpload(live.id, id) : null);
    if (!file) return;
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  }

  private checkDir(p: any): string {
    const s = String(p ?? "").trim();
    if (!s) throw new Error("path is required");
    const abs = path.resolve(expandHome(s));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`not a folder: ${abs}`);
    return abs;
  }

  private async handlePost(p: string, d: any): Promise<any> {
    const sid = String(d.sid ?? "");
    const live = () => {
      let l = this.live.get(sid);
      if (!l && sid && this.metas.has(sid)) {
        if (this.resumeSession(sid)) {
          l = this.live.get(sid);
        }
      }
      if (!l) throw new Error("no such session");
      return l;
    };
    switch (p) {
      case "/msg": {
        const l = live();
        const ids: string[] = Array.isArray(d.attachments) ? d.attachments.map(String) : [];
        const attachments = ids.map((id) => l.uploads.get(id));
        if (attachments.some((a) => !a)) throw new Error("an attachment is no longer available — add it again");
        for (const id of ids) l.uploads.delete(id);
        if (d.workItemId !== undefined && typeof d.workItemId !== "string") throw new Error("invalid Cowork work item ID");
        l.channel.handleMessage(String(d.text ?? ""), attachments as Attachment[], d.workItemId as string | undefined);
        return {};
      }
      case "/upload/remove":
        this.removeUpload(live(), String(d.id ?? ""));
        return {};
      case "/confirm":
        live().channel.handleAnswer(Number(d.id), d.answer);
        return {};
      case "/select":
        live().channel.handleAnswer(Number(d.id), d.index);
        return {};
      case "/prompt":
        live().channel.handleAnswer(Number(d.id), typeof d.value === "string" ? d.value : null);
        return {};
      case "/cycle": {
        const l = live();
        l.channel.onModeCycle?.();
        l.channel.refresh();
        return {};
      }
      case "/check": {
        // Runs the project's own check command for real, on demand. The status
        // rail used to claim "validation en cours" forever; this gives the
        // client something honest to display and a way to re-run it.
        const l = live();
        invalidateBuildCheck(l.workspace);
        const check = runBuildCheck(l.workspace);
        return { check };
      }
      case "/mcp/toggle": {
        const l = live();
        const name = String(d.name ?? "").trim();
        if (!name) throw new Error("mcp: missing server name");
        const verb = d.verb === "on" || d.verb === "off" ? d.verb : "toggle";
        const message = setMcpEnabled(l.workspace, name, verb);
        // The 60 s health cache would keep showing the old "hors ligne" state
        // after an activation — drop it so the next status() probes fresh.
        l.session?.toolCtx?.mcp?.invalidate?.(name);
        this.mcpSnap.delete(l.workspace);
        return { message };
      }
      case "/mcp/debug": {
        const l = live();
        const name = String(d.name ?? "").trim();
        if (!name) throw new Error("mcp: missing server name");
        const timeoutMs = Number(d.timeoutMs) > 0 ? Number(d.timeoutMs) : undefined;
        // debugServer lives on the per-session bridge, not on the module, so
        // probe the very same client the agent is using.
        const bridge = l.session?.toolCtx?.mcp;
        if (!bridge) throw new Error("mcp: no MCP bridge for this session");
        return { message: await bridge.debugServer(name, timeoutMs) };
      }
      case "/cancel": {
        const l = live();
        l.channel.cancel();
        if (l.session) {
          l.session.agent.cancel();
          l.session.taskManager.killAll();
        }
        return {};
      }
      case "/sessions/new":
        return { id: this.openSession(this.checkDir(d.workspace)) };
      case "/sessions/resume":
        if (!this.resumeSession(String(d.id ?? ""))) throw new Error("unknown session");
        return { id: d.id };
      case "/sessions/close":
        this.closeSession(String(d.id ?? ""));
        return {};
      case "/sessions/delete":
        this.deleteSession(String(d.id ?? ""));
        return {};
      case "/sessions/rename":
        this.renameSession(String(d.id ?? ""), String(d.title ?? ""));
        return {};
      case "/workspaces/add": {
        const ws = this.checkDir(d.path);
        this.workspaces.add(ws);
        this.changed();
        return d.start ? { path: ws, id: this.openSession(ws) } : { path: ws };
      }
      case "/workspaces/remove": {
        const err = this.removeWorkspace(String(d.path ?? ""));
        if (err) throw new Error(err);
        return {};
      }
      case "/term/open": {
        const r = this.openTerminal(sid);
        if (!r) throw new Error("no such session");
        return r;
      }
      case "/term/input": {
        const t = live().terminals.get(String(d.tid ?? ""));
        if (!t) throw new Error("no such terminal");
        t.write(String(d.text ?? ""));
        return {};
      }
      case "/term/interrupt": {
        const t = live().terminals.get(String(d.tid ?? ""));
        if (!t) throw new Error("no such terminal");
        t.interrupt();
        return {};
      }
      case "/term/close":
        this.closeTerminal(sid, String(d.tid ?? ""));
        return {};
      case "/agents/draft": {
        const l = live();
        return this.agentDraft(l.workspace, String(d.role ?? ""), String(d.task ?? ""));
      }
      case "/work/items": {
        const l = live();
        if (!l.session) throw new Error("session is not ready");
        if (d.action !== "list" && l.session.agent.mode === "ro") {
          throw new Error("creating or changing work items is unavailable in read-only mode");
        }
        const board = new CoworkBoard(l.workspace);
        const result = d.action === "complete" ? await board.completeWorkItem(String(d.task_id ?? "")) : await board.run(d);
        if (result.startsWith("Error:")) throw new Error(result);
        if (d.action !== "list") l.session.toolCtx.filesTouched.add(".smol/work-items.json");
        return { result, items: board.items() };
      }
      case "/workspace/file":
        return this.saveWorkspaceFile(sid, d);
      case "/workspace/file/new":
        return this.createWorkspaceEntry(sid, d);
      case "/workspace/file/rename":
        return this.renameWorkspaceEntry(sid, d);
      case "/workspace/file/delete":
        return this.deleteWorkspaceEntry(sid, d);
      case "/plan/done": {
        const l = live();
        const plan = (l.session as any)?.toolCtx?.plan;
        if (!plan || typeof plan.markDone !== "function") throw new Error("no plan in this session");
        const step = d.step === undefined || d.step === null ? undefined : Number(d.step);
        const message = plan.markDone(step);
        if (typeof message === "string" && message.startsWith("Error")) throw new Error(message);
        this.changed();
        return { message, plan: this.planView(l) };
      }
      case "/cursor": {
        const l = live();
        const name =
          String(d.name ?? "")
            .trim()
            .slice(0, 40) || "anonymous";
        const rel = String(d.path ?? "")
          .trim()
          .slice(0, 200);
        const line = Math.max(1, Number(d.line) || 1);
        let map = this.cursors.get(l.id);
        if (!map) {
          map = new Map();
          this.cursors.set(l.id, map);
        }
        if (rel) map.set(name, { name, path: rel, line, at: Date.now() });
        else map.delete(name);
        this.changed();
        return {};
      }
      case "/edit/open": {
        const l = live();
        return this.openEditDoc(l.workspace, String(d.path ?? ""), l.id);
      }
      case "/edit/op": {
        const l = live();
        return this.applyEditOps(l.workspace, String(d.path ?? ""), d.ops, l.id);
      }
      case "/code/diff/hunk": {
        const l = this.editLive(sid);
        const action = String(d.action ?? "");
        if (action !== "stage" && action !== "unstage" && action !== "revert")
          throw new Error('action must be "stage", "unstage" or "revert"');
        return { message: gitApplyHunk(l.workspace, String(d.path ?? ""), Number(d.hunk), action) };
      }
      case "/code/diff/stage": {
        const l = this.editLive(sid);
        const p = String(d.path ?? "");
        if (!p) throw new Error("path is required");
        return { message: gitStage(l.workspace, [p]) };
      }
      // Turns the 37-language catalogue into something usable: the panel can
      // only be trusted when a missing server can be installed from it.
      case "/code/lsp/install": {
        const want = String(d.lang ?? "")
          .trim()
          .toLowerCase();
        if (!want) throw new Error("lang is required");
        if (!LSP_LANGS.includes(want)) {
          throw new Error(`unknown language "${want}" - GET /code/availability lists the supported ones`);
        }
        const l = this.editLive(sid);
        return installLspServer(want, l.workspace);
      }
      case "/code/diff/unstage": {
        const l = this.editLive(sid);
        const p = String(d.path ?? "");
        if (!p) throw new Error("path is required");
        return { message: gitUnstage(l.workspace, [p]) };
      }
      case "/code/diff/stage-lines": {
        const l = this.editLive(sid);
        const p = String(d.path ?? "");
        if (!p) throw new Error("path is required");
        const lines = Array.isArray(d.lines) ? d.lines.map(Number).filter((n: number) => Number.isSafeInteger(n)) : [];
        return { message: gitStageLines(l.workspace, p, Number(d.hunk), lines) };
      }
      case "/code/diff/revert-file": {
        const l = this.editLive(sid);
        const p = String(d.path ?? "");
        if (!p) throw new Error("path is required");
        return { message: gitRevertFile(l.workspace, p) };
      }
      case "/code/commit": {
        const l = this.editLive(sid);
        return { message: gitCommit(l.workspace, String(d.message ?? "")) };
      }
      case "/shell": {
        const command = String(d.command ?? "");
        const ctl = command ? findLiveShell(command) : null;
        if (!ctl) return { ok: false, reason: "that command is no longer running" };
        const action = String(d.action ?? "");
        if (action === "extend") {
          const ok = ctl.extend(Number(d.ms) || 60_000);
          return { ok, deadline: ok ? ctl.deadline : null };
        }
        if (action === "detach") {
          const taskId = ctl.detach();
          return { ok: Boolean(taskId), taskId: taskId ?? null };
        }
        if (action === "cancel") {
          ctl.cancel();
          return { ok: true };
        }
        return { ok: false, reason: 'action must be "extend", "detach" or "cancel"' };
      }
      case "/code/inline/start": {
        const l = live();
        this.prepareInlineEdit(l, d);
        const id = crypto.randomBytes(8).toString("hex");
        this.inlineJobs.set(id, { at: Date.now(), status: "running" });
        if (this.inlineJobs.size > 20) {
          const first = this.inlineJobs.keys().next();
          if (!first.done) this.inlineJobs.delete(first.value);
        }
        void this.runInlineEdit(l, d).then(
          (result) => this.inlineJobs.set(id, { at: Date.now(), status: "done", result }),
          (err: any) => this.inlineJobs.set(id, { at: Date.now(), status: "error", error: String(err?.message ?? err).slice(0, 500) })
        );
        return { op: id };
      }
      case "/sessions/share": {
        const l = live();
        return this.shareSession(l.id);
      }
      default:
        throw new Error(`unknown endpoint ${p}`);
    }
  }

  /** Structured project tree for the web IDE panel. It is deliberately
   * read-only and bounded so a huge monorepo cannot freeze the browser. */
  private workspaceTree(sidRaw: string | null, relRaw: string | null): any {
    const sid = String(sidRaw ?? "");
    const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
    const meta = this.metas.get(sid);
    const ws = live?.workspace ?? meta?.workspace;
    if (!ws) throw new Error("no such session or workspace");
    const rel = String(relRaw ?? "").trim() || ".";
    let abs: string;
    try {
      abs = resolveInWorkspace(ws, rel);
    } catch (err: any) {
      throw new Error(err instanceof SandboxError ? err.message : String(err?.message ?? err));
    }
    const st = fs.statSync(abs);
    if (!st.isDirectory()) throw new Error("not a folder");
    const statusMap = gitStatusMap(ws, abs);
    const entries = fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && !["node_modules", "dist", "build", "coverage", ".git"].includes(e.name))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
      .slice(0, WEB_TREE_CAP)
      .map((e) => {
        const child = path.join(abs, e.name);
        let size = 0;
        let mtimeMs = 0;
        if (!e.isDirectory()) {
          try {
            const cs = fs.statSync(child);
            size = cs.size;
            mtimeMs = cs.mtimeMs;
          } catch {
            /* best effort */
          }
        }
        return {
          name: e.name,
          path: path.relative(ws, child).split(path.sep).join("/") || ".",
          dir: e.isDirectory(),
          status: statusMap.get(e.name) ?? "",
          size,
          mtimeMs,
        };
      });
    return { workspace: ws, path: rel === "." ? "." : path.relative(ws, abs).split(path.sep).join("/"), entries };
  }

  private workspaceFile(res: http.ServerResponse, url: URL): void {
    const sid = String(url.searchParams.get("sid") ?? "");
    const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
    const meta = this.metas.get(sid);
    const ws = live?.workspace ?? meta?.workspace;
    if (!ws) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no such session or workspace" }));
      return;
    }
    let abs: string;
    try {
      abs = resolveInWorkspace(ws, String(url.searchParams.get("path") ?? ""));
      const st = fs.statSync(abs);
      if (st.isDirectory()) throw new Error("not a file");
      if (url.searchParams.get("meta") === "1") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            path: path.relative(ws, abs).split(path.sep).join("/"),
            size: st.size,
            mtimeMs: st.mtimeMs,
          })
        );
        return;
      }
      if (st.size > WEB_FILE_CAP) throw new Error(`file is larger than ${WEB_FILE_CAP} bytes`);
      const buf = fs.readFileSync(abs);
      if (looksBinary(buf)) throw new Error("binary file — it cannot be opened as text");
      const content = buf.toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          path: path.relative(ws, abs).split(path.sep).join("/"),
          content,
          size: st.size,
          mtimeMs: st.mtimeMs,
        })
      );
    } catch (err: any) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof SandboxError ? err.message : String(err?.message ?? err) }));
    }
  }

  /** Serve bounded project images for the file explorer preview. */
  private workspaceAsset(res: http.ServerResponse, url: URL): void {
    const sid = String(url.searchParams.get("sid") ?? "");
    const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
    if (!live) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const abs = resolveInWorkspace(live.workspace, String(url.searchParams.get("path") ?? ""));
      const st = fs.statSync(abs);
      const ext = path.extname(abs).toLowerCase();
      const allowed: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        ".bmp": "image/bmp",
      };
      const mime = allowed[ext];
      if (!st.isFile() || !mime || st.size > 8 * 1024 * 1024) throw new Error("image must be a supported file under 8 MB");
      res.writeHead(200, {
        "content-type": mime,
        "content-length": st.size,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        // SVGs are scripts in disguise: served on the hub origin they could
        // read ?k= from location.search. No scripts, ever.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      });
      // The file can vanish between stat and open: an unhandled stream error
      // here used to kill the whole hub process.
      fs.createReadStream(abs)
        .on("error", () => res.destroy())
        .pipe(res);
    } catch (err: any) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof SandboxError ? err.message : String(err?.message ?? err) }));
    }
  }

  private saveWorkspaceFile(sid: string, d: any): any {
    const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
    if (!live?.session) throw new Error("no such session");
    const mode = live.session.agent.mode;
    if (mode === "ro") throw new Error("workspace is read-only; switch the session to edit mode first");
    const rel = String(d.path ?? "").trim();
    const content = typeof d.content === "string" ? d.content : "";
    if (!rel) throw new Error("path is required");
    // Compare in bytes, not UTF-16 units: 512 000 emoji would pass this check
    // but be rejected on reopen by the byte-based read cap.
    if (Buffer.byteLength(content, "utf8") > WEB_FILE_CAP) throw new Error(`file is larger than ${WEB_FILE_CAP} bytes`);
    let abs: string;
    try {
      abs = resolveInWorkspace(live.workspace, rel);
    } catch (err: any) {
      throw new Error(err instanceof SandboxError ? err.message : String(err?.message ?? err));
    }
    if (d.expectedMtimeMs !== undefined) {
      const expected = Number(d.expectedMtimeMs);
      if (!Number.isFinite(expected)) throw new Error("invalid file version; reload it before saving");
      // 0 means "no version known": comparing against epoch always failed and
      // locked the user out of their own file.
      if (expected > 0) {
        if (!fs.existsSync(abs)) throw new Error("file was removed from disk; reload the folder before saving");
        const current = fs.statSync(abs).mtimeMs;
        if (Math.abs(current - expected) > 1) {
          throw new Error("file changed on disk; reload it before saving");
        }
      }
    }
    // Never let a text save replace a binary file or embed NUL bytes: the
    // utf8 round-trip would silently destroy the original content.
    if (content.includes(String.fromCharCode(0))) throw new Error("content contains NUL bytes - refusing to save it as text");
    if (fs.existsSync(abs) && looksBinary(fs.readFileSync(abs))) {
      throw new Error("file is binary on disk - refusing to overwrite it as text");
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // Write to a temp file then rename: a crash or full disk mid-write would
    // otherwise leave the user's file truncated to zero.
    const tmp = `${abs}.smol-tmp`;
    try {
      fs.writeFileSync(tmp, content, "utf8");
      fs.renameSync(tmp, abs);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* keep the original error */
      }
      throw err;
    }
    live.session.toolCtx.filesTouched.add(rel);
    const st = fs.statSync(abs);
    live.channel.status(`· saved ${rel}`);
    live.channel.refresh();
    return { path: rel, size: st.size, mtimeMs: st.mtimeMs };
  }

  /** Guard for every mutating workspace-file endpoint. */
  private editLive(sid: string): Live & { session: Session } {
    const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
    if (!live?.session) throw new Error("no such session");
    if ((live.session as any)?.agent?.mode === "ro") {
      throw new Error("workspace is read-only; switch the session to edit mode first");
    }
    return live as Live & { session: Session };
  }

  private createWorkspaceEntry(sid: string, d: any): any {
    const live = this.editLive(sid);
    const rel = String(d.path ?? "").trim();
    if (!rel || rel === "." || rel === "/") throw new Error("path is required");
    let abs: string;
    try {
      abs = resolveInWorkspace(live.workspace, rel);
    } catch (err: any) {
      throw new Error(err instanceof SandboxError ? err.message : String(err?.message ?? err));
    }
    if (fs.existsSync(abs)) throw new Error(`"${rel}" already exists`);
    if (d.dir === true) fs.mkdirSync(abs, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, "", "utf8");
    }
    live.session.toolCtx.filesTouched.add(rel);
    live.channel.status(`· created ${rel}`);
    return { path: rel };
  }

  private renameWorkspaceEntry(sid: string, d: any): any {
    const live = this.editLive(sid);
    const from = String(d.path ?? "").trim();
    const to = String(d.to ?? "").trim();
    if (!from || !to) throw new Error("path and to are required");
    let absFrom: string;
    let absTo: string;
    try {
      absFrom = resolveInWorkspace(live.workspace, from);
      absTo = resolveInWorkspace(live.workspace, to);
    } catch (err: any) {
      throw new Error(err instanceof SandboxError ? err.message : String(err?.message ?? err));
    }
    if (!fs.existsSync(absFrom)) throw new Error(`"${from}" does not exist`);
    if (fs.existsSync(absTo)) throw new Error(`"${to}" already exists`);
    fs.mkdirSync(path.dirname(absTo), { recursive: true });
    fs.renameSync(absFrom, absTo);
    live.session.toolCtx.filesTouched.add(to);
    live.channel.status(`· renamed ${from} → ${to}`);
    return { path: to };
  }

  private deleteWorkspaceEntry(sid: string, d: any): any {
    const live = this.editLive(sid);
    const rel = String(d.path ?? "").trim();
    if (!rel || rel === "." || rel === "/") throw new Error("path is required (never the workspace itself)");
    let abs: string;
    try {
      abs = resolveInWorkspace(live.workspace, rel);
    } catch (err: any) {
      throw new Error(err instanceof SandboxError ? err.message : String(err?.message ?? err));
    }
    if (!fs.existsSync(abs)) throw new Error(`"${rel}" does not exist`);
    if (fs.statSync(abs).isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
    else fs.unlinkSync(abs);
    live.session.toolCtx.filesTouched.add(rel);
    live.channel.status(`· deleted ${rel}`);
    return {};
  }

  /** Collab document key: one live doc per workspace file. */
  private editKey(workspace: string, rel: string): string {
    return `${workspace}\n${rel}`;
  }

  private readEditFile(workspace: string, rel: string): { abs: string; text: string } {
    if (!rel || rel === "." || rel === "/") throw new Error("path is required");
    let abs: string;
    try {
      abs = resolveInWorkspace(workspace, rel);
    } catch (err: any) {
      throw new Error(err instanceof SandboxError ? err.message : String(err?.message ?? err));
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new Error(`"${rel}" does not exist`);
    }
    if (!stat.isFile()) throw new Error(`"${rel}" is a folder, not a file`);
    if (stat.size > 256 * 1024) throw new Error(`"${rel}" is too large for live collaboration (256 KB limit)`);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      throw new Error(`could not read "${rel}"`);
    }
    if (looksBinary(buf)) throw new Error(`"${rel}" looks binary — live collaboration needs text`);
    return { abs, text: buf.toString("utf8") };
  }

  /** (Re)bootstrap the shared doc from disk. The file stays authoritative:
   * saves and agent writes converge everyone here. Never throws (route
   * translates Error strings). */
  private openEditDoc(workspace: string, rel: string, sid: string): { text: string; version: number } {
    const { text } = this.readEditFile(workspace, rel);
    const key = this.editKey(workspace, rel);
    const prev = this.editDocs.get(key);
    const doc = docFromText(text);
    this.editDocs.set(key, { chars: doc.chars, seen: [], version: (prev?.version ?? 0) + 1, at: Date.now() });
    if (this.editDocs.size > 20) {
      const first = this.editDocs.keys().next();
      if (!first.done) this.editDocs.delete(first.value);
    }
    const rec = this.editDocs.get(key)!;
    // sid is mandatory: the client drops any event without one, so a
    // rebase/op broadcast without it would never reach the editors.
    this.send({ t: "editrebase", sid, file: rel, version: rec.version });
    return { text, version: rec.version };
  }

  /** Apply broadcast ops to the shared doc and relay the accepted ones.
   * Ops are order-independent (fractional positions), so no version gating. */
  private applyEditOps(workspace: string, rel: string, rawOps: unknown, sid: string): { version: number; applied: number } {
    const key = this.editKey(workspace, rel);
    const rec = this.editDocs.get(key);
    if (!rec) throw new Error("open the file for collaboration first (open it in the editor)");
    if (!Array.isArray(rawOps) || !rawOps.length) throw new Error("ops must be a non-empty array");
    const doc = { chars: rec.chars, seen: rec.seen, counter: 0, site: "hub" };
    const accepted: CrdOp[] = [];
    for (const raw of (rawOps as unknown[]).slice(0, 200)) {
      const op = raw as CrdOp;
      if (!op || (op.op !== "ins" && op.op !== "del")) continue;
      try {
        if (applyOp(doc, op)) accepted.push(op);
      } catch {
        /* malformed op — skip */
      }
    }
    rec.at = Date.now();
    if (!accepted.length) return { version: rec.version, applied: 0 };
    rec.version++;
    this.send({ t: "editop", sid, file: rel, ops: accepted, version: rec.version });
    return { version: rec.version, applied: accepted.length };
  }

  /** Sync validation + file read for an inline edit (throws immediately so
   * the start call fails fast on bad input; the model work stays async). */
  private prepareInlineEdit(live: Live, d: any): { rel: string; instruction: string; selection: string; start: number; end: number } {
    const rel = String(d.path ?? "").trim();
    const instruction = String(d.instruction ?? "").trim();
    const selection = typeof d.selection === "string" ? d.selection : "";
    const start = Math.max(1, Number(d.start) || 1);
    const end = Math.max(start, Number(d.end) || start);
    if (!rel) throw new Error("path is required");
    if (!instruction) throw new Error("instruction is required");
    if (!selection.trim()) throw new Error("select the code to replace first");
    if (selection.length > 8000) throw new Error("selection too large (8000 chars max) — narrow it");
    try {
      resolveInWorkspace(live.workspace, rel);
    } catch (err: any) {
      throw new Error(err instanceof SandboxError ? err.message : String(err?.message ?? err));
    }
    return { rel, instruction, selection, start, end };
  }

  /** One bounded inline edit: a read-only sub-agent generates the
   * replacement, the caller previews and applies it explicitly. Never
   * throws (route translates Error strings). */
  private async runInlineEdit(live: Live, d: any): Promise<any> {
    const session = live.session as any;
    const agent = session?.agent;
    if (!session || !agent) throw new Error("no such session");
    if (agent.mode === "ro") throw new Error("read-only session — switch to edit mode for inline edits");
    const rel = String(d.path ?? "").trim();
    const instruction = String(d.instruction ?? "").trim();
    const selection = typeof d.selection === "string" ? d.selection : "";
    const start = Math.max(1, Number(d.start) || 1);
    const end = Math.max(start, Number(d.end) || start);
    if (!rel) throw new Error("path is required");
    if (!instruction) throw new Error("instruction is required");
    if (!selection.trim()) throw new Error("select the code to replace first");
    if (selection.length > 8000) throw new Error("selection too large (8000 chars max) — narrow it");
    let abs: string;
    try {
      abs = resolveInWorkspace(live.workspace, rel);
    } catch (err: any) {
      throw new Error(err instanceof SandboxError ? err.message : String(err?.message ?? err));
    }
    let disk: string;
    try {
      disk = fs.readFileSync(abs, "utf8");
    } catch {
      throw new Error(`could not read "${rel}"`);
    }
    const lines = disk.split("\n");
    const from = Math.max(1, start - 20);
    const to = Math.min(lines.length, end + 20);
    const context = lines.slice(from - 1, to).join("\n");
    const ext = path.extname(rel).slice(1) || "txt";
    const toolCtx: ToolContext = {
      workspace: live.workspace,
      taskManager: session.toolCtx.taskManager,
      plan: new Plan(),
      filesTouched: new Set<string>(),
      commandsRun: [],
      canWrite: false,
      allowedTools: new Set(["read_file", "symbols", "index_symbols", "search", "list_files"]),
      depth: 1,
      role: "inline",
    };
    const provider = agent.provider;
    const mgr = new ContextManager(provider.contextWindow, provider.maxOutputTokens);
    const inline = new Agent(provider, "ro", INLINE_SYSTEM, toolCtx, mgr, new EventBus(), silentUI(), false, 6);
    const task =
      `File: ${rel} (lines ${start}-${end} of ${lines.length}).\n\nMarked section to replace:\n${selection}\n\n` +
      `Surrounding code for context (lines ${from}-${to}):\n${context}\n\nInstruction: ${instruction}\n\n` +
      `Reply with ONLY one fenced ${ext} block containing the COMPLETE replacement lines.`;
    await inline.runTurn(task);
    if (inline.outcome !== "completed") {
      throw new Error("the model did not produce a replacement — try a shorter selection or simpler instruction");
    }
    const last = [...inline.messages].reverse().find((m) => m.role === "assistant" && (m.content ?? "").trim());
    let newText = "";
    const m = /```(?:[\w.+#-]+)?\s*\n([\s\S]*?)```/.exec(last?.content ?? "");
    if (m) {
      newText = m[1].replace(/\n$/, "");
    } else {
      const raw = (last?.content ?? "").trim();
      if (raw && !raw.startsWith("I ") && !raw.startsWith("Here")) {
        newText = raw;
      } else {
        throw new Error("the model did not return a code block — rephrase the instruction");
      }
    }
    return { oldText: selection, newText, startLine: start, endLine: end, diff: renderEditDiff(selection, newText) };
  }

  /** Serializable plan for the checklist tab. Never throws. */
  private planView(live: Live): {
    exists: boolean;
    steps: Array<{ text: string; done: boolean }>;
    current: number;
    done: number;
    total: number;
  } {
    try {
      const plan = (live.session as any)?.toolCtx?.plan;
      if (!plan || !Array.isArray(plan.steps)) return { exists: false, steps: [], current: -1, done: 0, total: 0 };
      const steps = plan.steps
        .filter((s: any) => s && typeof s.text === "string")
        .map((s: any) => ({ text: String(s.text).slice(0, 300), done: !!s.done }));
      const current = typeof plan.currentIndex === "number" ? plan.currentIndex : steps.findIndex((s: any) => !s.done);
      const done = steps.filter((s: any) => s.done).length;
      return { exists: steps.length > 0, steps: steps.slice(0, 20), current, done, total: steps.length };
    } catch {
      return { exists: false, steps: [], current: -1, done: 0, total: 0 };
    }
  }
  /** Everything the IDE control centre needs about one live session. Kept off
   * the hot SSE path: the page asks for it when the panel opens. */
  /** Statut MCP instantané : sert le dernier état connu (ou les lignes
   * « démarrage… » tant qu'aucun résultat n'existe) et lance le sondage réel
   * en arrière-plan, une seule passe à la fois, résultat gardé 60 s. */
  private mcpStatusFor(live: Live): () => Promise<PendingMcpRow[]> {
    const ws = live.workspace;
    const id = live.id;
    const start = () => {
      if (this.mcpBusy.has(ws)) return;
      const bridge = this.live.get(id)?.session?.toolCtx?.mcp;
      if (!bridge) return;
      this.mcpBusy.add(ws);
      bridge
        .status(MCP_PROBE_MS)
        .then((rows) => this.mcpSnap.set(ws, { rows: rows as PendingMcpRow[], at: Date.now() }))
        .catch(() => undefined)
        .finally(() => this.mcpBusy.delete(ws));
    };
    return () => {
      const snap = this.mcpSnap.get(ws);
      if (snap && Date.now() - snap.at < MCP_TTL_MS) return Promise.resolve(snap.rows);
      start();
      return Promise.resolve(snap?.rows ?? pendingMcpRows(ws));
    };
  }

  private async statusReport(url: URL): Promise<any> {
    const sid = String(url.searchParams.get("sid") ?? "");
    const live = SESSION_ID_RE.test(sid) ? this.live.get(sid) : undefined;
    if (!live) return { error: "no such session" };
    const session = live.session;
    // Same builder as the CLI /status: the terminal, the page and Electron
    // read one function, so the three surfaces cannot drift apart.
    const report = await buildStatusReport({
      workspace: live.workspace,
      modelId: session?.chosen?.id,
      backend: session?.chosen?.backend,
      host: session?.chosen?.host,
      effort: session?.agent?.provider?.effortLabel?.() ?? undefined,
      mode: session?.agent?.mode,
      contextTokens: session?.agent?.contextTokens?.() ?? 0,
      contextWindow: session?.chosen?.contextWindow,
      mcpStatus: this.mcpStatusFor(live),
    });
    // Keep the established web contract alongside the shared status shape.
    // Older Electron/web panels consume these fields directly while newer
    // clients use the compact report above.
    let skills: any[] = [];
    try {
      skills = describeSkills(live.workspace);
    } catch {
      skills = [];
    }
    const tools = (session?.agent?.tools ?? []).map((t: any) => ({
      name: String(t.name ?? ""),
      description: String(t.description ?? "")
        .split("\n")[0]
        .slice(0, 220),
    }));
    let workItems: ReturnType<CoworkBoard["items"]> = [];
    let workItemsError = "";
    try {
      workItems = new CoworkBoard(live.workspace).items();
    } catch (error) {
      workItemsError = String((error as Error)?.message ?? error).slice(0, 300);
    }
    return {
      ...report,
      t: "status",
      sid: live.id,
      version: this.opts.version,
      state: session?.state() ?? {},
      tools,
      workItems,
      workItemsError,
      skills,
      skillsActive: live.channel.skillsActive,
      subagents: {
        ...report.subagents,
        roles: loadSubagentRoles(live.workspace),
        running: live.channel.subagentActive,
        runs: live.channel.subagentRuns,
        stats: readDelegateStats(live.workspace),
      },
      runtime: report.system,
      c3: {
        enabled: fs.existsSync(path.join(live.workspace, ".c3")) || fs.existsSync(path.join(os.homedir(), ".c3")),
        workspace: fs.existsSync(path.join(live.workspace, ".c3")),
        artifacts: fs.existsSync(path.join(live.workspace, ".c3", "agent_artifacts")),
        memory: fs.existsSync(path.join(live.workspace, ".c3", "file_memory")),
        cacheFiles: (() => {
          try {
            return fs.readdirSync(path.join(live.workspace, ".c3", "cache")).length;
          } catch {
            return 0;
          }
        })(),
        indexedBytes: (() => {
          try {
            return fs.statSync(path.join(live.workspace, ".c3", "index", "index.sqlite")).size;
          } catch {
            return 0;
          }
        })(),
      },
    };
  }

  /** The delegation message for a role. subagents.ts stays the single source of
   * truth so the IDE, the TUI and the CLI all say the same thing. */
  private agentDraft(workspace: string, roleName: string, task: string): any {
    const clean = task.trim();
    if (!clean) throw new Error("écrivez la tâche à déléguer");
    const wanted = String(roleName ?? "")
      .trim()
      .toLowerCase();
    const role = loadSubagentRoles(workspace).find((r: SubagentRole) => r.name === wanted);
    if (!role) throw new Error(`rôle de sous-agent inconnu : ${roleName}`);
    return { role: role.name, title: role.role, text: delegatePrompt(role, clean) };
  }
}

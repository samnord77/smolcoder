// One session = one workspace + one agent + one UI, plus the input loop and
// slash commands that drive it. Extracted from the CLI entry point so the
// terminal TUI and the web hub (many sessions side by side, one per browser
// sidebar entry) run exactly the same loop.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "./agent";
import { type Attachment, MAX_UPLOAD_BYTES, mimeForExt } from "./attachments";
import type { BrowserLiveShot } from "./browser";
import { listCustomCommands, loadCustomCommand } from "./commands";
import { type Config, effortForBackend, loadConfig, updateConfig } from "./config";
import { ContextManager } from "./context";
import { type DetectedModel, detectAll, envKeyFor, isFlagshipBase, keyAllowed, resolveContextWindow } from "./detect";
import { EventBus } from "./events";
import { FileHistory } from "./file-history";
import { formatReview } from "./git";
import { hostUrls } from "./hosts";
import { lspDoctor, setupLsp } from "./lsp-install";
import { queryCode } from "./lsp-pro";
import { createMcpBridge, setMcpEnabled } from "./mcp";
import { type FlowUI, findModelsOnNetwork, manageHosts } from "./network";
import { Plan, type PlanStep } from "./plan";
import { loadPlugins } from "./plugins";
import { buildSystemPrompt, loadAgentsMd, loadMemoryMd } from "./prompt";
import { LmStudioProvider } from "./providers/lmstudio";
import { OllamaProvider } from "./providers/ollama";
import type { Effort, Msg, Provider } from "./providers/types";
import { RoutingProvider, routeProvider } from "./router";
import { describeCadence, RoutineBook } from "./routines";
import { resolveInWorkspace } from "./sandbox";
import { serviceStatus } from "./service";
import { listSkills, readSkill, saveSkill } from "./skills";
import { buildStatusReport, renderStatusText } from "./status";
import { CoworkBoard } from "./tools/cowork";
import { readFile } from "./tools/fs-tools";
import { MODE_LABELS, type Mode, type ToolContext } from "./tools/index";
import { pickShell, runCommand } from "./tools/shell";
import { TaskManager } from "./tools/tasks";
import { renderPlan, type SelectOption, type SessionUI, type SlashCommand } from "./ui";
import { c, truncateEnd, truncateMiddle } from "./util";

/** Per-session preferences from the command line. `effort: null` means an
 * explicit "default"; undefined means "whatever the config remembers". */
export interface SessionPrefs {
  mode?: Mode;
  model?: string;
  backend?: string;
  /** Server the wanted model lives on, when the same id exists on several machines. */
  baseUrl?: string;
  ctx?: number;
  effort?: Effort | null;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "models", desc: "Switch model · add models from other machines" },
  { name: "model", desc: "Switch directly — /model <id>" },
  { name: "mode", desc: "Set mode (ro / edit / auto / bypass)" },
  { name: "effort", desc: "Set reasoning effort" },
  { name: "plan", desc: "Show the agent's plan" },
  { name: "todo", desc: "Show the agent's task list (same as /plan)" },
  { name: "review", desc: "Code review — /review (the agent reviews and reports) · /review diff|staged (raw hunks)" },
  { name: "diag", desc: "Language-server diagnostics — /diag src/agent.ts" },
  { name: "doctor", desc: "Language-server health + install — /doctor install" },
  { name: "route", desc: "Model route and failover status" },
  { name: "context", desc: "Show context usage" },
  { name: "compact", desc: "Compact the conversation now" },
  { name: "tasks", desc: "List background tasks" },
  { name: "logs", desc: "Show task output — /logs t1" },
  { name: "stop", desc: "Stop a background task — /stop t1" },
  { name: "mcp", desc: "MCP servers: green/red lights + tools" },
  { name: "status", desc: "One report: model, MCP, language servers, build, system" },
  { name: "skills", desc: "Saved skills, incl. built-ins" },
  { name: "skill", desc: "Read or save a skill — /skill read <name> · /skill save <name> <text>" },
  { name: "clear", desc: "Reset the conversation" },
  { name: "undo", desc: "Undo the last file write" },
  { name: "redo", desc: "Redo the undone file write" },
  { name: "rewind", desc: "Restore files to before a turn — /rewind lists, /rewind <n> restores" },
  { name: "routine", desc: "Scheduled prompts — /routine add every 30m | check the build" },
  { name: "autopilot", desc: "Autonomous mission — /autopilot <goal> loops on its own plan until done, /autopilot stop" },
  { name: "editor", desc: "Write your message in $EDITOR" },
  { name: "export", desc: "Export the conversation to markdown" },
  { name: "copy", desc: "Copy the last assistant reply to the clipboard" },
  { name: "fetch", desc: "Read a public web page, no key — /fetch https://…" },
  { name: "help", desc: "Show help" },
  { name: "exit", desc: "Quit smolcoder (web: close this session)" },
];

export const MODE_ORDER: Mode[] = ["ro", "edit", "auto", "bypass"];

// ---- model selection helpers (shared with the headless path) --------------

/** Output budget scales with the window: big windows can afford whole-file
 * writes (a single write_file's JSON must fit in the output), tiny windows
 * must stay conservative. */
export function outputBudget(window: number): number {
  return Math.max(128, Math.min(8192, Math.floor(window / 4)));
}

/** Bearer key for this model's server: attached by detection when the host
 * stores one, else looked up from the saved host serving the same address. */
function apiKeyFor(m: DetectedModel): string | undefined {
  // Never attach a key to a plain-http address outside this machine: every
  // chat request would carry the user's OpenRouter/Gemini key in clear text.
  if (!keyAllowed(m.baseUrl)) return undefined;
  if (m.apiKey) return m.apiKey;
  const env = envKeyFor(m.baseUrl);
  if (env) return env;
  const hosts = loadConfig().hosts ?? [];
  for (const h of hosts) {
    if (h.apiKey && hostUrls(h).includes(m.baseUrl)) return h.apiKey;
  }
  return undefined;
}

/** Short name of the server behind a model, used in provider labels and
 * error text. Blaming LM Studio for an OpenRouter quota 429 sends the user
 * to the wrong machine. */
function serverNameFor(baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "lmstudio";
  }
  if (host.endsWith("openrouter.ai")) return "OpenRouter";
  if (host.endsWith("generativelanguage.googleapis.com")) return "Gemini";
  if (isFlagshipBase(baseUrl)) return "FlagshipRouter";
  if (host === "localhost" || host.startsWith("127.") || host === "::1") return "lmstudio";
  return host;
}

export function makeProvider(m: DetectedModel): Provider {
  const maxOut = outputBudget(m.contextWindow);
  return m.backend === "ollama"
    ? new OllamaProvider(m.baseUrl, m.id, m.contextWindow, m.numCtx, maxOut, m.vision)
    : new LmStudioProvider(m.baseUrl, m.id, m.contextWindow, maxOut, m.reasoning, m.vision, apiKeyFor(m), serverNameFor(m.baseUrl));
}

/** One-line advice when the effective reasoning setting will be slow: LM
 * Studio applies the model's own default level when none is chosen, and for
 * current qwen builds that default is the maximum. */
export function effortAdvice(m: DetectedModel, effort: Effort | null): string | null {
  if (m.backend !== "lmstudio" || !m.reasoning?.default) return null;
  const d = m.reasoning.default;
  if (effort === null && /^(high|xhigh)$/.test(d)) {
    return `this model thinks at "${d}" by default on LM Studio — expect long pauses before each tool call. /effort off (or --effort off) is many times faster; /effort low or medium keeps some reasoning.`;
  }
  return null;
}

/** Tell the user what context management just did (both UIs; headless logs
 * it to stderr so a long run's log shows when and how hard compaction hit). */
export function reportCompactions(bus: EventBus, ui: { status: (s: string) => void; warn: (s: string) => void }): void {
  bus.on("post_compact", (report: any) => {
    const delta = `${report?.before} → ${report?.after} tokens est.`;
    if (report?.action === "evicted") ui.status(`· pruned context (${delta})`);
    else if (report?.action === "compacted") ui.status(`· compacted the conversation into hand-over notes (${delta})`);
    else if (report?.action === "floor")
      ui.warn(
        `· context is at its floor: system prompt + tools + the working tail no longer fit comfortably (${delta}). Consider a bigger context window.`
      );
  });
}

/** `url` says which server the wanted (or else the remembered) model was on;
 * it only breaks ties between machines that serve the same model id. */
export function autoPickModel(
  models: DetectedModel[],
  wanted: string | undefined,
  remembered: string | undefined,
  url?: string
): DetectedModel {
  if (wanted) {
    let hit = models.find((m) => m.id === wanted && m.baseUrl === url) ?? models.find((m) => m.id === wanted);
    if (hit) return hit;

    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/:latest$/, "")
        .replace(/[-_]/g, ":");
    const wantedNorm = norm(wanted);
    hit = models.find((m) => norm(m.id) === wantedNorm);
    if (hit) return hit;

    hit =
      models.find((m) => m.id.toLowerCase().includes(wanted.toLowerCase())) ??
      models.find((m) => wanted.toLowerCase().includes(m.id.toLowerCase()));
    if (hit) return hit;

    const words = wanted
      .toLowerCase()
      .replace(/[^a-z0-9]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2);
    if (words.length >= 2) {
      hit = models.find((m) => {
        const mLower = m.id.toLowerCase();
        return words.every((w) => mLower.includes(w));
      });
      if (hit) return hit;
    }

    // Repli intelligent si le modèle précis sauvegardé n'existe plus
    const local = models.filter((m) => !m.host);
    const pool = local.length ? local : models;
    const fallback =
      models.find((m) => m.id === remembered && m.baseUrl === url) ??
      models.find((m) => m.id === remembered) ??
      pool.find((m) => m.backend === "ollama") ??
      pool.find((m) => m.loaded) ??
      pool[0];
    if (fallback) return fallback;

    throw new Error(`Model "${wanted}" was not found on the selected backend. Use /models to choose an available model.`);
  }
  // With nothing remembered, a model on this computer beats one across the network.
  const local = models.filter((m) => !m.host);
  const pool = local.length ? local : models;
  return (
    models.find((m) => m.id === remembered && m.baseUrl === url) ??
    models.find((m) => m.id === remembered) ??
    pool.find((m) => m.backend === "ollama") ??
    pool.find((m) => m.loaded) ??
    pool[0]
  );
}

export function noBackendsMessage(): string {
  return (
    c.red("No usable model found.") +
    `\n\nsmolcoder connects to a running model server; it does not scan installed apps or drives.\n` +
    `  · ${c.bold("Ollama")}: start the app (or run: ollama serve), then check: ollama list\n` +
    `    Found on this computer, at ${c.dim("$OLLAMA_HOST")}, and in Docker containers that publish its port.\n` +
    `    If the list is empty, run: ollama pull qwen3\n` +
    `  · ${c.bold("LM Studio")}: load a model and start Local Server in the Developer tab (any port).\n` +
    `  · ${c.bold("Another machine")}: start smol in a terminal or with --web and choose "Find models on another machine".\n\n` +
    `Then run smol again.`
  );
}

/** "ollama" on this computer, "ollama @ gpu-box" across the network.
 * FlagshipRouter keeps its product name: "lmstudio" would blame the wrong
 * server for a gateway failure. */
export function backendLabel(m: DetectedModel): string {
  const name = m.backend === "flagship" ? "flagshiprouter" : m.backend;
  return m.host ? `${name} @ ${m.host}` : name;
}

export function sessionLine(m: DetectedModel, mode: Mode): string {
  return `${c.green("●")} ${backendLabel(m)} · ${c.bold(m.id)} · ctx ${m.contextWindow.toLocaleString()} · ${m.id.endsWith(":free") ? `${c.green("GRATUIT")} · ` : ""}${MODE_LABELS[mode]} mode`;
}

/** Gros bandeau quand le mode YOLO est actif : rien ne demande avant d'agir. */
export function yoloBanner(): string {
  return (
    `${c.red(c.bold("YOLO ACTIF"))} ${c.red("— aucune demande avant d'écrire ou d'exécuter.")}\n` +
    `${c.dim("Restez dans votre dossier projet. shift+tab pour revenir en edit.")}`
  );
}

export function fmtTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

function modeColored(mode: Mode): string {
  const label = MODE_LABELS[mode];
  if (mode === "bypass") return c.red(c.bold(label));
  if (mode === "ro") return c.magenta(c.bold(label));
  if (mode === "auto") return c.yellow(c.bold(label));
  return c.cyan(c.bold(label));
}

/** Detect backends, pick a model and resolve its context window. Returns null
 * when no backend answers. `progress` gets a short label for each slow step. */
export async function prepareModel(prefs: SessionPrefs, cfg: Config, progress?: (label: string) => void): Promise<DetectedModel | null> {
  progress?.("looking for Ollama and LM Studio");
  const url = prefs.model ? prefs.baseUrl : cfg.lastModelUrl;
  // Without --model the remembered one wins anyway, so stop looking the moment
  // it shows up instead of waiting out a network host that is switched off.
  const until =
    !prefs.model && cfg.lastModel
      ? (m: DetectedModel) => m.id === cfg.lastModel && (!url || m.baseUrl === url) && (!prefs.backend || m.backend === prefs.backend)
      : undefined;
  const models = (
    await detectAll({
      hosts: process.env.SMOLCODER_FAST_START === "1" ? [] : cfg.hosts,
      until,
      fast: process.env.SMOLCODER_FAST_START === "1",
    })
  ).filter((m) => !prefs.backend || m.backend === prefs.backend);
  if (models.length === 0) return null;
  const chosen = autoPickModel(models, prefs.model, cfg.lastModel, url);
  progress?.(`loading ${chosen.id}`);
  return resolveWithHint(chosen, prefs.ctx, (label) => progress?.(label));
}

/** First load of a model can mean minutes of total silence while it fills
 * memory. After this long, say so, so a slow load never looks like a freeze. */
export const LOAD_HINT_AFTER_MS = 8000;

/** resolveContextWindow with a heartbeat: after `afterMs` the caller hears
 * back with a label it can show, once. `cancel` (when given) wins the race
 * and ends the wait. Exported for tests. */
export async function resolveWithHint(
  model: DetectedModel,
  ctxOverride: number | undefined,
  onHint: (label: string) => void,
  afterMs = LOAD_HINT_AFTER_MS,
  cancel?: Promise<never>
): Promise<DetectedModel> {
  const timer = setTimeout(() => {
    try {
      onHint(`loading ${model.id} — first load fills memory, allow 1-3 min`);
    } catch {
      /* a UI that went away must never break the load */
    }
  }, afterMs);
  try {
    const load = resolveContextWindow(model, ctxOverride);
    if (!cancel) return await load;
    load.catch(() => {}); // if the cancel wins, a later failure must not crash
    return await Promise.race([load, cancel]);
  } finally {
    clearTimeout(timer);
  }
}

export const LOAD_CANCELLED_MSG = "chargement annulé — rechoisissez le modèle une fois son serveur prêt";

/** Load a model with esc wired to THIS wait (not to quitting, not to killing
 * the turn): the previous onCancel is parked and restored by the caller. */
async function loadModelCancellable(
  ui: FlowUI,
  model: DetectedModel,
  ctxOverride: number | undefined,
  onHint: (label: string) => void
): Promise<DetectedModel> {
  const outer = ui.onCancel ?? null;
  let reject!: (err: Error) => void;
  const cancelled = new Promise<never>((_, rej) => (reject = rej));
  ui.onCancel = () => reject(new Error(LOAD_CANCELLED_MSG));
  try {
    return await resolveWithHint(model, ctxOverride, onHint, LOAD_HINT_AFTER_MS, cancelled);
  } finally {
    ui.onCancel = outer;
  }
}

/** Picker rows for a model list: this computer first, then each network host. */
export function modelOptions(models: DetectedModel[], current?: DetectedModel): SelectOption[] {
  return models.map((m) => ({
    label: m.id,
    hint:
      (m.backend === "ollama"
        ? "ollama"
        : m.backend === "flagship"
          ? `flagshiprouter · ${m.contextWindow.toLocaleString()} ctx`
          : `lm studio${m.loaded ? ` · ctx ${m.contextWindow.toLocaleString()}` : " · not loaded"}`) +
      (m.host ? ` · ${m.host}` : "") +
      (m.id.endsWith(":free") ? " · GRATUIT" : ""),
    current: !!current && m.id === current.id && m.backend === current.backend && m.baseUrl === current.baseUrl,
  }));
}

export const FIND_ROW: SelectOption = {
  label: "+ Trouver des modèles sur un autre ordinateur…",
  hint: "chercher sur mon réseau ou saisir une adresse",
};
export const HOSTS_ROW: SelectOption = { label: "Hôtes réseau…", hint: "renommer, retirer ou rechercher les machines ajoutées" };

/** Nothing answered on this computer. Rather than giving up, offer to look on
 * the network — with both UIs' own pickers, before a session exists. Returns
 * a ready model, or null when the user backs out. */
export async function setupWithoutLocalModels(ui: FlowUI, prefs: SessionPrefs): Promise<DetectedModel | null> {
  for (;;) {
    const pick = await ui.select("Aucun serveur de modèles trouvé sur cet ordinateur", [
      { label: "Trouver des modèles sur un autre ordinateur", hint: "chercher sur mon réseau ou saisir une adresse" },
      { label: "Réessayer", hint: "après avoir démarré Ollama ou LM Studio ici" },
    ]);
    if (pick === null) return null;
    if (pick === 0 && !(await findModelsOnNetwork(ui))) continue;
    ui.startSpinner("recherche d'Ollama et de LM Studio");
    const cfg = loadConfig();
    const models = (await detectAll({ hosts: cfg.hosts })).filter((m) => !prefs.backend || m.backend === prefs.backend);
    ui.stopSpinner();
    if (!models.length) {
      ui.warn("Toujours aucun serveur de modèles qui répond.");
      continue;
    }
    // A machine was just added by hand: let the user say which of its models
    // to load instead of pulling the first one into its memory.
    const idx = models.length === 1 ? 0 : await ui.select("Choisir un modèle", modelOptions(models));
    if (idx === null) continue;
    ui.startSpinner(`chargement de ${models[idx].id}`);
    try {
      return await loadModelCancellable(ui, models[idx], prefs.ctx, (label) => ui.startSpinner(label));
    } catch (err: any) {
      ui.warn(String(err?.message ?? err));
    } finally {
      ui.stopSpinner();
    }
  }
}

// ---- session titles ---------------------------------------------------------

/** Ask the model for a short session name from the first exchange. One cheap
 * call with thinking off and a tiny output cap; null when the reply is not
 * usable, in which case the caller keeps its fallback (the first message). */
export async function suggestTitle(messages: Msg[], provider: Provider): Promise<string | null> {
  const first = messages.find((m) => m.role === "user" && !m.compactNote);
  if (!first) return null;
  const reply = [...messages].reverse().find((m) => m.role === "assistant" && m.content.trim());
  try {
    const res = await provider.chat(
      [
        {
          role: "system",
          content: "You name coding sessions. Reply with only the title: three to six words, plain text, no quotes, no trailing period.",
        },
        {
          role: "user",
          content:
            `First request:\n${truncateEnd(first.content, 600)}\n\n` +
            (reply ? `Reply excerpt:\n${truncateEnd(reply.content, 400)}\n\n` : "") +
            "Title:",
        },
      ],
      [],
      { effortOverride: "off", maxTokens: 30, timeoutMs: 15_000, background: true }
    );
    return cleanTitle(res.content);
  } catch {
    return null;
  }
}

/** Exported for tests: normalize a model-written title. */
export function cleanTitle(raw: string): string | null {
  let t = String(raw ?? "").replace(/<think>[\s\S]*?(<\/think>|$)/gi, "");
  t =
    t
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  t = t
    .replace(/^(title|session( name)?)\s*:\s*/i, "")
    .replace(/^["'`“”*#\s]+|["'`“”*.\s]+$/g, "")
    .replace(/\s+/g, " ");
  if (t.length < 3 || /[<>{}]/.test(t)) return null;
  if (t.length > 60) {
    t = t.slice(0, 60);
    const cut = t.lastIndexOf(" ");
    if (cut > 20) t = t.slice(0, cut);
    t = t.replace(/[\s,;:.-]+$/, "");
  }
  return t || null;
}

// ---- the session -----------------------------------------------------------

/** Everything needed to bring a session back after a restart. */
export interface SessionSnapshot {
  messages: Msg[]; // without the system message — rebuilt on restore
  plan: PlanStep[];
  filesTouched: string[];
  commandsRun: string[];
  originalRequest: string;
  currentRequest: string;
  mode: Mode;
  effort: Effort | null;
  model: string;
  backend: string;
  /** Server the model ran on (absent in sessions saved before network hosts). */
  baseUrl?: string;
}

export interface SessionOptions {
  workspace: string;
  /** Stable key for per-session plan persistence (CLI uses "cli"). */
  planKey?: string;
  /** Identifiant d'historique pour /rewind (défaut : le planKey web, sinon cli-<aléatoire>). */
  sessionId?: string;
  /** Racine de l'historique de fichiers (tests ; défaut ~/.smolcoder/file-history). */
  historyRoot?: string;
  chosen: DetectedModel;
  prefs: SessionPrefs;
  cfg: Config;
  /** Text printed by /help. */
  help: string;
  /** Hub record for the web/desktop hub (used for /build command). */
  hubRec?: any;
}

/** Replace each @path with the file's content (cap 9000 chars). Image
 * paths become vision attachments instead (collected into `images`) so
 * CLI/TUI users get screenshots exactly like web uploads. A failure
 * becomes an inline error text — never an exception. Pure in workspace. */
export function expandMentionsInWorkspace(workspace: string, text: string, images: Attachment[]): string {
  if (!text.includes("@")) return text;
  return text.replace(/@([^\s`"'()[\]{}<>]+)/g, (m, p: string) => {
    const rel = p.replace(/[.,;:!?]+$/, "");
    if (!rel) return m;
    try {
      const abs = resolveInWorkspace(workspace, rel);
      const st = fs.statSync(abs);
      if (st.isFile()) {
        const mime = mimeForExt(path.extname(abs).slice(1));
        if (mime.startsWith("image/")) {
          if (st.size > MAX_UPLOAD_BYTES) {
            return `[image @${rel}: too large (${Math.round(st.size / 1048576)} MB; limit 20 MB)]`;
          }
          images.push({
            id: `at-${Date.now().toString(36)}-${images.length}`,
            name: path.basename(abs),
            kind: "image",
            mime,
            size: st.size,
            path: abs,
          });
          return `[image @${rel} attached below]`;
        }
      }
    } catch {
      /* not an image — fall through to the text read */
    }
    try {
      const content = readFile(workspace, { path: rel }, 9000);
      return `[file @${rel}:]\n${content}`;
    } catch (err: any) {
      return `[file @${rel}: ${err?.message ?? err}]`;
    }
  });
}

/** Cadence du tick des routines planifiées : assez court pour honorer une
 * routine « every 1m », assez rare pour ne rien coûter. */
const ROUTINE_TICK_MS = 30_000;
const AUTOPILOT_MAX_TURNS = 6;
const AUTOPILOT_MAX_MS = 45 * 60_000;
const AUTOPILOT_MAX_FAILURES = 2;

export class Session {
  readonly workspace: string;
  chosen: DetectedModel;
  effort: Effort | null;
  readonly agent: Agent;
  readonly toolCtx: ToolContext;
  readonly taskManager: TaskManager;
  readonly ctxMgr: ContextManager;
  readonly bus = new EventBus();
  readonly shell = pickShell();
  /** Host hook: fired once when the session has shut down (/exit, ctrl+c). */
  onExit: (() => void) | null = null;
  /** Host hook: fired after each completed user turn (the web hub names the
   * session after the first one). */
  onTurnDone: (() => void) | null = null;

  private readonly agentsMd: string | null;
  private readonly memoryMd: string | null;
  private readonly prefs: SessionPrefs;
  private readonly help: string;
  private readonly hubRec: any;
  /** Identifiant de session pour la machine à remonter le temps (/rewind). */
  private readonly sid: string;
  private readonly fileHistory: FileHistory;
  /** Longueur du transcript de l'agent au début de chaque tour — permet à
   * /rewind de restaurer AUSSI la conversation, pas seulement les fichiers. */
  private readonly turnMarks = new Map<number, number>();
  private autoMission: { goal: string; turns: number; startedAt: number } | null = null;
  /** Tâches planifiées (/routine) : fichier .smol/routines.json + tick de fond. */
  private readonly routines: RoutineBook;
  private readonly routineTimer: ReturnType<typeof setInterval>;
  /** Built-in + custom slash commands: menu, /help and the web status view. */
  private readonly allSlash: SlashCommand[];
  private ended = false;

  constructor(
    readonly ui: SessionUI,
    opts: SessionOptions
  ) {
    const { workspace, chosen, prefs, cfg } = opts;
    this.workspace = workspace;
    this.chosen = chosen;
    this.prefs = prefs;
    this.help = opts.help;
    const persistedKey = opts.planKey && opts.planKey !== "cli" ? opts.planKey : null;
    this.sid = opts.sessionId ?? persistedKey ?? `cli-${randomUUID().slice(0, 8)}`;
    this.fileHistory = new FileHistory(opts.historyRoot);
    this.routines = new RoutineBook(workspace);
    const mode0 = prefs.mode ?? cfg.lastMode ?? "edit";
    this.effort = effortForBackend(cfg, chosen.backend, prefs.effort);

    const provider = routeProvider(
      makeProvider(chosen),
      process.env.SMOLCODER_FALLBACKS,
      () => detectAll({ hosts: cfg.hosts }),
      (m) => makeProvider(m),
      (msg) => {
        try {
          ui.status(msg);
        } catch {
          /* status must never break startup */
        }
      }
    );
    provider.setEffort(this.effort);
    this.taskManager = new TaskManager(workspace, (t) => {
      try {
        ui.status(`· background task ${t.id} finished (exit code ${t.exitCode ?? "?"}) — ${t.command.slice(0, 140)}`);
      } catch {
        /* a chat line must never break the exit path */
      }
    });
    let plugins: ToolContext["plugins"] = [];
    try {
      plugins = loadPlugins(workspace);
    } catch {
      plugins = [];
    }
    this.toolCtx = {
      workspace,
      taskManager: this.taskManager,
      plan: new Plan(workspace, opts.planKey ?? "cli"),
      filesTouched: new Set(),
      commandsRun: [],
      undoStack: [],
      redoStack: [],
      fileHistory: this.fileHistory,
      sessionId: this.sid,
      browserNotify: (ev) => this.browserLive(ev),
      mcp: createMcpBridge(workspace),
      plugins,
    };
    this.ctxMgr = new ContextManager(chosen.contextWindow, provider.maxOutputTokens);
    if (this.toolCtx.plan.loadError) ui.warn(`· ${this.toolCtx.plan.loadError}`);
    this.agentsMd = loadAgentsMd(workspace);
    this.memoryMd = loadMemoryMd(workspace);
    // The step cap is a runaway-loop backstop, not a work limit — esc/ctrl+c
    // is the user's real kill switch, so set it far above any legitimate task.
    this.agent = new Agent(provider, mode0, this.sysPrompt(mode0), this.toolCtx, this.ctxMgr, this.bus, ui, true, 1000);

    const custom = listCustomCommands(workspace).filter((c) => !SLASH_COMMANDS.some((s) => s.name === c.name));
    this.allSlash = [...SLASH_COMMANDS, ...custom];
    ui.slashCommands = this.allSlash;
    ui.hintLeft = workspace.replace(os.homedir(), "~");
    ui.getStatus = () => this.statusLine();
    ui.onModeCycle = () => {
      const next = MODE_ORDER[(MODE_ORDER.indexOf(this.agent.mode) + 1) % MODE_ORDER.length];
      this.agent.setMode(next, this.sysPrompt(next));
      this.persist();
    };
    ui.onCancel = () => this.agent.cancel();
    ui.onExit = () => void this.shutdown();
    reportCompactions(this.bus, ui);
    this.bus.on("context_update", () => ui.refresh());
    this.persist();
    // Les routines planifiées : un tick discret, `unref` pour ne jamais
    // retenir le process en vie, et jamais pendant qu'un tour travaille.
    this.routineTimer = setInterval(() => void this.routineTick(), ROUTINE_TICK_MS);
    this.routineTimer.unref?.();
  }

  /** Le direct du navigateur : la capture jpeg de la dernière action est
   *  écrite dans .smol/screenshots/live.jpg, puis poussée à l'UI (panneau
   *  Navigateur côté web, ligne discrète côté TUI). Purement best effort :
   *  le direct ne casse jamais l'action du navigateur. */
  private async browserLive(ev: BrowserLiveShot): Promise<void> {
    try {
      const rel = ".smol/screenshots/live.jpg";
      const abs = path.join(this.workspace, ...rel.split("/"));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, Buffer.from(ev.png, "base64"));
      this.ui.browserView?.({ url: ev.url, title: ev.title, action: ev.action, shot: rel });
    } catch {
      /* le direct est un confort : jamais une erreur */
    }
  }

  private sysPrompt(mode: Mode): string {
    return buildSystemPrompt({
      workspace: this.workspace,
      mode,
      shellLabel: this.shell.label,
      agentsMd: this.agentsMd,
      memoryMd: this.memoryMd,
    });
  }

  private persist(): void {
    const current = loadConfig();
    updateConfig({
      lastModel: this.chosen.id,
      lastModelUrl: this.chosen.baseUrl,
      lastMode: this.agent.mode,
      effort: this.effort,
      effortByBackend: { ...current.effortByBackend, [this.chosen.backend]: this.effort },
    });
  }

  /** The TUI's status row: mode · model · effort · context · plan · tasks. */
  statusLine(): string {
    const agent = this.agent;
    const tasks = this.taskManager.runningSummary().length;
    const plan = this.toolCtx.plan;
    return (
      `${modeColored(agent.mode)} ${c.dim("·")} ${this.chosen.id} ${c.dim(backendLabel(this.chosen))}` +
      (this.effort || agent.provider.effortLabel() ? ` ${c.dim("·")} ${c.yellow(agent.provider.effortLabel() ?? this.effort ?? "")}` : "") +
      ` ${c.dim("·")} ${c.dim(`${fmtTokens(agent.contextTokens())} (${agent.contextPercent()}%)`)}` +
      (plan.exists
        ? ` ${c.dim("·")} ${
            plan.currentIndex < 0
              ? c.green(`plan ${plan.doneCount}/${plan.steps.length}`)
              : c.cyan(`plan ${plan.doneCount}/${plan.steps.length}`)
          }`
        : "") +
      (tasks ? ` ${c.dim("·")} ${c.green(`${tasks} task${tasks > 1 ? "s" : ""}`)}` : "")
    );
  }

  /** Structured status for the web page's status bar. */
  /** One-line plan progress for sidebars and menus ("Plan 2/5 · write tests"). */
  planLine(): string | null {
    try {
      const plan = this.toolCtx?.plan;
      if (!plan?.exists || !plan.steps.length) return null;
      const done = plan.doneCount ?? 0;
      const total = plan.steps.length;
      const cur = plan.currentIndex >= 0 && plan.currentIndex < total ? plan.steps[plan.currentIndex].text : "complete";
      return `Plan ${done}/${total} · ${String(cur).slice(0, 80)}`;
    } catch {
      return null;
    }
  }

  state(): Record<string, any> {
    const plan = this.toolCtx.plan;
    return {
      mode: this.agent.mode,
      yolo: this.agent.mode === "bypass",
      modeLabel: MODE_LABELS[this.agent.mode],
      model: this.chosen.id,
      backend: this.chosen.backend,
      host: this.chosen.host,
      vision: this.chosen.vision,
      effort: this.agent.provider.effortLabel() ?? this.effort,
      ctxTokens: this.agent.contextTokens(),
      ctxPct: this.agent.contextPercent(),
      context: this.agent.contextBudget(),
      outcome: this.agent.outcome,
      lastError: this.agent.lastError,
      autopilot:
        this.agent.autopilotPhase === "completed" || this.agent.autopilotPhase === "cancelled"
          ? null
          : {
              phase: this.agent.autopilotPhase,
              label: this.agent.autopilotLabel,
              ...(this.agent.autopilotDetails ? { details: this.agent.autopilotDetails } : {}),
            },
      verification: this.agent.verificationResult
        ? { attempts: this.agent.verificationResult.attempts, passed: this.agent.verificationResult.passed }
        : null,
      plan: plan.exists ? { steps: plan.steps, current: plan.currentIndex } : null,
      tasks: this.taskManager.runningSummary().length,
      tools: this.agent.tools.map((t) => t.name),
      filesTouched: [...this.toolCtx.filesTouched],
      filesTouchedCount: this.toolCtx.filesTouched.size,
      commandsRun: this.toolCtx.commandsRun.slice(-20),
      workspace: this.workspace,
      commands: this.allSlash,
      urls: this.taskManager.recentUrls(),
    };
  }

  /** The opening lines: backend · model · mode, workspace, AGENTS.md, advice. */
  announce(): void {
    const ui = this.ui;
    if (this.agent.mode === "bypass") ui.warn(`  ${yoloBanner()}`);
    if (this.chosen.note) ui.warn(`  ${this.chosen.note}`);
    const advice = effortAdvice(this.chosen, this.effort);
    if (advice) ui.warn(`  ${advice}`);
  }

  snapshot(): SessionSnapshot {
    return {
      messages: this.agent.messages.slice(1),
      plan: this.toolCtx.plan.steps.map((s) => ({ ...s })),
      filesTouched: [...this.toolCtx.filesTouched],
      commandsRun: [...this.toolCtx.commandsRun],
      originalRequest: this.agent.originalRequest,
      currentRequest: this.agent.currentRequest,
      mode: this.agent.mode,
      effort: this.effort,
      model: this.chosen.id,
      backend: this.chosen.backend,
      baseUrl: this.chosen.baseUrl,
    };
  }

  /** A model-written name for this session, or null to keep the fallback. */
  suggestTitle(): Promise<string | null> {
    return suggestTitle(this.agent.messages, this.agent.provider);
  }

  /** Bring a saved transcript back (the system message is rebuilt for the
   * current mode/workspace; approvals are deliberately not restored). */
  restore(s: SessionSnapshot): void {
    this.agent.restoreTranscript(s.messages ?? [], s.originalRequest ?? "", s.currentRequest ?? "");
    if (s.plan?.length) {
      const error = this.toolCtx.plan.restoreSteps(s.plan);
      if (error) this.ui.warn(`· ${error}`);
    }
    for (const f of s.filesTouched ?? []) this.toolCtx.filesTouched.add(f);
    this.toolCtx.commandsRun.push(...(s.commandsRun ?? []));
  }

  /** User-input pipeline — applied ONLY to user text, never to model
   * messages. `!` is checked first on the raw text (a shell command must not
   * have its arguments rewritten), otherwise @file mentions are expanded. */
  private async handleUserMessage(input: string, attachments: Attachment[], workItemId?: string): Promise<void> {
    const { ui, agent } = this;
    // Machine à remonter le temps : chaque tour ouvre son point de
    // restauration avant que le moindre outil ne touche un fichier.
    // (Best effort : les harnais de test instancient la session sans constructeur.)
    const turn = this.fileHistory?.beginTurn(this.sid, input);
    if (turn !== undefined) {
      const mark = this.agent?.transcriptCount?.();
      if (mark !== undefined) {
        this.turnMarks.set(turn, mark);
        if (this.turnMarks.size > 128) {
          const oldest = this.turnMarks.keys().next().value;
          if (oldest !== undefined) this.turnMarks.delete(oldest);
        }
      }
    }
    const board = workItemId ? new CoworkBoard(this.workspace) : null;
    if (board && workItemId) {
      try {
        const started = await board.beginExecution(workItemId);
        if (started.startsWith("Error:")) {
          ui.error(`\n${started}`);
          return;
        }
        this.toolCtx.filesTouched.add(".smol/work-items.json");
      } catch (error: any) {
        ui.error(`\nCowork task could not be started: ${String(error?.message ?? error)}`);
        return;
      }
    }
    let turnStarted = false;
    try {
      if (input.startsWith("!") && input.slice(1).trim()) {
        const cmd = input.slice(1).trim();
        ui.toolCall("run_command", { command: cmd });
        const raw = await runCommand(cmd, this.workspace);
        const body = raw.length > 8000 ? truncateMiddle(raw, 8000) : raw;
        ui.toolResult(body);
        try {
          turnStarted = true;
          await agent.runTurn(`${input}\n\n[shell output of "${cmd}":]\n${body}`, attachments);
          this.onTurnDone?.();
        } catch (err: any) {
          ui.error(`\n${err?.message ?? err}`);
        }
        return;
      }
      const imageRefs: Attachment[] = [];
      const expanded = this.expandMentions(input, imageRefs);
      try {
        turnStarted = true;
        await agent.runTurn(expanded, [...attachments, ...imageRefs]);
        this.onTurnDone?.();
      } catch (err: any) {
        ui.error(`\n${err?.message ?? err}`);
        if (
          String(err?.message ?? "")
            .toLowerCase()
            .includes("does not support tools")
        ) {
          ui.warn("This model does not support tool calling. Pick a tool-capable model with /models (e.g. qwen3, llama3.1, mistral-nemo).");
        }
      }
    } finally {
      if (board && workItemId) {
        const outcome =
          !turnStarted || agent.outcome === "error"
            ? "failed"
            : agent.outcome === "cancelled"
              ? "cancelled"
              : agent.outcome === "completed" && agent.verificationResult?.passed
                ? "verified"
                : "unverified";
        const report =
          outcome === "verified"
            ? "Agent turn completed and automated acceptance checks passed."
            : outcome === "unverified"
              ? "Agent turn completed, but no successful automated acceptance check was recorded."
              : outcome === "cancelled"
                ? "Agent turn was cancelled."
                : `Agent turn failed${agent.lastError ? `: ${agent.lastError}` : " before completion."}`;
        try {
          const result = await board.finishExecution(workItemId, outcome, report);
          if (result.startsWith("Error:")) ui.warn(`· Cowork execution state could not be saved: ${result}`);
          else this.toolCtx.filesTouched.add(".smol/work-items.json");
        } catch (error: any) {
          ui.warn(`· Cowork execution state could not be saved: ${String(error?.message ?? error)}`);
        }
      }
    }
  }

  private expandMentions(text: string, images: Attachment[]): string {
    return expandMentionsInWorkspace(this.workspace, text, images);
  }

  /** Restore the last file write (prev null = the file was created → delete). */
  private undoEdit(): void {
    const ui = this.ui;
    this.toolCtx.undoStack ??= [];
    this.toolCtx.redoStack ??= [];
    const stack = this.toolCtx.undoStack;
    const redo = this.toolCtx.redoStack;
    const entry = stack.pop();
    if (!entry) {
      ui.status("· nothing to undo — no file written yet");
      return;
    }
    const rel = path.relative(this.workspace, entry.abs) || entry.abs;
    try {
      if (entry.prev === null) {
        try {
          fs.unlinkSync(entry.abs);
        } catch (err: any) {
          if (err?.code !== "ENOENT") throw err;
        }
        ui.println(`· undo: ${rel} deleted (it had been created)`);
      } else {
        fs.mkdirSync(path.dirname(entry.abs), { recursive: true });
        fs.writeFileSync(entry.abs, entry.prev, "utf8");
        ui.println(`· undo: ${rel} restored to its previous version`);
      }
      redo.push(entry);
    } catch (err: any) {
      stack.push(entry);
      ui.error(`· undo: could not restore ${rel} (${err?.message ?? err})`);
    }
  }

  /** Re-apply the last undone write. Edits replay old_text -> next on the
   * current content (writing the snippet alone would destroy the file). */
  private redoEdit(): void {
    const ui = this.ui;
    this.toolCtx.undoStack ??= [];
    this.toolCtx.redoStack ??= [];
    const stack = this.toolCtx.undoStack;
    const redo = this.toolCtx.redoStack;
    const entry = redo.pop();
    if (!entry) {
      ui.status("· nothing to redo — no undone write");
      return;
    }
    const rel = path.relative(this.workspace, entry.abs) || entry.abs;
    const fail = (msg: string) => {
      redo.push(entry);
      ui.error(`· redo: ${rel} — ${msg}`);
    };
    try {
      fs.mkdirSync(path.dirname(entry.abs), { recursive: true });
      if (entry.kind === "edit" && typeof entry.oldText === "string" && entry.oldText) {
        let cur: string;
        try {
          cur = fs.readFileSync(entry.abs, "utf8");
        } catch {
          fail("file changed since undo (cannot replay the edit)");
          return;
        }
        const n = cur.split(entry.oldText).length - 1;
        if (n !== 1) {
          fail(`anchor found ${n} times (need exactly 1) — file changed since undo`);
          return;
        }
        fs.writeFileSync(entry.abs, cur.replace(entry.oldText, entry.next), "utf8");
      } else if (entry.kind === "delete") {
        // Undo restored the text; redo takes it back out again.
        try {
          fs.unlinkSync(entry.abs);
        } catch (err: any) {
          if (err?.code !== "ENOENT") throw err;
        }
        ui.println(`· redo: ${rel} re-deleted`);
      } else {
        fs.writeFileSync(entry.abs, entry.next, "utf8");
        ui.println(`· redo: ${rel} re-applied`);
      }
      stack.push(entry);
    } catch (err: any) {
      fail(`could not re-apply (${err?.message ?? err})`);
    }
  }

  /** La machine à remonter le temps. Sans argument : les tours enregistrés.
   * Avec un numéro : restaure les fichiers ET la conversation tels qu'ils
   * étaient AU DÉBUT de ce tour. Un suffixe facultatif restreint la portée :
   * `files` (fichiers seuls) ou `chat` (conversation seule) ; sans suffixe,
   * les deux reviennent en arrière ensemble, comme dans Claude Code. */
  private rewindTurns(rest: string[]): void {
    const ui = this.ui;
    const words = rest.join(" ").trim().split(/\s+/).filter(Boolean);
    let what: "both" | "files" | "chat" = "both";
    if (words.length > 1) {
      const mode = words[words.length - 1].toLowerCase();
      if (mode === "files" || mode === "fichiers") what = "files";
      else if (mode === "chat" || mode === "conversation") what = "chat";
      else {
        ui.error(`· précision « ${words[words.length - 1]} » inconnue — utilisez files, chat, ou rien du tout (les deux)`);
        return;
      }
      words.pop();
    }
    const arg = words.join(" ").trim();
    const turns = this.fileHistory.readIndex(this.sid);
    if (!turns.length) {
      ui.status("· rien à remonter — aucun tour enregistré pour cette session");
      return;
    }
    if (!arg) {
      ui.println("· Points de restauration (les plus récents d'abord) :");
      for (const t of this.fileHistory.list(this.sid, 10)) {
        const when = new Date(t.at);
        const hh = String(when.getHours()).padStart(2, "0");
        const mm = String(when.getMinutes()).padStart(2, "0");
        const n = t.files.length;
        ui.println(`   ${String(t.turn).padStart(3)}  « ${t.prompt} »  ${hh}:${mm}  ${n} fichier${n > 1 ? "s" : ""}`);
      }
      ui.println("· /rewind <n> restaure les fichiers ET la conversation tels qu'ils étaient AU DÉBUT du tour n");
      ui.println("  (ajoutez « files » ou « chat » pour n'en restaurer qu'un seul).");
      return;
    }
    const n = Number(arg);
    if (!Number.isInteger(n) || !turns.some((t) => t.turn === n)) {
      ui.error(`· tour « ${arg} » inconnu — /rewind liste les tours disponibles`);
      return;
    }
    if (what !== "chat") {
      const outcome = this.fileHistory.restore(this.sid, n, this.workspace);
      for (const rel of [...outcome.restored, ...outcome.deleted]) this.toolCtx.filesTouched.add(rel);
      const parts = [
        outcome.restored.length ? `${outcome.restored.length} restauré${outcome.restored.length > 1 ? "s" : ""}` : "",
        outcome.deleted.length ? `${outcome.deleted.length} supprimé${outcome.deleted.length > 1 ? "s" : ""} (créés après ce tour)` : "",
        outcome.unchanged.length ? `${outcome.unchanged.length} déjà conforme${outcome.unchanged.length > 1 ? "s" : ""}` : "",
      ].filter(Boolean);
      ui.println(`· rewind fichiers → début du tour ${n} : ${parts.join(", ") || "rien à faire"}.`);
      for (const rel of outcome.restored) ui.println(`   restaure  ${rel}`);
      for (const rel of outcome.deleted) ui.println(`   supprime  ${rel}`);
      for (const f of outcome.failed) ui.warn(`   échec  ${f.rel} — ${f.reason}`);
    }
    if (what !== "files") {
      const mark = this.turnMarks?.get(n);
      if (mark === undefined || !this.agent?.rewindTranscript) {
        ui.warn("   conversation : point de reprise indisponible (tour antérieur à cette session) — le modèle garde la suite en mémoire.");
      } else {
        const dropped = this.agent.rewindTranscript(mark);
        ui.println(
          `· rewind conversation → début du tour ${n} : ${dropped} message${dropped > 1 ? "s" : ""} retiré${dropped > 1 ? "s" : ""} du contexte du modèle.`
        );
      }
    }
  }

  /** Un tick de fond : réclame une routine due et la fait tourner comme un
   * message utilisateur normal — même mode, même historique (/rewind), même
   * journal. Jamais pendant un tour : on retentera au tick suivant. */
  private async routineTick(): Promise<void> {
    try {
      if (this.agent?.outcome === "running") return;
      const due = await this.routines?.claimDue();
      if (!due) return;
      this.ui.println(`\n⏰ routine ${describeCadence(due.cadence)} — ${truncateEnd(due.prompt, 80)}`);
      let status = "ok";
      try {
        await this.handleUserMessage(due.prompt, []);
        if (this.agent.outcome === "error") status = "erreur";
      } catch (err: any) {
        status = "erreur";
        this.ui.warn(`· routine : ${err?.message ?? err}`);
      }
      await this.routines?.markResult(due.id, status);
    } catch (err: any) {
      this.ui.warn(`· routine : ${err?.message ?? err}`);
    }
  }

  /** /routine [list] · add <cadence> | <texte> · run|on|off|remove <n>. */
  private async routineCommand(rest: string[]): Promise<void> {
    const ui = this.ui;
    if (!this.routines) return; // harnais de test instanciés sans constructeur
    const sub = (rest[0] ?? "list").toLowerCase();
    const whenOf = (ms: number) =>
      new Date(ms).toLocaleString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    if (sub === "list" || sub === "ls") {
      const items = this.routines.listSorted();
      if (!items.length) {
        ui.status("· aucune routine — /routine add every 30m | relis les issues ouvertes");
        return;
      }
      const svc = serviceStatus();
      ui.println(
        svc.running
          ? `· routines planifiées — service d'arrière-plan actif (pid ${svc.pid}) : elles tournent même sans session ouverte.`
          : "· routines planifiées — service arrêté : elles tournent tant que cette session est ouverte (smol service start pour qu'elles tournent app fermée)."
      );
      items.forEach((r, i) => {
        ui.println(`   ${i + 1}. ${r.enabled ? "" : "[en pause] "}${describeCadence(r.cadence)} → « ${truncateEnd(r.prompt, 60)} »`);
        ui.println(`      prochaine : ${whenOf(r.next)}${r.lastStatus ? ` · dernier essai : ${r.lastStatus}` : ""}`);
      });
      ui.println("   /routine run <n> lance maintenant · off <n> met en pause · remove <n> supprime");
      return;
    }
    if (sub === "add") {
      const body = rest.slice(1).join(" ");
      const sep = body.indexOf("|");
      if (sep < 0) {
        ui.warn("Usage : /routine add <cadence> | <texte> — ex. /routine add every 30m | relis les issues");
        return;
      }
      const res = await this.routines.add(body.slice(0, sep).trim(), body.slice(sep + 1).trim());
      if (!res.ok) {
        ui.warn(`· ${res.error}`);
        return;
      }
      ui.status(`· routine ajoutée — ${describeCadence(res.routine.cadence)}, prochaine : ${whenOf(res.routine.next)}`);
      return;
    }
    if (sub === "on" || sub === "off") {
      const out = await this.routines.setEnabled(rest[1] ?? "", sub === "on");
      if (out.startsWith("Error:")) ui.warn(`· ${out.slice(7)}`);
      else ui.status(`· ${out}`);
      return;
    }
    if (sub === "remove" || sub === "rm" || sub === "delete") {
      const out = await this.routines.remove(rest[1] ?? "");
      if (out.startsWith("Error:")) ui.warn(`· ${out.slice(7)}`);
      else ui.status(`· ${out}`);
      return;
    }
    if (sub === "run") {
      const r = this.routines.resolve(rest[1] ?? "");
      if (!r) {
        ui.warn(`· routine « ${rest[1] ?? ""} » introuvable — /routine liste les routines`);
        return;
      }
      ui.println(`\n⏰ routine ${describeCadence(r.cadence)} — ${truncateEnd(r.prompt, 80)}`);
      await this.handleUserMessage(r.prompt, []);
      await this.routines.markResult(r.id, this.agent.outcome === "error" ? "manuel · erreur" : "manuel · ok");
      return;
    }
    ui.warn("Usage : /routine · add <cadence> | <texte> · on|off <n> · run <n> · remove <n>");
  }

  /** Agent code review: builds a structured review request and runs one turn. */
  private async reviewCode(base?: string): Promise<void> {
    const scope = base
      ? `les changements de cette branche par rapport à « ${base} » (commence par git log ${base}..HEAD --oneline et git diff ${base}...HEAD --stat, puis lis le diff)`
      : "les changements non commités (git diff et git diff --staged) — s'il n'y a rien de non commité, prends les derniers commits de la branche par rapport à son amont (git log @{u}..HEAD)";
    const message = [
      "[Revue de code]",
      `Passe en revue ${scope}.`,
      "",
      "Méthode : identifie les fichiers concernés, lis le diff, ouvre les fichiers aux endroits cités pour vérifier le contexte réel, et lance le build ou les tests pertinents si le projet en a.",
      "",
      "Rends la revue fichier par fichier, du plus grave au plus léger. Pour chaque constat :",
      "- 🔴 bug certain / 🟠 risque ou comportement douteux / 🟡 style ou lisibilité",
      "- référence fichier:ligne",
      "- le problème en une phrase, puis le correctif concret (extrait de code si utile).",
      "",
      "Termine par « Points positifs » (3 maximum) puis un verdict : « ✅ prêt à committer » ou « ⚠️ N points à corriger ».",
      "Revue uniquement : ne modifie aucun fichier, ne commit rien, ne pousse rien.",
    ].join("\n");
    await this.handleUserMessage(message, []);
  }

  /** /autopilot <objectif> — mission autonome : l'agent construit un plan,
   * puis la session relance des tours jusqu'à ce que le plan soit complet.
   * /autopilot seul montre l'aide et l'état ; /autopilot stop interrompt. */
  private async autopilotCommand(rest: string[]): Promise<void> {
    const ui = this.ui;
    const first = (rest[0] ?? "").toLowerCase();
    if (first === "stop" || first === "arret" || first === "arrêt") {
      if (!this.autoMission) {
        ui.status("· aucune mission autonome en cours.");
        return;
      }
      const tours = this.autoMission.turns;
      this.autoMission = null;
      ui.status(`· pilote automatique arrêté (tour ${tours}/${AUTOPILOT_MAX_TURNS}).`);
      return;
    }
    if (!rest.length) {
      if (this.autoMission) {
        const m = this.autoMission;
        const min = Math.max(1, Math.round((Date.now() - m.startedAt) / 60_000));
        ui.println(`· mission autonome en cours depuis ~${min} min — tour ${m.turns}/${AUTOPILOT_MAX_TURNS} : « ${truncateEnd(m.goal, 100)} »`);
      } else {
        ui.println("· /autopilot <objectif> lance une mission autonome : l'agent crée un plan puis travaille seul, étape par étape, jusqu'au bout (max 6 tours, 45 min).");
        ui.println("  Exemple : /autopilot crée un site vitrine pour ma boulangerie dans ./site (html + css + page contact)");
        ui.println("  /autopilot stop arrête une mission en cours.");
      }
      return;
    }
    if (this.autoMission) {
      ui.warn(`· mission déjà en cours (tour ${this.autoMission.turns}) — /autopilot stop pour l'arrêter d'abord.`);
      return;
    }
    if (this.toolCtx?.canWrite === false) {
      ui.warn("· pilote automatique : impossible en mode lecture seule — passez en mode edit, auto ou bypass (Shift+Tab).");
      return;
    }
    const goal = rest.join(" ").trim();
    if (!goal) return;
    this.autoMission = { goal, turns: 0, startedAt: Date.now() };
    ui.println(`\n🚀 pilote automatique : « ${truncateEnd(goal, 120)} »`);
    ui.println("   l'agent planifie puis enchaîne les tours seul — Échap annule le tour en cours, /autopilot stop après un tour.");
    try {
      await this.autopilotLoop(goal);
    } finally {
      this.autoMission = null;
    }
  }

  private async autopilotLoop(goal: string): Promise<void> {
    const ui = this.ui;
    let failures = 0;
    while (this.autoMission) {
      const m = this.autoMission;
      m.turns += 1;
      if (m.turns > AUTOPILOT_MAX_TURNS || Date.now() - m.startedAt > AUTOPILOT_MAX_MS) {
        ui.warn(`· pilote automatique : limite atteinte (${m.turns - 1} tour(s)) — je m'arrête là. Le plan reste disponible.`);
        break;
      }
      const plan = this.toolCtx?.plan;
      const openSteps = plan?.exists
        ? plan.steps
            .map((s, i) => (s.done ? null : `${i + 1}. ${s.text}`))
            .filter((line): line is string => line !== null)
            .join("\n")
        : "";
      const message =
        m.turns === 1
          ? `[Pilote automatique — objectif]\n${goal}\n\nCrée d'abord un plan de 3 à 8 étapes concrètes et vérifiables (outil plan, action "set"), puis commence immédiatement la première étape.`
          : `[Pilote automatique — tour ${m.turns}/${AUTOPILOT_MAX_TURNS}]\nObjectif : ${goal}\nÉtapes restantes :\n${openSteps}\n\nContinue exactement où tu en es : ne refais pas ce qui est terminé, finis l'étape suivante, marque-la done une fois vérifiée, puis poursuis. Si le plan est complet, donne le rapport final. Si tu es vraiment bloqué, arrête-toi et dis précisément pourquoi.`;
      try {
        await this.handleUserMessage(message, []);
      } catch (err: any) {
        ui.warn(`· pilote automatique : tour interrompu (${err?.message ?? err})`);
        break;
      }
      const outcome = this.agent?.outcome;
      if (outcome === "cancelled") {
        ui.status("· pilote automatique : annulé.");
        break;
      }
      failures = outcome === "error" ? failures + 1 : 0;
      if (failures >= AUTOPILOT_MAX_FAILURES) {
        ui.warn(`· pilote automatique : arrêt après ${failures} tours en erreur — le plan reste disponible.`);
        break;
      }
      if (plan?.exists && plan.doneCount >= plan.steps.length) {
        ui.println("");
        ui.status(`✅ pilote automatique : objectif atteint en ${m.turns} tour(s) — ${plan.steps.length} étape(s) vérifiée(s).`);
        break;
      }
      if (!plan?.exists && m.turns === 1) {
        ui.status("· pilote automatique : l'agent n'a pas créé de plan — objectif traité en un seul tour, j'arrête la boucle.");
        break;
      }
    }
    const plan = this.toolCtx?.plan;
    if (plan?.exists) {
      ui.println("· plan final :");
      plan.steps.forEach((s, i) => {
        ui.println(`   ${s.done ? "☑" : "☐"} ${i + 1}. ${truncateEnd(s.text, 100)}`);
      });
    }
  }

  /** Suspend the TUI, open $EDITOR (or notepad) on a tmp file holding the
   * draft, read the saved text back as the message, resume the TUI. Returns
   * null when the editor could not run (error already shown). */
  private async openEditor(draft: string): Promise<string | null> {
    const ui = this.ui;
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      ui.error("· /editor needs an interactive terminal (no TTY here) — type your message directly.");
      return null;
    }
    const editor = process.env.EDITOR || process.env.VISUAL || (process.platform === "win32" ? "notepad" : "vi");
    const tmp = path.join(os.tmpdir(), `smol-editor-${Date.now()}.md`);
    try {
      fs.writeFileSync(tmp, draft ?? "", "utf8");
    } catch (err: any) {
      ui.error(`· /editor: could not create the draft file (${err?.message ?? err})`);
      return null;
    }
    try {
      (ui as any).close?.();
    } catch {
      /* non-TUI surface */
    }
    let status: number | null = 1;
    let spawnErr: any = null;
    try {
      const res = spawnSync(editor, [tmp], { stdio: "inherit" });
      status = res.status;
      spawnErr = (res as any).error ?? null;
    } catch (err: any) {
      spawnErr = err;
    }
    try {
      (ui as any).start?.();
    } catch {
      /* non-TUI surface */
    }
    // Tui.start() is a no-op after close() (started flag): re-arm stdin here.
    try {
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      if (process.stdout.isTTY) process.stdout.write("\x1b[?2004h");
    } catch {
      /* headless pipe */
    }
    let content: string;
    try {
      content = fs.readFileSync(tmp, "utf8");
    } catch (err: any) {
      ui.error(`· /editor: could not read back the draft (${err?.message ?? err})`);
      return null;
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    if (spawnErr) {
      ui.error(`· /editor: could not start "${editor}" (${spawnErr?.message ?? spawnErr}) — message not sent.`);
      return null;
    }
    if (status !== 0) {
      ui.error(`· /editor: "${editor}" exited with code ${status ?? "?"} — message not sent.`);
      return null;
    }
    return content;
  }

  /** Write the transcript as timestamped markdown under .smol/exports/. */
  private exportTranscript(): void {
    const ui = this.ui;
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const dir = path.join(this.workspace, ".smol", "exports");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `export-${stamp}.md`);
      const lines = [`# smolcoder export — ${new Date().toLocaleString()}`, ""];
      for (const m of this.agent.messages) {
        lines.push(`## ${m.role}`, "", m.content || "(empty)", "");
      }
      fs.writeFileSync(file, lines.join("\n"), "utf8");
      ui.println(`· conversation exported: ${file}`);
    } catch (err: any) {
      ui.error(`· /export failed (${err?.message ?? err})`);
    }
  }

  /** Copy the last assistant reply to the OS clipboard (best effort). */
  private copyLastReply(): void {
    const ui = this.ui;
    const msgs = this.agent.messages;
    let text = "";
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant" && (msgs[i].content ?? "").trim()) {
        text = msgs[i].content;
        break;
      }
    }
    if (!text.trim()) {
      ui.status("· nothing to copy yet — no assistant reply");
      return;
    }
    try {
      if (process.platform === "win32") {
        const r = spawnSync("clip", [], { input: text, windowsHide: true });
        if (r.error) throw r.error;
      } else if (process.platform === "darwin") {
        const r = spawnSync("pbcopy", [], { input: text });
        if (r.error) throw r.error;
      } else {
        let r = spawnSync("xclip", ["-selection", "clipboard"], { input: text });
        if (r.error) r = spawnSync("xsel", ["--clipboard", "--input"], { input: text });
        if (r.error) throw r.error;
      }
      ui.println(`· copied ${text.length} chars to the clipboard`);
    } catch (err: any) {
      ui.error(`· /copy failed (${err?.message ?? err})`);
    }
  }

  /** The input loop. Returns after /exit (or after the host asked the UI to
   * hand back "/exit"). */
  async run(): Promise<void> {
    const { ui, agent, toolCtx, taskManager } = this;
    await this.bus.emit("session_start");
    for (;;) {
      const raw = await ui.readInput();
      const input = typeof raw === "string" ? raw : raw.text;
      const attachments = typeof raw === "string" ? [] : raw.attachments;
      const workItemId = typeof raw === "string" ? undefined : raw.workItemId;

      if (!attachments.length && input.startsWith("/")) {
        try {
          const [cmd, ...rest] = input.slice(1).split(/\s+/);
          const arg = rest[0];
          switch (cmd) {
            case "exit":
            case "quit":
            case "q":
              await this.shutdown();
              return;
            case "help":
              ui.println(this.help);
              {
                const n = this.allSlash.length - SLASH_COMMANDS.length;
                if (n > 0) ui.println(`\n${n} custom command(s) from .smol/commands and .smol/ecc-commands — type / to see them.`);
              }
              break;
            case "models":
            case "model":
              await this.switchModel(arg);
              break;
            case "mode":
              await this.setMode(arg);
              break;
            case "effort":
              await this.setEffort(arg);
              break;
            case "plan":
              if (toolCtx.plan.exists) ui.println(renderPlan(toolCtx.plan));
              else ui.status("· no plan yet — the agent creates one when it starts a multi-step task");
              break;
            case "todo":
              if (toolCtx.plan.exists) ui.println(renderPlan(toolCtx.plan));
              else ui.status("· no task list yet — the agent creates one when it starts a multi-step task");
              break;
            case "review": {
              const sub = (arg ?? "").trim();
              if (sub.toLowerCase() === "diff") {
                ui.println(formatReview(this.workspace, false));
                break;
              }
              if (sub.toLowerCase() === "staged") {
                ui.println(formatReview(this.workspace, true));
                break;
              }
              await this.reviewCode(sub || undefined);
              break;
            }
            case "diag": {
              const target = rest.join(" ").trim() || (arg ?? "");
              if (!target) {
                ui.status("· usage: /diag <file> — ex. /diag src/agent.ts");
                break;
              }
              ui.startSpinner("analyzing with the language server");
              try {
                ui.println(await queryCode(this.workspace, { action: "diag", path: target }));
              } catch (err: any) {
                ui.error(String(err?.message ?? err));
              } finally {
                ui.stopSpinner();
              }
              break;
            }
            case "doctor": {
              if ((arg ?? "").toLowerCase() === "install") {
                const lang = (rest[1] ?? "all").trim() || "all";
                ui.startSpinner(`installing language servers (${lang} — up to 2 min)`);
                try {
                  ui.println(setupLsp(this.workspace, lang));
                } catch (err: any) {
                  ui.error(String(err?.message ?? err));
                } finally {
                  ui.stopSpinner();
                }
                break;
              }
              ui.println(lspDoctor());
              break;
            }
            case "route": {
              const p = this.agent.provider as any;
              ui.println(
                p instanceof RoutingProvider
                  ? p.describe()
                  : 'Route: direct (this model only).\nSet SMOLCODER_FALLBACKS="ollama:qwen,lmstudio:glm" to add automatic failover.'
              );
              break;
            }
            case "tasks":
              ui.println(taskManager.list());
              break;
            case "logs":
              ui.println(taskManager.logs(arg ?? "", Number(rest[1]) || 50));
              break;
            case "stop":
              ui.println(taskManager.stop(arg ?? ""));
              break;
            case "mcp": {
              if (!toolCtx.mcp) {
                ui.warn("MCP bridge is not wired in this session.");
                break;
              }
              // Interruptors: /mcp on <nom> | off <nom> | toggle <nom>
              const verb = (rest[1] ?? "").toLowerCase();
              if (verb === "on" || verb === "off" || verb === "toggle" || verb === "enable" || verb === "disable") {
                const target = (rest[2] ?? "").trim();
                if (!target) {
                  ui.warn(`Usage: /mcp ${verb} <nom> - ex. /mcp off zapier`);
                  break;
                }
                try {
                  ui.println(setMcpEnabled(toolCtx.workspace, target, verb));
                } catch (err: any) {
                  ui.error(String(err?.message ?? err));
                }
                break;
              }
              if ((arg ?? "").toLowerCase() === "debug") {
                const target = rest[1];
                if (!target) {
                  ui.warn("Usage: /mcp debug <nom> — ex. /mcp debug files");
                  break;
                }
                ui.startSpinner(`debug MCP ${target}`);
                try {
                  ui.println(await toolCtx.mcp.debugServer(target));
                } catch (err: any) {
                  ui.error(String(err?.message ?? err));
                } finally {
                  ui.stopSpinner();
                }
                break;
              }
              ui.startSpinner("checking MCP servers (up to 20s — npx servers start slowly)");
              try {
                // 8s par défaut marquait les serveurs npx "too slow" à tort :
                // 5/22 verts à 8s contre 19/22 à 20s (mesuré).
                const rows = await toolCtx.mcp.status(20000);
                if (!rows.length) {
                  ui.status("· no MCP servers configured — see docs/plugins.md");
                } else {
                  for (const r of rows) {
                    ui.println(r.ok ? `● ${r.name} (${(r.tools ?? []).length} tools)` : `○ ${r.name} — ${r.error ?? "unreachable"}`);
                  }
                }
              } catch (err: any) {
                ui.error(String(err?.message ?? err));
              } finally {
                ui.stopSpinner();
              }
              break;
            }
            case "status":
              // One report for the terminal, the web hub and Electron: they
              // read the same function, so the three surfaces cannot disagree.
              ui.startSpinner("checking model, MCP and language servers");
              try {
                const report = await buildStatusReport({
                  workspace: toolCtx.workspace,
                  modelId: this.chosen.id,
                  backend: this.chosen.backend,
                  host: this.chosen.host,
                  effort: this.agent.provider.effortLabel() ?? this.effort ?? undefined,
                  mode: this.agent.mode,
                  modeLabel: MODE_LABELS[this.agent.mode],
                  contextTokens: this.agent.contextTokens(),
                  contextWindow: this.chosen.contextWindow,
                  mcpStatus: toolCtx.mcp ? () => toolCtx.mcp!.status(20000) : undefined,
                });
                ui.println(renderStatusText(report));
              } catch (err: any) {
                ui.error(String(err?.message ?? err));
              } finally {
                ui.stopSpinner();
              }
              break;
            case "skills":
              ui.println(listSkills(toolCtx.workspace));
              break;
            case "skill": {
              const sub = (arg ?? "").toLowerCase();
              if (sub === "list") {
                ui.println(listSkills(toolCtx.workspace));
                break;
              }
              if (sub === "save") {
                // From the raw line (not the whitespace split) so multi-line
                // checklists keep their newlines and spacing intact.
                const m = input.slice(1).match(/^skill\s+save\s+(\S+)\s+([\s\S]+)$/i);
                if (!m) {
                  ui.status("· usage: /skill save <name> <contenu — le corps de la skill>");
                  break;
                }
                ui.println(saveSkill(toolCtx.workspace, m[1], m[2]));
                break;
              }
              const name = sub === "read" || sub === "show" || sub === "view" ? rest.slice(1).join(" ").trim() : (arg ?? "").trim();
              if (!name) {
                ui.status("· usage: /skill read <name> — try /skills to list them");
                break;
              }
              ui.println(readSkill(toolCtx.workspace, name));
              break;
            }
            case "compact":
              ui.startSpinner("compacting");
              try {
                await agent.compactNow();
              } catch (err: any) {
                ui.error(String(err?.message ?? err));
              } finally {
                ui.stopSpinner();
              }
              break;
            case "context": {
              const budget = agent.contextBudget();
              ui.status(
                `Context ${budget.prompt.toLocaleString()} / ${budget.window.toLocaleString()} tokens (${budget.source})\nReply reserve ${budget.reserve.toLocaleString()} · available ${budget.available.toLocaleString()} · ${agent.messages.length} messages · ${agent.tools.length} tools`
              );
              break;
            }
            case "fetch": {
              const target = rest.join(" ").trim();
              if (!target) {
                ui.warn("Usage: /fetch https://example.com — lit une page web sans clé");
                break;
              }
              ui.startSpinner("fetching page");
              try {
                const { fetchUrl } = await import("./tools/web");
                ui.println(await fetchUrl(this.workspace, { url: target }));
              } catch (err: any) {
                ui.error(`· /fetch failed (${err?.message ?? err})`);
              } finally {
                ui.stopSpinner();
              }
              break;
            }
            case "clear":
              agent.resetTranscript();
              {
                const error = toolCtx.plan.reset();
                if (error) ui.warn(`· ${error}`);
                else ui.status("· conversation cleared");
              }
              break;
            case "undo":
              this.undoEdit();
              break;
            case "redo":
              this.redoEdit();
              break;
            case "rewind":
              this.rewindTurns(rest);
              break;
            case "routine":
              await this.routineCommand(rest);
              break;
            case "autopilot":
              await this.autopilotCommand(rest);
              break;
            case "editor": {
              const content = await this.openEditor(rest.join(" "));
              if (content === null) break;
              if (!content.trim()) {
                ui.status("· empty message — nothing sent");
                break;
              }
              await this.handleUserMessage(content, []);
              break;
            }
            case "export":
              this.exportTranscript();
              break;
            case "build": {
              if (!this.hubRec) {
                ui.status("· /build only works with --web (no hub in TUI mode)");
                break;
              }
              const hubClient = require("../desktop/hub-client.js");
              const res = await hubClient.runInTerminal(this.hubRec, "npm run build");
              ui.println(res);
              break;
            }
            case "copy":
              this.copyLastReply();
              break;
            default: {
              const body = loadCustomCommand(this.workspace, cmd, rest.join(" "));
              if (body !== null) await this.handleUserMessage(body, []);
              else ui.warn(`Unknown command /${cmd} — try /help`);
            }
          }
        } catch (err: any) {
          ui.error(`\n${err?.message ?? err}`);
        }
        ui.refresh();
        continue;
      }

      await this.handleUserMessage(input, attachments, workItemId);
    }
  }

  /** Idempotent: end-of-session hook, kill background tasks, close the UI,
   * then tell the host. */
  async shutdown(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.agent.cancel();
    try {
      await this.bus.emit("session_end");
    } catch {
      /* best effort */
    }
    this.taskManager.killAll();
    clearInterval(this.routineTimer);
    try {
      await this.toolCtx.browser?.close();
    } catch {
      /* best effort */
    }
    try {
      this.toolCtx.mcp?.closeAll();
    } catch {
      /* best effort */
    }
    this.ui.close();
    this.onExit?.();
  }

  /** Open the model picker; with `requested` set (from `/model <id>`), match a
   *  detected model directly and load it without showing the picker — an
   *  unknown name falls back to the picker with a warning. */
  private async switchModel(requested?: string): Promise<void> {
    const { ui, agent } = this;
    const wanted = (requested ?? "").trim().toLowerCase();
    let fresh: DetectedModel[];
    let idx: number | null;
    // The picker is also where other machines are added and managed; after
    // either, look again and reopen it so their models are right there.
    for (;;) {
      const hosts = loadConfig().hosts ?? [];
      ui.startSpinner("looking for models");
      try {
        fresh = await detectAll({ hosts });
      } catch {
        fresh = [];
      } finally {
        ui.stopSpinner();
      }
      if (!fresh.length) ui.warn("No model server is answering right now.");
      if (wanted) {
        // Local cards send display names ("llama-3-8b.Q4") while detection
        // reports ids ("llama-3-8b"): try exact, normalized and both directions
        // of containment before falling back to the interactive picker.
        const base = (x: string) =>
          x
            .split(/[\\/]/)
            .pop()!
            .replace(/\.(gguf|safetensors|bin)$/i, "")
            .toLowerCase();
        const hit =
          fresh.find((m) => m.id === requested) ||
          fresh.find((m) => base(m.id) === wanted) ||
          fresh.find((m) => base(m.id).includes(wanted) || wanted.includes(base(m.id)));
        if (hit) {
          idx = fresh.indexOf(hit);
          break;
        }
        ui.warn(`Modèle « ${requested} » introuvable — ouverture du sélecteur à la place.`);
      }
      const rows = [...modelOptions(fresh, this.chosen), FIND_ROW, ...(hosts.length ? [HOSTS_ROW] : [])];
      idx = await ui.select("Choisir un modèle", rows);
      if (idx === null) return;
      if (idx < fresh.length) break;
      if (rows[idx] === FIND_ROW) await findModelsOnNetwork(ui);
      else await manageHosts(ui);
    }
    let next: DetectedModel;
    ui.startSpinner(`chargement de ${fresh[idx].id}`);
    try {
      next = await loadModelCancellable(ui, fresh[idx], this.prefs.ctx, (label) => ui.startSpinner(label));
    } catch (err: any) {
      ui.error(String(err?.message ?? err));
      return;
    } finally {
      ui.stopSpinner();
    }
    const previousBackend = this.chosen.backend;
    this.chosen = next;
    if (next.backend !== previousBackend && this.prefs.effort === undefined) {
      this.effort = effortForBackend(loadConfig(), next.backend);
    }
    const p = routeProvider(
      makeProvider(next),
      process.env.SMOLCODER_FALLBACKS,
      () => detectAll({ hosts: loadConfig().hosts }),
      (m) => makeProvider(m),
      (msg) => {
        try {
          ui.status(msg);
        } catch {
          /* ignore */
        }
      }
    );
    p.setEffort(this.effort);
    agent.setProvider(p);
    this.ctxMgr.setWindow(next.contextWindow, p.maxOutputTokens);
    this.persist();
    ui.println(sessionLine(next, agent.mode));
    if (next.note) ui.warn(`  ${next.note}`);
    const advice = effortAdvice(next, this.effort);
    if (advice) ui.warn(`  ${advice}`);
  }

  private async setMode(arg?: string): Promise<void> {
    const { ui, agent } = this;
    let next: Mode | undefined =
      arg === "ro" || arg === "read-only"
        ? "ro"
        : arg === "edit" || arg === "write"
          ? "edit"
          : arg === "auto" || arg === "auto-pilote" || arg === "pilot"
            ? "auto"
            : arg === "bypass" || arg === "yolo"
              ? "bypass"
              : undefined;
    if (!next) {
      const idx = await ui.select("Select mode", [
        { label: "read-only", hint: "read and search files only", current: agent.mode === "ro" },
        {
          label: "edit",
          hint: "edit files; run commands inside the workspace, ask y/n for anything outside it",
          current: agent.mode === "edit",
        },
        {
          label: "auto-pilot",
          hint: "edit + safe read-only commands outside the workspace run without asking",
          current: agent.mode === "auto",
        },
        {
          label: "bypass permissions",
          hint: "full access, never asks for approval",
          current: agent.mode === "bypass",
        },
      ]);
      if (idx === null) return;
      next = MODE_ORDER[idx];
    }
    agent.setMode(next, this.sysPrompt(next));
    this.persist();
  }

  private async setEffort(arg?: string): Promise<void> {
    const { ui, agent } = this;
    const levels: (Effort | "default")[] = ["default", "off", "low", "medium", "high"];
    let next: Effort | null | undefined;
    if (arg && (levels as string[]).includes(arg)) {
      next = arg === "default" ? null : (arg as Effort);
    } else {
      const idx = await ui.select("Reasoning effort", [
        {
          label: "default",
          hint: this.chosen.reasoning?.default ? `the model's own default (${this.chosen.reasoning.default})` : "leave it to the model",
          current: this.effort === null,
        },
        { label: "off", hint: "no thinking — fastest, best for long tool loops", current: this.effort === "off" },
        { label: "low", hint: "brief reasoning", current: this.effort === "low" },
        { label: "medium", hint: "", current: this.effort === "medium" },
        { label: "high", hint: "most thorough — slow on local models", current: this.effort === "high" },
      ]);
      if (idx === null) return;
      next = idx === 0 ? null : (levels[idx] as Effort);
    }
    this.effort = next;
    agent.provider.setEffort(this.effort);
    this.persist();
    const label = agent.provider.effortLabel();
    ui.status(`· effort ${label ?? this.effort ?? "default"}`);
    const advice = effortAdvice(this.chosen, this.effort);
    if (advice) ui.warn(`  ${advice}`);
  }
}

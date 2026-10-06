#!/usr/bin/env node
// smolcoder — a smol, zero-config CLI coding agent for local models.
//
// Interactive: a modern inline TUI. No upfront questions — the last
// (or first) detected model is picked automatically; switch with /models,
// cycle modes with shift+tab, set reasoning effort with /effort.
// Web: smol --web serves a browser UI with a workspace sidebar — many
// projects and sessions side by side, started from anywhere.
// Headless: smol -p "prompt" for people and automations.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "./agent";
import { ensureBuilt } from "./build-check";
import { resolveSlashPrompt } from "./commands";
import { effortForBackend, loadConfig } from "./config";
import { ContextManager } from "./context";
import { detectAll } from "./detect";
import { EventBus } from "./events";
import { terminalLogo } from "./logo";
import { createMcpBridge } from "./mcp";
import { Plan } from "./plan";
import { loadPlugins } from "./plugins";
import { buildSystemPrompt, loadAgentsMd, loadMemoryMd } from "./prompt";
import type { Effort } from "./providers/types";
import { routeProvider } from "./router";
import {
  effortAdvice,
  makeProvider,
  noBackendsMessage,
  prepareModel,
  reportCompactions,
  Session,
  type SessionPrefs,
  sessionLine,
  setupWithoutLocalModels,
  yoloBanner,
} from "./session";
import type { Mode, ToolContext } from "./tools/index";
import { pickShell } from "./tools/shell";
import { TaskManager } from "./tools/tasks";
import { Tui } from "./tui/tui";
import { UI } from "./ui";
import { c } from "./util";
import { launchApp } from "./web/app";
import { askHubToOpen, hubVersion, pingHub, readHubRecord, WebHub } from "./web/hub";

const VERSION = require("../package.json").version as string;
const DEFAULT_WEB_PORT = 7433;

interface CliArgs {
  workspace: string;
  /** A folder was given on the command line (vs. defaulting to the cwd). */
  workspaceGiven?: boolean;
  mode?: Mode;
  model?: string;
  ctx?: number;
  print?: string;
  verify?: string;
  verifyAttempts?: number;
  effort?: Effort | null; // null = explicit "default"
  web?: boolean;
  webPort?: number;
  /** --host for --web: "127.0.0.1" (default) or "0.0.0.0" for the LAN. */
  webHost?: string;
  /** Open the web hub like a desktop app instead of a browser tab. */
  app?: boolean;
  help?: boolean;
  version?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { workspace: process.cwd() };
  const needValue = (flag: string, value: string | undefined): string => {
    if (value === undefined || value === "") {
      console.error(`Option "${flag}" needs a value. Try smol --help.`);
      process.exit(1);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version" || a === "-v") args.version = true;
    else if (a === "--mode" || a === "-m") {
      const v = needValue(a, argv[++i]);
      if (v === "ro" || v === "read-only" || v === "readonly") args.mode = "ro";
      else if (v === "edit" || v === "e" || v === "write" || v === "w") args.mode = "edit";
      else if (v === "bypass" || v === "bypass-permissions" || v === "b" || v === "yolo" || v === "y") args.mode = "bypass";
      else {
        console.error(`Unknown mode "${v}". Use ro, edit, or bypass.`);
        process.exit(1);
      }
    } else if (a === "--bypass" || a === "--bypass-permissions" || a === "--yolo") args.mode = "bypass";
    else if (a === "--model") args.model = needValue(a, argv[++i]);
    else if (a === "--ctx") {
      const raw = needValue(a, argv[++i]);
      args.ctx = Number(raw);
      if (!Number.isSafeInteger(args.ctx) || args.ctx < 1024) {
        console.error("--ctx must be a whole number of at least 1024 tokens.");
        process.exit(1);
      }
    } else if (a === "--effort") {
      const v = needValue(a, argv[++i]);
      if (v === "off" || v === "low" || v === "medium" || v === "high") args.effort = v;
      else if (v === "default") args.effort = null;
      else {
        console.error(`Unknown effort "${v}". Use off, low, medium, high, or default.`);
        process.exit(1);
      }
    } else if (a === "--verify") {
      const raw = needValue(a, argv[++i]);
      args.verify = raw;
      if (!args.verify?.trim()) {
        console.error("--verify needs an acceptance command.");
        process.exit(1);
      }
    } else if (a === "--verify-attempts") {
      const raw = needValue(a, argv[++i]);
      args.verifyAttempts = Number(raw);
      if (!Number.isSafeInteger(args.verifyAttempts) || args.verifyAttempts < 1) {
        console.error("--verify-attempts must be a positive whole number.");
        process.exit(1);
      }
    } else if (a === "--print" || a === "-p") args.print = needValue(a, argv[++i]);
    else if (a === "--app") args.app = true;
    else if (a === "--host") {
      const v = needValue(a, argv[++i]).trim();
      if (!v) {
        console.error('--host needs an address ("127.0.0.1" or "0.0.0.0").');
        process.exit(1);
      }
      args.webHost = v;
    } else if (a === "--web") {
      args.web = true;
      if (argv[i + 1] && /^\d+$/.test(argv[i + 1] as string)) {
        const port = Number(argv[++i]);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
          console.error("--web port must be a number between 1 and 65535.");
          process.exit(1);
        }
        args.webPort = port;
      }
    } else if (!a.startsWith("-")) {
      args.workspace = path.resolve(a);
      args.workspaceGiven = true;
    } else {
      console.error(`Unknown option "${a}". Try smol --help.`);
      process.exit(1);
    }
  }
  return args;
}

const HELP = `
${c.bold("smolcoder")} v${VERSION} — a smol, zero-config coding agent for local models.

Detects Ollama and LM Studio on this computer automatically — any port, Docker
containers included. Models on other machines: /models → "Find models on
another machine" searches your network or takes an address, and remembers it.

${c.bold("Usage:")}
  smol [workspace] [options]

${c.bold("Options:")}
  -m, --mode <ro|edit|bypass>  ro: read files only. edit: read/write files and run
                               commands inside the workspace; anything reaching
                               outside it asks y/n. bypass: no approvals at all.
  --model <name>               pick a model by (partial) name
  --ctx <tokens>               force a context window (Ollama: sends num_ctx)
  --verify <command>           headless acceptance gate; automatically repair failures
  --verify-attempts <count>     maximum acceptance checks (default 6; requires --verify)
  --effort <level>             reasoning effort: off, low, medium, high, default
  --web [port]                 browser UI (default port ${DEFAULT_WEB_PORT}): a sidebar of your
                               workspaces and sessions, an embedded browser and
                               terminal panel. Run it from anywhere; a second
                               smol --web adds its folder to the running UI.
  --app                        with --web: open the UI like a desktop app
                                (own window, no browser tab).
  --host <addr>                with --web: listen address ("127.0.0.1" or
                                "0.0.0.0" for the LAN; token link stays the key).
  -p, --print "<prompt>"       headless: run a single prompt and exit
  -h, --help                   this help
  -v, --version                version

${c.bold("Keys:")}
  shift+tab   cycle mode (read-only → edit → YOLO bypass)
  /           slash commands (autocomplete menu)
  esc         cancel a running turn · clear the input
  ctrl+c ×2   quit

${c.bold("Slash commands:")}
    /models     switch model         /tasks        background tasks
    /mode       set mode             /logs <id>    task output
    /effort     reasoning effort     /stop <id>    kill a task
    /context    context usage        /mcp          MCP server lights
    /compact    compact now          /skills       saved skills
    /plan       show the plan        /clear        reset conversation
    /undo       undo last write      /redo         redo undone write
    /editor     message via $EDITOR  /export       export to markdown
    /copy       copy last reply      /exit         quit
    /fetch <url> read a web page, no key
    /build      run npm run build in a terminal
    /<name>     custom commands from .smol/commands + .smol/ecc-commands

 ${c.bold("Input tricks:")}
   @path       inline a file (e.g. @src/app.js, max 9000 chars)
   !command    run in the workspace and send the output to the model
`;

/** Node fires 'exit' on normal termination but NOT on a killing signal, so
 * background tasks (dev servers) survive a closed terminal (SIGHUP) or `kill`
 * (SIGTERM) unless we handle those explicitly. Runs synchronous cleanup then
 * re-exits so the 'exit' path is still reached. */
function installSignalCleanup(cleanup: () => void): void {
  let done = false;
  const run = (code: number) => {
    if (done) return;
    done = true;
    try {
      cleanup();
    } catch {
      /* best effort */
    }
    process.exit(code);
  };
  process.on("SIGTERM", () => run(143));
  process.on("SIGHUP", () => run(129));
  process.on("SIGINT", () => run(130));
}

/** The SMOL banner that opens every interactive session. */
function printLogo(): void {
  for (const line of terminalLogo(process.stdout.columns || 80, VERSION)) console.log(line);
}

function prefsOf(args: CliArgs): SessionPrefs {
  return { mode: args.mode, model: args.model, ctx: args.ctx, effort: args.effort };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    console.log(VERSION);
    return;
  }
  // dist/ is git-ignored: guarantee fresh code on every entry point instead
  // of silently running last month's build. Cheap when fresh (one mtime walk).
  const ROOT = path.resolve(__dirname, "..");
  if (!ensureBuilt(ROOT, (s) => console.log(`  ${s}`))) {
    console.error("Cannot run without dist/. Run `npm run build` in the project, then retry.");
    process.exit(1);
  }
  if (args.verify && (!args.print || args.web)) throw new Error("--verify requires a headless -p run");
  if (args.verifyAttempts !== undefined && !args.verify) throw new Error("--verify-attempts requires --verify");
  if (args.app && !args.web) throw new Error("--app needs --web (smol --web --app)");
  if (!fs.existsSync(args.workspace) || !fs.statSync(args.workspace).isDirectory()) {
    console.error(`Workspace folder does not exist: ${args.workspace}`);
    process.exit(1);
  }

  if (args.print !== undefined) await runHeadless(args);
  else if (args.web) await runWeb(args);
  else await runInteractive(args);
}

// ---- headless (-p) ---------------------------------------------------------

async function runHeadless(args: CliArgs): Promise<void> {
  const ui = new UI();
  const bus = new EventBus();
  const cfg = loadConfig();
  const chosen = await prepareModel(prefsOf(args), cfg);
  if (!chosen) {
    ui.println(noBackendsMessage());
    ui.close();
    process.exit(1);
  }
  const mode = args.mode ?? cfg.lastMode ?? "edit";

  const shell = pickShell();
  const provider = routeProvider(
    makeProvider(chosen),
    process.env.SMOLCODER_FALLBACKS,
    () => detectAll({}),
    (m) => makeProvider(m),
    (msg) => {
      try {
        ui.status(msg);
      } catch {
        /* ignore */
      }
    }
  );
  provider.setEffort(effortForBackend(cfg, chosen.backend, args.effort));
  const taskManager = new TaskManager(args.workspace, (t) => {
    try {
      ui.status(`· background task ${t.id} finished (exit code ${t.exitCode ?? "?"}) — ${t.command.slice(0, 140)}`);
    } catch {
      /* status must never break startup or an exit */
    }
  });
  let headlessPlugins: ToolContext["plugins"] = [];
  try {
    headlessPlugins = loadPlugins(args.workspace);
  } catch {
    headlessPlugins = [];
  }
  const toolCtx: ToolContext = {
    workspace: args.workspace,
    taskManager,
    plan: new Plan(args.workspace, "cli"),
    filesTouched: new Set(),
    commandsRun: [],
    mcp: createMcpBridge(args.workspace),
    plugins: headlessPlugins,
  };
  const ctxMgr = new ContextManager(chosen.contextWindow, provider.maxOutputTokens);
  const agentsMd = loadAgentsMd(args.workspace);
  if (agentsMd) ui.status(`· AGENTS.md loaded (${agentsMd.split("\n").length} lines)`);
  const memoryMd = loadMemoryMd(args.workspace);
  if (memoryMd) ui.status(`· MEMORY.md loaded (${memoryMd.split("\n").length} lines)`);
  const systemPrompt = buildSystemPrompt({ workspace: args.workspace, mode, shellLabel: shell.label, agentsMd, memoryMd });
  const agent = new Agent(
    provider,
    mode,
    systemPrompt,
    toolCtx,
    ctxMgr,
    bus,
    ui,
    false,
    1000,
    args.verify ? { command: args.verify, maxAttempts: args.verifyAttempts } : undefined
  );
  reportCompactions(bus, ui);
  const shutdownTools = (): void => {
    taskManager.killAll();
    try {
      toolCtx.mcp?.closeAll();
    } catch {
      /* best effort */
    }
  };
  process.on("exit", shutdownTools);
  installSignalCleanup(shutdownTools);

  ui.println(sessionLine(chosen, mode));
  if (mode === "bypass") ui.warn(`  ${yoloBanner()}`);
  if (chosen.note) ui.warn(`  ${chosen.note}`);
  const effortSetting = effortForBackend(cfg, chosen.backend, args.effort);
  ui.status(`  effort ${provider.effortLabel() ?? effortSetting ?? "default"}`);
  const advice = effortAdvice(chosen, effortSetting);
  if (advice) ui.warn(`  ${advice}`);
  try {
    await agent.runTurn(resolveSlashPrompt(args.workspace, args.print!));
    if (agent.outcome !== "completed") process.exitCode = 1;
  } catch (err: any) {
    ui.error(`\n${err?.message ?? err}`);
    process.exitCode = 1;
  }
  const st = agent.lastTurnStats;
  if (st) {
    // Machine-readable summary for scripts/benchmarks comparing backends.
    process.stderr.write(
      `[stats] ${JSON.stringify({
        backend: chosen.backend,
        outcome: agent.outcome,
        verification: agent.verificationResult
          ? { attempts: agent.verificationResult.attempts, passed: agent.verificationResult.passed }
          : null,
        model: chosen.id,
        durationMs: st.durationMs,
        modelCalls: st.modelCalls,
        toolCalls: st.toolCalls,
        generatedTokens: st.generatedTokens,
        thinkingTokensEst: Math.round(st.thinkingChars / 4),
        genTokPerSec: st.genSeconds > 0 ? Math.round(st.generatedTokens / st.genSeconds) : null,
        promptTokensLast: st.promptTokensLast,
        contextWindow: chosen.contextWindow,
        planDone: toolCtx.plan.exists ? `${toolCtx.plan.doneCount}/${toolCtx.plan.steps.length}` : null,
      })}\n`
    );
  }
  taskManager.killAll();
  ui.close();
}

// ---- interactive TUI -------------------------------------------------------

async function runInteractive(args: CliArgs): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error('Interactive mode needs a terminal. For headless use, run: smol -p "your prompt" — or serve a browser UI with --web');
    process.exit(1);
  }

  printLogo();
  const cfg = loadConfig();
  process.stdout.write(c.dim("· looking for Ollama and LM Studio…"));
  let chosen = await prepareModel(prefsOf(args), cfg, (label) => {
    process.stdout.write(`\r\x1b[2K${c.dim(`· ${label}…`)}`);
  });
  process.stdout.write("\r\x1b[2K");

  const tui = new Tui();
  if (!chosen) {
    // Nothing on this computer: open the TUI early and offer to look on the
    // network. Until a session exists, esc/ctrl+c while it searches quits.
    tui.onCancel = () => {
      tui.close();
      process.exit(130);
    };
    tui.start();
    chosen = await setupWithoutLocalModels(tui, prefsOf(args));
    if (!chosen) {
      tui.close();
      console.log(noBackendsMessage());
      process.exit(1);
    }
  }

  const session = new Session(tui, { workspace: args.workspace, chosen, prefs: prefsOf(args), cfg, help: HELP, hubRec: null });
  session.onExit = () => process.exit(0);
  process.on("exit", () => session.taskManager.killAll());
  installSignalCleanup(() => {
    session.taskManager.killAll();
    try {
      tui.close(); // restore the raw-mode terminal on signal death
    } catch {
      /* best effort */
    }
  });

  tui.start();
  session.announce();
  tui.println("");
  await session.run();
}

// ---- web hub (--web) -------------------------------------------------------

/** The home folder or a drive root is not a project: launching there opens
 * the hub with the sidebar and lets the user pick a workspace. */
function isHomeOrRoot(p: string): boolean {
  const norm = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
  const r = path.resolve(p);
  return norm(r) === norm(os.homedir()) || path.dirname(r) === r;
}

async function runWeb(args: CliArgs): Promise<void> {
  console.log(`${c.bold("smol")}${c.dim(c.bold("coder"))} ${c.dim(`v${VERSION} · web`)}`);
  const port = args.webPort ?? DEFAULT_WEB_PORT;
  const workspace = args.workspace;
  const autoStart = !!args.workspaceGiven || !isHomeOrRoot(workspace);

  // A hub is already running: hand it this folder instead of starting another.
  const rec = readHubRecord();
  if (rec && (args.webPort === undefined || rec.port === port) && (await pingHub(rec))) {
    const running = await hubVersion(rec);
    if (running && running.version !== VERSION) {
      console.error(
        `\n  ⚠ the running hub serves v${running.version} (since ${new Date(running.startedAt || Date.now()).toLocaleString()}), this smol is v${VERSION}.` +
          `\n  New buttons and endpoints will be MISSING until you restart it: stop the old hub (Ctrl+C in its terminal, PID ${rec.pid}) and run smol --web again.\n`
      );
    }
    const r = await askHubToOpen(rec, workspace, autoStart);
    if (r) {
      const url = `http://127.0.0.1:${rec.port}/?k=${rec.token}${r.id ? `#${r.id}` : ""}`;
      console.log(`\n  ${autoStart ? "started a session for" : "added"} ${workspace} in the running web UI:\n  ${url}\n`);
      if (args.app) openAppWindow(url);
      return;
    }
  }

  const host = args.webHost || "127.0.0.1";
  if (args.webHost && args.webHost !== "127.0.0.1" && args.webHost !== "localhost") {
    console.log("  LAN open: anyone on your network with the ?k= link can use it (token key, no password).");
  }
  const hub = new WebHub({ port, host, prefs: prefsOf(args), help: HELP, version: VERSION });
  try {
    await hub.start();
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") {
      console.error(`\nPort ${port} is already in use. Pick another with: smol --web ${port + 1}`);
      process.exit(1);
    }
    throw err;
  }
  process.on("exit", () => hub.shutdownSync());
  installSignalCleanup(() => hub.shutdownSync());

  if (autoStart) hub.openSession(workspace);
  console.log(
    `\n  smolcoder web UI:  ${hub.url()}\n  ${
      autoStart ? `workspace ${workspace}` : "pick a workspace in the sidebar"
    } · ctrl+c stops the server\n`
  );
  if (args.app) openAppWindow(hub.url());
}

/** Open the hub like a desktop app and say what happened. Never throws. */
function openAppWindow(url: string): void {
  try {
    const how = launchApp(url);
    if (how === "app") console.log("  opened as a desktop app window\n");
    else if (how === "browser") console.log("  no app browser found — opened in your browser instead\n");
    else console.log("  could not open a window — copy the link above\n");
  } catch {
    console.log("  could not open a window — copy the link above\n");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

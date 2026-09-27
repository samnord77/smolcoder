// Tool registry. Thirteen tools with flat parameters — no
// nested objects or arrays: small models mangle them), an example call inside
// every description (small models imitate better than they infer), and the
// mode decides which schemas are sent. The agent rechecks mode at execution.
// Read-only mode keeps read_file, list_files, search, plan, skill
// (list/read only) and fetch_url; edit/bypass add write_file, edit_file,
// run_command, task, delegate, mcp, symbols and skill save.

import * as fs from "fs";
import { Plan } from "../plan";
import { ToolSpec } from "../providers/types";
import { editFile, listFiles, readFile, writeFile } from "./fs-tools";
import { fetchUrl } from "./web";
import { queryCode } from "../lsp-pro";
import { McpBridge } from "../mcp";
import { listSkills, readSkill, saveSkill } from "../skills";
import { syntaxCheck } from "./check";
import { runCommand } from "./shell";
import { TaskManager } from "./tasks";
import { CoworkBoard } from "./cowork";
import { queryIndex } from "../codeindex";
import { queryGit } from "../git";
import { queryDebug } from "../debug";
import { formatFile } from "../format";
import { resolveInWorkspace, SandboxError } from "../sandbox";
import { truncateMiddle } from "../util";
import { searchFilesBounded } from "./search-worker";
import { LoadedPlugin, describePlugins } from "../plugins";

export type Mode = "ro" | "edit" | "bypass";

export const MODE_LABELS: Record<Mode, string> = {
  ro: "read-only",
  edit: "edit",
  bypass: "YOLO bypass",
};

const TOOL_RESULT_CAP = 10000; // chars — final safety net over per-tool caps

function workTool(canWrite: boolean): ToolSpec {
  const actions = canWrite ? ["list", "create", "update", "complete", "archive"] : ["list"];
  return {
    name: "work",
    description: canWrite
      ? 'Keep durable personal and work tasks in this project. List: {"action":"list","status":"open"}. Create: {"action":"create","title":"Prepare report","area":"work","due":"2026-10-02","priority":"high","notes":"Use Excel figures"}. Update or complete by task_id from the list. Data stays in .smol/work-items.json.'
      : 'Read the durable personal and work task list for this project. Example: {"action":"list","status":"open","area":"work"}.',
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: actions },
        task_id: { type: "string", description: "ID from the work list" },
        title: { type: "string", description: "Task title (up to 200 characters)" },
        area: { type: "string", description: "Work or life area, such as work, personal, family, or study" },
        due: { type: "string", description: "Optional due date, YYYY-MM-DD; empty clears it when updating" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        notes: { type: "string", description: "Short task notes (up to 2,000 characters)" },
        status: { type: "string", enum: ["open", "completed", "archived"], description: "Optional list filter" },
      },
      required: ["action"],
    },
  };
}

export function buildToolSpecs(mode: Mode, opts?: { allowDelegate?: boolean }): ToolSpec[] {
  const read: ToolSpec[] = [
    {
      name: "read_file",
      description:
        'Read a text file in the workspace. Example: {"path": "src/app.js"}. Long files are returned in chunks; pass "offset" (a line number) to continue reading.',
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace" },
          offset: { type: "number", description: "Line number to start from (optional)" },
          limit: { type: "number", description: "Max lines to return (optional)" },
        },
        required: ["path"],
      },
    },
    {
      name: "list_files",
      description:
        'List files and folders in the workspace. Example: {} for everything, or {"path": "src"} for one folder. Folders end with "/".',
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Folder to list (optional, default: whole workspace)" },
        },
      },
    },
    {
      name: "search",
      description:
        'Search inside files for a pattern (regular expression; plain text also works). Example: {"pattern": "TODO"}. Returns file:line: matching text.',
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Text or regex to find" },
          path: { type: "string", description: "Folder to search in (optional)" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "plan",
      description:
        'Plan runnable increments, kept across compaction and saved sessions. Create: {"action":"set","steps":"wire entry point; run build; add movement and test"}. Finish current step: {"action":"done"} (or supply step). Save exact APIs, error and next edit before a long investigation: {"action":"checkpoint","text":"..."} (max 1000 chars, replaces current step notes). Append: {"action":"add","text":"..."}. Show: {"action":"show"}.',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["set", "done", "add", "show", "checkpoint"] },
          steps: { type: "string", description: 'The steps, one per line; semicolon lists also accepted (only for "set")' },
          step: { type: "number", description: 'Step number to mark done (optional, for "done")' },
          text: { type: "string", description: 'Step to append or working checkpoint' },
        },
        required: ["action"],
      },
    },
    {
      name: "skill",
      description:
        'Save and reuse know-how across sessions (auto-evolution). List: {"action":"list"}. Read: {"action":"read","name":"login-debug"}. Save a reusable checklist after a repair: {"action":"save","name":"login-debug","content":"# steps\\n1. ..."} (edit/bypass only).',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "read", "save"] },
          name: { type: "string", description: "Skill name: letters, numbers, - or _ (for read/save)" },
          content: { type: "string", description: "Checklist markdown (only for save)" },
        },
        required: ["action"],
      },
    },
    {
      name: "fetch_url",
      description:
        'Read a public web page as text (docs, APIs, articles). Example: {"url": "https://example.com/docs"}. No key needed. Local and private addresses are refused.',
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full https:// address of the page" },
        },
        required: ["url"],
      },
    },
    {
      name: "index_symbols",
      description:
        'Find where a function, class or type is defined (offline code index, instant). Search: {"action": "search", "query": "Agent"}. All symbols of one file: {"action": "file", "path": "src/agent.ts"}. Index info: {"action": "stats"}. Rebuild after adding files: {"action": "refresh"} (edit modes only).',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["search", "file", "stats", "refresh"] },
          query: { type: "string", description: "Symbol name to find (only for search)" },
          path: { type: "string", description: "File path relative to the workspace (only for file)" },
          limit: { type: "number", description: "Max results (only for search, default 30)" },
        },
        required: ["action"],
      },
    },
    {
      name: "git",
      description:
        'Read the git repository (works in read-only mode). Status: {"action": "status"}. Uncommitted changes: {"action": "diff"}. Hunk review: {"action": "review"}. History: {"action": "log", "count": 10}. Who wrote a line: {"action": "blame", "path": "src/agent.ts", "line": 42}. Branches: {"action": "branch"}. Stage (edit only): {"action": "stage", "path": "src/agent.ts"} — use "." for everything. Stage one hunk (edit only): {"action": "stage_hunk", "path": "src/a.ts", "hunk": 0}. Revert one hunk, undoable (edit only): {"action": "revert_hunk", "path": "src/a.ts", "hunk": 1}. Commit (edit only): {"action": "commit", "message": "Fix login retry"}.',
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["status", "diff", "log", "blame", "branch", "stage", "commit", "review", "stage_hunk", "revert_hunk"],
          },
          path: { type: "string", description: "File path (for diff, blame, stage, stage_hunk, revert_hunk); comma-separated for stage" },
          message: { type: "string", description: "Commit message (only for commit)" },
          count: { type: "number", description: "Commits to show (only for log, default 10)" },
          line: { type: "number", description: "Line number (only for blame)" },
          staged: { type: "boolean", description: "Show staged changes (for diff and review)" },
          stat: { type: "boolean", description: "Show file summary instead of full patch (only for diff)" },
          hunk: { type: "number", description: "Hunk number from review (only for stage_hunk and revert_hunk)" },
        },
        required: ["action"],
      },
    },
    {
      name: "plugins",
      description:
        'List installed workspace plugins with their version and description. Example: {"action": "list"}. Add one by dropping a .cjs file into .smol/plugins/ (optional <name>.json name card).',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list"] },
        },
        required: ["action"],
      },
    },
  ];

  const write: ToolSpec[] = [
    {
      name: "write_file",
      description:
        'Create a new file or completely overwrite an existing one. Example: {"path": "src/new.js", "content": "..."}. Parent folders are created automatically. To change part of an existing file, prefer edit_file.',
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace" },
          content: { type: "string", description: "The full file content" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "edit_file",
      description:
        'Replace text inside an existing file. Copy old_text EXACTLY from the file (a few lines, enough to be unique), and give the replacement as new_text. Example: {"path": "src/app.js", "old_text": "const x = 1;", "new_text": "const x = 2;"}',
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace" },
          old_text: { type: "string", description: "Exact text currently in the file" },
          new_text: { type: "string", description: "Text to replace it with" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
    {
      name: "format",
      description:
        'Format one code file in place with the project formatter (prettier, black/ruff, rustfmt, gofmt). Example: {"path": "src/agent.ts"}. Undoable like any edit. If no formatter is installed, the answer is the install command.',
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace" },
        },
        required: ["path"],
      },
    },
  ];

  const exec: ToolSpec[] = [
    {
      name: "run_command",
      description:
        'Run a shell command in the workspace and wait for it to finish. Example: {"command": "npm test"}. Times out after 120s — for servers or watchers use the task tool instead.',
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run" },
        },
        required: ["command"],
      },
    },
    {
      name: "task",
      description:
        'Manage background tasks (things that keep running, like dev servers). action "start" runs a command in the background: {"action": "start", "command": "npm run dev"}. action "logs" shows recent output: {"action": "logs", "task_id": "t1"}. action "list" shows all tasks. action "stop" kills one: {"action": "stop", "task_id": "t1"}.',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "list", "logs", "stop"] },
          command: { type: "string", description: 'Command to run (only for "start")' },
          task_id: { type: "string", description: 'Task id like "t1" (for "logs" and "stop")' },
        },
        required: ["action"],
      },
    },
    {
      name: "debug",
      description:
        'Run the program under a real debugger (breakpoints, stack, variables) using .smol/debug.json. Example: {"action": "run"}. First call without config explains the setup. Runs code: edit modes only.',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["run"] },
        },
        required: ["action"],
      },
    },
  ];

  if (mode === "ro") return [...read, workTool(false)];
  const mcp: ToolSpec[] = [
    {
      name: "mcp",
      description:
        'Use an external MCP server configured in `.smol/mcp.json` (mail, sheets, browser…). List servers: {"server": "?", "tool": ""}. Call: {"server": "files", "tool": "read_file", "args": "{\\"path\\": \\"notes.txt\\"}"} — args stays a JSON string.',
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: 'Server name from `.smol/mcp.json`, or "?" to list' },
          tool: { type: "string", description: "Tool name on that server" },
          args: { type: "string", description: "Tool arguments as a JSON object in a string (optional)" },
        },
        required: ["server", "tool"],
      },
    },
  ];
  const delegate: ToolSpec[] =
    opts?.allowDelegate === false
      ? []
      : [
          {
            name: "delegate",
      description:
        'Hand a small subtask to a bounded, role-scoped sub-agent. Example: {"role":"architect","task":"map the login flow and report files + line numbers"}. Choose a role shown in the IDE control centre; omit role for expert. Its tool allowlist is enforced. Max 12 tool calls, no nested delegates.',
            parameters: {
              type: "object",
          properties: {
            task: { type: "string", description: "The small concrete subtask" },
            role: { type: "string", description: 'Optional specialist role from the IDE roles panel (default: "expert")' },
              },
              required: ["task"],
            },
          },
        ];
  const symbols: ToolSpec[] = [
    {
      name: "symbols",
      description:
        'Ask a language server about code (TypeScript, JavaScript, Python, Rust, Go). Hover: {"action": "hover", "path": "src/agent.ts", "line": 10, "col": 15}. Definition: {"action": "def", ...}. References: {"action": "refs", ...}. Diagnostics: {"action": "diag", "path": "src/agent.ts"}. Rename preview: {"action": "rename", "path": "...", "line": 3, "col": 5, "new_text": "total"}. Completions: {"action": "completion", ...}. Signature: {"action": "signature", ...}. Quick fixes: {"action": "quickfix", ...}. Whole-workspace symbol: {"action": "wsymbol", "query": "Agent"}. Lines and columns start at 1.',
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["hover", "def", "refs", "diag", "rename", "completion", "signature", "wsymbol", "quickfix"],
          },
          path: { type: "string", description: "File path relative to the workspace (not for wsymbol)" },
          line: { type: "number", description: "Line number starting at 1 (not for diag/wsymbol)" },
          col: { type: "number", description: "Column number starting at 1 (not for diag/wsymbol)" },
          new_text: { type: "string", description: "New name (only for rename)" },
          query: { type: "string", description: "Symbol name to find (only for wsymbol)" },
          lang: { type: "string", description: "Language for wsymbol: typescript, python, rust, go (optional)" },
        },
        required: ["action"],
      },
    },
  ];
  return [...read, workTool(true), ...write, ...exec, ...mcp, ...symbols, ...delegate];
}

/** One undoable file write: absolute path, full previous content (null when
 * the file did not exist) and what redo must re-apply. For "edit", redo
 * replays the old_text -> next replacement (never writes the snippet alone). */
export interface UndoEntry {
  abs: string;
  prev: string | null;
  next: string;
  kind: "write" | "edit";
  oldText?: string;
}

const UNDO_CAP = 20;
const UNDO_SKIP_BYTES = 1024 * 1024; // >1 Mo : skip silencieuse, pas d'entrée undo

/** Capture le contenu AVANT écriture. Retourne null quand il n'y a rien à
 * enregistrer (hors workspace, dossier, >1 Mo, illisible). */
function capturePrev(workspace: string, rel: unknown): { abs: string; prev: string | null } | null {
  let abs: string;
  try {
    abs = resolveInWorkspace(workspace, String(rel));
  } catch {
    return null;
  }
  try {
    if (!fs.existsSync(abs)) return { abs, prev: null };
    const stat = fs.statSync(abs);
    if (stat.isDirectory() || stat.size > UNDO_SKIP_BYTES) return null;
    return { abs, prev: fs.readFileSync(abs, "utf8") };
  } catch {
    return null;
  }
}

/** Enregistre l'écriture APRES succès (cap 20, redo vidée à chaque nouvel edit). */
function pushUndo(
  ctx: ToolContext,
  captured: { abs: string; prev: string | null } | null,
  next: unknown,
  kind: "write" | "edit" = "write",
  oldText?: unknown
): void {
  if (!captured || typeof next !== "string") return;
  ctx.undoStack ??= [];
  ctx.redoStack ??= [];
  ctx.undoStack.push({
    abs: captured.abs,
    prev: captured.prev,
    next,
    kind,
    ...(kind === "edit" && typeof oldText === "string" ? { oldText } : {}),
  });
  if (ctx.undoStack.length > UNDO_CAP) ctx.undoStack.splice(0, ctx.undoStack.length - UNDO_CAP);
  ctx.redoStack.length = 0;
}

export interface ToolContext {
  workspace: string;
  taskManager: TaskManager;
  plan: Plan;
  /** Records for the compaction state note. */
  filesTouched: Set<string>;
  commandsRun: string[];
  /** Undo/redo des écritures fichier (write_file/edit_file). */
  undoStack?: UndoEntry[];
  redoStack?: UndoEntry[];
  /** Internal per-request cap; never a model-supplied tool argument. */
  resultCharLimit?: number;
  /** Nesting depth of sub-agents (0 = main agent). The delegate tool is
   * hidden at depth >= 1 so sub-agents cannot spawn their own. */
  depth?: number;
  /** Child-agent capability boundary, owned by the harness, never model input. */
  allowedTools?: ReadonlySet<string>;
  role?: string;
  /** False in read-only mode: skill "save" is refused. Defaults to true so
   * older callers and tests keep working. */
  canWrite?: boolean;
  /** Wired by the Agent: runs one bounded role-scoped sub-turn. Never set by the model. */
  delegate?: (task: string, signal?: AbortSignal, role?: string) => Promise<string>;
  /** Lazy MCP bridge (external servers from `.smol/mcp.json`). Never set by the model. */
  mcp?: McpBridge;
  /** Workspace tool plugins (.smol/plugins/*.cjs). Never set by the model. */
  plugins?: LoadedPlugin[];
}

export async function executeTool(
  name: string,
  args: Record<string, any>,
  ctx: ToolContext,
  signal?: AbortSignal
): Promise<string> {
  try {
    if (ctx.allowedTools && !ctx.allowedTools.has(name)) {
      return `Error: ${name} is unavailable for the ${ctx.role ?? "restricted"} role. Use only the tools assigned to this sub-agent.`;
    }
    try {
      for (const p of ctx.plugins ?? []) {
        if (!p || !p.ok || typeof p.beforeTool !== "function") continue;
        let r: unknown;
        try {
          r = p.beforeTool(name, args);
        } catch {
          continue;
        }
        if (!r || typeof r !== "object") continue;
        const rec = r as { args?: unknown; block?: unknown };
        if (typeof rec.block === "string" && rec.block.trim()) {
          return `Error: ${rec.block}`;
        }
        if (rec.args && typeof rec.args === "object") {
          args = rec.args as Record<string, any>;
        }
      }
    } catch {
      /* plugin hooks never break the turn */
    }
    let result: string;
    switch (name) {
      case "read_file":
        result = readFile(ctx.workspace, args, ctx.resultCharLimit ? ctx.resultCharLimit - 256 : undefined);
        break;
      case "list_files":
        result = listFiles(ctx.workspace, args);
        break;
      case "search":
        result = await searchFilesBounded(ctx.workspace, args, signal);
        break;
      case "plan": {
        const action = args.action ?? (typeof args.steps === "string" ? "set" : undefined);
        if (action === "set") result = ctx.plan.set(typeof args.steps === "string" ? args.steps : "");
        else if (action === "done")
          result = ctx.plan.markDone(args.step === undefined ? undefined : Number(args.step));
        else if (action === "add") result = ctx.plan.add(String(args.text ?? ""));
        else if (action === "checkpoint") result = ctx.plan.checkpoint(String(args.text ?? ""));
        else if (action === "show") result = ctx.plan.modelView();
        else
          return 'Error: action must be one of "set", "done", "add", "show", "checkpoint". Example: {"action": "done"}';
        break;
      }
      case "work": {
        if (args.action !== "list" && ctx.canWrite === false) {
          return "Error: creating or changing work items is unavailable in read-only mode. Switch to edit mode to make changes.";
        }
        result = new CoworkBoard(ctx.workspace).run(args);
        if (!result.startsWith("Error") && args.action !== "list") ctx.filesTouched.add(".smol/work-items.json");
        break;
      }
      case "write_file": {
        const undoCap = capturePrev(ctx.workspace, args.path);
        result = writeFile(ctx.workspace, args);
        if (!result.startsWith("Error")) {
          pushUndo(ctx, undoCap, args.content);
          ctx.filesTouched.add(String(args.path));
          result += afterWrite(ctx.workspace, String(args.path));
        }
        break;
      }
      case "edit_file": {
        const undoCap = capturePrev(ctx.workspace, args.path);
        result = editFile(ctx.workspace, args);
        if (!result.startsWith("Error")) {
          pushUndo(ctx, undoCap, args.new_text, "edit", args.old_text);
          ctx.filesTouched.add(String(args.path));
          result += afterWrite(ctx.workspace, String(args.path));
        }
        break;
      }
      case "run_command":
        if (typeof args.command !== "string" || !args.command.trim()) {
          return 'Error: command is required. Example: {"command": "npm test"}';
        }
        result = await runCommand(args.command, ctx.workspace, signal);
        ctx.commandsRun.push(`${args.command} → ${result.split("\n").at(-1)}`);
        if (ctx.commandsRun.length > 50) ctx.commandsRun.splice(0, ctx.commandsRun.length - 50);
        break;
      case "task": {
        const action = args.action;
        if (action === "start") {
          if (typeof args.command !== "string" || !args.command.trim()) {
            return 'Error: "start" needs a command. Example: {"action": "start", "command": "npm run dev"}';
          }
          ctx.commandsRun.push(`[bg] ${args.command}`);
          result = await ctx.taskManager.startWithEarlyOutput(args.command);
        } else if (action === "logs") {
          result = ctx.taskManager.logs(String(args.task_id ?? ""), Number(args.lines) || 50);
        } else if (action === "stop") {
          result = ctx.taskManager.stop(String(args.task_id ?? ""));
        } else if (action === "list") {
          result = ctx.taskManager.list();
        } else {
          return 'Error: action must be one of "start", "list", "logs", "stop". Example: {"action": "list"}';
        }
        break;
      }
      case "delegate": {
        const task = typeof args.task === "string" ? args.task.trim() : "";
        if (!task) {
          return 'Error: task is required. Example: {"task": "find where login validation lives and report files + line numbers"}';
        }
        if (task.length > 2000) {
          return "Error: keep the subtask under 2000 characters — one small concrete job.";
        }
        if (!ctx.delegate) {
          return "Error: sub-agents are unavailable at this depth. Do the step yourself with read/search.";
        }
        const role = typeof args.role === "string" ? args.role.trim() : undefined;
        result = await ctx.delegate(task, signal, role);
        break;
      }
      case "skill": {
        const action = args.action;
        if (action === "list") result = listSkills(ctx.workspace);
        else if (action === "read") result = readSkill(ctx.workspace, args.name);
        else if (action === "save") {
          if (ctx.canWrite === false) {
            return "Error: saving skills is unavailable in read-only mode. Switch to edit mode to save.";
          }
          result = saveSkill(ctx.workspace, args.name, args.content);
          if (!result.startsWith("Error")) ctx.filesTouched.add(`.smol/skills/${String(args.name).trim()}.md`);
        } else {
          return 'Error: action must be one of "list", "read", "save". Example: {"action": "list"}';
        }
        break;
      }
      case "fetch_url": {
        result = await fetchUrl(ctx.workspace, args, signal);
        break;
      }
      case "symbols": {
        result = await queryCode(ctx.workspace, args, signal);
        break;
      }
      case "mcp": {
        if (!ctx.mcp) {
          return "Error: MCP bridge is not wired in this session. The host must set toolCtx.mcp (see docs/plugins.md).";
        }
        result = await ctx.mcp.call(String(args.server ?? ""), String(args.tool ?? ""), String(args.args ?? ""), signal);
        break;
      }
      case "index_symbols": {
        result = queryIndex(ctx.workspace, args, { canWrite: ctx.canWrite });
        break;
      }
      case "git": {
        // revert_hunk destroys work: capture it first so /undo brings it back.
        const gAction = String(args.action ?? "");
        const gPath = typeof args.path === "string" ? args.path : "";
        const undoCap = gAction === "revert_hunk" && gPath ? capturePrev(ctx.workspace, gPath) : null;
        result = queryGit(ctx.workspace, args, { canWrite: ctx.canWrite });
        if (gAction === "revert_hunk" && undoCap && !result.startsWith("Error")) {
          try {
            pushUndo(ctx, undoCap, fs.readFileSync(resolveInWorkspace(ctx.workspace, gPath), "utf8"));
          } catch {
            /* undo is best effort — the revert itself succeeded */
          }
          ctx.filesTouched.add(gPath);
        }
        break;
      }
      case "debug": {
        result = await queryDebug(ctx.workspace, args, { canWrite: ctx.canWrite }, signal);
        break;
      }
      case "format": {
        const rel = typeof args.path === "string" ? args.path : "";
        if (!rel) {
          return 'Error: path is required. Example: {"path": "src/agent.ts"}';
        }
        const undoCap = capturePrev(ctx.workspace, rel);
        const fr = formatFile(ctx.workspace, rel);
        result = fr.message;
        if (fr.ok && !result.startsWith("Error")) {
          try {
            pushUndo(ctx, undoCap, fs.readFileSync(resolveInWorkspace(ctx.workspace, rel), "utf8"));
          } catch {
            /* undo is best effort — the format itself succeeded */
          }
          ctx.filesTouched.add(rel);
        }
        break;
      }
      case "plugins": {
        if (args.action !== undefined && args.action !== "list") {
          return 'Error: action must be "list". Example: {"action": "list"}';
        }
        result = describePlugins(ctx.workspace);
        break;
      }
      default:
        return `Error: unknown tool "${name}". Available tools are listed in your tool definitions — use one of those.`;
    }
    try {
      for (const p of ctx.plugins ?? []) {
        if (!p || !p.ok || typeof p.afterTool !== "function") continue;
        try {
          const out = p.afterTool(name, result);
          if (typeof out === "string") result = out;
        } catch {
          /* ignore failing after-hook */
        }
      }
    } catch {
      /* plugin hooks never break the turn */
    }
    return truncateMiddle(result, TOOL_RESULT_CAP);
  } catch (err: any) {
    if (err instanceof SandboxError) return `Error: ${err.message}`;
    return `Error: ${err?.message ?? String(err)}`;
  }
}

/** Post-write hook: parse what was just written and coach on the first
 * syntax error. A one-line warning riding on the success message is the
 * cheapest possible feedback loop for a local model. */
function afterWrite(workspace: string, relPath: string): string {
  try {
    const abs = resolveInWorkspace(workspace, relPath);
    const warning = syntaxCheck(abs, relPath);
    return warning ? `
Warning: ${warning} Fix this before moving on (use edit_file).` : "";
  } catch {
    return "";
  }
}

/** The command a call would run, if it is an exec call (edit mode may gate it;
 * bypass never asks; in ro mode the tool does not exist). */
export function commandOf(name: string, args: Record<string, any>): string | null {
  if (name === "run_command") return String(args.command ?? "");
  if (name === "task" && args.action === "start") return String(args.command ?? "");
  return null;
}

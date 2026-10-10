// Tool registry. Flat parameters — no
// nested objects or arrays: small models mangle them), an example call inside
// every description (small models imitate better than they infer), and the
// mode decides which schemas are sent. The agent rechecks mode at execution.
// Read-only mode keeps read_file, list_files, search, find_local, plan, skill
// (list/read only) and fetch_url; edit/bypass add write_file, edit_file,
// run_command, task, delegate, mcp, symbols and skill save.

import * as fs from "node:fs";
import { queryIndex } from "../codeindex";
import { queryDebug } from "../debug";
import { formatFile } from "../format";
import { queryGit } from "../git";
import { setupLsp } from "../lsp-install";
import { queryCode } from "../lsp-pro";
import type { McpBridge } from "../mcp";
import type { Plan } from "../plan";
import { describePlugins, type LoadedPlugin } from "../plugins";
import type { ToolSpec } from "../providers/types";
import { resolveInWorkspace, SandboxError } from "../sandbox";
import { listSkills, readSkill, saveSkill } from "../skills";
import { truncateMiddle } from "../util";
import { syntaxCheck } from "./check";
import { CoworkBoard } from "./cowork";
import { createFolder, deletePath, editFile, listFiles, movePath, readFile, writeFile } from "./fs-tools";
import { searchLocalFilesBounded } from "./local-search";
import { searchFilesBounded } from "./search-worker";
import { runCommand, type ShellControl } from "./shell";
import type { TaskManager } from "./tasks";
import { fetchUrl } from "./web";

export type Mode = "ro" | "edit" | "bypass";

export const MODE_LABELS: Record<Mode, string> = {
  ro: "lecture seule",
  edit: "édition",
  bypass: "YOLO",
};

const TOOL_RESULT_CAP = 10000; // chars — final safety net over per-tool caps

function workTool(canWrite: boolean): ToolSpec {
  const actions = canWrite ? ["list", "create", "update", "archive", "assign", "record_report"] : ["list"];
  return {
    name: "work",
    description: canWrite
      ? 'Keep durable personal and work tasks in this project. List: {"action":"list","status":"open"}. Create: {"action":"create","title":"Prepare report","area":"work","due":"2026-10-02","priority":"high","role":"architect","acceptance":"All tests pass"}. Assign role: {"action":"assign","task_id":"...","role":"implementer"}. Record a factual report: {"action":"record_report","task_id":"...","report":"..."} . The session runtime, not the model, controls running/verified/failed status and completion based on the actual turn and checks. Data stays in .smol/work-items.json.'
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
        role: { type: "string", description: "Assigned subagent specialist role (e.g. architect, implementer, quality_reviewer)" },
        acceptance: { type: "string", description: "Acceptance criteria / test verification required to complete the task" },
        report: { type: "string", description: "Execution report summary returned by the subagent" },
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
      name: "find_local",
      description:
        'Find files and folders on this computer by filename only. This does not open file contents. Default root is your user profile; narrow it with an absolute folder such as C:\\Users\\Name\\Downloads or a workspace-relative path. Example: {"query":"deepseek"}. Results are capped and say when incomplete.',
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Distinctive filename fragment, 2–120 characters; use e.g. deepseek, not a full sentence" },
          path: { type: "string", description: "Optional absolute folder on this computer; default is the current user's home folder" },
          max_results: { type: "number", description: "Maximum matching paths, 1–50 (default 50)" },
          max_depth: { type: "number", description: "Maximum folder depth, 0–20 (default 12)" },
        },
        required: ["query"],
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
          text: { type: "string", description: "Step to append or working checkpoint" },
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
        'Instant offline symbol search. Find {"action": "search", "query": "Agent"}, one file {"action": "file", "path": "src/a.ts"}, info {"action": "stats"}, rebuild {"action": "refresh"} (edit only).',
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
        'Git: status {"action": "status"}, diff {"action": "diff"}, hunk review {"action": "review"}. History {"action": "log", "count": 10}, blame {"action": "blame", "path": "src/a.ts", "line": 42}, branches {"action": "branch"}. Edit only: stage {"action": "stage", "path": "."}, stage one hunk {"action": "stage_hunk", "path": "src/a.ts", "hunk": 0}, revert one hunk {"action": "revert_hunk", ...} (undoable), commit {"action": "commit", "message": "Fix x"}. Reads work in read-only mode.',
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["status", "diff", "log", "blame", "branch", "stage", "commit", "review", "stage_hunk", "revert_hunk", "stage_lines"],
          },
          path: {
            type: "string",
            description: "File path (for diff, blame, stage, stage_hunk, revert_hunk, stage_lines); comma-separated for stage",
          },
          message: { type: "string", description: "Commit message (only for commit)" },
          count: { type: "number", description: "Commits to show (only for log, default 10)" },
          line: { type: "number", description: "Line number (only for blame)" },
          staged: { type: "boolean", description: "Show staged changes (for diff and review)" },
          stat: { type: "boolean", description: "Show file summary instead of full patch (only for diff)" },
          hunk: { type: "number", description: "Hunk number from review (only for stage_hunk and revert_hunk)" },
          lines: { type: "string", description: "Hunk line indices to stage, comma-separated (only for stage_lines)" },
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
      name: "move_path",
      description:
        'Move or rename a file or folder. Example: {"from": "draft.ts", "to": "src/draft.ts"}. Creates missing parent folders. Refuses to overwrite an existing destination — delete_path it first. Undo is git.',
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Current path (file or folder), relative to the workspace" },
          to: { type: "string", description: "Destination path, relative to the workspace" },
        },
        required: ["from", "to"],
      },
    },
    {
      name: "delete_path",
      description:
        'Delete one file or one folder. Example: {"path": "build/output.log"}. A folder that still has items needs {"recursive": true}. A small text file comes back with /undo; a folder never does.',
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to delete, relative to the workspace" },
          recursive: { type: "boolean", description: "Required to delete a folder that is not empty" },
        },
        required: ["path"],
      },
    },
    {
      name: "create_folder",
      description: 'Create a folder (and any missing parents). Example: {"path": "src/components"}. Safe to call when it already exists.',
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Folder path relative to the workspace" },
        },
        required: ["path"],
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
              'Hand a small subtask to a bounded sub-agent (max 12 tool calls, no nested delegates). Roster role: {"role":"architect","task":"map the login flow and report files + line numbers"}. Or define a purpose-built specialist inline: {"task":"audit this parser for crashes","tools":"read_file,search,symbols","instructions":"List every unchecked input with file:line"}. Custom tools must be a subset of your own tools; omit role for expert.',
            parameters: {
              type: "object",
              properties: {
                task: { type: "string", description: "The small concrete subtask" },
                role: { type: "string", description: 'Roster role from the IDE roles panel (default: "expert")' },
                tools: {
                  type: "string",
                  description: 'Custom specialist only: comma-separated subset of your tools, e.g. "read_file,search"',
                },
                instructions: { type: "string", description: "Custom specialist only: one-paragraph brief (max 1000 chars)" },
              },
              required: ["task"],
            },
          },
        ];
  const symbols: ToolSpec[] = [
    {
      name: "symbols",
      description:
        'Code intelligence (TypeScript, JavaScript, Python, Rust, Go). Hover {"action": "hover", "path": "src/a.ts", "line": 10, "col": 15}, definition {"action": "def", ...}, diagnostics {"action": "diag", "path": "src/a.ts"}. Rename preview {"action": "rename", "path": "...", "line": 3, "col": 5, "new_text": "total"}; completions, signature, quickfix and refs take line+col. Workspace search {"action": "wsymbol", "query": "Agent"}. Install a server {"action": "setup", "lang": "python"} (edit only). Lines and columns start at 1.',
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["hover", "def", "refs", "diag", "rename", "completion", "signature", "wsymbol", "quickfix", "setup"],
          },
          path: { type: "string", description: "File path relative to the workspace (not for wsymbol/setup)" },
          line: { type: "number", description: "Line number starting at 1 (not for diag/wsymbol)" },
          col: { type: "number", description: "Column number starting at 1 (not for diag/wsymbol)" },
          new_text: { type: "string", description: "New name (only for rename)" },
          query: { type: "string", description: "Symbol name to find (only for wsymbol)" },
          lang: { type: "string", description: "Language for wsymbol/setup: typescript, python, rust, go (or all for setup)" },
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
  kind: "write" | "edit" | "delete";
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
  kind: "write" | "edit" | "delete" = "write",
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
  /** Wired by the Agent: runs one bounded role-scoped sub-turn. Never set by the model.
   * custom defines a purpose-built specialist inline (no role file): a
   * comma-separated tool subset plus a one-paragraph brief. */
  delegate?: (task: string, signal?: AbortSignal, role?: string, custom?: { tools?: string; instructions?: string }) => Promise<string>;
  /** Lazy MCP bridge (external servers from `.smol/mcp.json`). Never set by the model. */
  mcp?: McpBridge;
  /** Workspace tool plugins (.smol/plugins/*.cjs). Never set by the model. */
  plugins?: LoadedPlugin[];
}

export async function executeTool(name: string, args: Record<string, any>, ctx: ToolContext, signal?: AbortSignal): Promise<string> {
  try {
    if (ctx.allowedTools && !ctx.allowedTools.has(name)) {
      return `Error: ${name} is unavailable for the ${ctx.role ?? "restricted"} role. Use only the tools assigned to this sub-agent.`;
    }
    try {
      for (const p of ctx.plugins ?? []) {
        if (!p?.ok || typeof p.beforeTool !== "function") continue;
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
      case "find_local":
        result = await searchLocalFilesBounded(ctx.workspace, args, signal);
        break;
      case "plan": {
        const action = args.action ?? (typeof args.steps === "string" ? "set" : undefined);
        if (action === "set") result = ctx.plan.set(typeof args.steps === "string" ? args.steps : "");
        else if (action === "done") result = ctx.plan.markDone(args.step === undefined ? undefined : Number(args.step));
        else if (action === "add") result = ctx.plan.add(String(args.text ?? ""));
        else if (action === "checkpoint") result = ctx.plan.checkpoint(String(args.text ?? ""));
        else if (action === "show") result = ctx.plan.modelView();
        else return 'Error: l\'action doit être "set", "done", "add", "show" ou "checkpoint". Exemple : {"action": "done"}';
        break;
      }
      case "work": {
        if (args.action !== "list" && ctx.canWrite === false) {
          return "Error: la création ou la modification des éléments de travail est indisponible en mode lecture seule. Passez en mode édition pour faire des changements.";
        }
        result = await new CoworkBoard(ctx.workspace).run(args);
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
      case "move_path":
        if (ctx.canWrite === false) {
          return "Error: le déplacement de fichiers est indisponible en mode lecture seule. Passez en mode édition pour réorganiser les fichiers.";
        }
        result = movePath(ctx.workspace, args);
        if (!result.startsWith("Error")) {
          ctx.filesTouched.add(String(args.from));
          ctx.filesTouched.add(String(args.to));
        }
        break;
      case "delete_path": {
        if (ctx.canWrite === false) {
          return "Error: la suppression de fichiers est indisponible en mode lecture seule. Passez en mode édition pour supprimer des fichiers.";
        }
        const undoCap = capturePrev(ctx.workspace, args.path);
        result = deletePath(ctx.workspace, args);
        if (!result.startsWith("Error")) {
          // A plain text file restores on /undo; capturePrev already returns
          // null for folders and oversized files, so nothing is claimed wrongly.
          pushUndo(ctx, undoCap, "", "delete");
          ctx.filesTouched.add(String(args.path));
        }
        break;
      }
      case "create_folder":
        if (ctx.canWrite === false) {
          return "Error: la création de dossiers est indisponible en mode lecture seule. Passez en mode édition pour réorganiser les fichiers.";
        }
        result = createFolder(ctx.workspace, args);
        if (!result.startsWith("Error")) ctx.filesTouched.add(String(args.path));
        break;
      case "run_command":
        if (typeof args.command !== "string" || !args.command.trim()) {
          return 'Error: la commande est requise. Exemple : {"command": "npm test"}';
        }
        result = await runCommand(args.command, ctx.workspace, signal, (ctl: ShellControl) => {
          // Offload path: the UI hands this live process to the background
          // runner instead of waiting for the 120s kill.
          ctl.adopt = (proc, cmd, seed, bgToken) => ctx.taskManager.adopt(proc, cmd, seed, bgToken);
        });
        ctx.commandsRun.push(`${args.command} → ${result.split("\n").at(-1)}`);
        if (ctx.commandsRun.length > 50) ctx.commandsRun.splice(0, ctx.commandsRun.length - 50);
        break;
      case "task": {
        const action = args.action;
        if (action === "start") {
          if (typeof args.command !== "string" || !args.command.trim()) {
            return 'Error: "start" nécessite une commande. Exemple : {"action": "start", "command": "npm run dev"}';
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
          return 'Error: l\'action doit être "start", "list", "logs" ou "stop". Exemple : {"action": "list"}';
        }
        break;
      }
      case "delegate": {
        const task = typeof args.task === "string" ? args.task.trim() : "";
        if (!task) {
          return 'Error: la tâche est requise. Exemple : {"task": "trouver où vit la validation de connexion et rapporter fichiers + numéros de ligne"}';
        }
        if (task.length > 2000) {
          return "Error: gardez la sous-tâche sous 2 000 caractères — une petite tâche concrète.";
        }
        if (!ctx.delegate) {
          return "Error: les sous-agents sont indisponibles à cette profondeur. Faites l'étape vous-même avec read/search.";
        }
        const role = typeof args.role === "string" ? args.role.trim() : undefined;
        const customTools = typeof args.tools === "string" ? args.tools : undefined;
        const customInstructions = typeof args.instructions === "string" ? args.instructions : undefined;
        if (customInstructions !== undefined && customInstructions.trim().length > 1000) {
          return "Error: keep custom instructions under 1000 characters — one paragraph.";
        }
        const custom =
          customTools !== undefined || customInstructions !== undefined
            ? { tools: customTools, instructions: customInstructions }
            : undefined;
        result = await ctx.delegate(task, signal, role, custom);
        break;
      }
      case "skill": {
        const action = args.action;
        if (action === "list") result = listSkills(ctx.workspace);
        else if (action === "read") result = readSkill(ctx.workspace, args.name);
        else if (action === "save") {
          if (ctx.canWrite === false) {
            return "Error: la sauvegarde de compétences est indisponible en mode lecture seule. Passez en mode édition pour sauvegarder.";
          }
          result = saveSkill(ctx.workspace, args.name, args.content);
          if (!result.startsWith("Error")) ctx.filesTouched.add(`.smol/skills/${String(args.name).trim()}.md`);
        } else {
          return 'Error: l\'action doit être "list", "read" ou "save". Exemple : {"action": "list"}';
        }
        break;
      }
      case "fetch_url": {
        result = await fetchUrl(ctx.workspace, args, signal);
        break;
      }
      case "symbols": {
        if (String(args.action ?? "") === "setup") {
          if (ctx.canWrite === false) {
            return "Error: installer des serveurs de langage modifie cet ordinateur — indisponible en mode lecture seule. Passez d'abord en mode édition.";
          }
          const lang = typeof args.lang === "string" && args.lang.trim() ? args.lang.trim() : "all";
          result = setupLsp(ctx.workspace, lang);
          break;
        }
        result = await queryCode(ctx.workspace, args, signal);
        break;
      }
      case "mcp": {
        if (!ctx.mcp) {
          return "Error: le pont MCP n'est pas branché dans cette session. L'hôte doit définir toolCtx.mcp (voir docs/plugins.md).";
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
          return 'Error: le chemin est requis. Exemple : {"path": "src/agent.ts"}';
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
          return 'Error: l\'action doit être "list". Exemple : {"action": "list"}';
        }
        result = describePlugins(ctx.workspace);
        break;
      }
      default:
        return `Error: outil inconnu « ${name} ». Les outils disponibles sont listés dans vos définitions d'outils — utilisez-en un de ceux-là.`;
    }
    try {
      for (const p of ctx.plugins ?? []) {
        if (!p?.ok || typeof p.afterTool !== "function") continue;
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
    return warning
      ? `
Warning: ${warning} Fix this before moving on (use edit_file).`
      : "";
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

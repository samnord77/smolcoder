// The agent loop: one tool call at a time, tool results fed back, until the
// model answers in plain text. Parallel tool calls are not requested; if a
// model emits several anyway, they simply run sequentially. Malformed calls
// come back as coaching errors so the model can retry instead of derailing.

import { createHash } from "node:crypto";
import { classifyCommand, classifyDanger } from "./approvals";
import { type Attachment, renderAttachmentsForModel } from "./attachments";
import { ContextManager } from "./context";
import { validateChange } from "./continuous-validation";
import type { EventBus } from "./events";
import { gitTurnSummary } from "./git";
import { classifyTask, formatOrchestratorSummary, type TaskClassification } from "./orchestrator";
import { Plan } from "./plan";
import { abortableDelay, isBackendTimeoutError, isSlowPrefillError } from "./providers/transport";
import { type ChatResult, type Msg, nextCallId, type Provider, type ToolSpec } from "./providers/types";
import { commandEscapesWorkspace } from "./sandbox";
import { recordDelegateStats, relevantSkillNames, relevantSkills, saveAutoRepairLesson } from "./skills";
import { loadSubagentRoles, type SubagentRole } from "./subagents";
import { buildToolSpecs, commandOf, executeTool, MODE_LABELS, type Mode, type ToolContext } from "./tools/index";
import { runCommand } from "./tools/shell";
import type { AgentPhase, AgentPhaseDetails, AgentUI } from "./ui";
import { c, fmtDuration, truncateMiddle } from "./util";
import { failureSignature, mergeVerificationCommands, projectVerification } from "./verification";

/** Supplied by the caller, never generated or changed by a model tool. */
export interface Verification {
  command: string;
  maxAttempts?: number;
  source?: "project";
}

const TRANSIENT_ERROR = /fetch failed|econn|socket|network|timed?.?out|429|50[0-4]|stream ended|malformed JSON|stream error/i;
const CONTEXT_ERROR = /context.{0,50}(exceed|overflow|full|length)|too (many|long).{0,30}tokens|prompt.{0,30}(too long|exceed)/i;
const WORKSPACE_ACTION =
  /\b(analy[sz](e|er|ez|erai|ons)?|audit(?:er|ez)?|inspect(?:er|ez)?|review|diagnos(?:e|er|ez|tic)|investigat(?:e|er|ez)|verif(?:y|ier|iez)|check|examin(?:e|er|ez)|scan(?:ner)?|search|find|locat(?:e|ing)|read|recherch(?:e|es|ez|er|ons)|cherch(?:e|es|ez|er|ons)|trouv(?:e|es|ez|er|ons)|localis(?:e|es|ez|er|ons)|corrig(?:e|er|ez)|fix|edit|modif(?:y|ier|iez)|optimis(?:e|er)|optimiz(?:e|er)|automat(?:e|iser|isez)|amélior(?:e|er|ez)|amelior(?:e|er|ez)|explor(?:e|er|ez)|list(?:er)?|résum(?:e|er|ez)|resum(?:e|er|ez)|expliqu(?:e|er|ez))\b/i;
const WORKSPACE_TARGET =
  /\b(projet|project|workspace|repository|repo|codebase|code|fichier|fichiers|file|files|dossier|folder|src|test|build|compilation|bug|erreur|error|pc|ordinateur|computer|machine|disque|drive|deepseek|ollama|lm studio|modele|model)\b/i;
const ADVICE_REQUEST =
  /^\s*(?:what are the best ways?|tell me how|should i|can you recommend|can you suggest|recommend(?:ations?)?|suggest(?:ions?)?|how could i|explain how i could)\b/i;
const CONTINUATION = /^\s*(?:continue(?:r|z)?|poursui(?:s|vre|vez)?|reprends?|go on|keep going)\s*[.!…]*\s*$/i;
const CHANGE_ACTION =
  /\b(?:implement|build|create|add|fix|repair|correct|update|refactor|improve|enhance|remove|delete|modify|change|automate|write|generate|produces?|produced|construi(?:re|r|s|t|ez|ons)|corrig(?:e|es|ez|er|ons)|repar(?:e|es|ez|er|ons)|ajout(?:e|es|ez|er|ons)|cre(?:e|es|ez|er|ons)|cri(?:e|es|ez|er|ons)|modifi(?:e|es|ez|er|ons)|amelior(?:e|es|ez|er|ons)|enrich(?:i|is|it|ir|issons|issez)|optimis(?:e|es|ez|er|ons)|automatis(?:e|es|ez|er|ons)|supprim(?:e|es|ez|er|ons)|gener(?:e|es|ez|er|ons)|ecrit(?:s)?|ecriv(?:e|es|ez|ons)|redig(?:e|es|ez|er|ons)|fabriqu(?:e|es|ez|er|ons)|produis(?:t|s|ez|ons)|install(?:e|es|ez|er|ons))\b/;
const CHANGE_TARGET =
  /\b(?:workspace|project|repository|codebase|code|file|files|folder|src|test|copilot|autopilot|agent|cowork|ide|fichier|fichiers|dossier|dossiers|projet|projets|html|css|javascript|typescript|page|pages|site|sites|web|application|app|script|scripts|snippet|module|template|formulaire|form|composant|components|component|api|endpoint|serveur|server|preview|apercu|bundle|package|npm|calculatrice|jeu|game)\b/;
const ACTION_TOOLS = new Set([
  "write_file",
  "edit_file",
  "move_path",
  "delete_path",
  "create_folder",
  "run_command",
  "task",
  "format",
  "git",
  "debug",
  "mcp",
]);
function actionErrorNeedsRepair(output: string): boolean {
  if (!output.startsWith("Error")) return false;
  // These are deliberate harness/policy outcomes, not failed coding work:
  // read-only restrictions, approval refusals and unavailable external
  // services must be explained or skipped, not retried forever.
  if (
    /^(?:Error: )?(?:this command .*needs user approval|this command uses .*home directory|this command .*outside the workspace|the user declined|mcp server .*needs user approval|the (?:mail|calendar) tool needs user approval|.*is not allowed for the .* role|.*is unavailable for the .* role|the tool ".*" is not available|.*is no longer available)/i.test(
      output.trim()
    )
  )
    return false;
  return true;
}
function actionFamily(name: string): "mutation" | "command" | "task" | "integration" | "other" {
  if (["write_file", "edit_file", "move_path", "delete_path", "create_folder", "format", "git"].includes(name)) return "mutation";
  if (name === "run_command") return "command";
  if (name === "task") return "task";
  if (["mcp", "debug"].includes(name)) return "integration";
  return "other";
}
function explicitlyRequestsWorkspaceChange(request: string): boolean {
  const normalized = request
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (
    /\b(?:without\s+(?:modifying|changing|creating|writing)|do not\s+(?:modify|change|create|write)|don'?t\s+(?:modify|change|create|write)|no changes|read[- ]only|sans\s+(?:rien\s+)?(?:modifi\w*|cre\w*|ecri\w*)|ne\s+(?:rien\s+)?(?:modifi\w*|cree|creer)|ne modifie pas|ne cree pas|ne creer pas|aucune modification)\b/.test(
      normalized
    )
  ) {
    return false;
  }
  if (
    /^\s*(?:what|why|how|explain|tell me|recommend|suggest|should i|should we|do you think|expliquer|explique|pourquoi|comment|conseille|devrais-je)\b/.test(
      normalized
    ) ||
    /^\s*(?:peux[- ]tu|pouvez[- ]tu|tu peux|can you|could you)\s+(?:m'?expliquer|me dire|m'indiquer|me montrer comment)/.test(normalized)
  ) {
    return false;
  }
  return CHANGE_ACTION.test(normalized) && CHANGE_TARGET.test(normalized);
}
function requiresWorkspaceChange(request: string, previousRequests: string[]): boolean {
  if (CONTINUATION.test(request)) return previousRequests.slice(-3).some(explicitlyRequestsWorkspaceChange);
  return explicitlyRequestsWorkspaceChange(request);
}
function requiresWorkspaceEvidence(request: string, previousRequests: string[]): boolean {
  if (ADVICE_REQUEST.test(request)) return false;
  const needsEvidence = (text: string) => WORKSPACE_ACTION.test(text) && WORKSPACE_TARGET.test(text);
  return needsEvidence(request) || (CONTINUATION.test(request) && previousRequests.slice(-3).some(needsEvidence));
}
function localComputerSearchQuery(request: string): string | null {
  const normalized = request.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const asksToSearch = /\b(?:search|find|locate|look\s+for|recherch\w*|cherch\w*|trouv\w*|localis\w*)\b/i.test(normalized);
  const localTarget =
    /\b(?:pc|ordinateur|computer|this\s+computer|my\s+computer|my\s+pc|sur\s+mon\s+pc|sur\s+mon\s+ordinateur|drive|disque)\b/i.test(
      normalized
    );
  const fileTarget = /\b(?:file|files|folder|directory|dossier|fichier|repertoire)\b/i.test(normalized);
  if (!asksToSearch || !localTarget || !fileTarget) return null;

  const target = /\b(?:folder|directory|dossier|file|files|fichier|repertoire)\b/i.exec(normalized);
  const tail = target ? normalized.slice(target.index + target[0].length) : normalized;
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "called",
    "computer",
    "de",
    "des",
    "dossier",
    "du",
    "file",
    "files",
    "folder",
    "for",
    "fichier",
    "find",
    "le",
    "la",
    "les",
    "my",
    "named",
    "on",
    "ordinateur",
    "pc",
    "repertoire",
    "recherche",
    "rechercher",
    "recherches",
    "recherchez",
    "recherchons",
    "search",
    "the",
    "to",
    "sur",
    "this",
    "un",
    "une",
    "with",
    "workspace",
    "projet",
    "actuel",
    "current",
  ]);
  const words = tail.match(/[a-z0-9][a-z0-9._-]{1,119}/gi) ?? [];
  const candidates = words.filter((word) => !stopWords.has(word.toLocaleLowerCase()));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.length - a.length)[0].slice(0, 120);
}
function needsTaskOrchestration(request: string): boolean {
  const normalized = request
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (
    /\b(explain|describe|summari[sz]e|tell me|what|why|how|recommend|advise|advice|suggestions|should i|should we|is it worth|expliquer|explique|decrire|decris|resumer|resume|pourquoi|comment|qu'est-ce|devrais-je|devrions-nous|conseil|conseiller)\b/.test(
      normalized
    )
  )
    return false;
  return (
    normalized.length >= 120 &&
    /\b(fix|repair|correct|improv|enhanc|implement|build|create|refactor|corrig|repar|amelior|enrich|optimis|optimis|develop)\w*/.test(
      normalized
    ) &&
    /\b(all|every|entire|whole|deep|thorough|comprehensive|multiple|several|many|tous|toutes|tout|ensemble|global|plusieurs|beaucoup|approfond|pro|and|also|plus|et|puis)\w*/.test(
      normalized
    )
  );
}

/** Shell metacharacters that let one "allowed program" smuggle in others.
 * Auto-approval via always-allow only applies to commands without them. */
const SHELL_META = /[;&|`$<>(){}\n\r\\]/;

/** Exported for tests: does the always-allow set cover this exact command?
 * First-token match alone is bypassable (`npm -v; evil`) because commands run
 * under a real shell — so chained/piped/substituted commands always re-prompt.
 * Global installs are never auto-approved: `npm test` must not unlock
 * `npm i -g evil`. */
export function isAutoApproved(command: string, allowed: Set<string>, reason?: string | null): boolean {
  if (reason && /globally|outside the workspace/i.test(reason)) return false;
  const trimmed = command.trim();
  let program = trimmed.split(/\s+/)[0] ?? "";
  if (process.platform === "win32") program = program.toLowerCase();
  return allowed.has(program) && !SHELL_META.test(trimmed);
}

/** UI vue par un sous-agent : tout son travail (pensees, appels d'outils,
 * code, resultats) ruisselle dans les 3 interfaces comme celui du parent,
 * mais chaque ligne est signee ⇄ et la fin de tour ne sonne pas (seule la
 * fin du tour parent sonne). Le spinner affiche "sous-agent · …". */
export class ChildUI implements AgentUI {
  private readonly executionPrefix = `child-${nextCallId()}-`;
  constructor(private parent: AgentUI) {}
  resetResponse?(): void {
    this.parent.resetResponse?.();
  }
  token(text: string): void {
    this.parent.token(text);
  }
  thinking(text: string): void {
    this.parent.thinking(text);
  }
  toolCall(name: string, args: Record<string, any>, executionId?: string): void {
    this.parent.toolCall(name, args, executionId ? this.executionPrefix + executionId : undefined);
  }
  toolResult(result: string, executionId?: string): void {
    this.parent.toolResult(result, executionId ? this.executionPrefix + executionId : undefined);
  }
  println(s?: string): void {
    this.parent.println(s);
  }
  status(s: string): void {
    this.parent.status(`⇄ ${s}`);
  }
  warn(s: string): void {
    this.parent.warn(s);
  }
  error(s: string): void {
    this.parent.error(s);
  }
  startSpinner(label: string): void {
    this.parent.startSpinner(`sous-agent · ${label}`);
  }
  stopSpinner(): void {
    this.parent.stopSpinner();
  }
  confirmCommand(command: string, reason?: string): Promise<"yes" | "no" | "always"> {
    return this.parent.confirmCommand(command, reason);
  }
  turnEnd(label: string): void {
    this.parent.status(`✓ sous-agent : ${label} (voir le rapport dans le tour parent)`);
  }
  planUpdated(plan: Plan): void {
    this.parent.planUpdated(plan);
  }
  subagent?(phase: "start" | "done", label: string): void {
    this.parent.subagent?.(phase, label);
  }
}

export class Agent {
  messages: Msg[] = [];
  tools: ToolSpec[];
  private alwaysAllowed = new Set<string>();
  originalRequest = "";
  currentRequest = "";
  private planNudged = false;
  private abort: AbortController | null = null;
  /** Speed/size figures for the last completed turn (for the turn-end label
   * and headless stats). */
  lastTurnStats: TurnStats | null = null;
  outcome: "idle" | "running" | "completed" | "cancelled" | "error" = "idle";
  lastError: string | null = null;
  autopilotPhase: AgentPhase = "starting";
  autopilotLabel = "";
  autopilotDetails: AgentPhaseDetails | null = null;
  verificationResult: { attempts: number; passed: boolean; output: string } | null = null;
  workspaceChangedThisTurn = false;
  lastClassification: TaskClassification | null = null;
  private verification?: Verification;
  private progressFailure = "";
  private sameVerificationFailures = 0;
  private canRefreshVerification = false;
  private lastTurnWorkspaceEvidence = false;

  constructor(
    public provider: Provider,
    public mode: Mode,
    systemPrompt: string,
    private toolCtx: ToolContext,
    private ctxMgr: ContextManager,
    private bus: EventBus,
    private ui: AgentUI,
    private interactive: boolean,
    /** Tool-call budget per user turn. Headless runs get a much larger one. */
    private maxSteps = 30,
    private callerVerification?: Verification
  ) {
    this.verification = callerVerification;
    if (
      callerVerification &&
      (!callerVerification.command.trim() ||
        (callerVerification.maxAttempts !== undefined &&
          (!Number.isSafeInteger(callerVerification.maxAttempts) || callerVerification.maxAttempts < 1)))
    )
      throw new Error("Verification needs a command and a positive attempt limit.");
    this.messages = [{ role: "system", content: systemPrompt }];
    this.tools = this.toolsFor(mode);
    this.toolCtx.canWrite = mode !== "ro";
    this.ctxMgr.setReplayThinking(provider.replaysThinking !== false);
    this.wireDelegate();
  }

  private setAutopilotPhase(phase: AgentPhase, label: string, details?: AgentPhaseDetails): void {
    this.autopilotPhase = phase;
    this.autopilotLabel = label.slice(0, 240);
    this.autopilotDetails = details ? { ...details } : null;
    this.ui.autopilotPhase?.(phase, this.autopilotLabel, this.autopilotDetails ?? undefined);
  }

  /** Sub-agents: one bounded child turn, same workspace and mode (never
   * higher), no nested delegates, max 12 tool calls. The child shares the
   * file/command records so the parent sees its work. Read-only parents may
   * delegate too: the child inherits read-only and cannot write. */
  private wireDelegate(): void {
    if ((this.toolCtx.depth ?? 0) >= 1) {
      this.toolCtx.delegate = undefined;
      return;
    }
    this.toolCtx.delegate = async (
      task: string,
      signal?: AbortSignal,
      requestedRole?: string,
      custom?: { tools?: string; instructions?: string }
    ): Promise<string> => {
      const customToolsRaw = typeof custom?.tools === "string" ? custom.tools : "";
      const customInstructions = typeof custom?.instructions === "string" ? custom.instructions.trim().slice(0, 1000) : "";
      let role: SubagentRole;
      if (customToolsRaw.trim() || customInstructions) {
        // Purpose-built specialist: the parent defines tools + brief inline,
        // no role file needed. The allowlist can only shrink, never grow.
        const mine = this.toolCtx.allowedTools ? [...this.toolCtx.allowedTools] : this.tools.map((t) => t.name);
        const wanted = customToolsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const bad = wanted.filter((t) => !mine.includes(t));
        if (bad.length) {
          return `Error: custom tools must come from your own tool list (no privilege escalation). Not allowed: ${bad.join(", ")}. Yours: ${mine.join(", ")}.`;
        }
        const readerFallback = ["read_file", "list_files", "search", "find_local", "symbols", "index_symbols", "fetch_url"].filter((t) =>
          mine.includes(t)
        );
        const specialist = requestedRole
          ? loadSubagentRoles(this.toolCtx.workspace).find((candidate) => candidate.name === requestedRole.trim().toLowerCase())
          : undefined;
        role = {
          name: specialist?.name ?? "custom",
          role: specialist?.role ?? "Custom specialist",
          description: task.slice(0, 120),
          tools: wanted.length ? [...new Set(wanted)] : readerFallback,
          instructions:
            [specialist?.instructions, customInstructions].filter(Boolean).join("\n\n") ||
            "Do the subtask and report back with files, line numbers and what remains.",
          source: specialist?.source ?? ("builtin" as const),
        };
      } else {
        const roleName = (requestedRole || "expert").trim().toLowerCase();
        const found = loadSubagentRoles(this.toolCtx.workspace).find((candidate) => candidate.name === roleName);
        if (!found) {
          const available = loadSubagentRoles(this.toolCtx.workspace)
            .map((candidate) => candidate.name)
            .join(", ");
          return `Error: unknown sub-agent role "${roleName}". Available roles: ${available}.`;
        }
        role = found;
      }
      const childCtx: ToolContext = {
        workspace: this.toolCtx.workspace,
        taskManager: this.toolCtx.taskManager,
        plan: new Plan(),
        filesTouched: this.toolCtx.filesTouched,
        commandsRun: this.toolCtx.commandsRun,
        resultCharLimit: this.toolCtx.resultCharLimit,
        depth: (this.toolCtx.depth ?? 0) + 1,
        allowedTools: new Set(role.tools),
        role: role.name,
        canWrite: this.mode !== "ro",
        mcp: this.toolCtx.mcp,
        plugins: this.toolCtx.plugins,
      };
      const window = this.ctxMgr.budget(this.messages, this.tools).window;
      const childMgr = new ContextManager(window, this.provider.maxOutputTokens);
      const child = new Agent(
        this.provider,
        this.mode,
        `${this.messages[0]?.content ?? ""}\n\nSub-agent role: ${role.role} (${role.name}). ${role.instructions}\nAllowed tools are enforced by the harness; do not try to use any other tool.`,
        childCtx,
        childMgr,
        this.bus,
        new ChildUI(this.ui),
        this.interactive,
        12
      );
      this.ui.status(`· sous-agent ${role.name} : travail délégué (max 12 actions)`);
      this.ui.subagent?.("start", `${role.name}: ${task}`.slice(0, 120));
      try {
        await child.runTurn(
          `Subtask (answer with a short report: what you found or changed, files + line numbers, what remains):\n${task}`
        );
      } catch (err: any) {
        this.workspaceChangedThisTurn ||= child.workspaceChangedThisTurn;
        try {
          recordDelegateStats(this.toolCtx.workspace, child.lastTurnStats?.toolCalls ?? 0);
        } catch {
          /* stats must never break a turn */
        }
        const calls = child.lastTurnStats?.toolCalls ?? 0;
        const verification = child.verificationResult ? (child.verificationResult.passed ? "passed" : "failed") : "not run";
        const failure = String(err?.message ?? err).slice(0, 700);
        const filesTouched = [...childCtx.filesTouched].slice(-10);
        this.ui.subagent?.("done", `${child.outcome}: ${calls} actions`, {
          outcome: child.outcome,
          verification,
          report: failure,
          filesTouched,
          toolCalls: calls,
        });
        return `Sub-agent execution=${child.outcome}; verification=${verification}; error=${failure}\nFiles touched: ${filesTouched.join(", ") || "none"}\n(Sub-agent did ${calls} tool calls.)`;
      }
      this.lastTurnWorkspaceEvidence ||= child.lastTurnWorkspaceEvidence;
      this.workspaceChangedThisTurn ||= child.workspaceChangedThisTurn;
      const last = [...child.messages].reverse().find((m) => m.role === "assistant" && m.content.trim());
      const report = (last?.content ?? "No report.").slice(0, 3000);
      const filesTouched = [...childCtx.filesTouched].slice(-10);
      try {
        recordDelegateStats(this.toolCtx.workspace, child.lastTurnStats?.toolCalls ?? 0);
      } catch {
        /* stats must never break a turn */
      }
      const doneCalls = child.lastTurnStats?.toolCalls ?? 0;
      const verification = child.verificationResult ? (child.verificationResult.passed ? "passed" : "failed") : "not run";
      const outcome = signal?.aborted ? "cancelled" : child.outcome;
      this.ui.subagent?.("done", `${outcome}: ${doneCalls} actions`, {
        outcome,
        verification,
        report,
        filesTouched,
        toolCalls: doneCalls,
      });
      if (signal?.aborted) throw signal.reason;
      const touched = filesTouched.join(", ");
      return `Sub-agent execution=${child.outcome}; verification=${verification}\n${report}${touched ? `\nFiles touched: ${touched}` : ""}\n(Sub-agent did ${doneCalls} tool calls.)`;
    };
  }

  private toolsFor(mode: Mode): ToolSpec[] {
    const available = buildToolSpecs(mode, { allowDelegate: (this.toolCtx.depth ?? 0) < 1 });
    return this.toolCtx.allowedTools ? available.filter((tool) => this.toolCtx.allowedTools!.has(tool.name)) : available;
  }

  private async orchestrateBroadTask(request: string, signal: AbortSignal): Promise<number> {
    const classification = this.lastClassification ?? classifyTask(request);
    this.lastClassification = classification;

    if (!needsTaskOrchestration(request) || this.mode === "ro" || !this.toolCtx.delegate || (this.toolCtx.depth ?? 0) > 0) {
      return 0;
    }

    let toolCalls = 0;
    if (!this.toolCtx.plan.exists) {
      const planContent = classification.planSteps.join("\n");
      const result = this.toolCtx.plan.set(planContent);
      if (result.startsWith("Error:")) throw new Error(result);
      this.ui.planUpdated(this.toolCtx.plan);
      this.messages.push({
        role: "user",
        historyNote: true,
        content: `[Plan de travail automatique (${classification.category} / ${classification.complexity}) :\n${this.toolCtx.plan.modelView()}]`,
      });
    }

    const readTools = ["read_file", "list_files", "search", "find_local", "symbols"].filter((name) =>
      this.tools.some((tool) => tool.name === name)
    );
    const targetRole = classification.recommendedRole || "expert";
    this.setAutopilotPhase("delegating", `pré-vol de l’expert ${targetRole}`, {
      tool: "delegate",
      message: "inspection en lecture seule avant implémentation",
    });
    const args = {
      task: `[Orchestrateur / ${classification.category}] Inspecter le workspace pour préparer cette demande sans modifier les fichiers. Identifier les fichiers et parcours concrets, les causes probables, et le plan d'implémentation à transmettre à l'agent principal:\n${request.slice(0, 1400)}`,
      tools: readTools.join(","),
      instructions:
        "Exploration en lecture seule. Utilise les outils autorisés, rapporte les chemins exacts et les preuves; ne modifie aucun fichier. L'agent principal fera les changements.",
    };
    const id = nextCallId();
    this.ui.status(`· sous-agent d’exploration (${targetRole}) lancé avant l’implémentation`);
    this.ui.toolCall("delegate", args, id);
    this.messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{ id, name: "delegate", args }],
    });
    let report: string;
    try {
      report = await this.toolCtx.delegate(args.task, signal, targetRole, { tools: args.tools, instructions: args.instructions });
    } catch (error: any) {
      if (signal.aborted) throw signal.reason;
      report = `Error: sub-agent exploration failed: ${String(error?.message ?? error).slice(0, 500)}`;
    }
    this.ui.toolResult(report, id);
    this.messages.push({ role: "tool", content: report, toolCallId: id, toolName: "delegate" });
    await this.bus.emit("post_tool", { name: "delegate", args });
    await this.bus.emit("context_update");
    toolCalls++;
    return toolCalls;
  }

  getOrchestrationSummary(): string | null {
    if (!this.lastClassification) return null;
    return formatOrchestratorSummary({
      originalRequest: this.originalRequest,
      classification: this.lastClassification,
      filesTouched: this.toolCtx.filesTouched,
      commandsRun: this.toolCtx.commandsRun,
      verificationResult: this.verificationResult,
      durationMs: this.lastTurnStats?.durationMs,
      stepsCompleted: this.toolCtx.plan.exists ? { total: this.toolCtx.plan.steps.length, done: this.toolCtx.plan.doneCount } : undefined,
    });
  }

  setMode(mode: Mode, systemPrompt: string): void {
    this.ctxMgr.cancelBackground(true);
    this.ctxMgr.resetAnchor();
    this.mode = mode;
    this.tools = this.toolsFor(mode);
    this.toolCtx.canWrite = mode !== "ro";
    this.messages[0] = { role: "system", content: systemPrompt };
    this.wireDelegate();
  }

  setProvider(provider: Provider): void {
    this.ctxMgr.cancelBackground(true);
    this.provider = provider;
    this.ctxMgr.setReplayThinking(provider.replaysThinking !== false);
  }

  resetTranscript(): void {
    this.ctxMgr.cancelBackground(true);
    this.messages = [this.messages[0]];
    this.originalRequest = "";
    this.currentRequest = "";
    this.planNudged = false;
    this.outcome = "idle";
    this.lastError = null;
    this.autopilotPhase = "starting";
    this.autopilotLabel = "";
    this.autopilotDetails = null;
    this.verificationResult = null;
    this.verification = this.callerVerification;
    this.progressFailure = "";
    this.sameVerificationFailures = 0;
    this.lastClassification = null;
    // Session facts feed the compaction state note — stale ones from a
    // cleared conversation would assert work the new task never did.
    this.toolCtx.filesTouched.clear();
    this.toolCtx.commandsRun.length = 0;
    this.ctxMgr.resetAnchor();
  }

  /** Resume a saved session: the transcript (without its system message) and
   * the two requests the compaction note is built around. */
  restoreTranscript(messages: Msg[], originalRequest: string, currentRequest: string): void {
    this.ctxMgr.cancelBackground(true);
    this.messages = [this.messages[0], ...messages];
    this.originalRequest = originalRequest;
    this.currentRequest = currentRequest;
    this.autopilotPhase = "paused";
    this.autopilotLabel = "session restaurée — vérifier la progression avant reprise";
    this.autopilotDetails = { message: "Les outils interrompus doivent être inspectés avant de continuer." };
    this.planNudged = false;
    this.ctxMgr.resetAnchor();
    this.repairTranscript(
      "[Tool execution was interrupted by a restart. Its outcome is unknown. Inspect files or command state before retrying; do not assume it failed or rerun it blindly.]"
    );
  }

  /** Longueur actuelle du transcript — le point exact où un rewind de
   * conversation ramènerait le modèle (message système compris). */
  transcriptCount(): number {
    return this.messages.length;
  }

  /** Tronque le transcript pour revenir à `count` messages (le message
   * système est toujours conservé). Retourne le nombre de messages retirés.
   * Les ancres du gestionnaire de contexte repartent de zéro : la prochaine
   * requête recalibrera sur ce qui reste. */
  rewindTranscript(count: number): number {
    const keep = Math.max(1, Math.min(count, this.messages.length));
    if (keep >= this.messages.length) return 0;
    this.ctxMgr.cancelBackground(true);
    const dropped = this.messages.length - keep;
    this.messages = this.messages.slice(0, keep);
    this.originalRequest = "";
    this.currentRequest = "";
    this.planNudged = false;
    this.ctxMgr.resetAnchor();
    return dropped;
  }

  cancel(): void {
    this.abort?.abort();
    this.ctxMgr.cancelBackground(true);
  }

  contextPercent(): number {
    return this.ctxMgr.fillPercent(this.messages, this.tools);
  }

  contextTokens(): number {
    return this.ctxMgr.estimatePrompt(this.messages, this.tools);
  }

  contextBudget() {
    return this.ctxMgr.budget(this.messages, this.tools);
  }

  private compactState() {
    const failure =
      this.verificationResult && !this.verificationResult.passed
        ? `\nLast acceptance failure (actual command output; resolve before completion):\n${truncateMiddle(this.verificationResult.output, 1800)}`
        : "";
    const progress = this.progressFailure
      ? `\nLast project check failure (may predate subsequent edits):\n${truncateMiddle(this.progressFailure, 1800)}`
      : "";
    return {
      originalRequest: this.originalRequest,
      currentRequest: this.currentRequest,
      verificationLine: this.verificationInstruction() + failure + progress,
      filesTouched: this.toolCtx.filesTouched,
      commandsRun: this.toolCtx.commandsRun,
      planLine: this.toolCtx.plan.compactLine(),
    };
  }

  private async checkProgress(signal: AbortSignal): Promise<boolean> {
    const command = projectVerification(this.toolCtx.workspace);
    if (!command) return false;
    this.ui.status("· checking implementation progress");
    this.setAutopilotPhase("validating", "vérification intermédiaire du projet", { tool: "verification" });
    const executionId = nextCallId();
    this.ui.toolCall("verification", { command }, executionId);
    this.ctxMgr.prepareBackground(this.messages, this.tools, this.provider, this.compactState());
    const output = await runCommand(command, this.toolCtx.workspace, signal);
    if (signal.aborted) throw abortError();
    const passed = !output.startsWith("Error") && /\[exit code 0 in [^\]]+\]\s*$/.test(output);
    this.progressFailure = passed ? "" : output;
    this.ui.toolResult(output, executionId);
    this.messages.push({
      role: "user",
      content: passed
        ? `[Project checks passed: ${command}. Continue the remaining work in the original request.]`
        : `[Progress checks failed. Fix the first concrete failure before further investigation. Continue the same task.\nCommand: ${command}\n${truncateMiddle(output, this.ctxMgr.toolResultCharLimit())}]`,
    });
    // Publish only after the factual result is in the transcript. Listeners
    // may compact immediately; they must receive the failure evidence both in
    // compactState() and in the conversation hand-off.
    await this.bus.emit("post_progress_check", { command, passed, output });
    return true;
  }

  private verificationInstruction(): string {
    return this.verification
      ? `\n${this.verification.source === "project" ? `Project checks (${this.verification.command})` : "Caller-owned acceptance checks"} must pass before completion. The harness runs them automatically and returns failures for repair. Use project files and returned failures to fix the application. Do not weaken or bypass acceptance checks.`
      : "";
  }

  private discoverVerification(wroteThisTurn: boolean): void {
    if ((!this.verification || this.verification.source === "project") && wroteThisTurn && this.mode !== "ro") {
      const command = projectVerification(this.toolCtx.workspace);
      if (command) {
        // Include scripts added during repairs, while retaining checks already
        // required earlier in this turn (deleting one must not bypass it).
        const merged = mergeVerificationCommands(this.verification?.command, command);
        this.verification = { command: merged, source: "project" };
      }
    }
  }

  private async verify(signal: AbortSignal): Promise<boolean> {
    if (this.mode === "ro") throw new Error("Acceptance commands are unavailable in read-only mode.");
    const check = this.verification!;
    const attempts = (this.verificationResult?.attempts ?? 0) + 1;
    if (attempts > (check.maxAttempts ?? 6))
      throw new Error("Acceptance attempt limit reached before the agent finished. The task is incomplete.");
    this.ui.status(`· checking acceptance (${attempts}/${check.maxAttempts ?? 6})`);
    this.setAutopilotPhase("validating", `validation d’acceptance (${attempts}/${check.maxAttempts ?? 6})`, {
      tool: "verification",
      message: check.command,
    });
    const executionId = nextCallId();
    this.ui.toolCall("verification", { command: check.command }, executionId);
    const output = await runCommand(check.command, this.toolCtx.workspace, signal);
    if (signal.aborted) throw abortError();
    const passed = !output.startsWith("Error") && /\[exit code 0 in [^\]]+\]\s*$/.test(output);
    this.sameVerificationFailures = passed
      ? 0
      : this.verificationResult &&
          !this.verificationResult.passed &&
          failureSignature(this.verificationResult.output) === failureSignature(output)
        ? this.sameVerificationFailures + 1
        : 1;
    this.verificationResult = { attempts, passed, output };
    this.ui.toolResult(output, executionId);
    await this.bus.emit("post_verify", this.verificationResult);
    if (passed) {
      this.ui.status("· acceptance checks passed");
      // Auto-evolution: a repair that took several tries becomes a reusable
      // lesson on its own — no model call needed, files only.
      if (attempts > 1 && (this.mode as string) !== "ro") {
        try {
          const name = saveAutoRepairLesson(this.toolCtx.workspace, {
            command: check.command,
            attempts,
            failure: failureSignature(this.verificationResult.output),
            files: [...this.toolCtx.filesTouched],
            commands: this.toolCtx.commandsRun,
          });
          if (name) this.ui.status(`· leçon auto sauvée : skill ${name}`);
        } catch {
          /* lessons must never break a turn */
        }
      }
      return true;
    }
    if (attempts >= (check.maxAttempts ?? 6))
      throw new Error(`Acceptance checks still fail after ${attempts} attempts. The task is incomplete.\n${truncateMiddle(output, 1600)}`);
    this.ui.status("· acceptance failed — continuing repairs automatically");
    // Auto-evolution at the moment of need: past lessons for similar
    // failures ride into the repair, not just the next turn's prompt.
    let lessonNote = "";
    try {
      const lessons = relevantSkills(this.toolCtx.workspace, output, 800);
      if (lessons.trim()) lessonNote = `\nPast auto-repair lessons for similar failures — apply first:\n${lessons}`;
    } catch {
      /* lessons must never break a repair */
    }
    this.messages.push({
      role: "user",
      content: `[Acceptance failed; the task is not complete. Repair the first failing behavior. The harness will rerun acceptance automatically. Do not skip tests or report success.${check.source === "project" ? `\nCommand: ${check.command}` : ""}\n${truncateMiddle(output, this.ctxMgr.toolResultCharLimit())}${lessonNote}]`,
    });
    if (this.sameVerificationFailures === 2 && this.canRefreshVerification) {
      this.ui.status("· same check failed again — refreshing working context");
      // Repeating an unchanged hypothesis in a larger transcript is not
      // progress. Keep the task, plan/checkpoint and actual failure, but drop
      // old model-written narratives before a facts-only handover. Current
      // files remain untouched and can be reread; no additional inference.
      this.ctxMgr.cancelBackground(true);
      this.messages = this.messages.filter((message) => !message.compactNote);
      this.ctxMgr.resetAnchor();
      await this.compactNow(true, true);
    }
    return false;
  }

  async compactNow(force = true, deterministic = false): Promise<void> {
    this.ui.startSpinner("organizing context");
    try {
      await this.ctxMgr.foreground();
      await this.bus.emit("pre_compact");
      const { messages, report } = await this.ctxMgr.manage(this.messages, this.tools, this.provider, this.compactState(), {
        force,
        deterministic,
        signal: this.abort?.signal,
      });
      this.messages = messages;
      await this.bus.emit("post_compact", report);
      await this.bus.emit("context_update");
    } finally {
      this.ui.stopSpinner();
    }
  }

  async runTurn(userInput: string, attachments: Attachment[] = []): Promise<void> {
    await this.ctxMgr.foreground();
    this.ctxMgr.cancelBackground(true);
    this.outcome = "running";
    this.setAutopilotPhase("starting", "tour de codage démarré");
    this.workspaceChangedThisTurn = false;
    this.ctxMgr.resetAnchor(); // prior-turn reasoning no longer travels on the wire
    this.lastError = null;
    this.verificationResult = null;
    this.verification = this.callerVerification;
    this.progressFailure = "";
    this.sameVerificationFailures = 0;
    this.lastTurnWorkspaceEvidence = false;
    // Earlier user decisions may exist only in a previous turn's summary.
    // Only a fresh conversation can safely discard every old narrative.
    this.canRefreshVerification = !this.originalRequest && this.messages.length === 1;
    const rendered = renderAttachmentsForModel(attachments, this.provider.vision !== false);
    const request = userInput || (attachments.length ? `See the attached ${attachments.length === 1 ? "file" : "files"}.` : "");
    const previousRequests = this.messages
      .filter((message) => message.role === "user" && !message.historyNote)
      .slice(-3)
      .map((message) => message.content);
    if (this.currentRequest) previousRequests.push(this.currentRequest);
    const evidenceRequest = request.startsWith("Subtask (") ? request.slice(request.indexOf("\n") + 1) : request;
    const evidenceRequired = requiresWorkspaceEvidence(evidenceRequest, previousRequests);
    const changeRequired = requiresWorkspaceChange(evidenceRequest, previousRequests);
    // Compaction keeps the request text, so the file names ride along with it.
    const requestNote = attachments.length ? `${request} [attached: ${attachments.map((a) => a.name).join(", ")}]` : request;
    this.lastClassification = classifyTask(requestNote);
    this.setAutopilotPhase("planning", "analyse de la demande et préparation du plan");
    if (!this.originalRequest && this.toolCtx.plan.exists) {
      this.messages.push({
        role: "user",
        historyNote: true,
        content: `[Saved project plan from an earlier session — resume it only if it matches the current request; otherwise leave it available for later.\n${this.toolCtx.plan.modelView()}]`,
      });
    }
    if (!this.originalRequest) this.originalRequest = requestNote;
    this.currentRequest = requestNote; // the task compaction must never lose
    // Auto-evolution: skills matching the task ride along without being asked.
    let autoSkills = "";
    let autoSkillNames: string[] = [];
    const preferredSkills =
      changeRequired || evidenceRequired || this.lastClassification.shouldDelegate ? this.lastClassification.recommendedSkills : [];
    try {
      autoSkills = relevantSkills(this.toolCtx.workspace, requestNote, 1200, preferredSkills);
      autoSkillNames = relevantSkillNames(this.toolCtx.workspace, requestNote, 2, preferredSkills);
    } catch {
      autoSkills = "";
      autoSkillNames = [];
    }
    try {
      this.ui.skills?.(autoSkillNames);
    } catch {
      /* a status view must never break a turn */
    }
    if (autoSkills) {
      this.messages.push({
        role: "user",
        historyNote: true,
        content: `[Auto-loaded skills selected for this task — read and apply them, then work:]\n${autoSkills}`,
      });
    }
    this.messages.push({
      role: "user",
      content: request + (rendered.text ? `\n\n${rendered.text}` : "") + this.verificationInstruction(),
      ...(rendered.images.length ? { images: rendered.images } : {}),
    });
    this.abort = new AbortController();
    const signal = this.abort.signal;

    const t0 = Date.now();
    let completed = false;
    let steps = 0;
    let nudges = 0;
    let evidenceNudges = 0;
    let changeNudges = 0;
    let toolCallsThisTurn = 0;
    let lastVerifiedToolCalls = -1;
    const runAcceptance = async () => {
      if (signal.aborted) throw abortError();
      // A summary after a successful check does not need to run it twice.
      if (this.verificationResult?.passed && lastVerifiedToolCalls === toolCallsThisTurn) return true;
      const passed = await this.verify(signal);
      lastVerifiedToolCalls = toolCallsThisTurn;
      return passed;
    };
    let sincePlanUpdate = 0;
    let repeatKey = "";
    let repeats = 0;
    let failedCalls = 0;
    const repeatedReads = new Map<string, { count: number; receipt?: Msg }>();
    let readsSinceAction = 0;
    let actionOnlyCalls = 0;
    let unresolvedActionErrors = 0;
    let actionErrorNudges = 0;
    let lastActionErrorFamily: ReturnType<typeof actionFamily> | null = null;
    let turnRecovery = 0;
    let reasoningExhaustions = 0;
    let wroteThisTurn = false;
    let changedWorkspaceThisTurn = false;
    let lastProgressCheck = 0;
    const stats: TurnStats = {
      modelCalls: 0,
      toolCalls: 0,
      generatedTokens: 0,
      genSeconds: 0,
      thinkingChars: 0,
      promptTokensLast: 0,
      durationMs: 0,
    };
    this.lastTurnStats = stats;
    try {
      const localQuery = localComputerSearchQuery(evidenceRequest);
      if (localQuery && this.tools.some((tool) => tool.name === "find_local")) {
        if (signal.aborted) throw abortError();
        const id = nextCallId();
        const localWorkspace =
          /\b(?:dans\s+(?:le\s+)?workspace|in\s+(?:the\s+)?workspace|dans\s+le\s+projet\s+actuel|in\s+the\s+current\s+project)\b/i.test(
            evidenceRequest.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
          );
        const args = { query: localQuery, ...(localWorkspace ? { path: "." } : {}) };
        this.ui.status("· recherche locale exécutée avant la réponse");
        this.ui.toolCall("find_local", args, id);
        this.messages.push({ role: "assistant", content: "", toolCalls: [{ id, name: "find_local", args }] });
        const output = await this.gateAndExecute("find_local", args, signal);
        this.ui.toolResult(output, id);
        this.messages.push({ role: "tool", content: output, toolCallId: id, toolName: "find_local" });
        toolCallsThisTurn++;
        stats.toolCalls++;
        if (!output.startsWith("Error:")) this.lastTurnWorkspaceEvidence = true;
        await this.bus.emit("post_tool", { name: "find_local", args });
        await this.bus.emit("context_update");
      }
      toolCallsThisTurn += await this.orchestrateBroadTask(requestNote, signal);
      stats.toolCalls = toolCallsThisTurn;
      await this.refreshLoadedWindow();
      agentLoop: while (steps++ < this.maxSteps) {
        this.setAutopilotPhase("thinking", `raisonnement du modèle — étape ${steps}/${this.maxSteps}`, {
          step: steps,
          maxSteps: this.maxSteps,
        });
        if (process.env.SMOL_DEBUG_VERIFY)
          console.error(
            "MODEL_STEP",
            steps,
            "calls",
            toolCallsThisTurn,
            "verification",
            !!this.verification,
            "result",
            (this.verificationResult as any)?.attempts ?? 0,
            "progress",
            !!this.progressFailure
          );
        // Context management before every request.
        await this.bus.emit("pre_request");
        if (this.ctxMgr.needsAttention(this.messages, this.tools)) {
          await this.compactNow(false);
        }
        await this.ctxMgr.foreground();
        this.ctxMgr.assertFits(this.messages, this.tools);

        this.ui.startSpinner("thinking");
        let result: ChatResult;
        try {
          result = await this.chatWithRetry(signal, actionOnlyCalls > 0);
          if (actionOnlyCalls > 0) actionOnlyCalls--;
        } catch (err: any) {
          const recoverable = isBackendTimeoutError(err) || isSlowPrefillError(err) || TRANSIENT_ERROR.test(String(err?.message ?? err));
          if (turnRecovery < 2 && recoverable && err?.name !== "AbortError" && !signal.aborted) {
            turnRecovery++;
            this.ui.resetResponse?.();
            this.ui.warn(`· appel au modèle interrompu — relance automatique du tour (${turnRecovery}/2) dans 10s`);
            await abortableDelay(10_000, signal);
            continue;
          }
          throw err;
        } finally {
          this.ui.stopSpinner();
        }
        this.ctxMgr.calibrate(result.promptTokens, this.messages, this.tools);
        this.messages.push({
          role: "assistant",
          content: result.content,
          toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
          thinking: result.thinking,
        });
        // Anchor AFTER the push: lastPromptTokens+lastCompletionTokens then
        // cover exactly the first `messages.length` messages — recording
        // before the push double-counted the reply in every estimate.
        this.ctxMgr.recordUsage(result.promptTokens, result.completionTokens, this.messages.length);
        if (stats.modelCalls === 0) await this.refreshLoadedWindow();
        await this.bus.emit("context_update");
        stats.modelCalls++;
        if (result.generatedTokens) {
          stats.generatedTokens += result.generatedTokens;
          if (result.genTokPerSec) stats.genSeconds += result.generatedTokens / result.genTokPerSec;
        }
        if (result.promptTokens) stats.promptTokensLast = result.promptTokens;
        if (result.thinking) stats.thinkingChars += result.thinking.length;
        if (result.content) this.ui.println(); // end the streamed line

        if (result.toolCalls.length === 0) {
          if (unresolvedActionErrors > 0) {
            this.messages.pop();
            this.ctxMgr.resetAnchor();
            this.ui.resetResponse?.();
            if (actionErrorNudges++ === 0) {
              this.ui.status("· une action a échoué — demande de réparation avant toute conclusion");
              this.messages.push({
                role: "user",
                content:
                  "[Une action d’exécution ou de modification a échoué dans ce tour. Ne déclare pas la tâche terminée. Inspecte l’erreur exacte, change d’approche, réessaie l’action avec des paramètres corrigés ou explique le blocage concret.]",
              });
              continue;
            }
            throw new Error(
              "Tâche incomplète : une action de modification ou d’exécution a échoué et n’a pas été réparée avant la conclusion."
            );
          }
          if (evidenceRequired && !this.lastTurnWorkspaceEvidence) {
            this.messages.pop();
            this.ctxMgr.resetAnchor();
            this.ui.resetResponse?.();
            if (evidenceNudges++ === 0) {
              this.ui.status("· analyse non vérifiée — demande d'inspection du workspace via les outils");
              this.messages.push({
                role: "user",
                content:
                  "[This request requires inspecting the actual workspace. Do not summarize or claim findings yet. Use the relevant read/search/status tools now; if tools are unavailable, say so explicitly.]",
              });
              continue;
            }
            throw new Error(
              "Analyse non effectuée : aucun outil n'a consulté le workspace, donc aucun constat ne peut être présenté comme vérifié."
            );
          }
          if (changeRequired && !changedWorkspaceThisTurn) {
            this.messages.pop();
            this.ctxMgr.resetAnchor();
            this.ui.resetResponse?.();
            if (changeNudges++ === 0) {
              this.ui.status("· aucune modification du workspace détectée — demande d’exécution réelle");
              this.messages.push({
                role: "user",
                content:
                  '[This is an explicit workspace-change request, but no successful file mutation has occurred. Do not output text or code blocks. You MUST invoke write_file({"path": "...", "content": "..."}) or edit_file directly now to apply the changes, then verify them; if blocked, report the concrete blocker.]',
              });
              continue;
            }
            throw new Error(
              "Tâche incomplète : aucune modification du workspace n’a été effectuée après la relance. Le modèle n’a pas confirmé une réussite fictive."
            );
          }
          // A reply cut off by the output cap, or an empty reply, is not a
          // finished turn — that is how local-model sessions die silently.
          // Nudge the model back on track (bounded).
          if (result.truncated && nudges < 3) {
            nudges++;
            this.ui.status("· reply hit the output limit — asking the model to continue");
            // Reasoning models can burn the ENTIRE budget thinking, arriving
            // with no visible output at all — "continue where you left off"
            // would just restart the same doomed think. Target that case.
            // With thinking off, an empty truncated reply is almost always a
            // tool call whose arguments (a whole file) overflowed the cap — it
            // was never parsed, so nothing was saved and "continue" cannot
            // work. Name the cap and coach the split explicitly.
            const noContent = !result.content.trim();
            const burnedByThinking = noContent && !!result.thinking?.trim();
            if (burnedByThinking) {
              reasoningExhaustions++;
              actionOnlyCalls = reasoningExhaustions === 1 ? 1 : Math.min(8, 2 ** Math.min(reasoningExhaustions, 3));
              this.ui.status(
                `· reasoning exhausted the reply budget — ${actionOnlyCalls} response${actionOnlyCalls === 1 ? "" : "s"} with thinking off, then restore the selected effort`
              );
            }
            const nudgeText = burnedByThinking
              ? `[Your reasoning used the entire output limit (${this.provider.maxOutputTokens} tokens) and produced no answer. Do not re-derive everything — reply now with your next tool call or a brief answer.]`
              : noContent
                ? `[${this.truncatedCallHint()}]`
                : `[Your reply was cut off by the output length limit of ${this.provider.maxOutputTokens} tokens. Continue where you left off. If a file was too large for one write_file call, split the content into separate files — writing the same path again replaces it completely.]`;
            this.messages.push({ role: "user", content: nudgeText });
            continue;
          }
          if (!result.content.trim() && nudges < 2) {
            nudges++;
            this.ui.status("· empty reply — nudging the model");
            this.messages.push({
              role: "user",
              content: "[Your reply was empty. If the task is finished, summarize what you did. Otherwise make the next tool call now.]",
            });
            continue;
          }
          // The model wants to stop but its own plan still has open steps —
          // the classic local-model quit-halfway. One bounded push back.
          // One nudge PER PLAN STATE, not per turn: an abandoned plan must not
          // drag every later unrelated question back to stale work. The flag
          // re-arms only when the plan actually changes (set/done/add).
          const plan = this.toolCtx.plan;
          if (plan.exists && plan.currentIndex >= 0 && toolCallsThisTurn > 0 && !this.planNudged) {
            this.planNudged = true;
            this.ui.status("· plan has unfinished steps — nudging the model to continue");
            this.messages.push({
              role: "user",
              content: `[Your plan still has unfinished steps: ${plan.pendingSummary()}. Continue with the next step now — or if a step no longer applies, mark it done with the plan tool and explain why.]`,
            });
            continue;
          }
          if (result.truncated || !result.content.trim())
            throw new Error(
              "The model repeatedly returned an empty or cut-off reply. Progress is kept. Try /effort off, switch models with /models, or say continue."
            );
          this.discoverVerification(wroteThisTurn);
          if (this.verification && !(await runAcceptance())) {
            repeatedReads.clear();
            repeats = 0;
            failedCalls = 0;
            readsSinceAction = 0;
            lastProgressCheck = toolCallsThisTurn;
            continue;
          }
          completed = true;
          this.outcome = "completed";
          this.setAutopilotPhase("completed", "tâche terminée et résultat vérifié");
          try {
            const summary = gitTurnSummary(this.toolCtx.workspace, this.toolCtx.filesTouched);
            if (summary) this.ui.println(`  ${summary}`);
          } catch {
            /* the summary is a nicety, never the result */
          }
          return; // plain answer — turn over
        }
        nudges = 0;

        for (const call of result.toolCalls) {
          if (process.env.SMOL_DEBUG_VERIFY) console.error("TOOL", call.name, toolCallsThisTurn + 1);
          if (signal.aborted) throw abortError();
          this.ui.toolCall(call.name, call.parseError ? { __raw: (call.rawArgs ?? "").slice(0, 80) } : call.args, call.id);

          let output: string;
          let observedOutput: string | undefined;
          if (call.parseError) {
            // LM Studio streams the partial arguments of a cut-off call, so
            // the overflow surfaces here as unparseable JSON.
            output = result.truncated
              ? `Error: ${this.truncatedCallHint()}`
              : `Error: your tool call arguments could not be parsed (${call.parseError}). Send the arguments as a single JSON object, e.g. {"path": "src/app.js"}.`;
          } else if (result.truncated) {
            output = `Error: ${this.truncatedCallHint()}`;
          } else if (!this.tools.some((t) => t.name === call.name)) {
            // HARD mode enforcement. The schemas sent to the model are only
            // advisory — a hallucinated or injected write_file/run_command in
            // read-only mode must be rejected here, at execution time.
            output =
              this.toolCtx.allowedTools && !this.toolCtx.allowedTools.has(call.name)
                ? `Error: ${call.name} is not allowed for the ${this.toolCtx.role ?? "restricted"} role. Available tools: ${this.tools.map((t) => t.name).join(", ")}.`
                : `Error: the tool "${call.name}" is not available in ${MODE_LABELS[this.mode]} mode. Available tools: ${this.tools.map((t) => t.name).join(", ")}.`;
          } else {
            const phase: AgentPhase = call.name === "delegate" ? "delegating" : call.name === "verification" ? "validating" : "executing";
            const details: AgentPhaseDetails = {
              tool: call.name,
              ...(typeof call.args?.path === "string" ? { path: call.args.path } : {}),
              step: steps,
              maxSteps: this.maxSteps,
            };
            this.setAutopilotPhase(phase, `${call.name} en cours`, details);
            this.toolCtx.resultCharLimit = this.ctxMgr.toolResultCharLimit();
            if (call.name === "run_command") {
              let end = this.messages.length - 1;
              while (this.messages[end]?.role === "tool") end--;
              this.ctxMgr.prepareBackground(this.messages.slice(0, end), this.tools, this.provider, this.compactState());
            }
            output = await this.gateAndExecute(call.name, call.args, signal);
            observedOutput = output; // fingerprint real evidence before coaching/reminders
            if (
              !output.startsWith("Error") &&
              ["write_file", "edit_file", "move_path", "delete_path", "create_folder", "format"].includes(call.name)
            ) {
              changedWorkspaceThisTurn = true;
              this.workspaceChangedThisTurn = true;
            }
            if (ACTION_TOOLS.has(call.name)) {
              const family = actionFamily(call.name);
              if (actionErrorNeedsRepair(output)) {
                unresolvedActionErrors++;
                lastActionErrorFamily = family;
              } else if (
                (call.name !== "task" || call.args?.action === "start") &&
                (lastActionErrorFamily === null || lastActionErrorFamily === family)
              ) {
                unresolvedActionErrors = 0;
                lastActionErrorFamily = null;
              }
            }
            if (call.name === "delegate" && this.workspaceChangedThisTurn) {
              changedWorkspaceThisTurn = true;
              wroteThisTurn = true;
              this.discoverVerification(true);
            }
            const observedWorkspace =
              call.name === "read_file" ||
              call.name === "list_files" ||
              call.name === "search" ||
              call.name === "find_local" ||
              (call.name === "index_symbols" && call.args.action !== "refresh") ||
              (call.name === "symbols" && call.args.action !== "setup");
            if (observedWorkspace && !output.startsWith("Error:")) this.lastTurnWorkspaceEvidence = true;
            toolCallsThisTurn++;
            stats.toolCalls++;
            // Tier-0 context hygiene: a full overwrite makes every earlier
            // read of that file wrong. Stub them out right away.
            if (
              (call.name === "write_file" || call.name === "edit_file") &&
              !output.startsWith("Error") &&
              typeof call.args?.path === "string"
            ) {
              wroteThisTurn = true;
              this.ctxMgr.evictStaleReads(this.messages, call.args.path);
              repeatedReads.clear();
              readsSinceAction = 0;
              try {
                const valResult = await validateChange(call.args.path, this.toolCtx.workspace, { runTargetedTests: true });
                this.setAutopilotPhase("validating", `validation continue de ${call.args.path}`, {
                  path: call.args.path,
                  tool: "continuous-validation",
                  step: steps,
                  maxSteps: this.maxSteps,
                });
                if (valResult.visualRail) {
                  this.ui.status?.(valResult.visualRail);
                  await this.bus.emit("validation", valResult);
                }
                if (!valResult.syntaxOk && valResult.syntaxError) {
                  output += `\n[Validation continue : ⚠️ ${valResult.syntaxError}. Corrige cette syntaxe avant de continuer.]`;
                }
              } catch {
                /* la validation continue ne doit jamais casser le flux principal */
              }
            }
            // Keep the plan honest: small models forget to mark steps done
            // mid-flow, leaving the checklist stale for minutes. A periodic
            // one-line reminder riding on a tool result fixes it cheaply.
            const plan = this.toolCtx.plan;
            if (call.name === "plan") {
              sincePlanUpdate = 0;
              if (!output.startsWith("Error") && ["set", "done", "add"].includes(String(call.args?.action))) this.planNudged = false;
            } else if (plan.exists && plan.currentIndex >= 0 && ++sincePlanUpdate >= 4) {
              sincePlanUpdate = 0;
              const cur = plan.steps[plan.currentIndex];
              output += `\n[Reminder: the plan still shows step ${plan.currentIndex + 1} "${cur.text}" as current. If you have finished steps, mark each with plan {"action": "done"} now.]`;
            }
          }

          const key = JSON.stringify([call.name, call.args, observedOutput ?? output]);
          repeats = key === repeatKey ? repeats + 1 : 1;
          repeatKey = key;
          failedCalls = output.startsWith("Error") ? failedCalls + 1 : 0;
          if (repeats === 3 || failedCalls === 3)
            output +=
              "\n[Repeated attempts are not making progress. Inspect the error or relevant file and change your approach before trying again.]";
          let readRepeats = 0;
          let readKey = "";
          if (["read_file", "search", "list_files", "find_local"].includes(call.name) && !output.startsWith("Error")) {
            if (++readsSinceAction % 12 === 0 && this.mode !== "ro")
              output +=
                "\n[Investigation checkpoint: record the exact APIs, unresolved error and next small edit with plan checkpoint. Then make and verify that edit before inspecting more modules.]";
            // Match both the request and file/output contents: rereading an
            // edited file or a different line range is legitimate progress.
            readKey = createHash("sha256")
              .update(call.name + JSON.stringify(call.args) + (observedOutput ?? output))
              .digest("hex");
            const previous = repeatedReads.get(readKey);
            // Refetching evidence that WE removed is legitimate. Count only
            // repeated observations the model can still see in its context.
            const retained = previous?.receipt && !previous.receipt.evicted && this.messages.includes(previous.receipt);
            readRepeats = retained ? previous!.count + 1 : 1;
            if (!retained) repeats = 1; // the generic consecutive-call guard must agree
            repeatedReads.set(readKey, { count: readRepeats });
            if (readRepeats >= 3)
              output +=
                "\n[This unchanged result has already been read repeatedly. Do not restart the same reads after compaction. Use a different small line range or narrow search if needed, then implement the next step.]";
          }
          const outputCap = this.ctxMgr.toolResultCharLimit();
          // read_file already paginates on complete lines. Never middle-cut
          // that page while its trailer claims a contiguous line range.
          if (output.length > outputCap && call.name !== "read_file")
            output = `${truncateMiddle(output, outputCap)}\n[Output capped for this context window. Read a smaller line range or narrow the search.]`;

          // Plan changes render as the visual checklist instead of a ✓ line.
          if (
            call.name === "plan" &&
            !output.startsWith("Error") &&
            ["set", "done", "add"].includes(String(call.args?.action ?? (typeof call.args?.steps === "string" ? "set" : undefined)))
          ) {
            this.ui.planUpdated(this.toolCtx.plan);
            this.ui.toolResult(output, call.id);
          } else {
            this.ui.toolResult(output, call.id);
          }
          this.messages.push({
            role: "tool",
            content: output,
            toolCallId: call.id,
            toolName: call.name,
          });
          if (readKey) repeatedReads.get(readKey)!.receipt = this.messages[this.messages.length - 1];
          await this.bus.emit("post_tool", { name: call.name, args: call.args });
          await this.bus.emit("context_update");
          // A cancel during tool execution ends the turn now, with the
          // (cancelled) result already recorded so the transcript stays valid.
          if (signal.aborted) throw abortError();
          // Individual rereads after eviction are legitimate, but a long
          // investigation with no edit must still return to executable evidence.
          // Preserve this counter across compaction; only an edit or check
          // resets it. Read-only investigations never execute commands.
          const needsEvidence =
            readRepeats >= 5 || repeats >= 6 || failedCalls >= 6 || (wroteThisTurn && readsSinceAction >= 24 && this.mode !== "ro");
          if (needsEvidence) this.discoverVerification(wroteThisTurn);
          if (this.verification && needsEvidence) {
            this.repairTranscript("[Not executed: the harness switched to executable checks after repeated attempts.]");
            this.ctxMgr.resetAnchor();
            // During implementation, known failing project checks are already
            // the actionable evidence. Tool-recovery checks must not spend the
            // caller's final acceptance budget before acceptance has started.
            if (!this.verificationResult && this.progressFailure && (await this.checkProgress(signal))) {
              repeatedReads.clear();
              repeats = 0;
              failedCalls = 0;
              readsSinceAction = 0;
              lastProgressCheck = toolCallsThisTurn;
              continue agentLoop;
            }
            if (!(await runAcceptance())) {
              repeatedReads.clear();
              repeats = 0;
              failedCalls = 0;
              readsSinceAction = 0;
              lastProgressCheck = toolCallsThisTurn;
              continue agentLoop;
            }
            // Passing acceptance does not authorize dropping the remaining
            // task: ask for a final requirements review before completion.
            this.messages.push({
              role: "user",
              content: "[Acceptance passed. Review the original request, finish any remaining work, and summarize the verified result.]",
            });
            repeatedReads.clear();
            repeats = 0;
            failedCalls = 0;
            readsSinceAction = 0;
            lastProgressCheck = toolCallsThisTurn;
            continue agentLoop;
          }
          if (readRepeats >= 5)
            throw new Error(
              "Paused after repeatedly reading the same unchanged data without an edit. Progress is kept. Ask for a specific next change, read a different range, or use a larger context window."
            );
          if (repeats >= 6 || failedCalls >= 6)
            throw new Error(
              "Paused after repeated tool attempts made no progress. Progress is kept; inspect the error, change the request or model, then continue."
            );
        }
        // A model can cycle through different reads and small API edits forever
        // without triggering an identical-call guard. Periodic executable
        // feedback grounds that investigation before a proposed completion.
        if (wroteThisTurn && this.mode !== "ro" && toolCallsThisTurn - lastProgressCheck >= 24) {
          lastProgressCheck = toolCallsThisTurn;
          this.discoverVerification(wroteThisTurn);
          if (this.verification && this.verificationResult) {
            // Once acceptance has found a real failure, keep checking THAT
            // behavior. Passing a weaker build check cannot resolve it.
            if (await runAcceptance())
              this.messages.push({ role: "user", content: "[Acceptance checks passed. Finish your response with the verified result.]" });
            readsSinceAction = 0;
            repeatedReads.clear();
            repeats = 0;
            failedCalls = 0;
          } else if (await this.checkProgress(signal)) {
            readsSinceAction = 0;
            repeatedReads.clear();
            repeats = 0;
            failedCalls = 0;
          }
        }
      }
      this.setAutopilotPhase("paused", `limite de ${this.maxSteps} étapes atteinte`, {
        step: steps,
        maxSteps: this.maxSteps,
        message: "Progression conservée; reprendre avec « continue ».",
      });
      throw new Error(`Paused after ${this.maxSteps} model steps. Progress is kept. Say "continue" to keep going.`);
    } catch (err: any) {
      if (err?.name === "AbortError" || signal.aborted) {
        this.ui.println();
        this.ui.status("· cancelled");
        this.ui.turnCancelled?.();
        this.setAutopilotPhase("cancelled", "tour annulé; progression conservée");
        this.outcome = "cancelled";
        this.sanitizeAfterCancel();
        return;
      }
      this.outcome = "error";
      this.lastError = String(err?.message ?? err);
      this.setAutopilotPhase("error", this.lastError, { message: this.lastError });
      this.ui.turnError?.(this.lastError);
      this.repairTranscript("[Tool did not run because the turn stopped after an error. Inspect the preceding error before continuing.]");
      throw err;
    } finally {
      await this.ctxMgr.foreground();
      this.abort = null;
      stats.durationMs = Date.now() - t0;
      if (completed) {
        this.ui.turnEnd(`${fmtDuration(stats.durationMs)}${describeStats(stats)}`);
      }
    }
  }

  /** Coaching for a tool call that overflowed the output cap. Exported via
   * the class for tests. */
  truncatedCallHint(): string {
    const cap = this.provider.maxOutputTokens;
    const part = Math.max(300, Math.floor(cap * 0.5));
    return (
      `Your tool call was cut off by the output limit of ${cap} tokens, so it was NOT executed and nothing was saved. ` +
      `Send smaller calls: write the file in parts of at most ~${part} tokens — write_file with the first part, ` +
      `then edit_file to append each next part (old_text = the last line you wrote, new_text = that line followed by the next part) — ` +
      `or split the code across several smaller files.`
    );
  }

  /** One model call, with bounded retries on transient backend failures
   * (Ollama/LM Studio hiccups, dropped sockets, 5xx). The transcript is
   * unchanged between attempts, so a retry is always safe. A local CPU model can
   * also need minutes to prefill: Node gives up after ~300 s waiting for response
   * headers, so that wait gets a long backoff instead of killing the turn. */
  private async chatWithRetry(signal: AbortSignal, actionOnly = false): Promise<ChatResult> {
    let lastErr: any;
    let recoveredContext = false;
    let timeoutRecovery = 0;
    for (let attempt = 1; attempt <= 6; attempt++) {
      let streamed = false;
      const requestStarted = Date.now();
      try {
        return await this.provider.chat(this.messages, this.tools, {
          signal,
          ...(actionOnly ? { effortOverride: "off" as const } : {}),
          maxTokens: Math.min(
            this.provider.maxOutputTokens,
            this.contextBudget().reserve,
            timeoutRecovery > 0 ? Math.max(512, Math.floor(this.provider.maxOutputTokens * 0.65)) : Infinity
          ),
          onToken: (t) => {
            streamed = true;
            this.ui.token(t);
          },
          onThinking: (t) => {
            streamed = true;
            this.ui.thinking(t);
          },
        });
      } catch (err: any) {
        if (err?.name === "AbortError" || signal.aborted) throw err;
        lastErr = err;
        if (streamed) this.ui.resetResponse?.();
        if (isBackendTimeoutError(err)) {
          if (timeoutRecovery >= 2 || attempt === 6) throw err;
          timeoutRecovery++;
          this.ui.warn(
            `· délai du backend (${timeoutRecovery}/2) — nouvelle tentative automatique avec raisonnement réduit dans ${timeoutRecovery}s`
          );
          await abortableDelay(timeoutRecovery * 1000, signal);
          actionOnly = true;
          continue;
        }
        if (!recoveredContext && CONTEXT_ERROR.test(String(err?.message ?? err))) {
          recoveredContext = true;
          this.ui.status("· backend context limit — reducing history and retrying");
          await this.compactNow(true, true);
          this.ctxMgr.assertFits(this.messages, this.tools);
          continue;
        }
        const slow = isSlowPrefillError(err);
        const message = String(err?.message ?? err);
        if (attempt === 6 || !(slow || TRANSIENT_ERROR.test(message))) throw err;
        const wait = slow ? Math.min(60, 15 * attempt) : attempt * 3;
        this.ui.warn(
          slow
            ? `· le serveur local n'a pas répondu en ${Math.round((Date.now() - requestStarted) / 1000)}s (prompt lourd sur CPU) — nouvelle tentative ${attempt}/6 dans ${wait}s`
            : `· backend error (${message.slice(0, 80)}) — nouvelle tentative ${attempt}/6 dans ${wait}s`
        );
        await abortableDelay(wait * 1000, signal);
      }
    }
    throw lastErr;
  }

  private async refreshLoadedWindow(): Promise<void> {
    try {
      const actual = await this.provider.loadedContextWindow?.();
      if (actual && Number.isSafeInteger(actual) && actual < this.contextBudget().window) {
        this.ctxMgr.setWindow(actual, Math.min(this.provider.maxOutputTokens, Math.floor(actual / 4)));
        this.ui.status(`· loaded model context changed to ${actual.toLocaleString()} tokens; budget adjusted`);
        await this.bus.emit("context_update");
      }
    } catch {
      /* probe réseau optionnelle : ne casse jamais le tour */
    }
  }

  private async gateAndExecute(name: string, args: Record<string, any>, signal?: AbortSignal): Promise<string> {
    const command = commandOf(name, args);
    // External MCP servers can send mail, edit sheets and browse the web —
    // always ask in edit mode (bypass runs without asking, like commands).
    if (name === "mcp" && this.mode !== "bypass") {
      const server = String(args.server ?? "").trim() || "?";
      const key = `mcp:${server.toLowerCase()}`;
      if (!this.alwaysAllowed.has(key)) {
        if (!this.interactive) {
          return `Error: MCP server "${server}" needs user approval, and this session is non-interactive. The user can rerun smol with --mode bypass, or run this themselves.`;
        }
        const answer = await this.ui.confirmCommand(
          `mcp ${server} ${String(args.tool ?? "").trim()}`,
          `uses the external MCP server "${server}"`
        );
        if (answer === "no") {
          return "The user declined the MCP call. Continue without it, or ask the user what to do instead.";
        }
        if (answer === "always") this.alwaysAllowed.add(key);
      }
    }
    // Connecteurs : envoyer un e-mail ou créer un événement sort de la machine —
    // toujours demander en édition, et « always » ne couvre jamais ces actions.
    if ((name === "mail" || name === "calendar") && this.mode !== "bypass") {
      const action = String(args.action ?? "").trim();
      const risky = name === "mail" ? action === "send" : action === "create";
      if (risky) {
        const to = String(args.to ?? "?")
          .trim()
          .slice(0, 80);
        const title =
          String(args.summary ?? "")
            .trim()
            .slice(0, 80) ||
          String(args.subject ?? "")
            .trim()
            .slice(0, 80);
        const label = name === "mail" ? `mail send to ${to}` : `calendar create « ${title} »`;
        const reason =
          name === "mail"
            ? `envoie un vrai e-mail à ${to} — objet « ${String(args.subject ?? "")
                .trim()
                .slice(0, 80)} »`
            : `crée un vrai événement « ${title} » dans votre agenda`;
        if (!this.interactive) {
          return `Error: the ${name} tool needs user approval, and this session is non-interactive. The user can approve in the interactive terminal, rerun smol with --mode bypass, or run it themselves.`;
        }
        const answer = await this.ui.confirmCommand(label, reason);
        if (answer === "no") {
          return `The user declined the ${name} action. Continue without it, or ask the user what to do instead.`;
        }
      }
    }
    // Gate everywhere except bypass (defense-in-depth: in ro mode exec tools are
    // already rejected before this point by the tool-existence check). Edit
    // mode runs commands that stay inside the workspace without asking and
    // only prompts for ones that reach outside it.
    if (command !== null && this.mode !== "bypass") {
      const danger = classifyDanger(command);
      if (danger !== null) {
        // Commande dangereuse : toujours demander, jamais de « always ».
        if (!this.interactive) {
          return `Error: this command ${danger}, and dangerous commands always need user approval. This session is non-interactive. Keep every path inside the workspace (relative paths, a scratch folder in the workspace instead of /tmp), or the user can rerun smol with --mode bypass, or run this themselves: ${command}`;
        }
        const answer = await this.ui.confirmCommand(command, danger);
        if (answer === "no") {
          return "The user declined to run this command. Continue without it, or ask the user what to do instead.";
        }
      } else {
        const reason = commandEscapesWorkspace(command, this.toolCtx.workspace);
        if (reason !== null && !isAutoApproved(command, this.alwaysAllowed, reason)) {
          if (this.mode === "auto" && classifyCommand(command) === "safe") {
            // Auto-pilote : consultation manifeste (lecture seule, sans chaînage).
            this.ui.status(`· auto-pilote : « ${command} » est en lecture seule — exécutée sans demander`);
          } else {
            if (!this.interactive) {
              return `Error: this command ${reason}, which needs user approval, and this session is non-interactive. Keep every path inside the workspace (relative paths, a scratch folder in the workspace instead of /tmp), or the user can rerun smol with --mode bypass, or run this themselves: ${command}`;
            }
            const answer = await this.ui.confirmCommand(command, reason);
            if (answer === "no") {
              return "The user declined to run this command. Continue without it, or ask the user what to do instead.";
            }
            if (answer === "always") {
              if (/globally|outside the workspace/i.test(reason)) {
                this.ui.status?.("· autorisation unique : les installs globales demandent toujours");
              } else {
                let program = command.trim().split(/\s+/)[0] ?? "";
                if (process.platform === "win32") program = program.toLowerCase();
                if (program) this.alwaysAllowed.add(program);
              }
            }
          }
        }
      }
    }
    if (signal?.aborted) throw signal.reason;
    if (!this.tools.some((t) => t.name === name)) {
      return this.toolCtx.allowedTools && !this.toolCtx.allowedTools.has(name)
        ? `Error: ${name} is unavailable for the ${this.toolCtx.role ?? "restricted"} role. Use only the tools assigned to this sub-agent.`
        : `Error: ${name} is no longer available in ${MODE_LABELS[this.mode]} mode.`;
    }
    return executeTool(name, args, this.toolCtx, signal);
  }

  private repairTranscript(reason: string): void {
    const repaired: Msg[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.role === "tool") continue; // consumed with its assistant, or orphaned
      repaired.push(m);
      if (!m.toolCalls?.length) continue;
      const results = new Map<string | undefined, Msg>();
      while (this.messages[i + 1]?.role === "tool") {
        const t = this.messages[++i];
        results.set(t.toolCallId, t);
      }
      for (const call of m.toolCalls)
        repaired.push(results.get(call.id) ?? { role: "tool", toolCallId: call.id, toolName: call.name, content: reason });
    }
    this.messages = repaired;
  }

  /**
   * After a cancel, the most recent assistant tool-call message may have some
   * calls unanswered — strict backends reject that shape on the next request.
   * A cancel mid-way through a MULTI-call batch buries that assistant message
   * behind the already-pushed tool results, so walk back past them.
   */
  private sanitizeAfterCancel(): void {
    this.repairTranscript("[cancelled by the user before this tool ran]");
  }

  statusLine(): string {
    const pct = this.contextPercent();
    const tasks = this.toolCtx.taskManager.runningSummary();
    const taskPart = tasks.length ? ` · ${tasks.length} bg task${tasks.length > 1 ? "s" : ""}` : "";
    return c.gray(`ctx ${pct}% of ${this.provider.contextWindow.toLocaleString()} · ${this.provider.label} · ${this.mode}${taskPart}`);
  }
}

export interface TurnStats {
  modelCalls: number;
  toolCalls: number;
  /** All tokens the model produced this turn, reasoning included. */
  generatedTokens: number;
  /** Seconds spent generating (from backend timings or stream wall-clock). */
  genSeconds: number;
  /** Characters of reasoning streamed this turn (~4 chars per token). */
  thinkingChars: number;
  /** Prompt size of the last request — where the context sits now. */
  promptTokensLast: number;
  durationMs: number;
}

/** " · 12 tools · 4.1k tok @ 118 tok/s" — the speed readout local-model users
 * actually want to compare backends with. */
export function describeStats(s: TurnStats): string {
  const parts: string[] = [];
  if (s.toolCalls) parts.push(`${s.toolCalls} tool${s.toolCalls === 1 ? "" : "s"}`);
  if (s.generatedTokens) {
    const k = s.generatedTokens >= 1000 ? `${(s.generatedTokens / 1000).toFixed(1)}k` : String(s.generatedTokens);
    const rate = s.genSeconds > 0 ? ` @ ${Math.round(s.generatedTokens / s.genSeconds)} tok/s` : "";
    parts.push(`${k} tok${rate}`);
  }
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

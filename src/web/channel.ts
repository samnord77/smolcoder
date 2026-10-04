// SessionChannel: the SessionUI a web session talks to. Same contract the
// terminal Tui implements, but every event is tagged with the session id and
// handed to the hub, which multiplexes all sessions onto one SSE stream.
// Keeps a replay buffer (so a page that connects later sees the transcript),
// the pending input/approval promises, and a coarse status for the sidebar.

import type { Attachment, UserInput } from "../attachments";
import type { Plan } from "../plan";
import { type AgentPhase, type AgentPhaseDetails, type SelectOption, type SessionUI, type SlashCommand, summarizeArgs } from "../ui";
import { renderEditDiff } from "./diff";

export type Event = Record<string, any>;

export type ChannelStatus = "starting" | "idle" | "busy" | "waiting" | "error";

export interface ChannelHost {
  /** Deliver an (already tagged) event to every connected page. */
  send(ev: Event): void;
  /** Sidebar-visible facts changed (status, title): resend the hub snapshot. */
  changed(id: string): void;
  /** The transcript grew: schedule a save. */
  touched(id: string): void;
}

const REPLAY_CAP = 2000;

export class SessionChannel implements SessionUI {
  slashCommands: SlashCommand[] = [];
  getStatus: () => string = () => "";
  /** Structured snapshot for the page's status bar; assigned by the hub. */
  getState: () => Record<string, any> = () => ({});
  hintLeft = "";
  onModeCycle: (() => void) | null = null;
  onCancel: (() => void) | null = null;
  onExit: (() => void) | null = null;

  phase: ChannelStatus = "starting";
  title = "";
  busyLabel: string | null = null;
  /** Live sub-agent activity (delegate tool) — shown by the IDE status view. */
  subagentActive: string | null = null;
  subagentRuns = 0;
  /** Skills that auto-loaded into the current turn. */
  skillsActive: string[] = [];
  /** Structured Auto Copilot phase shown by web and Electron status panels. */
  autopilot: { phase: AgentPhase; label: string; details?: AgentPhaseDetails } | null = null;
  replay: Event[] = [];
  closed = false;

  private pendingInput: ((s: string | UserInput) => void) | null = null;
  private inputQueue: (string | UserInput)[] = [];
  private exitRequested = false;
  private pending = new Map<number, { resolve: (v: any) => void; kind: "confirm" | "select" | "prompt"; label: string }>();
  private askId = 0;

  restoreReplay(events: Event[]): void {
    this.replay = events.slice(-REPLAY_CAP).filter((e) => e.t !== "confirm" && e.t !== "select" && e.t !== "prompt" && e.t !== "answered");
    this.askId = Math.max(0, ...events.map((e) => (typeof e.id === "number" ? e.id : 0)));
  }

  constructor(
    readonly id: string,
    private host: ChannelHost
  ) {}

  // ---- lifecycle -----------------------------------------------------------

  start(): void {}

  close(): void {
    this.closed = true;
    this.busyLabel = null;
    this.resolvePending(null);
    this.host.changed(this.id);
  }

  /** Make the session loop's next readInput() return "/exit" without echoing
   * it as a user message. Used when a session is closed from the sidebar. */
  requestExit(): void {
    this.exitRequested = true;
    if (this.pendingInput) {
      const r = this.pendingInput;
      this.pendingInput = null;
      r("/exit");
    }
  }

  // ---- input from the page -------------------------------------------------

  /** A message from the page: text, attachments, or both. */
  handleMessage(text: string, attachments: Attachment[] = [], workItemId?: string): void {
    text = text.trim();
    if ((!text && !attachments.length) || this.closed) return;
    const input: string | UserInput =
      attachments.length || workItemId ? { text, attachments, ...(workItemId ? { workItemId } : {}) } : text;
    if (this.pendingInput) {
      const resolve = this.pendingInput;
      this.pendingInput = null;
      this.accept(input);
      resolve(input);
    } else {
      this.inputQueue.push(input);
    }
  }

  handleAnswer(id: number, value: any): void {
    if (!this.pending.has(id)) return;
    this.setStatus("busy");
    this.settle(id, value);
  }

  /** Stop button / esc: answer any open prompt with "no"/cancel, then abort
   * the turn. Without the first step a cancel during an approval prompt
   * would leave the agent waiting on a promise nothing will resolve. */
  cancel(): void {
    this.resolvePending(null);
    this.onCancel?.();
  }

  private resolvePending(value: any): void {
    for (const id of [...this.pending.keys()]) this.settle(id, value);
  }

  /** Resolve one prompt and record the outcome in the transcript, so a page
   * that replays it later (reconnect, resume) sees the answer, not live
   * buttons for a question nobody is asking any more. */
  private settle(id: number, value: any): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.broadcast({ t: "answered", id });
    if (p.kind === "confirm") {
      const a = value === "always" ? "always allow" : value === "yes" ? "yes" : "no";
      this.broadcast({ t: "line", kind: "status", s: `${a} — ${p.label}` });
    } else if (value === null || value === undefined || (p.kind === "prompt" && !String(value).trim())) {
      this.broadcast({ t: "line", kind: "status", s: `cancelled — ${p.label}` });
    } else if (p.kind === "prompt") {
      this.broadcast({ t: "line", kind: "status", s: `${p.label}: ${String(value).trim().slice(0, 200)}` });
    }
    p.resolve(value);
  }

  private accept(input: string | UserInput): void {
    const text = typeof input === "string" ? input : input.text;
    const files =
      typeof input === "string"
        ? []
        : input.attachments.map((a) => ({ id: a.id, name: a.name, kind: a.kind, size: a.size, url: uploadUrl(this.id, a.id) }));
    this.setStatus("busy");
    const workItemId = typeof input === "string" ? undefined : input.workItemId;
    this.broadcast({ t: "user", s: text, ...(files.length ? { files } : {}), ...(workItemId ? { workItemId } : {}) });
    const label = text || files.map((f) => f.name).join(", ");
    if (!this.title && !label.startsWith("/")) {
      this.title = label.replace(/\s+/g, " ").slice(0, 60);
      this.host.changed(this.id);
    }
  }

  private setStatus(s: ChannelStatus): void {
    if (this.phase === s) return;
    this.phase = s;
    this.host.changed(this.id);
  }

  // ---- event plumbing ------------------------------------------------------

  private broadcast(ev: Event): void {
    ev.sid = this.id;
    if (ev.t !== "busy" && ev.t !== "state") {
      const prev = this.replay[this.replay.length - 1];
      if ((ev.t === "token" || ev.t === "thinking") && prev?.t === ev.t && String(prev.s).length + String(ev.s).length < 100_000) {
        prev.s += ev.s;
      } else this.replay.push({ ...ev });
      if (this.replay.length > REPLAY_CAP) this.replay.shift();
      this.host.touched(this.id);
    }
    this.host.send(ev);
  }

  stateEvent(): Event {
    return {
      t: "state",
      sid: this.id,
      s: {
        ...this.getState(),
        busy: this.busyLabel,
        title: this.title,
        subagent: this.subagentActive,
        subagentRuns: this.subagentRuns,
        skills: this.skillsActive,
        ...(this.autopilot ? { autopilot: this.autopilot } : {}),
      },
    };
  }

  pushState(): void {
    this.host.send(this.stateEvent());
  }

  refresh(): void {
    this.pushState();
  }

  // ---- SessionUI -----------------------------------------------------------

  readInput(): Promise<string | UserInput> {
    this.busyLabel = null;
    this.setStatus("idle");
    this.pushState();
    if (this.exitRequested || this.closed) return Promise.resolve("/exit");
    if (this.inputQueue.length) {
      const text = this.inputQueue.shift()!;
      this.accept(text);
      return Promise.resolve(text);
    }
    return new Promise((resolve) => (this.pendingInput = resolve));
  }

  select(title: string, options: SelectOption[]): Promise<number | null> {
    const id = ++this.askId;
    this.broadcast({ t: "select", id, title, options });
    this.setStatus("waiting");
    return new Promise((resolve) =>
      this.pending.set(id, { kind: "select", label: title, resolve: (i) => resolve(typeof i === "number" ? i : null) })
    );
  }

  prompt(title: string, placeholder = ""): Promise<string | null> {
    const id = ++this.askId;
    this.broadcast({ t: "prompt", id, title, placeholder });
    this.setStatus("waiting");
    return new Promise((resolve) =>
      this.pending.set(id, {
        kind: "prompt",
        label: title,
        resolve: (s) => resolve(typeof s === "string" && s.trim() ? s.trim().slice(0, 500) : null),
      })
    );
  }

  confirmCommand(command: string, reason?: string): Promise<"yes" | "no" | "always"> {
    const id = ++this.askId;
    this.broadcast({ t: "confirm", id, command, reason });
    this.setStatus("waiting");
    return new Promise((resolve) =>
      this.pending.set(id, {
        kind: "confirm",
        label: command,
        resolve: (a) => resolve(a === "always" ? "always" : a === "yes" ? "yes" : "no"),
      })
    );
  }

  token(text: string): void {
    this.broadcast({ t: "token", s: text });
  }

  resetResponse(): void {
    this.broadcast({ t: "response_reset" });
  }

  thinking(text: string): void {
    this.broadcast({ t: "thinking", s: text });
  }

  toolCall(name: string, args: Record<string, any>, executionId?: string): void {
    const ev: Record<string, any> = { t: "tool", name, summary: summarizeArgs(name, args) };
    if (executionId) ev.executionId = executionId;
    ev.category =
      name === "verification"
        ? "verification"
        : name === "delegate"
          ? "delegation"
          : ["read_file", "list_files", "search", "symbols", "index_symbols"].includes(name)
            ? "observation"
            : ["edit_file", "write_file", "delete_file", "delete_path", "move_path", "create_folder"].includes(name)
              ? "modification"
              : "tool";
    if (name === "run_command" && typeof args?.command === "string") ev.command = args.command.slice(0, 20_000);
    if (name === "edit_file" && typeof args?.old_text === "string" && typeof args?.new_text === "string") {
      try {
        ev.diff = renderEditDiff(args.old_text, args.new_text);
      } catch {
        /* summary alone is enough */
      }
    }
    this.broadcast(ev);
  }

  toolResult(result: string, executionId?: string): void {
    const lines = result.split("\n");
    const first = lines[0] ?? "";
    const ev: Record<string, any> = {
      t: "result",
      line: first.slice(0, 160),
      err: first.startsWith("Error"),
      extra: lines.length > 1 ? lines.length - 1 : 0,
      body: result,
    };
    if (executionId) ev.executionId = executionId;
    this.broadcast(ev);
  }

  turnCancelled(): void {
    this.autopilotPhase("cancelled", "tour annulé");
    this.broadcast({ t: "turn_cancelled" });
  }

  autopilotPhase(phase: AgentPhase, label: string, details?: AgentPhaseDetails): void {
    this.autopilot = { phase, label: label.slice(0, 240), ...(details ? { details } : {}) };
    if (phase === "error") this.setStatus("error");
    else if (phase === "completed" || phase === "cancelled") this.setStatus("idle");
    else this.setStatus("busy");
    this.broadcast({ t: "autopilot", phase, label: this.autopilot.label, ...(details ? { details } : {}) });
    this.pushState();
  }

  turnError(message: string): void {
    this.autopilotPhase("error", message || "échec du tour", { message: message || "échec du tour" });
    this.stopSpinner();
    this.broadcast({ t: "turn_error", message: message || "échec du tour" });
  }

  planUpdated(plan: Plan): void {
    this.broadcast({ t: "plan", steps: plan.steps, current: plan.currentIndex });
    this.pushState();
  }

  subagent(
    phase: "start" | "done",
    label: string,
    details?: {
      outcome?: string;
      verification?: string;
      report?: string;
      filesTouched?: string[];
      toolCalls?: number;
    }
  ): void {
    const clean = label.slice(0, 200);
    const safeDetails = details
      ? {
          outcome: typeof details.outcome === "string" ? details.outcome.slice(0, 40) : "",
          verification: typeof details.verification === "string" ? details.verification.slice(0, 40) : "",
          report: typeof details.report === "string" ? details.report.slice(0, 3000) : "",
          filesTouched: Array.isArray(details.filesTouched)
            ? details.filesTouched
                .filter((file): file is string => typeof file === "string")
                .slice(0, 10)
                .map((file) => file.slice(0, 300))
            : [],
          toolCalls: Number.isFinite(details.toolCalls) ? Math.max(0, Math.floor(details.toolCalls!)) : 0,
        }
      : undefined;
    if (phase === "start") {
      this.subagentActive = clean;
      this.subagentRuns += 1;
    } else {
      this.subagentActive = null;
    }
    this.broadcast({ t: "sub", phase, label: clean, ...(safeDetails ? { details: safeDetails } : {}) });
    this.pushState();
  }

  /** Skills that just auto-loaded: the status view lists them live. */
  skills(names: string[]): void {
    this.skillsActive = (Array.isArray(names) ? names : []).filter((n) => typeof n === "string" && n.trim()).slice(0, 20);
    this.broadcast({ t: "skills", names: this.skillsActive });
    this.pushState();
  }

  println(s = ""): void {
    if (s.trim()) this.broadcast({ t: "line", kind: "status", s: stripAnsi(s) });
  }

  status(s: string): void {
    this.broadcast({ t: "line", kind: "status", s: stripAnsi(s) });
  }

  warn(s: string): void {
    this.broadcast({ t: "line", kind: "warn", s: stripAnsi(s) });
  }

  error(s: string): void {
    this.broadcast({ t: "line", kind: "error", s: stripAnsi(s) });
  }

  turnEnd(label: string): void {
    this.broadcast({ t: "turnend", label });
    this.pushState();
  }

  startSpinner(label: string): void {
    this.busyLabel = label;
    this.broadcast({ t: "busy", label });
  }

  stopSpinner(): void {
    this.busyLabel = null;
    this.broadcast({ t: "busy", label: null });
  }
}

/** Where the page fetches a stored upload (it appends its own key). */
export function uploadUrl(sid: string, id: string): string {
  return `/upload?sid=${sid}&id=${id}`;
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

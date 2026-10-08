// The agent's plan is harness-owned, bounded and persisted per workspace
// conversation. It survives compaction and restarts without relying on model
// summaries; each `done` result restates the next step to keep small models on
// track. In-memory instances remain available for isolated sub-agents/tests.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { resolveInWorkspace } from "./sandbox";

export interface PlanStep {
  text: string;
  done: boolean;
  /** Model-authored working notes, kept verbatim instead of re-summarized. */
  note?: string;
}

export class Plan {
  steps: PlanStep[] = [];
  private readonly storage: { workspace: string; key: string } | null;
  loadError: string | null = null;

  constructor(workspace?: string, key = "cli") {
    this.storage = workspace ? { workspace, key } : null;
    if (!this.storage) return;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
      this.loadError = "invalid plan storage key; plan persistence is disabled for this session.";
      return;
    }
    try {
      const file = this.storagePath();
      if (!fs.existsSync(file)) return;
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 128 * 1024) throw new Error("saved plan exceeds its size limit or is not a regular file");
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data?.version !== 1 || !Array.isArray(data.steps) || !Plan.validSteps(data.steps)) {
        throw new Error("saved plan has an unsupported format");
      }
      this.steps = data.steps.map((step: PlanStep) => ({ ...step }));
    } catch (error: any) {
      this.loadError = `could not load the saved plan: ${String(error?.message ?? error).slice(0, 240)}`;
    }
  }

  private static validSteps(value: unknown): value is PlanStep[] {
    return (
      Array.isArray(value) &&
      value.length <= 20 &&
      value.every((step) => {
        if (!step || typeof step !== "object") return false;
        const s = step as PlanStep;
        return (
          typeof s.text === "string" &&
          s.text.trim().length > 0 &&
          s.text.length <= 4000 &&
          typeof s.done === "boolean" &&
          (s.note === undefined || (typeof s.note === "string" && s.note.length <= 1000))
        );
      })
    );
  }

  private storagePath(): string {
    const storage = this.storage!;
    return resolveInWorkspace(storage.workspace, `.smol/plans/${storage.key}.json`);
  }

  /** Atomically commit a proposed state. Callers only publish it in memory
   * after disk persistence succeeds. Plans are bounded and workspace-local. */
  private persist(steps: PlanStep[]): string | null {
    if (!this.storage) return null;
    const data = `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), steps }, null, 2)}\n`;
    if (Buffer.byteLength(data, "utf8") > 128 * 1024) return "Error: saved plan exceeds its 128 KB storage limit.";
    let temp: string | null = null;
    try {
      const directory = resolveInWorkspace(this.storage.workspace, ".smol/plans");
      fs.mkdirSync(directory, { recursive: true });
      const file = this.storagePath();
      temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(temp, data, { encoding: "utf8", flag: "wx" });
      fs.renameSync(temp, file);
      temp = null;
      return null;
    } catch (error: any) {
      return `Error: could not save the project plan: ${String(error?.message ?? error).slice(0, 240)}`;
    } finally {
      try {
        if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
      } catch {
        /* preserve the primary result */
      }
    }
  }

  /** Restore a validated plan snapshot, used when resuming one saved session. */
  restoreSteps(steps: unknown): string | null {
    if (!Plan.validSteps(steps)) return "Error: saved session plan has an unsupported format.";
    const copy = steps.map((step) => ({ ...step }));
    const failure = this.persist(copy);
    if (failure) return failure;
    this.steps = copy;
    return null;
  }

  get exists(): boolean {
    return this.steps.length > 0;
  }

  get doneCount(): number {
    return this.steps.filter((s) => s.done).length;
  }

  /** Index of the current (first undone) step, or -1 when all done/empty. */
  get currentIndex(): number {
    return this.steps.findIndex((s) => !s.done);
  }

  reset(): string | null {
    const failure = this.persist([]);
    if (failure) return failure;
    this.steps = [];
    return null;
  }

  /** Replace the plan. Accept the semicolon lists local models often return
   * when asked for a newline-separated string. Keep explicit multiline steps
   * intact, including punctuation or code within a step. */
  set(stepsText: string): string {
    const lines = stepsText
      .split(stepsText.includes("\n") ? "\n" : /;\s*/)
      .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])?\s*(?:\[.\]\s*)?/, "").trim())
      .filter(Boolean)
      .slice(0, 20);
    if (lines.length === 0) {
      return 'Error: steps is required — one step per line. Example: {"action": "set", "steps": "create index.html\\ncreate game.js\\ntest the page"}';
    }
    if (lines.some((text) => text.length > 4000)) return "Error: each plan step must be at most 4,000 characters.";
    const next = lines.map((text) => ({ text, done: false }));
    const failure = this.persist(next);
    if (failure) return failure;
    this.steps = next;
    return `Plan set (${this.steps.length} steps). Current: 1. ${this.steps[0].text}`;
  }

  /** Mark a step done. No index = the current step. Returns a compact
   * "what's next" line — cheap tokens that keep the model on course. */
  markDone(stepNumber?: number): string {
    if (!this.exists) return 'Error: no plan yet. Create one first with {"action": "set", "steps": "..."}';
    let idx: number;
    if (stepNumber === undefined || stepNumber === null) {
      idx = this.currentIndex;
      if (idx < 0) return "All steps are already done.";
    } else {
      if (typeof stepNumber !== "number" || !Number.isFinite(stepNumber)) {
        return `Error: step must be a number between 1 and ${this.steps.length}.`;
      }
      idx = Math.floor(stepNumber) - 1;
      if (!Number.isSafeInteger(idx) || idx < 0 || idx >= this.steps.length) {
        return `Error: step ${stepNumber} does not exist. The plan has ${this.steps.length} steps.`;
      }
    }
    const nextSteps = this.steps.map((step, i) => (i === idx ? { ...step, done: true } : step));
    const failure = this.persist(nextSteps);
    if (failure) return failure;
    this.steps = nextSteps;
    const next = this.currentIndex;
    return next < 0
      ? `Done: ${idx + 1}. All ${this.steps.length} steps complete.`
      : `Done: ${idx + 1}. Next: ${next + 1}. ${this.steps[next].text}`;
  }

  /** Force one step to an explicit state (check or uncheck from the UI).
   *  markDone can only move a step forward; the task rail needs to toggle. */
  setDone(stepNumber: unknown, done: boolean): string {
    if (!this.exists) return 'Error: no plan yet. Create one first with {"action": "set", "steps": "..."}';
    const idx = typeof stepNumber === "number" && Number.isFinite(stepNumber) ? Math.floor(stepNumber) - 1 : -1;
    if (!Number.isSafeInteger(idx) || idx < 0 || idx >= this.steps.length) {
      return `Error: step must be a number between 1 and ${this.steps.length}.`;
    }
    if (!!this.steps[idx].done === !!done) {
      return `Step ${idx + 1} is already ${done ? "done" : "open"}.`;
    }
    const nextSteps = this.steps.map((step, i) => (i === idx ? { ...step, done: !!done } : step));
    const failure = this.persist(nextSteps);
    if (failure) return failure;
    this.steps = nextSteps;
    return `Step ${idx + 1} ${done ? "done" : "reopened"}.`;
  }

  add(text: string): string {
    if (typeof text !== "string" || !text.trim()) {
      return 'Error: text is required. Example: {"action": "add", "text": "fix the collision bug"}';
    }
    if (this.steps.length >= 20) return "Error: the plan already has 20 steps — finish some first.";
    if (text.trim().length > 4000) return "Error: each plan step must be at most 4,000 characters.";
    const next = [...this.steps, { text: text.trim(), done: false }];
    const failure = this.persist(next);
    if (failure) return failure;
    this.steps = next;
    return `Added step ${this.steps.length}: ${text.trim()}`;
  }

  checkpoint(text: string): string {
    const idx = this.currentIndex;
    if (idx < 0) return "Error: create a plan with an unfinished step before recording a checkpoint.";
    if (typeof text !== "string" || !text.trim() || text.length > 1000)
      return "Error: checkpoint text must be 1–1000 characters. Keep exact APIs, the unresolved error and the next small edit.";
    const next = this.steps.map((step, i) => (i === idx ? { ...step, note: text.trim() } : step));
    const failure = this.persist(next);
    if (failure) return failure;
    this.steps = next;
    return `Checkpoint saved for step ${idx + 1}: ${text.trim()}`;
  }

  /** Compact model-facing checklist (used by action "show" and after compaction). */
  modelView(): string {
    if (!this.exists) return "No plan set.";
    return this.steps
      .map(
        (s, i) =>
          `${i + 1}.[${s.done ? "x" : i === this.currentIndex ? ">" : " "}] ${s.text}` +
          (s.note && i === this.currentIndex ? `\nWorking checkpoint (agent notes; verify against files): ${s.note}` : "")
      )
      .join("\n");
  }

  /** One-line summary for the compaction state note. */
  compactLine(): string | null {
    if (!this.exists) return null;
    return `Plan (${this.doneCount}/${this.steps.length} done):\n${this.modelView()}`;
  }

  pendingSummary(): string {
    return this.steps
      .filter((s) => !s.done)
      .map((s) => s.text)
      .join("; ");
  }
}

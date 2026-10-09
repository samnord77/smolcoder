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
      this.loadError = "clé de stockage de plan invalide ; la persistance des plans est désactivée pour cette session.";
      return;
    }
    try {
      const file = this.storagePath();
      if (!fs.existsSync(file)) return;
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 128 * 1024)
        throw new Error("le plan enregistré dépasse sa limite de taille ou n'est pas un fichier régulier");
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data?.version !== 1 || !Array.isArray(data.steps) || !Plan.validSteps(data.steps)) {
        throw new Error("le plan enregistré a un format non pris en charge");
      }
      this.steps = data.steps.map((step: PlanStep) => ({ ...step }));
    } catch (error: any) {
      this.loadError = `impossible de charger le plan enregistré : ${String(error?.message ?? error).slice(0, 240)}`;
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
    if (Buffer.byteLength(data, "utf8") > 128 * 1024) return "Error: le plan enregistré dépasse sa limite de stockage de 128 Ko.";
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
      return `Error: impossible d'enregistrer le plan du projet : ${String(error?.message ?? error).slice(0, 240)}`;
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
    if (!Plan.validSteps(steps)) return "Error: le plan de session enregistré a un format non pris en charge.";
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
      return 'Error: steps est requis — une étape par ligne. Exemple : {"action": "set", "steps": "create index.html\\ncreate game.js\\ntest the page"}';
    }
    if (lines.some((text) => text.length > 4000)) return "Error: chaque étape du plan doit faire au plus 4 000 caractères.";
    const next = lines.map((text) => ({ text, done: false }));
    const failure = this.persist(next);
    if (failure) return failure;
    this.steps = next;
    return `Plan défini (${this.steps.length} étapes). Actuel : 1. ${this.steps[0].text}`;
  }

  /** Mark a step done. No index = the current step. Returns a compact
   * "what's next" line — cheap tokens that keep the model on course. */
  markDone(stepNumber?: number): string {
    if (!this.exists) return 'Error: pas encore de plan. Créez-en un d\'abord avec {"action": "set", "steps": "..."}';
    let idx: number;
    if (stepNumber === undefined || stepNumber === null) {
      idx = this.currentIndex;
      if (idx < 0) return "Toutes les étapes sont déjà terminées.";
    } else {
      if (typeof stepNumber !== "number" || !Number.isFinite(stepNumber)) {
        return `Error: l'étape doit être un nombre entre 1 et ${this.steps.length}.`;
      }
      idx = Math.floor(stepNumber) - 1;
      if (!Number.isSafeInteger(idx) || idx < 0 || idx >= this.steps.length) {
        return `Error: l'étape ${stepNumber} n'existe pas. Le plan comporte ${this.steps.length} étapes.`;
      }
    }
    const nextSteps = this.steps.map((step, i) => (i === idx ? { ...step, done: true } : step));
    const failure = this.persist(nextSteps);
    if (failure) return failure;
    this.steps = nextSteps;
    const next = this.currentIndex;
    return next < 0
      ? `Terminé : ${idx + 1}. Les ${this.steps.length} étapes sont complètes.`
      : `Terminé : ${idx + 1}. Ensuite : ${next + 1}. ${this.steps[next].text}`;
  }

  /** Force one step to an explicit state (check or uncheck from the UI).
   *  markDone can only move a step forward; the task rail needs to toggle. */
  setDone(stepNumber: unknown, done: boolean): string {
    if (!this.exists) return 'Error: pas encore de plan. Créez-en un d\'abord avec {"action": "set", "steps": "..."}';
    const idx = typeof stepNumber === "number" && Number.isFinite(stepNumber) ? Math.floor(stepNumber) - 1 : -1;
    if (!Number.isSafeInteger(idx) || idx < 0 || idx >= this.steps.length) {
      return `Error: l'étape doit être un nombre entre 1 et ${this.steps.length}.`;
    }
    if (!!this.steps[idx].done === !!done) {
      return `L'étape ${idx + 1} est déjà ${done ? "terminée" : "ouverte"}.`;
    }
    const nextSteps = this.steps.map((step, i) => (i === idx ? { ...step, done: !!done } : step));
    const failure = this.persist(nextSteps);
    if (failure) return failure;
    this.steps = nextSteps;
    return `Étape ${idx + 1} ${done ? "terminée" : "rouverte"}.`;
  }

  add(text: string): string {
    if (typeof text !== "string" || !text.trim()) {
      return 'Error: le texte est requis. Exemple : {"action": "add", "text": "fix the collision bug"}';
    }
    if (this.steps.length >= 20) return "Error: le plan a déjà 20 étapes — en terminez certaines d'abord.";
    if (text.trim().length > 4000) return "Error: chaque étape du plan doit faire au plus 4 000 caractères.";
    const next = [...this.steps, { text: text.trim(), done: false }];
    const failure = this.persist(next);
    if (failure) return failure;
    this.steps = next;
    return `Étape ${this.steps.length} ajoutée : ${text.trim()}`;
  }

  checkpoint(text: string): string {
    const idx = this.currentIndex;
    if (idx < 0) return "Error: créez un plan avec une étape non terminée avant d'enregistrer un point de sauvegarde.";
    if (typeof text !== "string" || !text.trim() || text.length > 1000)
      return "Error: le texte du point de sauvegarde doit faire 1 à 1 000 caractères. Conservez les API exactes, l'erreur non résolue et la prochaine petite modification.";
    const next = this.steps.map((step, i) => (i === idx ? { ...step, note: text.trim() } : step));
    const failure = this.persist(next);
    if (failure) return failure;
    this.steps = next;
    return `Point de sauvegarde enregistré pour l'étape ${idx + 1} : ${text.trim()}`;
  }

  /** Compact model-facing checklist (used by action "show" and after compaction). */
  modelView(): string {
    if (!this.exists) return "Aucun plan défini.";
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

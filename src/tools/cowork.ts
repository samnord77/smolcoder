import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveInWorkspace } from "../sandbox";

export type WorkStatus = "open" | "completed" | "archived";
export type WorkPriority = "low" | "normal" | "high" | "urgent";
export type ExecutionStatus = "idle" | "running" | "verified" | "unverified" | "failed" | "cancelled";

export interface WorkSnapshot {
  file: string;
  timestamp: string;
  summary?: string;
}

export interface WorkItem {
  id: string;
  title: string;
  area: string;
  due: string | null;
  priority: WorkPriority;
  notes: string;
  status: WorkStatus;
  createdAt: string;
  updatedAt: string;
  assignedRole?: string;
  acceptanceCriteria?: string;
  executionStatus?: ExecutionStatus;
  lastReport?: string;
  snapshots?: WorkSnapshot[];
}

const MAX_FILE_BYTES = 512 * 1024;
const MAX_ITEMS = 1000;
// Concurrent agent workers can be CPU-starved while the model, LSP and test
// processes are active. Five seconds caused false "busy" failures even though
// the lock owner was healthy. Keep the wait bounded, but give a real
// cross-process write burst enough time to drain.
const LOCK_TIMEOUT_MS = 15_000;
const STALE_LOCK_AGE_MS = 60_000;
const PRIORITIES: WorkPriority[] = ["low", "normal", "high", "urgent"];
const STATUSES: WorkStatus[] = ["open", "completed", "archived"];
const EXECUTION_STATUSES: ExecutionStatus[] = ["idle", "running", "verified", "unverified", "failed", "cancelled"];

function boundedText(value: unknown, max: number, required = false): string | null {
  if (value === undefined && !required) return "";
  if (typeof value !== "string") return null;
  const text = value.trim();
  if ((required && !text) || text.length > max) return null;
  return text;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isItem(value: unknown): value is WorkItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WorkItem>;
  const baseValid =
    typeof item.id === "string" &&
    /^w_[a-f0-9-]{36}$/.test(item.id) &&
    typeof item.title === "string" &&
    typeof item.area === "string" &&
    (item.due === null || validDate(item.due)) &&
    PRIORITIES.includes(item.priority as WorkPriority) &&
    typeof item.notes === "string" &&
    STATUSES.includes(item.status as WorkStatus) &&
    typeof item.createdAt === "string" &&
    Number.isFinite(Date.parse(item.createdAt)) &&
    typeof item.updatedAt === "string" &&
    Number.isFinite(Date.parse(item.updatedAt));
  if (!baseValid) return false;
  if (item.assignedRole !== undefined && typeof item.assignedRole !== "string") return false;
  if (item.acceptanceCriteria !== undefined && typeof item.acceptanceCriteria !== "string") return false;
  if (item.executionStatus !== undefined && !EXECUTION_STATUSES.includes(item.executionStatus as ExecutionStatus)) return false;
  if (item.lastReport !== undefined && typeof item.lastReport !== "string") return false;
  if (item.snapshots !== undefined && !Array.isArray(item.snapshots)) return false;
  return true;
}

/** A small durable work/personal task board shared by CLI, web and desktop sessions. */
export class CoworkBoard {
  private readonly file: string;
  private readonly lockFile: string;

  constructor(readonly workspace: string) {
    this.file = resolveInWorkspace(workspace, ".smol/work-items.json");
    this.lockFile = `${this.file}.lock`;
  }

  async run(args: Record<string, unknown>): Promise<string> {
    try {
      if (args.action === "list") return this.list(this.load(), args);
      if (["create", "update", "archive", "assign", "record_report"].includes(String(args.action))) {
        return await this.withLock(() => {
          const items = this.load();
          switch (args.action) {
            case "create":
              return this.create(items, args);
            case "update":
              return this.update(items, args);
            case "archive":
              return this.changeStatus(items, args, "archived");
            case "assign":
              return this.assign(items, args);
            case "record_report":
              return this.recordReport(items, args);
            default:
              return 'Error: l\'action doit être "list", "create", "update", "complete", "archive", "assign" ou "record_report".';
          }
        });
      }
      return 'Error: l\'action doit être "list", "create", "update", "complete", "archive", "assign" ou "record_report".';
    } catch (error: any) {
      return `Error: ${error?.message ?? String(error)}`;
    }
  }

  async beginExecution(taskId: string): Promise<string> {
    return this.withLock(() => {
      const items = this.load();
      const item = items.find((row) => row.id === taskId && row.status === "open");
      if (!item) return "Error: élément de travail ouvert introuvable ; il n'a pas été démarré.";
      if (item.executionStatus === "running") return "Error: cet élément de travail est déjà en cours d'exécution.";
      item.executionStatus = "running";
      item.updatedAt = new Date().toISOString();
      this.save(items);
      return `Élément de travail ${item.id} démarré : ${item.title}`;
    });
  }

  async finishExecution(taskId: string, outcome: "verified" | "unverified" | "failed" | "cancelled", report: string): Promise<string> {
    return this.withLock(() => {
      const items = this.load();
      const item = items.find((row) => row.id === taskId);
      if (!item) return `Error: l'élément de travail ${taskId} n'existe plus.`;
      if (item.executionStatus !== "running") {
        return `Error: l'élément de travail ${taskId} n'est pas en cours ; son résultat d'exécution est resté inchangé.`;
      }
      item.executionStatus = outcome;
      item.lastReport = report.slice(0, 8000);
      if (outcome === "verified" && item.status === "open") item.status = "completed";
      item.updatedAt = new Date().toISOString();
      this.save(items);
      return `Élément de travail ${item.id} terminé : statut=${item.status}, exécution=${item.executionStatus}`;
    });
  }

  async completeWorkItem(taskId: string): Promise<string> {
    return this.withLock(() => {
      const items = this.load();
      const item = items.find((row) => row.id === taskId && row.status === "open");
      if (!item)
        return 'Error: élément de travail ouvert introuvable ; utilisez work {"action":"list"} pour voir les identifiants disponibles.';
      item.status = "completed";
      item.updatedAt = new Date().toISOString();
      this.save(items);
      return `Élément de travail ${item.id} terminé : ${item.title}`;
    });
  }

  items(): WorkItem[] {
    return this.load()
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 100)
      .map((item) => ({ ...item }));
  }

  private load(): WorkItem[] {
    if (!fs.existsSync(this.file)) return [];
    const stat = fs.statSync(this.file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
      throw new Error("la liste de travail n'est pas un petit fichier de données valide ; elle est restée inchangée.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      throw new Error("la liste de travail contient un JSON invalide ; elle est restée inchangée.");
    }
    if (!Array.isArray(parsed) || parsed.length > MAX_ITEMS || !parsed.every(isItem)) {
      throw new Error("la liste de travail a un format non pris en charge ; elle est restée inchangée.");
    }
    return parsed;
  }

  private save(items: WorkItem[]): void {
    const json = `${JSON.stringify(items, null, 2)}\n`;
    if (Buffer.byteLength(json, "utf8") > MAX_FILE_BYTES) throw new Error("la liste de travail a atteint sa limite de stockage.");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, json, { encoding: "utf8", flag: "wx" });
      fs.renameSync(temp, this.file);
    } finally {
      try {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      } catch {
        /* preserve the primary result */
      }
    }
  }

  private async withLock<T>(action: () => T): Promise<T> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const token = randomUUID();
    const startedAt = Date.now();
    let lockFd: number | undefined;
    while (lockFd === undefined) {
      try {
        lockFd = fs.openSync(this.lockFile, "wx");
        fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, token }), "utf8");
      } catch (error: any) {
        if (lockFd !== undefined) {
          fs.closeSync(lockFd);
          lockFd = undefined;
          try {
            fs.unlinkSync(this.lockFile);
          } catch {
            /* preserve the lock creation error */
          }
        }
        if (error?.code !== "EEXIST") throw error;
        this.removeStaleLock();
        if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
          throw new Error("la liste de travail est occupée par un autre processus Smolcoder ; réessayez dans un instant.");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return action();
    } finally {
      fs.closeSync(lockFd);
      try {
        const owner = JSON.parse(fs.readFileSync(this.lockFile, "utf8"));
        if (owner.token === token) fs.unlinkSync(this.lockFile);
      } catch {
        /* do not replace the operation result with lock cleanup errors */
      }
    }
  }

  private removeStaleLock(): void {
    try {
      const stat = fs.statSync(this.lockFile);
      let owner: { pid?: unknown } | undefined;
      try {
        owner = JSON.parse(fs.readFileSync(this.lockFile, "utf8"));
      } catch {
        if (Date.now() - stat.mtimeMs < STALE_LOCK_AGE_MS) return;
      }
      if (owner && typeof owner.pid === "number") {
        try {
          process.kill(owner.pid, 0);
          return;
        } catch (error: any) {
          if (error?.code !== "ESRCH") return;
        }
      } else if (Date.now() - stat.mtimeMs < STALE_LOCK_AGE_MS) {
        return;
      }
      const stalePath = `${this.lockFile}.${randomUUID()}.stale`;
      fs.renameSync(this.lockFile, stalePath);
      fs.unlinkSync(stalePath);
    } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "EEXIST") throw error;
    }
  }

  private list(items: WorkItem[], args: Record<string, unknown>): string {
    const status = args.status;
    const area = typeof args.area === "string" ? args.area.trim().toLowerCase() : "";
    if (status !== undefined && !STATUSES.includes(status as WorkStatus))
      return 'Error: le statut doit être "open", "completed" ou "archived".';
    const shown = items
      .filter((item) => (!status || item.status === status) && (!area || item.area.toLowerCase() === area))
      .sort((a, b) => (a.due ?? "9999-12-31").localeCompare(b.due ?? "9999-12-31") || b.createdAt.localeCompare(a.createdAt));
    if (!shown.length) return "Aucun élément de travail ne correspond à ces filtres.";
    return shown
      .slice(0, 100)
      .map((item) => {
        const due = item.due
          ? ` · échéance ${item.due}${item.status === "open" && item.due < new Date().toISOString().slice(0, 10) ? " · en retard" : ""}`
          : "";
        const role = item.assignedRole ? ` · @${item.assignedRole}` : "";
        const exec = item.executionStatus && item.executionStatus !== "idle" ? ` [${item.executionStatus}]` : "";
        const criteria = item.acceptanceCriteria ? `\n  Critères d'acceptation : ${item.acceptanceCriteria}` : "";
        const report = item.lastReport ? `\n  Rapport : ${item.lastReport.slice(0, 160)}${item.lastReport.length > 160 ? "…" : ""}` : "";
        return `${item.id} [${item.status}] [${item.priority}]${exec} ${item.title} · ${item.area}${role}${due}${item.notes ? `\n  ${item.notes}` : ""}${criteria}${report}`;
      })
      .join("\n");
  }

  private create(items: WorkItem[], args: Record<string, unknown>): string {
    if (items.length >= MAX_ITEMS) return "Error: la liste de travail a atteint sa limite de 1 000 éléments.";
    const title = boundedText(args.title, 200, true);
    const area = boundedText(args.area ?? "personal", 60, true);
    const notes = boundedText(args.notes ?? "", 2000);
    const priority = args.priority ?? "normal";
    if (!title) return "Error: le titre est requis et doit comporter au plus 200 caractères.";
    if (!area) return "Error: la zone est requise et doit comporter au plus 60 caractères.";
    if (notes === null) return "Error: les notes doivent comporter au plus 2 000 caractères.";
    if (!PRIORITIES.includes(priority as WorkPriority)) return 'Error: la priorité doit être "low", "normal", "high" ou "urgent".';
    if (args.due !== undefined && args.due !== "" && !validDate(args.due))
      return "Error: l'échéance doit être une date de calendrier réelle au format AAAA-MM-JJ.";
    const assignedRole = boundedText(args.role, 40) || undefined;
    const acceptanceCriteria = boundedText(args.acceptance, 1000) || undefined;
    const now = new Date().toISOString();
    const item: WorkItem = {
      id: `w_${randomUUID()}`,
      title,
      area,
      due: typeof args.due === "string" && args.due ? args.due : null,
      priority: priority as WorkPriority,
      notes,
      status: "open",
      createdAt: now,
      updatedAt: now,
      ...(assignedRole ? { assignedRole } : {}),
      ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
      executionStatus: "idle",
      snapshots: [],
    };
    this.save([...items, item]);
    const roleNotice = item.assignedRole ? ` · assigné à ${item.assignedRole}` : "";
    return `Élément de travail ${item.id} créé : ${item.title} [${item.priority}] · ${item.area}${item.due ? ` · échéance ${item.due}` : ""}${roleNotice}`;
  }

  private update(items: WorkItem[], args: Record<string, unknown>): string {
    const id = typeof args.task_id === "string" ? args.task_id.trim() : "";
    const index = items.findIndex((item) => item.id === id && item.status === "open");
    if (index < 0)
      return 'Error: élément de travail ouvert introuvable ; utilisez work {"action":"list"} pour voir les identifiants disponibles.';
    const item = { ...items[index] };
    if (args.title !== undefined) {
      const value = boundedText(args.title, 200, true);
      if (!value) return "Error: le titre doit comporter de 1 à 200 caractères.";
      item.title = value;
    }
    if (args.area !== undefined) {
      const value = boundedText(args.area, 60, true);
      if (!value) return "Error: la zone doit comporter de 1 à 60 caractères.";
      item.area = value;
    }
    if (args.notes !== undefined) {
      const value = boundedText(args.notes, 2000);
      if (value === null) return "Error: les notes doivent comporter au plus 2 000 caractères.";
      item.notes = value;
    }
    if (args.due !== undefined) {
      if (args.due !== "" && !validDate(args.due))
        return "Error: l'échéance doit être une date de calendrier réelle au format AAAA-MM-JJ, ou vide pour l'effacer.";
      item.due = typeof args.due === "string" && args.due ? args.due : null;
    }
    if (args.priority !== undefined) {
      if (!PRIORITIES.includes(args.priority as WorkPriority)) return 'Error: la priorité doit être "low", "normal", "high" ou "urgent".';
      item.priority = args.priority as WorkPriority;
    }
    if (args.role !== undefined) {
      const value = boundedText(args.role, 40);
      item.assignedRole = value || undefined;
    }
    if (args.acceptance !== undefined) {
      const value = boundedText(args.acceptance, 1000);
      item.acceptanceCriteria = value || undefined;
    }
    item.updatedAt = new Date().toISOString();
    items[index] = item;
    this.save(items);
    return `Élément de travail ${item.id} mis à jour : ${item.title}`;
  }

  private changeStatus(items: WorkItem[], args: Record<string, unknown>, status: "completed" | "archived"): string {
    const id = typeof args.task_id === "string" ? args.task_id.trim() : "";
    const item = items.find((row) => row.id === id && row.status === "open");
    if (!item)
      return 'Error: élément de travail ouvert introuvable ; utilisez work {"action":"list"} pour voir les identifiants disponibles.';
    item.status = status;
    item.updatedAt = new Date().toISOString();
    this.save(items);
    return `Élément de travail ${item.id} ${status} : ${item.title}`;
  }

  private assign(items: WorkItem[], args: Record<string, unknown>): string {
    const id = typeof args.task_id === "string" ? args.task_id.trim() : "";
    const index = items.findIndex((item) => item.id === id && item.status === "open");
    if (index < 0)
      return 'Error: élément de travail ouvert introuvable ; utilisez work {"action":"list"} pour voir les identifiants disponibles.';
    const item = { ...items[index] };
    const role = boundedText(args.role, 40);
    if (!role) return "Error: le rôle est requis et doit comporter au plus 40 caractères.";
    item.assignedRole = role;
    if (args.acceptance !== undefined) {
      const criteria = boundedText(args.acceptance, 1000);
      item.acceptanceCriteria = criteria || undefined;
    }
    item.executionStatus = "idle";
    item.updatedAt = new Date().toISOString();
    items[index] = item;
    this.save(items);
    return `Élément de travail ${item.id} assigné au rôle « ${item.assignedRole} » : ${item.title}`;
  }

  private recordReport(items: WorkItem[], args: Record<string, unknown>): string {
    const id = typeof args.task_id === "string" ? args.task_id.trim() : "";
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return 'Error: élément de travail introuvable ; utilisez work {"action":"list"} pour voir les identifiants disponibles.';
    if (args.execution_status !== undefined || args.mark_completed === true) {
      return "Error: le statut d'exécution et l'achèvement sont contrôlés par le runtime de session, pas par le modèle.";
    }
    const item = { ...items[index] };
    if (args.report !== undefined) {
      const report = boundedText(args.report, 8000);
      if (report === null) return "Error: le rapport doit comporter au plus 8 000 caractères.";
      item.lastReport = report;
    }
    if (args.snapshot && typeof args.snapshot === "object") {
      const s = args.snapshot as { file?: unknown; summary?: unknown };
      if (typeof s.file === "string" && s.file.trim()) {
        const list = Array.isArray(item.snapshots) ? [...item.snapshots] : [];
        list.push({
          file: s.file.trim(),
          timestamp: new Date().toISOString(),
          ...(typeof s.summary === "string" && s.summary ? { summary: s.summary.trim().slice(0, 200) } : {}),
        });
        item.snapshots = list.slice(-20);
      }
    }
    item.updatedAt = new Date().toISOString();
    items[index] = item;
    this.save(items);
    return `Rapport d'exécution enregistré pour l'élément de travail ${item.id} : statut=${item.status}, exécution=${item.executionStatus ?? "idle"}`;
  }
}

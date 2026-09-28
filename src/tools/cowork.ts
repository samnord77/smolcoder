import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveInWorkspace } from "../sandbox";

export type WorkStatus = "open" | "completed" | "archived";
export type WorkPriority = "low" | "normal" | "high" | "urgent";

interface WorkItem {
  id: string;
  title: string;
  area: string;
  due: string | null;
  priority: WorkPriority;
  notes: string;
  status: WorkStatus;
  createdAt: string;
  updatedAt: string;
}

const MAX_FILE_BYTES = 512 * 1024;
const MAX_ITEMS = 1000;
const PRIORITIES: WorkPriority[] = ["low", "normal", "high", "urgent"];
const STATUSES: WorkStatus[] = ["open", "completed", "archived"];

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
  return (
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
    Number.isFinite(Date.parse(item.updatedAt))
  );
}

/** A small durable work/personal task board shared by CLI, web and desktop sessions. */
export class CoworkBoard {
  private readonly file: string;

  constructor(readonly workspace: string) {
    this.file = resolveInWorkspace(workspace, ".smol/work-items.json");
  }

  run(args: Record<string, unknown>): string {
    try {
      const items = this.load();
      switch (args.action) {
        case "list":
          return this.list(items, args);
        case "create":
          return this.create(items, args);
        case "update":
          return this.update(items, args);
        case "complete":
          return this.changeStatus(items, args, "completed");
        case "archive":
          return this.changeStatus(items, args, "archived");
        default:
          return 'Error: action must be "list", "create", "update", "complete" or "archive".';
      }
    } catch (error: any) {
      return `Error: ${error?.message ?? String(error)}`;
    }
  }

  private load(): WorkItem[] {
    if (!fs.existsSync(this.file)) return [];
    const stat = fs.statSync(this.file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
      throw new Error("the work list is not a valid small data file; it was left unchanged.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      throw new Error("the work list contains invalid JSON; it was left unchanged.");
    }
    if (!Array.isArray(parsed) || parsed.length > MAX_ITEMS || !parsed.every(isItem)) {
      throw new Error("the work list has an unsupported format; it was left unchanged.");
    }
    return parsed;
  }

  private save(items: WorkItem[]): void {
    const json = `${JSON.stringify(items, null, 2)}\n`;
    if (Buffer.byteLength(json, "utf8") > MAX_FILE_BYTES) throw new Error("the work list reached its storage limit.");
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

  private list(items: WorkItem[], args: Record<string, unknown>): string {
    const status = args.status;
    const area = typeof args.area === "string" ? args.area.trim().toLowerCase() : "";
    if (status !== undefined && !STATUSES.includes(status as WorkStatus)) return 'Error: status must be "open", "completed" or "archived".';
    const shown = items
      .filter((item) => (!status || item.status === status) && (!area || item.area.toLowerCase() === area))
      .sort((a, b) => (a.due ?? "9999-12-31").localeCompare(b.due ?? "9999-12-31") || b.createdAt.localeCompare(a.createdAt));
    if (!shown.length) return "No work items match those filters.";
    return shown
      .slice(0, 100)
      .map((item) => {
        const due = item.due
          ? ` · due ${item.due}${item.status === "open" && item.due < new Date().toISOString().slice(0, 10) ? " · overdue" : ""}`
          : "";
        return `${item.id} [${item.status}] [${item.priority}] ${item.title} · ${item.area}${due}${item.notes ? `\n  ${item.notes}` : ""}`;
      })
      .join("\n");
  }

  private create(items: WorkItem[], args: Record<string, unknown>): string {
    if (items.length >= MAX_ITEMS) return "Error: the work list has reached its 1,000-item limit.";
    const title = boundedText(args.title, 200, true);
    const area = boundedText(args.area ?? "personal", 60, true);
    const notes = boundedText(args.notes ?? "", 2000);
    const priority = args.priority ?? "normal";
    if (!title) return "Error: title is required and must be at most 200 characters.";
    if (!area) return "Error: area is required and must be at most 60 characters.";
    if (notes === null) return "Error: notes must be at most 2,000 characters.";
    if (!PRIORITIES.includes(priority as WorkPriority)) return 'Error: priority must be "low", "normal", "high" or "urgent".';
    if (args.due !== undefined && args.due !== "" && !validDate(args.due))
      return "Error: due must be a real calendar date in YYYY-MM-DD format.";
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
    };
    this.save([...items, item]);
    return `Created work item ${item.id}: ${item.title} [${item.priority}] · ${item.area}${item.due ? ` · due ${item.due}` : ""}`;
  }

  private update(items: WorkItem[], args: Record<string, unknown>): string {
    const id = typeof args.task_id === "string" ? args.task_id.trim() : "";
    const index = items.findIndex((item) => item.id === id && item.status === "open");
    if (index < 0) return 'Error: open work item not found; use work {"action":"list"} to see available IDs.';
    const item = { ...items[index] };
    if (args.title !== undefined) {
      const value = boundedText(args.title, 200, true);
      if (!value) return "Error: title must be 1–200 characters.";
      item.title = value;
    }
    if (args.area !== undefined) {
      const value = boundedText(args.area, 60, true);
      if (!value) return "Error: area must be 1–60 characters.";
      item.area = value;
    }
    if (args.notes !== undefined) {
      const value = boundedText(args.notes, 2000);
      if (value === null) return "Error: notes must be at most 2,000 characters.";
      item.notes = value;
    }
    if (args.due !== undefined) {
      if (args.due !== "" && !validDate(args.due))
        return "Error: due must be a real calendar date in YYYY-MM-DD format, or empty to clear it.";
      item.due = typeof args.due === "string" && args.due ? args.due : null;
    }
    if (args.priority !== undefined) {
      if (!PRIORITIES.includes(args.priority as WorkPriority)) return 'Error: priority must be "low", "normal", "high" or "urgent".';
      item.priority = args.priority as WorkPriority;
    }
    item.updatedAt = new Date().toISOString();
    items[index] = item;
    this.save(items);
    return `Updated work item ${item.id}: ${item.title}`;
  }

  private changeStatus(items: WorkItem[], args: Record<string, unknown>, status: "completed" | "archived"): string {
    const id = typeof args.task_id === "string" ? args.task_id.trim() : "";
    const item = items.find((row) => row.id === id && row.status === "open");
    if (!item) return 'Error: open work item not found; use work {"action":"list"} to see available IDs.';
    item.status = status;
    item.updatedAt = new Date().toISOString();
    this.save(items);
    return `Work item ${item.id} ${status}: ${item.title}`;
  }
}

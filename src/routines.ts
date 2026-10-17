import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveInWorkspace } from "./sandbox";

export const ROUTINE_MAX_ITEMS = 50;
export const ROUTINE_PROMPT_MAX = 2000;
const MAX_FILE_BYTES = 256 * 1024;
const LOCK_TIMEOUT_MS = 30_000;
const STALE_LOCK_AGE_MS = 60_000;
const EVERY_MIN_MAX = 24 * 60;
const EVERY_HOUR_MAX = 24 * 7;
const CADENCE_RE = /^(every \d+[mh]|hourly|daily \d{2}:\d{2}|weekdays \d{2}:\d{2}|weekly (sun|mon|tue|wed|thu|fri|sat) \d{2}:\d{2})$/;

export interface Routine {
  id: string;
  prompt: string;
  /** Canonical cadence: "every 30m" · "every 2h" · "hourly" · "daily 09:00" ·
   *  "weekdays 08:30" · "weekly mon 10:00". */
  cadence: string;
  enabled: boolean;
  /** Epoch ms of the next planned run. */
  next: number;
  lastRun?: number;
  lastStatus?: string;
  createdAt: number;
}

const DAY_NUMBERS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  dimanche: 0,
  monday: 1,
  mon: 1,
  lundi: 1,
  tuesday: 2,
  tue: 2,
  mardi: 2,
  wednesday: 3,
  wed: 3,
  mercredi: 3,
  thursday: 4,
  thu: 4,
  jeudi: 4,
  friday: 5,
  fri: 5,
  vendredi: 5,
  saturday: 6,
  sat: 6,
  samedi: 6,
};

const DOW_CANON: Record<number, string> = { 0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat" };
const DOW_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function parseHM(h: string, m: string): string | null {
  const hh = Number(h);
  const mm = Number(m);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh > 23 || mm > 59) return null;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** Accepts English and French cadences and returns the canonical form, or null.
 *  Examples: "every 30m", "toutes les 2 heures", "every day at 09:00",
 *  "weekdays at 08:30", "chaque lundi à 10:00", "tous les mardis". */
export function parseCadence(text: string): string | null {
  const t = stripAccents(String(text ?? ""))
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!t) return null;
  let m = t.match(/^(?:every|toutes? les?|tous les) (\d+) ?(m|min|mins|minute|minutes)$/);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 && n <= EVERY_MIN_MAX ? `every ${n}m` : null;
  }
  m = t.match(/^(?:every|toutes? les?|tous les) (\d+) ?(h|hr|hrs|hour|hours|heure|heures)$/);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 && n <= EVERY_HOUR_MAX ? `every ${n}h` : null;
  }
  if (/^(?:hourly|chaque heure|toutes les heures)$/.test(t)) return "hourly";
  m = t.match(/^(?:daily|every day|tous les jours|chaque jour)(?: (?:(?:at|a) )?(\d{1,2}):(\d{2}))?$/);
  if (m) {
    const hm = m[1] ? parseHM(m[1], m[2]) : "09:00";
    return hm ? `daily ${hm}` : null;
  }
  m = t.match(/^(?:weekdays?|en semaine|jours ouvres?|jours ouvrables?)(?: (?:(?:at|a) )?(\d{1,2}):(\d{2}))?$/);
  if (m) {
    const hm = m[1] ? parseHM(m[1], m[2]) : "09:00";
    return hm ? `weekdays ${hm}` : null;
  }
  const dayMatch = t.match(/^(.*?)(?: (?:(?:at|a) )?(\d{1,2}):(\d{2}))?$/);
  if (dayMatch) {
    const hm = dayMatch[2] ? parseHM(dayMatch[2], dayMatch[3]) : "09:00";
    if (!hm) return null;
    const head = dayMatch[1]
      .replace(/^(?:weekly on |weekly |every |chaque |tous les |le )/, "")
      .replace(/s$/, "")
      .trim();
    const dow = DAY_NUMBERS[head];
    if (dow !== undefined) return `weekly ${DOW_CANON[dow]} ${hm}`;
  }
  return null;
}

/** A short French description of a canonical cadence. */
export function describeCadence(cadence: string): string {
  if (cadence.startsWith("every ")) {
    const value = cadence.slice(6);
    const n = value.slice(0, -1);
    return value.slice(-1) === "m" ? `toutes les ${n} min` : `toutes les ${n} h`;
  }
  if (cadence === "hourly") return "chaque heure";
  const m = cadence.match(/^(daily|weekdays|weekly (sun|mon|tue|wed|thu|fri|sat)) (\d{2}:\d{2})$/);
  if (!m) return cadence;
  if (m[1] === "daily") return `chaque jour à ${m[3]}`;
  if (m[1] === "weekdays") return `en semaine à ${m[3]}`;
  const dow = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(m[2]);
  return `chaque ${DOW_FR[dow]} à ${m[3]}`;
}

/** Next run strictly after fromMs, in the machine's local timezone. */
export function computeNext(cadence: string, fromMs: number): number {
  if (cadence.startsWith("every ")) {
    const value = cadence.slice(6);
    const n = Number(value.slice(0, -1));
    const step = value.slice(-1) === "m" ? n * 60_000 : n * 3_600_000;
    return fromMs + step;
  }
  if (cadence === "hourly") {
    const d = new Date(fromMs);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1, 0, 0, 0).getTime();
  }
  const m = cadence.match(/^(daily|weekdays|weekly (sun|mon|tue|wed|thu|fri|sat)) (\d{2}:\d{2})$/);
  if (!m) return fromMs + 3_600_000;
  const hh = Number(m[3].slice(0, 2));
  const mm = Number(m[3].slice(3));
  const days =
    m[1] === "weekdays"
      ? [1, 2, 3, 4, 5]
      : m[1] === "daily"
        ? [0, 1, 2, 3, 4, 5, 6]
        : [["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(m[2])];
  const start = new Date(fromMs);
  for (let i = 0; i < 8; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, hh, mm, 0, 0);
    if (day.getTime() <= fromMs) continue;
    if (days.includes(day.getDay())) return day.getTime();
  }
  return fromMs + 3_600_000;
}

function isRoutine(value: unknown): value is Routine {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<Routine>;
  return (
    typeof r.id === "string" &&
    /^r_[a-f0-9-]{36}$/.test(r.id) &&
    typeof r.prompt === "string" &&
    r.prompt.length > 0 &&
    r.prompt.length <= ROUTINE_PROMPT_MAX &&
    typeof r.cadence === "string" &&
    CADENCE_RE.test(r.cadence) &&
    typeof r.enabled === "boolean" &&
    typeof r.next === "number" &&
    Number.isFinite(r.next) &&
    (r.lastRun === undefined || (typeof r.lastRun === "number" && Number.isFinite(r.lastRun))) &&
    (r.lastStatus === undefined || typeof r.lastStatus === "string") &&
    typeof r.createdAt === "number" &&
    Number.isFinite(r.createdAt)
  );
}

/** Durable per-project scheduled tasks. One runner wins each due routine
 *  through a cross-process claim under a lock file, so two open windows of the
 *  same project never run the same routine twice. */
export class RoutineBook {
  private readonly file: string;
  private readonly lockFile: string;

  constructor(readonly workspace: string) {
    this.file = resolveInWorkspace(workspace, ".smol/routines.json");
    this.lockFile = `${this.file}.lock`;
  }

  /** Routines ordered by next planned run (the order /routine numbers use). */
  listSorted(): Routine[] {
    return this.load()
      .slice()
      .sort((a, b) => a.next - b.next)
      .map((r) => ({ ...r }));
  }

  /** A routine by 1-based list number, id, or unique id prefix. */
  resolve(ref: string): Routine | null {
    const items = this.listSorted();
    const n = Number(String(ref).trim());
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1];
    const text = String(ref).trim();
    if (!text) return null;
    return items.find((r) => r.id === text) ?? items.find((r) => r.id.startsWith(text)) ?? null;
  }

  async add(cadenceText: string, prompt: string, now = Date.now()): Promise<{ ok: true; routine: Routine } | { ok: false; error: string }> {
    const cadence = parseCadence(cadenceText);
    if (!cadence) {
      return {
        ok: false,
        error:
          "cadence non reconnue — exemples : « every 30m », « every 2h », « hourly », « every day at 09:00 », « weekdays at 08:30 », « every monday at 10:00 ».",
      };
    }
    const text = String(prompt ?? "").trim();
    if (!text) return { ok: false, error: "la consigne est vide." };
    if (text.length > ROUTINE_PROMPT_MAX) return { ok: false, error: `la consigne dépasse ${ROUTINE_PROMPT_MAX} caractères.` };
    try {
      return await this.withLock(() => {
        const items = this.load();
        if (items.length >= ROUTINE_MAX_ITEMS)
          return { ok: false as const, error: `la limite de ${ROUTINE_MAX_ITEMS} routines est atteinte.` };
        const routine: Routine = {
          id: `r_${randomUUID()}`,
          prompt: text,
          cadence,
          enabled: true,
          next: computeNext(cadence, now),
          createdAt: now,
        };
        this.save([...items, routine]);
        return { ok: true as const, routine: { ...routine } };
      });
    } catch (error: any) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async remove(ref: string): Promise<string> {
    try {
      return await this.withLock(() => {
        const items = this.load();
        const target = toRoutine(resolveIn(items, ref));
        if (!target) return `Error: routine « ${ref} » inconnue — /routine liste les routines avec leur numéro.`;
        this.save(items.filter((r) => r.id !== target.id));
        return `Routine supprimée : ${describeCadence(target.cadence)} — « ${target.prompt.slice(0, 60)} »`;
      });
    } catch (error: any) {
      return `Error: ${String(error?.message ?? error)}`;
    }
  }

  async setEnabled(ref: string, enabled: boolean): Promise<string> {
    try {
      return await this.withLock(() => {
        const items = this.load();
        const target = resolveIn(items, ref);
        if (!target) return `Error: routine « ${ref} » inconnue — /routine liste les routines avec leur numéro.`;
        target.enabled = enabled;
        // Reactivating an overdue routine must not fire instantly: move its
        // next run to the first occurrence strictly after now.
        if (enabled && target.next <= Date.now()) target.next = computeNext(target.cadence, Date.now());
        this.save(items);
        return `Routine ${enabled ? "réactivée" : "mise en pause"} : ${describeCadence(target.cadence)} — « ${target.prompt.slice(0, 60)} »`;
      });
    } catch (error: any) {
      return `Error: ${String(error?.message ?? error)}`;
    }
  }

  /** Atomically takes the first due routine: advances its next run before the
   *  caller executes it, so a crash or a parallel window can never run it
   *  twice for the same occurrence. Returns null when nothing is due. */
  async claimDue(now = Date.now()): Promise<Routine | null> {
    return this.withLock(() => {
      const items = this.load();
      const due = items.filter((r) => r.enabled && r.next <= now).sort((a, b) => a.next - b.next)[0];
      if (!due) return null;
      due.lastRun = now;
      due.next = computeNext(due.cadence, Math.max(now, due.next));
      this.save(items);
      return { ...due };
    });
  }

  async markResult(id: string, status: string): Promise<void> {
    await this.withLock(() => {
      const items = this.load();
      const target = items.find((r) => r.id === id);
      if (!target) return;
      target.lastStatus = status.slice(0, 80);
      this.save(items);
    });
  }

  private load(): Routine[] {
    if (!fs.existsSync(this.file)) return [];
    const stat = fs.statSync(this.file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
      throw new Error("le fichier des routines n'est pas un petit fichier de données valide ; il est resté inchangé.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      throw new Error("le fichier des routines contient un JSON invalide ; il est resté inchangé.");
    }
    if (!Array.isArray(parsed) || parsed.length > ROUTINE_MAX_ITEMS || !parsed.every(isRoutine)) {
      throw new Error("le fichier des routines a un format non pris en charge ; il est resté inchangé.");
    }
    return parsed;
  }

  private save(items: Routine[]): void {
    const json = `${JSON.stringify(items, null, 2)}\n`;
    if (Buffer.byteLength(json, "utf8") > MAX_FILE_BYTES) throw new Error("les routines ont atteint leur limite de stockage.");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, json, { encoding: "utf8", flag: "wx" });
      // Windows can throw transient EPERM/EBUSY/EACCES while a scanner or a
      // concurrent reader still holds the file we just wrote: retry briefly
      // instead of failing a routine save the user never asked us to lose.
      const startedAt = Date.now();
      for (;;) {
        try {
          fs.renameSync(temp, this.file);
          break;
        } catch (error: any) {
          const code = error?.code;
          const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
          if (!transient || Date.now() - startedAt >= 1000) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
      }
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
    // Windows can throw transient EPERM/EBUSY/EACCES while another process
    // creates or deletes the same .lock: retry a few times without hiding a
    // real permissions error.
    let transientRetries = 0;
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
        const code = error?.code;
        if (code !== "EEXIST") {
          const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
          if (!transient || transientRetries >= 40) throw error;
          transientRetries += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          continue;
        }
        this.removeStaleLock();
        if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
          throw new Error("les routines sont occupées par un autre processus Smolcoder ; réessayez dans un instant.");
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
    } catch {
      /* a lock that vanished under us is already gone */
    }
  }
}

/** Resolve a ref against an in-memory list (same rules as RoutineBook.resolve). */
function resolveIn(items: Routine[], ref: string): Routine | undefined {
  const sorted = items.slice().sort((a, b) => a.next - b.next);
  const n = Number(String(ref).trim());
  if (Number.isInteger(n) && n >= 1 && n <= sorted.length) return sorted[n - 1];
  const text = String(ref).trim();
  if (!text) return undefined;
  return sorted.find((r) => r.id === text) ?? sorted.find((r) => r.id.startsWith(text));
}

function toRoutine(value: Routine | undefined): Routine | undefined {
  return value ? { ...value } : undefined;
}

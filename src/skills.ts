// Skills: small reusable know-how files the model saves and reuses.
// Stored as markdown under <workspace>/.smol/skills/<name>.md, so they
// survive sessions (auto-evolution) and travel with the project. Names are
// strict so a model cannot escape the folder with `../../`.
import * as fs from "node:fs";
import * as path from "node:path";
import { BUILTIN_SKILLS } from "./builtin-skills";
import { isHistoryPlaceholder } from "./history";
import { resolveInWorkspace, SandboxError } from "./sandbox";

const SKILLS_DIR = ".smol/skills";
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const READ_CAP = 4000;
const SAVE_CAP = 8000;

function assertName(name: unknown): string {
  if (typeof name !== "string" || !NAME_RE.test(name.trim())) {
    throw new SandboxError('skill name must be 1-40 letters, numbers, "-" or "_" (example: "login-debug").');
  }
  return name.trim();
}

export function skillMeta(content: string): { name?: string; description?: string } {
  try {
    if (typeof content !== "string") return {};
    let src = String(content);
    if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
    const trimmed = src.trimStart();
    if (!trimmed.startsWith("---")) return {};
    const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(trimmed);
    if (!m) return {};
    const out: { name?: string; description?: string } = {};
    for (const line of m[1].split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const idx = t.indexOf(":");
      if (idx <= 0) continue;
      const key = t.slice(0, idx).trim().toLowerCase();
      if (key !== "name" && key !== "description") continue;
      let val = t.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2) || (val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
        val = val.slice(1, -1);
      }
      val = val.trim();
      if (!val) continue;
      if (key === "name") out.name = val;
      else out.description = val;
    }
    return out;
  } catch {
    return {};
  }
}

export function listSkills(root: string): string {
  let names: string[] = [];
  try {
    const dir = resolveInWorkspace(root, SKILLS_DIR);
    try {
      names = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.slice(0, -3));
    } catch {
      names = [];
    }
  } catch {
    names = [];
  }
  const valid = names
    .filter((n) => NAME_RE.test(n))
    .sort()
    .slice(0, 50);
  const builtins = Object.keys(BUILTIN_SKILLS).filter((n) => !valid.includes(n));
  const all = [...valid, ...builtins.map((n) => `${n} (built-in)`)];
  if (!all.length) return "No skills saved yet.";
  return `Skills (${all.length}): ${all.join(", ")}`;
}

export function readSkill(root: string, name: unknown): string {
  const clean = assertName(name);
  try {
    const abs = resolveInWorkspace(root, `${SKILLS_DIR}/${clean}.md`);
    if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) {
      const text = fs.readFileSync(abs, "utf8");
      const base = text.length > READ_CAP ? `${text.slice(0, READ_CAP)}\n[skill truncated — keep skills short]` : text;
      try {
        const meta = skillMeta(text);
        if (meta.name && meta.name !== clean) {
          return `${base}\n[skill warning: frontmatter name "${meta.name}" does not match file name "${clean}"]`;
        }
      } catch {
        /* soft validation never crashes */
      }
      return base;
    }
  } catch {
    /* fall through to built-ins */
  }
  const builtin = BUILTIN_SKILLS[clean];
  if (builtin) return builtin.length > READ_CAP ? `${builtin.slice(0, READ_CAP)}\n[skill truncated]` : builtin;
  return `Error: no skill named "${clean}". Use skill {"action": "list"} to see saved skills.`;
}

export function saveSkill(root: string, name: unknown, content: unknown): string {
  const clean = assertName(name);
  if (typeof content !== "string" || !content.trim()) {
    return 'Error: content is required. Example: {"action": "save", "name": "login-debug", "content": "# steps\\n1. ..."}';
  }
  if (content.length > SAVE_CAP) {
    return `Error: keep the skill under ${SAVE_CAP} characters (${content.length} given). Short checklists survive compaction best.`;
  }
  if (isHistoryPlaceholder(content)) {
    return "Error: this is a history placeholder, not a skill. Write the actual checklist.";
  }
  const abs = resolveInWorkspace(root, `${SKILLS_DIR}/${clean}.md`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${content.trim()}\n`, "utf8");
  return `Saved skill "${clean}" (${content.trim().split("\n").length} lines). It will be listed by skill {"action": "list"}.`;
}

// ---------------------------------------------------------------------------
// Auto-evolution: the harness loads matching skills without being asked and
// files away hard-won repair lessons on its own. Everything is deterministic
// (keyword overlap, counters, capped files) — no extra model calls.
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set(
  "with,from,that,this,have,will,your,into,over,under,about,after,before,when,where,which,while,what,than,also,just,like,make,made,does,doing,file,files,code,task,work,need,needs,using,use,used,error,errors,avec,pour,dans,une,des,les,aux,son,ses,est,sont,faire,fait,besoin,besoins,fichier,fichiers,code,tâche,taches,travail,utiliser,utilise,erreur,erreurs".split(
    ","
  )
);

function keywords(s: string): Set<string> {
  const out = new Set<string>();
  const normalized = s
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/\b(mise en page|interface|interfaces|ui|ux|visuel|visuelle|visuels|design|conception)\b/gu, " design ")
    .replace(/\b(espacement|espacements|marges|marge|alignement|alignements)\b/gu, " spacing ")
    .replace(/\b(animation|animations|transition|transitions)\b/gu, " motion ");
  for (const w of normalized.match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) ?? []) {
    if (!STOP_WORDS.has(w)) out.add(w);
  }
  return out;
}

function allSkillTexts(root: string): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  try {
    const dir = resolveInWorkspace(root, SKILLS_DIR);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const name = f.slice(0, -3);
      if (!NAME_RE.test(name)) continue;
      try {
        const abs = path.join(dir, f);
        if (fs.statSync(abs).isDirectory()) continue;
        out.push({ name, text: fs.readFileSync(abs, "utf8").slice(0, READ_CAP) });
      } catch {
        /* skip one bad file */
      }
    }
  } catch {
    /* no workspace skills yet */
  }
  for (const [name, text] of Object.entries(BUILTIN_SKILLS)) {
    if (!out.some((s) => s.name === name)) out.push({ name, text });
  }
  return out;
}

/** One skill as the control centre shows it. */
export interface SkillInfo {
  name: string;
  /** Shipped with smolcoder (read-only, not a file in the workspace). */
  builtin: boolean;
  /** Files an auto-repair lesson wrote (`auto-…`). */
  auto: boolean;
  description: string;
  bytes: number;
  updatedAt: number;
}

/** Every skill a session can use, workspace files first then built-ins.
 * Never throws: the control centre must render in an empty workspace. */
export function describeSkills(root: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  try {
    const dir = resolveInWorkspace(root, SKILLS_DIR);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const name = f.slice(0, -3);
      if (!NAME_RE.test(name)) continue;
      try {
        const abs = path.join(dir, f);
        const st = fs.statSync(abs);
        if (!st.isFile()) continue;
        const text = fs.readFileSync(abs, "utf8");
        out.push({
          name,
          builtin: false,
          auto: name.startsWith("auto-"),
          description: skillMeta(text).description ?? "",
          bytes: st.size,
          updatedAt: st.mtimeMs,
        });
      } catch {
        /* skip one unreadable file */
      }
    }
  } catch {
    /* no workspace skills yet */
  }
  for (const [name, text] of Object.entries(BUILTIN_SKILLS)) {
    if (out.some((s) => s.name === name)) continue;
    out.push({ name, builtin: true, auto: false, description: skillMeta(text).description ?? "", bytes: text.length, updatedAt: 0 });
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.name.localeCompare(b.name));
  return out.slice(0, 200);
}

/** Skills whose name or declared description overlaps the request, best match first.
 * Shared by the text loader and the live status view. */
function matchingSkills(root: string, request: string): { name: string; score: number; excerpt: string }[] {
  const req = keywords(String(request ?? ""));
  if (!req.size) return [];
  const hits: { name: string; score: number; excerpt: string }[] = [];
  for (const s of allSkillTexts(root)) {
    const nameWords = keywords(s.name.replace(/[-_]/g, " "));
    const description = skillMeta(s.text).description;
    const summary = description ?? s.text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").slice(0, 500);
    const summaryWords = keywords(summary);
    const nameMatches = [...req].filter((word) => nameWords.has(word)).length;
    const summaryMatches = [...req].filter((word) => summaryWords.has(word)).length;
    const score = nameMatches * 2 + summaryMatches;
    if (nameMatches > 0 || summaryMatches >= 2) {
      hits.push({ name: s.name, score, excerpt: s.text.slice(0, 600) });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/** Relevant skills are selected from their name/description, not generic
 * vocabulary buried in the full instructions. Capped to protect small contexts. */
export function relevantSkills(root: string, request: string, maxChars = 1200): string {
  try {
    let out = "";
    for (const h of matchingSkills(root, request).slice(0, 2)) {
      const block = `### skill ${h.name}\n${h.excerpt}\n`;
      if ((out + block).length > maxChars) break;
      out += block;
    }
    return out;
  } catch {
    return "";
  }
}

/** Names of the skills that just rode into a turn (for the status view). */
export function relevantSkillNames(root: string, request: string, limit = 2): string[] {
  try {
    return matchingSkills(root, request)
      .slice(0, Math.max(0, limit))
      .map((h) => h.name);
  } catch {
    return [];
  }
}

const MAX_AUTO_LESSONS = 20;

/** File away a hard-won repair as a reusable lesson. Returns the skill name,
 * or null when there is nothing worth keeping. Never throws. */
export function saveAutoRepairLesson(
  root: string,
  lesson: { command: string; attempts: number; failure: string; files: string[]; commands: string[] }
): string | null {
  try {
    if (!lesson.command?.trim() || lesson.attempts < 2) return null;
    const name = `auto-${Date.now().toString(36)}`;
    const body =
      `# auto repair lesson (saved automatically after ${lesson.attempts} acceptance attempts)\n` +
      `Command: ${lesson.command.slice(0, 300)}\n` +
      `Failure pattern: ${lesson.failure.slice(0, 400)}\n` +
      (lesson.files.length ? `Files: ${lesson.files.slice(-10).join(", ").slice(0, 400)}\n` : "") +
      (lesson.commands.length
        ? `Recent commands: ${lesson.commands
            .slice(-4)
            .map((s) => s.replace(/\s+/g, " ").slice(0, 180))
            .join(" ; ")
            .slice(0, 600)}\n`
        : "") +
      `Reuse: when the same failure pattern appears, apply the same fix shape first.\n`;
    const abs = resolveInWorkspace(root, `${SKILLS_DIR}/${name}.md`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf8");
    pruneAutoLessons(root);
    return name;
  } catch {
    return null;
  }
}

function pruneAutoLessons(root: string): void {
  try {
    const dir = resolveInWorkspace(root, SKILLS_DIR);
    const autos = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("auto-") && f.endsWith(".md"))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    for (const old of autos.slice(0, Math.max(0, autos.length - MAX_AUTO_LESSONS))) {
      try {
        fs.unlinkSync(path.join(dir, old.f));
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* best effort */
  }
}

export function readDelegateStats(root: string): { runs: number; toolCalls: number; lastAt: number } {
  try {
    const abs = resolveInWorkspace(root, ".smol/delegate-stats.json");
    const raw = JSON.parse(fs.readFileSync(abs, "utf8"));
    return {
      runs: Number(raw?.runs) || 0,
      toolCalls: Number(raw?.toolCalls) || 0,
      lastAt: Number(raw?.lastAt) || 0,
    };
  } catch {
    return { runs: 0, toolCalls: 0, lastAt: 0 };
  }
}

/** Running counters for delegated sub-agent turns. Never throws. */
export function recordDelegateStats(root: string, toolCalls: number): void {
  try {
    const abs = resolveInWorkspace(root, ".smol/delegate-stats.json");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    let cur = { runs: 0, toolCalls: 0, lastAt: 0 };
    try {
      const raw = JSON.parse(fs.readFileSync(abs, "utf8"));
      if (raw && typeof raw === "object") {
        cur = {
          runs: Number(raw.runs) || 0,
          toolCalls: Number(raw.toolCalls) || 0,
          lastAt: Number(raw.lastAt) || 0,
        };
      }
    } catch {
      /* start fresh */
    }
    cur.runs++;
    cur.toolCalls += Math.max(0, toolCalls);
    cur.lastAt = Date.now();
    fs.writeFileSync(abs, JSON.stringify(cur), "utf8");
  } catch {
    /* stats must never break a turn */
  }
}

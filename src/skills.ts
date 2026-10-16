// Skills: small reusable know-how files the model saves and reuses.
// Stored as markdown under <workspace>/.smol/skills/<name>.md, so they
// survive sessions (auto-evolution) and travel with the project. Names are
// strict so a model cannot escape the folder with `../../`.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BUILTIN_SKILLS } from "./builtin-skills";
import { isHistoryPlaceholder } from "./history";
import { resolveInWorkspace, SandboxError } from "./sandbox";

const SKILLS_DIR = ".smol/skills";
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const READ_CAP = 4000;
const SAVE_CAP = 8000;

// ---------------------------------------------------------------------------
// Machine skills: read-only skill folders shared by the whole PC (the Codex /
// ECC installs, including skills shipped by packages such as REA). Each root
// holds one folder per skill with a SKILL.md inside. SMOLCODER_SKILL_DIRS
// (path-separator separated) overrides the lookup, which keeps tests hermetic.
// ---------------------------------------------------------------------------

const MACHINE_SKILL_DIRS_ENV = "SMOLCODER_SKILL_DIRS";
const MACHINE_CACHE_TTL_MS = 60_000;

function machineSkillRoots(): string[] {
  const raw = process.env[MACHINE_SKILL_DIRS_ENV];
  if (typeof raw === "string") {
    return raw
      .split(path.delimiter)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const home = os.homedir();
  const out: string[] = [];
  for (const dir of [path.join(home, ".agents", "skills"), path.join(home, ".codex", "skills")]) {
    try {
      if (fs.statSync(dir).isDirectory()) out.push(dir);
    } catch {
      /* folder absent: ignore */
    }
  }
  return out;
}

interface MachineSkill {
  name: string;
  file: string;
  text: string;
}

let machineCache: { key: string; at: number; items: MachineSkill[] } | null = null;

/** Every machine skill, capped and cached briefly (a turn must stay fast even
 * with hundreds of installed skills). Workspace files always win, so a local
 * skill with the same name shadows the machine one. */
function machineSkills(): MachineSkill[] {
  const roots = machineSkillRoots();
  if (!roots.length) return [];
  const key = roots.join("|");
  if (
    !process.env[MACHINE_SKILL_DIRS_ENV] &&
    machineCache &&
    machineCache.key === key &&
    Date.now() - machineCache.at < MACHINE_CACHE_TTL_MS
  ) {
    return machineCache.items;
  }
  const items: MachineSkill[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (items.length >= 400) break;
      if (!NAME_RE.test(entry)) continue;
      const file = path.join(root, entry, "SKILL.md");
      try {
        if (!fs.statSync(file).isFile()) continue;
        items.push({ name: entry, file, text: fs.readFileSync(file, "utf8").slice(0, READ_CAP) });
      } catch {
        /* skip one unreadable skill */
      }
    }
  }
  machineCache = { key, at: Date.now(), items };
  return items;
}

function machineSkillByName(name: string): MachineSkill | undefined {
  return machineSkills().find((s) => s.name === name);
}

function machineDescription(skill: MachineSkill): string {
  const meta = skillMeta(skill.text);
  if (meta.description) return meta.description;
  return (
    skill.text
      .replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "")
      .replace(/^#.*$/m, "")
      .trim()
      .split(/\r?\n/)[0]
      ?.slice(0, 160) ?? ""
  );
}

function assertName(name: unknown): string {
  if (typeof name !== "string" || !NAME_RE.test(name.trim())) {
    throw new SandboxError('le nom de la compétence doit comporter 1 à 40 lettres, chiffres, « - » ou « _ » (exemple : "login-debug").');
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
    .slice(0, 400);
  const builtins = Object.keys(BUILTIN_SKILLS).filter((n) => !valid.includes(n));
  const machine = machineSkills()
    .filter((s) => !valid.includes(s.name) && !BUILTIN_SKILLS[s.name])
    .map((s) => `${s.name} (machine)`);
  const all = [...valid, ...builtins.map((n) => `${n} (intégrée)`), ...machine];
  if (!all.length) return "Aucune compétence sauvegardée pour l'instant.";
  return `Compétences (${all.length}) : ${all.join(", ")}`;
}

export function readSkill(root: string, name: unknown): string {
  const clean = assertName(name);
  try {
    const abs = resolveInWorkspace(root, `${SKILLS_DIR}/${clean}.md`);
    if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) {
      const text = fs.readFileSync(abs, "utf8");
      const base = text.length > READ_CAP ? `${text.slice(0, READ_CAP)}\n[compétence tronquée — gardez les compétences courtes]` : text;
      try {
        const meta = skillMeta(text);
        if (meta.name && meta.name !== clean) {
          return `${base}\n[avertissement de compétence : le nom du frontmatter « ${meta.name} » ne correspond pas au nom de fichier « ${clean} »]`;
        }
      } catch {
        /* soft validation never crashes */
      }
      return base;
    }
  } catch {
    /* fall through to built-ins */
  }
  const machine = machineSkillByName(clean);
  if (machine) {
    const base = machine.text.length >= READ_CAP ? `${machine.text.slice(0, READ_CAP)}\n[compétence machine tronquée]` : machine.text;
    return `${base}\n[compétence machine (${machine.file}) — lecture seule]`;
  }
  const builtin = BUILTIN_SKILLS[clean];
  if (builtin) return builtin.length > READ_CAP ? `${builtin.slice(0, READ_CAP)}\n[compétence tronquée]` : builtin;
  return `Error: aucune compétence nommée « ${clean} ». Utilisez skill {"action": "list"} pour voir les compétences sauvegardées.`;
}

export function saveSkill(root: string, name: unknown, content: unknown): string {
  const clean = assertName(name);
  if (typeof content !== "string" || !content.trim()) {
    return 'Error: le contenu est requis. Exemple : {"action": "save", "name": "login-debug", "content": "# steps\\n1. ..."}';
  }
  if (content.length > SAVE_CAP) {
    return `Error: gardez la compétence sous ${SAVE_CAP} caractères (${content.length} fournis). Les courtes listes de vérification survivent le mieux à la compression.`;
  }
  if (isHistoryPlaceholder(content)) {
    return "Error: ceci est un marqueur d'historique, pas une compétence. Écrivez la liste de vérification réelle.";
  }
  const abs = resolveInWorkspace(root, `${SKILLS_DIR}/${clean}.md`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${content.trim()}\n`, "utf8");
  return `Compétence « ${clean} » sauvegardée (${content.trim().split("\n").length} lignes). Elle sera listée par skill {"action": "list"}.`;
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

function allSkillTexts(root: string): { name: string; text: string; machine?: boolean }[] {
  const out: { name: string; text: string; machine?: boolean }[] = [];
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
  for (const s of machineSkills()) {
    if (!out.some((prev) => prev.name === s.name)) out.push({ name: s.name, text: s.text, machine: true });
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
  /** Read-only skill installed for the whole PC (Codex/ECC/REA folders). */
  machine?: boolean;
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
  for (const s of machineSkills()) {
    if (out.some((prev) => prev.name === s.name)) continue;
    let updatedAt = 0;
    try {
      updatedAt = fs.statSync(s.file).mtimeMs;
    } catch {
      /* keep 0 */
    }
    out.push({
      name: s.name,
      builtin: false,
      auto: false,
      machine: true,
      description: machineDescription(s),
      bytes: s.text.length,
      updatedAt,
    });
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.name.localeCompare(b.name));
  return out.slice(0, 400);
}

/** Skills whose name or declared description overlaps the request, best match first.
 * Shared by the text loader and the live status view. */
function matchingSkills(root: string, request: string, preferredNames: string[] = []): { name: string; score: number; excerpt: string }[] {
  const req = keywords(String(request ?? ""));
  const hits: { name: string; score: number; excerpt: string }[] = [];
  const preferredOrder = new Map(preferredNames.map((name, index) => [name, index]));
  for (const s of allSkillTexts(root)) {
    const nameWords = keywords(s.name.replace(/[-_]/g, " "));
    const description = skillMeta(s.text).description;
    const summary = description ?? s.text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").slice(0, 500);
    const summaryWords = keywords(summary);
    const nameMatches = [...req].filter((word) => nameWords.has(word)).length;
    const summaryMatches = [...req].filter((word) => summaryWords.has(word)).length;
    const score = nameMatches * 2 + summaryMatches;
    // Machine folders hold hundreds of skills: demand stronger evidence there
    // so a generic request never drags in an unrelated one.
    const needed = s.machine ? 3 : 2;
    if (preferredOrder.has(s.name) || nameMatches > 0 || summaryMatches >= needed) {
      hits.push({ name: s.name, score, excerpt: s.text.slice(0, 600) });
    }
  }
  return hits.sort((a, b) => {
    const aPreferred = preferredOrder.get(a.name);
    const bPreferred = preferredOrder.get(b.name);
    if (aPreferred !== undefined || bPreferred !== undefined) {
      if (aPreferred === undefined) return 1;
      if (bPreferred === undefined) return -1;
      return aPreferred - bPreferred;
    }
    return b.score - a.score;
  });
}

/** Relevant skills are selected from their name/description, not generic
 * vocabulary buried in the full instructions. Capped to protect small contexts. */
export function relevantSkills(root: string, request: string, maxChars = 1200, preferredNames: string[] = []): string {
  try {
    let out = "";
    for (const h of matchingSkills(root, request, preferredNames).slice(0, 2)) {
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
export function relevantSkillNames(root: string, request: string, limit = 2, preferredNames: string[] = []): string[] {
  try {
    return matchingSkills(root, request, preferredNames)
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

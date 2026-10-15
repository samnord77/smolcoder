#!/usr/bin/env node
/**
 * ecc-smol-install.cjs — installe une sélection ECC (github.com/affaan-m/ECC)
 * dans smolcode :
 *   skills  → <workspace>/.smol/skills/<name>.md   (frontmatter minimal, ≤ 3900 octets)
 *   agents  → <workspace>/.smol/agents/<name>.json (SubagentRole, ≤ 2000 car. instructions)
 *   commandes → <workspace>/.smol/ecc-commands/<name>.md ET ~/.smolcoder/ecc-commands/<name>.md
 *            (le dossier partagé rend /commande disponible dans tous les dossiers)
 *
 * Usage : node scripts/ecc-smol-install.cjs [--dry-run] [--uninstall] [--ecc <chemin>]
 * Idempotent : seul ce qui figure au manifeste .smol/ecc-install.json est écrasé/supprimé.
 * Jamais de fichier existant non géré n'est modifié.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SKILLS_DIR = path.join(ROOT, ".smol", "skills");
const AGENTS_DIR = path.join(ROOT, ".smol", "agents");
const MANIFEST_PATH = path.join(ROOT, ".smol", "ecc-install.json");

const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SKILL_FILE_CAP = 3900; // READ_CAP de skills.ts = 4000 : on garde 100 de marge
const SKILL_DESC_CAP = 300;
const ROLE_DESC_CAP = 600;
const ROLE_INSTR_CAP = 2000;
const MAX_WORKSPACE_SKILLS = 400; // skills.ts : listSkills/describeSkills = 400
const MAX_TOTAL_ROLES = 100; // subagents.ts MAX_ROLES = 100

/** Tous les skills du dépôt ECC : dossiers sous skills/ contenant un SKILL.md. */
function listEccSkills(eccRoot) {
  try {
    const base = path.join(eccRoot, "skills");
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(base, e.name, "SKILL.md")))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Tous les agents du dépôt ECC : fichiers agents/*.md. */
function listEccAgents(eccRoot) {
  try {
    return fs
      .readdirSync(path.join(eccRoot, "agents"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

/** Toutes les commandes du dépôt ECC : fichiers commands/*.md (bibliothèque de référence). */
function listEccCommands(eccRoot) {
  try {
    return fs
      .readdirSync(path.join(eccRoot, "commands"))
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

/** Skills intégrés de smolcode (src/builtin-skills.ts) — jamais écrasés. */
const BUILTIN_SKILL_NAMES = [
  "coding-workflow",
  "bugfix-workflow",
  "code-review-workflow",
  "workspace-investigation",
  "documentation-workflow",
  "direct-style",
  "impeccable-design",
];

/** Rôles intégrés (src/subagents.ts BUILTIN_ROLES) — jamais écrasés. */
const BUILTIN_ROLE_NAMES = [
  "expert",
  "architect",
  "implementer",
  "spec_reviewer",
  "quality_reviewer",
  "researcher",
  "project_manager",
  "office_assistant",
  "personal_assistant",
  "security_auditor",
  "performance_profiler",
  "test_engineer",
  "debugger",
  "refactorer",
  "docs_writer",
];

/** Commandes slash intégrées (le switch de src/session.ts) - jamais
 * écrasées : une commande ECC du même nom est installée sous ecc-<nom>. */
const BUILTIN_SLASH_NAMES = [
  "build",
  "clear",
  "compact",
  "context",
  "copy",
  "diag",
  "doctor",
  "editor",
  "effort",
  "exit",
  "export",
  "fetch",
  "help",
  "logs",
  "mcp",
  "mode",
  "model",
  "models",
  "plan",
  "q",
  "quit",
  "redo",
  "review",
  "rewind",
  "route",
  "skills",
  "status",
  "stop",
  "tasks",
  "todo",
  "undo",
];

/** Outils ECC (frontmatter Claude) → outils smolcode. Inconnus = ignorés. */
const TOOL_MAP = {
  Read: "read_file",
  Write: "write_file",
  Edit: "edit_file",
  MultiEdit: "edit_file",
  Grep: "search",
  Glob: "list_files",
  Bash: "run_command",
  WebFetch: "fetch_url",
  WebSearch: "fetch_url",
  TodoWrite: "plan",
  NotebookEdit: "edit_file",
};

const ROLE_TITLES = {
  tdd: "TDD",
  e2e: "E2E",
  pr: "PR",
  mcp: "MCP",
  api: "API",
  typescript: "TypeScript",
  a11y: "Accessibility",
  ui: "UI",
  html: "HTML",
  sql: "SQL",
  go: "Go",
};

function parseArgs(argv) {
  const args = { dryRun: false, uninstall: false, ecc: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--uninstall") args.uninstall = true;
    else if (argv[i] === "--ecc" && argv[i + 1]) args.ecc = argv[++i];
  }
  if (!args.ecc) args.ecc = process.env.ECC_ROOT || path.join(os.homedir(), "ECC");
  return args;
}

function loadManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    if (m && Array.isArray(m.files)) return m;
  } catch {
    /* premier install */
  }
  return { version: 1, installedAt: null, eccRoot: null, eccCommit: null, skills: [], agents: [], files: [] };
}

function saveManifest(m, dryRun) {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(m, null, 2)}\n`, "utf8");
}

function eccCommit(eccRoot) {
  try {
    return execSync(`git -C "${eccRoot}" rev-parse --short HEAD`, { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Frontmatter YAML simple : attrs en une ligne, valeurs pliées (" >"/"|") suivies. */
function parseFrontmatter(text) {
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { attrs: {}, body: src };
  const attrs = {};
  let lastKey = null;
  let block = false;
  for (const rawLine of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(rawLine);
    if (kv && !/^\s/.test(rawLine)) {
      lastKey = kv[1].toLowerCase();
      const val = kv[2].trim();
      block = /^[>|][+-]?$/.test(val);
      attrs[lastKey] = block ? "" : val;
    } else if (lastKey && /^\s+\S/.test(rawLine)) {
      attrs[lastKey] = attrs[lastKey] ? `${attrs[lastKey]} ${rawLine.trim()}` : rawLine.trim();
    }
  }
  for (const k of Object.keys(attrs))
    attrs[k] = attrs[k]
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^["']|["']$/g, "");
  return { attrs, body: src.slice(m[0].length) };
}

function capAtLine(s, cap) {
  if (s.length <= cap) return s;
  const cut = s.lastIndexOf("\n", cap - 1);
  return s.slice(0, cut > 0 ? cut : cap);
}

function buildSkillContent(name, desc, body, srcPath) {
  const oneLine = (desc || "").replace(/\s+/g, " ").trim().slice(0, SKILL_DESC_CAP);
  const fm = `---\nname: ${name}\ndescription: ${oneLine}\n---\n\n`;
  let out = `${fm}${body.replace(/\r\n/g, "\n").trim()}\n`;
  if (out.length > SKILL_FILE_CAP) {
    const marker = `\n\n[tronqué — version complète : ${srcPath}]\n`;
    const budget = SKILL_FILE_CAP - marker.length;
    const cut = out.lastIndexOf("\n", budget);
    out = `${out.slice(0, cut > 0 ? cut : budget)}${marker}`;
  }
  return out;
}

function stripBaseline(body) {
  const i = body.indexOf("## Prompt Defense Baseline");
  if (i < 0) return body;
  const next = body.indexOf("\n## ", i + 10);
  const out = next < 0 ? body.slice(0, i) : body.slice(0, i) + body.slice(next + 1);
  return out.trim() ? out : body;
}

function titleFromName(name) {
  return name
    .split(/[-_]/)
    .map((w) => ROLE_TITLES[w.toLowerCase()] || w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function mapTools(raw) {
  const out = [];
  for (const part of String(raw || "").split(",")) {
    const t = TOOL_MAP[part.trim()];
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 20);
}

function countMdFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

function countFiles(dir, ext) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(ext)).length;
  } catch {
    return 0;
  }
}

/** Copie les commandes ECC en slash-command : dossier du projet
 * (.smol/ecc-commands) puis dossier partagé (~/.smolcoder/ecc-commands),
 * que smolcode cherche comme repli — /ecc-guide marche donc partout.
 * Le dossier partagé est purgé des commandes retirées d'ECC. */
function installCommands(eccRoot, manifest, dryRun, report) {
  const owned = new Set(manifest.files.map((f) => f.path));
  const sharedDir = path.join(os.homedir(), ".smolcoder", "ecc-commands");
  const written = new Set();
  for (const file of listEccCommands(eccRoot)) {
    const base = file.slice(0, -3);
    const finalName = BUILTIN_SLASH_NAMES.includes(base) ? `ecc-${base}` : base;
    const rel = `.smol/ecc-commands/${finalName}.md`;
    const target = path.join(ROOT, rel);
    if (fs.existsSync(target) && !owned.has(rel)) {
      report.skipped.push(`commande ${file} (fichier existant non géré, conservé)`);
      continue;
    }
    const content = fs.readFileSync(path.join(eccRoot, "commands", file));
    if (!dryRun) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      fs.mkdirSync(sharedDir, { recursive: true });
      fs.writeFileSync(path.join(sharedDir, `${finalName}.md`), content);
    }
    written.add(`${finalName}.md`);
    report.commands.push(finalName);
    report.files.push({ path: rel, bytes: content.length });
  }
  if (dryRun) return;
  // Repurge du partagé : il reproduit exactement la liste ECC courante.
  let stale = [];
  try {
    stale = fs.readdirSync(sharedDir).filter((f) => f.endsWith(".md") && !written.has(f));
  } catch {
    return;
  }
  for (const f of stale) {
    fs.unlinkSync(path.join(sharedDir, f));
    report.skipped.push(`commande partagée retirée ${f} (absente d'ECC)`);
  }
}

function installSkills(eccRoot, manifest, dryRun, report) {
  const owned = new Set(manifest.skills);
  const existing = countMdFiles(SKILLS_DIR);
  let fresh = 0;
  for (const name of listEccSkills(eccRoot)) {
    if (!NAME_RE.test(name)) {
      report.skipped.push(`${name} (nom invalide)`);
      continue;
    }
    if (BUILTIN_SKILL_NAMES.includes(name)) {
      report.skipped.push(`${name} (collision skill intégré smolcode)`);
      continue;
    }
    const src = path.join(eccRoot, "skills", name, "SKILL.md");
    if (!fs.existsSync(src)) {
      report.skipped.push(`${name} (absent du dépôt ECC)`);
      continue;
    }
    const target = path.join(SKILLS_DIR, `${name}.md`);
    if (fs.existsSync(target) && !owned.has(name)) {
      report.skipped.push(`${name} (fichier existant non géré, conservé tel quel)`);
      continue;
    }
    const { attrs, body } = parseFrontmatter(fs.readFileSync(src, "utf8"));
    const content = buildSkillContent(name, attrs.description || "", body, src);
    if (!dryRun) {
      fs.mkdirSync(SKILLS_DIR, { recursive: true });
      fs.writeFileSync(target, content, "utf8");
    }
    if (!owned.has(name)) fresh++;
    report.skills.push(name);
    report.files.push({ path: path.relative(ROOT, target).replace(/\\/g, "/"), bytes: Buffer.byteLength(content) });
  }
  const total = existing + fresh;
  report.skillTotal = total;
  if (total > MAX_WORKSPACE_SKILLS) {
    throw new Error(`Trop de skills workspace : ${total} > ${MAX_WORKSPACE_SKILLS} (listSkills en tronquerait).`);
  }
}

function installAgents(eccRoot, manifest, dryRun, report) {
  const owned = new Set(manifest.agents);
  let fresh = 0;
  for (const name of listEccAgents(eccRoot)) {
    if (!NAME_RE.test(name)) {
      report.skipped.push(`${name} (nom invalide)`);
      continue;
    }
    const finalName = BUILTIN_ROLE_NAMES.includes(name) ? `ecc-${name}` : name; // jamais d'écrasement d'un rôle intégré
    const src = path.join(eccRoot, "agents", `${name}.md`);
    if (!fs.existsSync(src)) {
      report.skipped.push(`${name} (absent du dépôt ECC)`);
      continue;
    }
    const target = path.join(AGENTS_DIR, `${finalName}.json`);
    if (fs.existsSync(target) && !owned.has(finalName)) {
      report.skipped.push(`${name} (fichier existant non géré, conservé tel quel)`);
      continue;
    }
    const { attrs, body } = parseFrontmatter(fs.readFileSync(src, "utf8"));
    const role = {
      name: finalName,
      role: titleFromName(finalName),
      description: String(attrs.description || "").slice(0, ROLE_DESC_CAP),
      tools: mapTools(attrs.tools),
      instructions: capAtLine(stripBaseline(body).trim(), ROLE_INSTR_CAP),
    };
    const content = `${JSON.stringify(role, null, 2)}\n`;
    if (!dryRun) {
      fs.mkdirSync(AGENTS_DIR, { recursive: true });
      fs.writeFileSync(target, content, "utf8");
    }
    if (!owned.has(finalName)) fresh++;
    report.agents.push(finalName);
    report.files.push({ path: path.relative(ROOT, target).replace(/\\/g, "/"), bytes: Buffer.byteLength(content) });
  }
  report.roleTotal = BUILTIN_ROLE_NAMES.length + countFiles(AGENTS_DIR, ".json") + (dryRun ? fresh : 0);
  if (report.roleTotal > MAX_TOTAL_ROLES) {
    throw new Error(`Trop de rôles : ${report.roleTotal} > ${MAX_TOTAL_ROLES} (MAX_ROLES en tronquerait).`);
  }
}

function uninstall(manifest, dryRun, report) {
  for (const f of manifest.files) {
    const abs = path.join(ROOT, f.path);
    try {
      const st = fs.statSync(abs);
      if (st.size !== f.bytes) {
        report.skipped.push(`${f.path} (modifié depuis l'installation, conservé)`);
        continue;
      }
      if (!dryRun) fs.unlinkSync(abs);
      report.removed.push(f.path);
    } catch {
      report.skipped.push(`${f.path} (déjà absent)`);
    }
  }
  if (!dryRun && fs.existsSync(MANIFEST_PATH)) fs.unlinkSync(MANIFEST_PATH);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = loadManifest();
  const report = { skills: [], agents: [], commands: [], files: [], removed: [], skipped: [] };

  if (args.uninstall) {
    uninstall(manifest, args.dryRun, report);
    console.log(`${args.dryRun ? "[dry-run] " : ""}Désinstallation ECC : ${report.removed.length} fichier(s) supprimé(s).`);
    for (const s of report.skipped) console.log(`  conservé : ${s}`);
    return;
  }

  const eccRoot = path.resolve(args.ecc);
  if (!fs.existsSync(path.join(eccRoot, "skills")) || !fs.existsSync(path.join(eccRoot, "agents"))) {
    throw new Error(`Dépôt ECC introuvable à "${eccRoot}" (attendu : skills/ et agents/).`);
  }
  const before = { skills: manifest.skills.length, agents: manifest.agents.length };
  installSkills(eccRoot, manifest, args.dryRun, report);
  installAgents(eccRoot, manifest, args.dryRun, report);
  installCommands(eccRoot, manifest, args.dryRun, report);

  manifest.version = 1;
  manifest.installedAt = new Date().toISOString();
  manifest.eccRoot = eccRoot;
  manifest.eccCommit = eccCommit(eccRoot);
  manifest.skills = [...new Set([...manifest.skills, ...report.skills])];
  manifest.agents = [...new Set([...manifest.agents, ...report.agents])];
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));
  for (const f of report.files) byPath.set(f.path, f);
  manifest.files = [...byPath.values()];
  saveManifest(manifest, args.dryRun);

  console.log(`${args.dryRun ? "[dry-run] " : ""}ECC → smolcode (${eccRoot}, commit ${manifest.eccCommit})`);
  console.log(`  skills : ${report.skills.length} installé(s) — workspace total ${report.skillTotal}/${MAX_WORKSPACE_SKILLS}`);
  console.log(`  agents : ${report.agents.length} installé(s) — rôles total ${report.roleTotal}/${MAX_TOTAL_ROLES}`);
  console.log(`  commandes : ${report.commands.length} slash-command(s) (.smol/ecc-commands + ~/.smolcoder/ecc-commands)`);
  const shown = (arr, n) => (arr.length > n ? `${arr.slice(0, n).join(", ")} … (+${arr.length - n})` : arr.join(", "));
  if (report.skills.length) console.log(`  skills : ${shown(report.skills, 25)}`);
  if (report.agents.length) console.log(`  agents : ${shown(report.agents, 25)}`);
  for (const s of report.skipped) console.log(`  ignoré : ${s}`);
  if (before.skills) console.log(`  manifeste : ${manifest.skills.length} skills / ${manifest.agents.length} agents cumulés`);
}

try {
  main();
} catch (err) {
  console.error(`Erreur : ${err?.message ? err.message : err}`);
  process.exitCode = 1;
}

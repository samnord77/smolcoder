// Skills, built-ins, auto-evolution and the visible YOLO mode: all
// deterministic, no model calls, scratch workspaces only.
const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const skills = require("../dist/skills");
const { buildToolSpecs, MODE_LABELS } = require("../dist/tools/index");
const { yoloBanner } = require("../dist/session");

// The machine skill folders (~/.agents/skills, ~/.codex/skills) hold whatever
// the developer has installed; point them at an empty scratch dir so these
// unit tests stay deterministic. The machine-skills test below sets its own
// fixture root.
const PREV_SKILL_DIRS = process.env.SMOLCODER_SKILL_DIRS;
process.env.SMOLCODER_SKILL_DIRS = fs.mkdtempSync(path.join(os.tmpdir(), "smol-skills-empty-"));
after(() => {
  if (PREV_SKILL_DIRS === undefined) delete process.env.SMOLCODER_SKILL_DIRS;
  else process.env.SMOLCODER_SKILL_DIRS = PREV_SKILL_DIRS;
});

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "smol-skills-"));
}

test("empty workspace still offers the built-in skill, yolo banner is visible", () => {
  assert.match(skills.listSkills(scratch()), /impeccable-design \(intégrée\)/);
  assert.match(yoloBanner(), /YOLO/);
  assert.match(MODE_LABELS.bypass, /YOLO/);
});

test("skill save and read round trip", () => {
  const ws = scratch();
  const r = skills.saveSkill(ws, "login-debug", "# steps\n1. check logs");
  assert.match(r, /Compétence « login-debug »/);
  assert.match(skills.readSkill(ws, "login-debug"), /check logs/);
  assert.match(skills.listSkills(ws), /login-debug/);
});

test("bad skill names and traversal are blocked", () => {
  const ws = scratch();
  for (const bad of ["../../evil", "../x", "", "a/b", "x".repeat(41)]) {
    assert.throws(() => skills.readSkill(ws, bad), /nom de la compétence/);
  }
  assert.throws(() => skills.saveSkill(ws, "../../evil", "x"), /nom de la compétence|dehors/);
  assert.match(skills.saveSkill(ws, "ok-name", "   "), /le contenu est requis/);
});

test("built-in impeccable-design skill is listed and readable", () => {
  const ws = scratch();
  assert.match(skills.listSkills(ws), /impeccable-design \(intégrée\)/);
  const text = skills.readSkill(ws, "impeccable-design");
  assert.match(text, /Persuade/);
  assert.match(text, /Operate/);
  assert.match(text, /pbakaus\/impeccable/);
});

test("relevant skills auto-match design work, ignore backend work", () => {
  const ws = scratch();
  const hit = skills.relevantSkills(ws, "redesign the login page layout and polish spacing");
  assert.match(hit, /impeccable-design/);
  assert.equal(skills.relevantSkills(ws, "rename variable in parser"), "");
});

test("orchestrator-preferred skills load even when their names do not overlap the user's wording", () => {
  const ws = scratch();
  const request = "Fix a defect in this repository.";
  const preferred = ["bugfix-workflow", "coding-workflow"];
  const content = skills.relevantSkills(ws, request, 1200, preferred);
  const names = skills.relevantSkillNames(ws, request, 2, preferred);

  assert.deepEqual(names, preferred);
  assert.ok(content.indexOf("### skill bugfix-workflow") < content.indexOf("### skill coding-workflow"));
  assert.match(content, /failing regression test/);
});

test("auto-matching uses skill descriptions and avoids incidental words in instructions", () => {
  const ws = scratch();
  skills.saveSkill(
    ws,
    "database-migration",
    "---\nname: database-migration\ndescription: Plan safe database schema migrations\n---\n# Database migration\nUse project files and tools to check the plan."
  );

  assert.match(skills.relevantSkills(ws, "préparer une migration database"), /database-migration/);
  assert.deepEqual(skills.relevantSkillNames(ws, "editor files image todo agents tools skills"), []);
});

test("auto repair lessons are kept only for hard repairs and capped", () => {
  const ws = scratch();
  assert.equal(skills.saveAutoRepairLesson(ws, { command: "npm test", attempts: 1, failure: "x", files: [], commands: [] }), null);
  const name = skills.saveAutoRepairLesson(ws, {
    command: "npm run build && npm test",
    attempts: 3,
    failure: "Error code #",
    files: ["src/a.ts"],
    commands: ["npm test → fail"],
  });
  assert.match(name, /^auto-[0-9a-z]+$/);
  assert.ok(fs.existsSync(path.join(ws, ".smol", "skills", `${name}.md`)));
  const dir = path.join(ws, ".smol", "skills");
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(dir, `auto-seed${i}.md`), "x");
  skills.saveAutoRepairLesson(ws, {
    command: "npm test",
    attempts: 2,
    failure: "y",
    files: [],
    commands: [],
  });
  const autos = fs.readdirSync(dir).filter((f) => f.startsWith("auto-"));
  assert.ok(autos.length <= 20, `expected at most 20 auto lessons, got ${autos.length}`);
});

test("delegate stats accumulate without ever throwing", () => {
  const ws = scratch();
  skills.recordDelegateStats(ws, 5);
  skills.recordDelegateStats(ws, 3);
  const cur = JSON.parse(fs.readFileSync(path.join(ws, ".smol", "delegate-stats.json"), "utf8"));
  assert.equal(cur.runs, 2);
  assert.equal(cur.toolCalls, 8);
});

test("delegate tool exists in edit and read-only, hidden in sub-agents", () => {
  const edit = buildToolSpecs("edit").map((t) => t.name);
  const ro = buildToolSpecs("ro").map((t) => t.name);
  const child = buildToolSpecs("edit", { allowDelegate: false }).map((t) => t.name);
  const childRo = buildToolSpecs("ro", { allowDelegate: false }).map((t) => t.name);
  assert.ok(edit.includes("delegate") && edit.includes("skill"));
  // Read-only parents may delegate: the child inherits read-only and can only read.
  assert.ok(ro.includes("skill") && ro.includes("delegate") && !ro.includes("write_file"));
  assert.ok(!child.includes("delegate") && child.includes("skill"));
  assert.ok(!childRo.includes("delegate"));
});

test("machine skills (Codex/ECC/REA folders) are listed, read, shown and auto-matched", () => {
  const ws = scratch();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smol-machineskills-"));
  fs.mkdirSync(path.join(root, "reverse-engineer-anything"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "reverse-engineer-anything", "SKILL.md"),
    "---\nname: reverse-engineer-anything\ndescription: Reverse engineer binaries and apps with evidence\n---\n# steps\n1. inspect the artifact\n",
    "utf8"
  );
  const prev = process.env.SMOLCODER_SKILL_DIRS;
  process.env.SMOLCODER_SKILL_DIRS = root;
  try {
    assert.match(skills.listSkills(ws), /reverse-engineer-anything \(machine\)/);
    assert.match(skills.readSkill(ws, "reverse-engineer-anything"), /inspect the artifact/);
    const info = skills.describeSkills(ws).find((s) => s.name === "reverse-engineer-anything");
    assert.ok(info, "la compétence machine doit etre decrite");
    assert.equal(info.machine, true);
    assert.equal(info.builtin, false);
    const names = skills.relevantSkillNames(ws, "reverse engineer this Electron app and show evidence");
    assert.ok(names.includes("reverse-engineer-anything"), `auto-match attendu, recu: ${names.join(", ")}`);
    // a workspace skill with the same name shadows the machine one
    skills.saveSkill(ws, "reverse-engineer-anything", "# local override");
    assert.match(skills.readSkill(ws, "reverse-engineer-anything"), /local override/);
    assert.ok(!skills.listSkills(ws).includes("(machine)"));
  } finally {
    if (prev === undefined) delete process.env.SMOLCODER_SKILL_DIRS;
    else process.env.SMOLCODER_SKILL_DIRS = prev;
  }
});

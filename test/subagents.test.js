const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BUILTIN_ROLES, loadSubagentRoles, delegatePrompt } = require("../dist/subagents");
const { buildToolSpecs } = require("../dist/tools/index.js");

// Tools that modify the workspace. A role that borrows none of the editor pair
// must not sneak a write in through another door.
const WRITE_TOOLS = ["edit_file", "write_file", "move_path", "delete_path", "create_folder", "format", "document"];

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "smol-roles-"));
}

test("the shipped roster is complete and well-formed", () => {
  assert.ok(BUILTIN_ROLES.length >= 30, `expected at least 30 builtin roles, found ${BUILTIN_ROLES.length}`);
  const names = new Set();
  for (const r of BUILTIN_ROLES) {
    assert.match(r.name, /^[a-z0-9_-]{1,40}$/, `bad role name: ${r.name}`);
    assert.ok(!names.has(r.name), `duplicate role name: ${r.name}`);
    names.add(r.name);
    assert.ok(r.role.length > 0, `${r.name} has no title`);
    assert.ok(r.description.length >= 20, `${r.name} description is too thin`);
    assert.ok(r.instructions.length >= 40, `${r.name} has no real instructions`);
    assert.equal(r.source, "builtin");
  }
  for (const want of [
    "expert",
    "architect",
    "api_designer",
    "data_engineer",
    "frontend_engineer",
    "release_manager",
    "teacher",
    "automation_engineer",
  ]) {
    assert.ok(names.has(want), `missing role: ${want}`);
  }
});

test("every role only borrows real tools, and read-only roles never get a write tool", () => {
  const real = new Set(buildToolSpecs("bypass").map((s) => s.name));
  for (const r of BUILTIN_ROLES) {
    for (const t of r.tools) assert.ok(real.has(t), `${r.name} lists unknown tool: ${t}`);
    const edits = r.tools.includes("edit_file") || r.tools.includes("write_file");
    if (!edits) {
      const writes = r.tools.filter((t) => WRITE_TOOLS.includes(t));
      assert.deepEqual(writes, [], `${r.name} is read-only but carries ${writes.join(", ")}`);
    }
  }
});

test("a workspace role overrides a builtin of the same name, and load never throws", () => {
  const ws = scratch();
  const builtinExpert = loadSubagentRoles(ws).find((r) => r.name === "expert");
  assert.equal(builtinExpert.source, "builtin");
  const dir = path.join(ws, ".smol", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "expert.json"),
    JSON.stringify({ name: "expert", role: "Mon Expert", description: "d", instructions: "i" })
  );
  fs.writeFileSync(path.join(dir, "broken.json"), "{ not json");
  const roles = loadSubagentRoles(ws);
  const mine = roles.find((r) => r.name === "expert");
  assert.equal(mine.source, "workspace");
  assert.equal(mine.role, "Mon Expert");
  assert.ok(roles.length >= 30, "the broken file must be skipped, not fatal");
  for (const r of BUILTIN_ROLES)
    assert.ok(
      roles.find((x) => x.name === r.name),
      `lost builtin ${r.name}`
    );
});

test("a folder-added role lands in the roster with its own scope", () => {
  const ws = scratch();
  const dir = path.join(ws, ".smol", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "my_helper.json"),
    JSON.stringify({ role: "Helper", description: "aide locale", instructions: "Lis avant d'agir.", tools: ["read_file", "search"] })
  );
  const helper = loadSubagentRoles(ws).find((r) => r.name === "my_helper");
  assert.ok(helper, "the folder role must appear");
  assert.equal(helper.source, "workspace");
  assert.deepEqual(helper.tools, ["read_file", "search"]);
});

test("delegatePrompt carries the role, its tools and the task", () => {
  const p = delegatePrompt(
    { name: "teacher", role: "Codebase Teacher", tools: ["read_file", "plan"], instructions: "Teach from real code." },
    "explique le module router"
  );
  assert.match(p, /teacher/);
  assert.match(p, /Codebase Teacher/);
  assert.match(p, /explique le module router/);
  assert.match(p, /read_file, plan/);
  assert.match(p, /delegate/);
});

test("Claude/OpenCode agent markdown files land in the roster with mapped tools", () => {
  const ws = scratch();
  const dir = path.join(ws, ".claude", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "release-notes-writer.md"),
    [
      "---",
      "name: Release Notes Writer",
      "description: Writes honest release notes from the real diff.",
      "tools: Read, Write, TodoWrite, SomethingUnknown",
      "---",
      "",
      "Read the diff first. Never invent a feature.",
    ].join("\n")
  );
  const r = loadSubagentRoles(ws).find((x) => x.name === "release-notes-writer");
  assert.ok(r, "the markdown agent must appear");
  assert.equal(r.source, "workspace");
  assert.equal(r.role, "Release Notes Writer");
  assert.deepEqual(r.tools, ["read_file", "write_file", "plan"]);
  assert.match(r.instructions, /Never invent a feature/);
});

test("an agent markdown without tools gets the full default set, and a boolean tools map works", () => {
  const ws = scratch();
  const dir = path.join(ws, ".opencode", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plain.md"), "---\nname: plain\ndescription: d\n---\nBody here.");
  const plain = loadSubagentRoles(ws).find((x) => x.name === "plain");
  assert.ok(plain.tools.includes("edit_file") && plain.tools.includes("read_file"), plain.tools.join(","));
  fs.writeFileSync(
    path.join(dir, "mapped.md"),
    "---\nname: mapped\ndescription: d\ntools:\n  read: true\n  edit: true\n  bash: false\n---\nBody."
  );
  const mapped = loadSubagentRoles(ws).find((x) => x.name === "mapped");
  assert.deepEqual(mapped.tools, ["read_file", "edit_file"]);
});

test("an explicit .smol role beats a same-named Claude agent file, and a files without front-matter is ignored", () => {
  const ws = scratch();
  fs.mkdirSync(path.join(ws, ".smol", "agents"), { recursive: true });
  fs.mkdirSync(path.join(ws, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".smol", "agents", "deployer.json"),
    JSON.stringify({ role: "SMOL Deployer", description: "d", instructions: "i", tools: ["read_file"] })
  );
  fs.writeFileSync(path.join(ws, ".claude", "agents", "deployer.md"), "---\nname: deployer\ndescription: cc\n---\nbody");
  fs.writeFileSync(path.join(ws, ".claude", "agents", "no-head.md"), "Just prose, no front-matter.");
  const roles = loadSubagentRoles(ws);
  const r = roles.find((x) => x.name === "deployer");
  assert.equal(r.role, "SMOL Deployer");
  assert.equal(r.source, "workspace");
  assert.ok(!roles.find((x) => x.name === "no-head"));
});

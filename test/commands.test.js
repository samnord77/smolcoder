// Custom slash commands: .smol/commands + .smol/ecc-commands → menu entries
// and the prompt a "/name" sends to the model. Pure fs, no model calls.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { listCustomCommands, loadCustomCommand, resolveSlashPrompt, split } = require("../dist/commands");

// Isolation: default to a temp data dir so the real ~/.smolcoder
// (global ecc-commands fallback) never leaks into these tests.
const DATA_SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "smol-data-"));
process.env.SMOLCODER_DATA_DIR = DATA_SCRATCH;

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "smol-commands-"));
}

function write(ws, dir, name, body) {
  fs.mkdirSync(path.join(ws, dir), { recursive: true });
  fs.writeFileSync(path.join(ws, dir, name), body, "utf8");
}

test("empty workspace: no custom commands, unknown name loads nothing", () => {
  const ws = scratch();
  assert.deepEqual(listCustomCommands(ws), []);
  assert.equal(loadCustomCommand(ws, "anything"), null);
});

test("command file is listed with its description and loaded as a prompt", () => {
  const ws = scratch();
  write(
    ws,
    ".smol/ecc-commands",
    "review-pr.md",
    "---\ndescription: Comprehensive PR review using specialized agents\n---\n\nRun a review pass.\n"
  );
  const list = listCustomCommands(ws);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "review-pr");
  assert.match(list[0].desc, /Comprehensive PR review/);
  const body = loadCustomCommand(ws, "review-pr", "branch fix-x");
  assert.match(body, /Run a review pass\./);
  assert.match(body, /branch fix-x/);
});

test("a command without frontmatter still gets a readable description", () => {
  const ws = scratch();
  write(ws, ".smol/commands", "plain.md", "# Just a heading\nbody text\n");
  assert.equal(listCustomCommands(ws)[0].desc, "Just a heading");
  assert.match(loadCustomCommand(ws, "plain"), /body text/);
});

test("workspace .smol/commands wins over ecc-commands, no duplicate menu row", () => {
  const ws = scratch();
  write(ws, ".smol/commands", "hello.md", "MINE\n");
  write(ws, ".smol/ecc-commands", "hello.md", "THEIRS\n");
  assert.equal(listCustomCommands(ws).length, 1);
  assert.match(loadCustomCommand(ws, "hello"), /^MINE/);
});

test("traversal, empty and non-md names are refused", () => {
  const ws = scratch();
  write(ws, ".smol/commands", "ok.md", "OK\n");
  assert.equal(loadCustomCommand(ws, "../evil"), null);
  assert.equal(loadCustomCommand(ws, "..\\evil"), null);
  assert.equal(loadCustomCommand(ws, ""), null);
  assert.equal(loadCustomCommand(ws, "ok.md"), null);
  assert.equal(loadCustomCommand(ws, "ok", "extra args").includes("extra args"), true);
});

test("split strips frontmatter, BOM and caps the description", () => {
  const { desc, body } = split(`﻿---\ndescription: "${"x".repeat(300)}"\n---\nBody`);
  assert.equal(desc.length, 100);
  assert.equal(body, "Body");
});

test("resolveSlashPrompt routes -p slash lines and passes the rest through", () => {
  const ws = scratch();
  write(ws, ".smol/commands", "ship.md", "SHIP IT");
  assert.equal(resolveSlashPrompt(ws, "plain prompt"), "plain prompt");
  assert.equal(resolveSlashPrompt(ws, "/unknown-x"), "/unknown-x");
  assert.match(resolveSlashPrompt(ws, "/ship now"), /^SHIP IT/);
  assert.equal(resolveSlashPrompt(ws, "/ship now").includes("now"), true);
});

test("command names are matched case-insensitively after the exact name", () => {
  const ws = scratch();
  write(ws, ".smol/ecc-commands", "ecc-guide.md", "GUIDE");
  assert.equal(loadCustomCommand(ws, "ECC-GUIDE"), "GUIDE");
  assert.equal(loadCustomCommand(ws, "Ecc-Guide"), "GUIDE");
  assert.equal(loadCustomCommand(ws, "NOPE"), null);
});

test("commands in the shared data directory work from any workspace", () => {
  const ws = scratch();
  const shared = scratch();
  const prev = process.env.SMOLCODER_DATA_DIR;
  process.env.SMOLCODER_DATA_DIR = shared;
  try {
    write(shared, "ecc-commands", "shared-only.md", "SHARED\n");
    assert.match(loadCustomCommand(ws, "shared-only"), /^SHARED/);
    assert.ok(listCustomCommands(ws).some((c) => c.name === "shared-only"));
    assert.match(resolveSlashPrompt(ws, "/shared-only now"), /^SHARED/);
  } finally {
    if (prev === undefined) delete process.env.SMOLCODER_DATA_DIR;
    else process.env.SMOLCODER_DATA_DIR = prev;
  }
});

test("the workspace copy wins over the shared copy", () => {
  const ws = scratch();
  const shared = scratch();
  const prev = process.env.SMOLCODER_DATA_DIR;
  process.env.SMOLCODER_DATA_DIR = shared;
  try {
    write(ws, ".smol/ecc-commands", "twin.md", "PROJECT\n");
    write(shared, "ecc-commands", "twin.md", "SHARED\n");
    assert.match(loadCustomCommand(ws, "twin"), /^PROJECT/);
    assert.equal(listCustomCommands(ws).length, 1);
  } finally {
    if (prev === undefined) delete process.env.SMOLCODER_DATA_DIR;
    else process.env.SMOLCODER_DATA_DIR = prev;
  }
});

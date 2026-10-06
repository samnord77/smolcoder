// Custom slash commands: .smol/commands + .smol/ecc-commands → menu entries
// and the prompt a "/name" sends to the model. Pure fs, no model calls.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { listCustomCommands, loadCustomCommand, split } = require("../dist/commands");

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

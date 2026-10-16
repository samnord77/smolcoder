"use strict";
/** The `github` tool: spec gating, validation, missing-gh honesty, live read. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildToolSpecs } = require("../dist/tools");
const { githubTool, runGithub } = require("../dist/tools/github");
const mcpModule = require("../dist/mcp");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "smol-github-"));
}

function spec(name, mode) {
  return buildToolSpecs(mode).find((t) => t.name === name);
}

test("the github tool offers reads in every mode and pr_create only when writing", () => {
  const ro = githubTool(false);
  const rw = githubTool(true);
  const roActions = ro.parameters.properties.action.enum;
  const rwActions = rw.parameters.properties.action.enum;
  for (const a of ["status", "pr_list", "pr_view", "pr_checks", "issue_list", "issue_view"]) {
    assert.ok(roActions.includes(a), `${a} is offered in read-only`);
    assert.ok(rwActions.includes(a), `${a} is offered in edit`);
  }
  assert.ok(!roActions.includes("pr_create"));
  assert.ok(rwActions.includes("pr_create"));
  assert.ok(spec("github", "ro"), "github is visible in read-only mode");
  assert.ok(spec("github", "edit"), "github is visible in edit mode");
});

test("runGithub refuses pr_create in read-only mode, before touching gh", () => {
  const out = runGithub(tmpdir(), { action: "pr_create", title: "x", body: "y" }, { canWrite: false });
  assert.match(out, /lecture seule/);
});

test("runGithub validates its input", () => {
  const root = tmpdir();
  assert.match(runGithub(root, { action: "banana" }), /l'action doit être/);
  assert.match(runGithub(root, { action: "pr_create" }, { canWrite: true }), /"title" est requis/);
  assert.match(runGithub(root, { action: "pr_view" }), /"number" est requis/);
  assert.match(runGithub(root, { action: "pr_checks", number: -3 }), /"number" est requis/);
});

test("runGithub says honestly when gh is missing", () => {
  const original = mcpModule.findCommand;
  mcpModule.findCommand = () => null;
  try {
    const out = runGithub(tmpdir(), { action: "status" });
    assert.match(out, /gh \(GitHub CLI\) introuvable/);
    assert.match(out, /continuez sans lui|continue sans lui/);
  } finally {
    mcpModule.findCommand = original;
  }
});

test("github: live status works through the real gh CLI", { skip: mcpModule.findCommand("gh") === null ? "aucun gh CLI sur cette machine" : false }, () => {
  const out = runGithub(tmpdir(), { action: "status" });
  assert.ok(typeof out === "string" && out.length > 0);
  assert.match(out, /Logged in|Error:/);
});

test("github: pr_create outside a git repository fails cleanly", { skip: mcpModule.findCommand("gh") === null ? "aucun gh CLI sur cette machine" : false }, () => {
  const out = runGithub(tmpdir(), { action: "pr_create", title: "test", body: "corps" }, { canWrite: true });
  assert.match(out, /^Error: gh pr create a échoué/);
  assert.match(out, /poussez d'abord la branche/i);
});

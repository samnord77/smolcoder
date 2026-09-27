// Pro git: validation, read-only guards, and a full commit flow in a
// scratch repository. Skips when git is not installed.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isGitRepo, queryGit, GIT_ACTIONS } = require("../dist/git");

function gitAvailable() {
  try {
    const r = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

function scratchRepo() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-git-"));
  let r = spawnSync("git", ["init", "-b", "main"], { cwd: ws, encoding: "utf8", timeout: 15000, windowsHide: true });
  if (r.status !== 0) {
    r = spawnSync("git", ["init"], { cwd: ws, encoding: "utf8", timeout: 15000, windowsHide: true });
    assert.equal(r.status, 0, "git init must work here");
  }
  spawnSync("git", ["config", "user.email", "test@smol.dev"], { cwd: ws, windowsHide: true });
  spawnSync("git", ["config", "user.name", "Smol Test"], { cwd: ws, windowsHide: true });
  return ws;
}

test("git: refuses outside a repository and validates actions", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-nogit-"));
  assert.match(queryGit(ws, { action: "status" }), /not a git repository/);
  assert.equal(isGitRepo(ws), false);
  assert.match(queryGit(ws, {}), /action must be one of/);
  assert.ok(GIT_ACTIONS.includes("commit") && GIT_ACTIONS.includes("blame"));
  if (!gitAvailable()) return;
  const repo = scratchRepo();
  assert.match(queryGit(repo, { action: "blame" }), /needs a path/);
  assert.match(queryGit(repo, { action: "commit" }), /needs a message/);
  assert.match(queryGit(repo, { action: "stage", path: "" }), /at least one path/);
});

test("git: read-only mode blocks stage and commit", () => {
  if (!gitAvailable()) return;
  const repo = scratchRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "hi\n");
  assert.match(queryGit(repo, { action: "stage", path: "." }, { canWrite: false }), /read-only/);
  assert.match(queryGit(repo, { action: "commit", message: "x" }, { canWrite: false }), /read-only/);
  assert.match(queryGit(repo, { action: "status" }, { canWrite: false }), /On branch|HEAD/);
});

test("git: full flow — stage, commit, status, diff, log, blame, branch", () => {
  if (!gitAvailable()) return;
  const repo = scratchRepo();
  fs.writeFileSync(path.join(repo, "app.txt"), "line one\nline two\n");
  assert.match(queryGit(repo, { action: "stage", path: "." }), /Staged/);
  assert.match(queryGit(repo, { action: "commit", message: "Add app" }), /Add app|master|main|create/i);
  assert.match(queryGit(repo, { action: "status" }), /clean/);
  assert.match(queryGit(repo, { action: "commit", message: "Empty" }), /nothing staged/);
  fs.writeFileSync(path.join(repo, "app.txt"), "line one\nline two changed\n");
  const diff = queryGit(repo, { action: "diff" });
  assert.match(diff, /line two changed/);
  assert.match(queryGit(repo, { action: "diff", stat: true }), /app\.txt/);
  assert.match(queryGit(repo, { action: "log" }), /Add app/);
  const blame = queryGit(repo, { action: "blame", path: "app.txt", line: 1 });
  assert.match(blame, /Smol Test/);
  assert.match(queryGit(repo, { action: "branch" }), /main|master/);
  assert.equal(isGitRepo(repo), true);
});

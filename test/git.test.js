// Pro git: validation, read-only guards, and a full commit flow in a
// scratch repository. Skips when git is not installed.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gitSyncStatus, isGitRepo, queryGit, GIT_ACTIONS } = require("../dist/git");

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
  assert.match(queryGit(ws, { action: "status" }), /n’est pas un dépôt git/);
  assert.equal(isGitRepo(ws), false);
  assert.match(queryGit(ws, {}), /l’action doit être l’une de/);
  assert.ok(GIT_ACTIONS.includes("commit") && GIT_ACTIONS.includes("blame"));
  if (!gitAvailable()) return;
  const repo = scratchRepo();
  assert.match(queryGit(repo, { action: "blame" }), /a besoin d’un chemin/);
  assert.match(queryGit(repo, { action: "commit" }), /a besoin d’un message/);
  assert.match(queryGit(repo, { action: "stage", path: "" }), /au moins un chemin/);
});

test("git: read-only mode blocks stage and commit", () => {
  if (!gitAvailable()) return;
  const repo = scratchRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "hi\n");
  assert.match(queryGit(repo, { action: "stage", path: "." }, { canWrite: false }), /lecture seule/);
  assert.match(queryGit(repo, { action: "commit", message: "x" }, { canWrite: false }), /lecture seule/);
  assert.match(queryGit(repo, { action: "status" }, { canWrite: false }), /Sur la branche|HEAD/);
});

test("git: full flow — stage, commit, status, diff, log, blame, branch", () => {
  if (!gitAvailable()) return;
  const repo = scratchRepo();
  fs.writeFileSync(path.join(repo, "app.txt"), "line one\nline two\n");
  assert.match(queryGit(repo, { action: "stage", path: "." }), /Mis en staging/);
  assert.match(queryGit(repo, { action: "commit", message: "Add app" }), /Add app|master|main|create/i);
  assert.match(queryGit(repo, { action: "status" }), /propre/);
  assert.match(queryGit(repo, { action: "commit", message: "Empty" }), /rien en staging/);
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

test("git sync status compares only cached upstream refs without contacting a remote", () => {
  if (!gitAvailable()) return;
  const repo = scratchRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "smol-git-origin-"));
  const git = (cwd, args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15000, windowsHide: true });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(bare, ["init", "--bare"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["push", "-u", "origin", "HEAD"]);

  assert.deepEqual((({ branch, upstream, ahead, behind }) => ({ branch, upstream, ahead, behind }))(gitSyncStatus(repo)), {
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
  });
  fs.appendFileSync(path.join(repo, "tracked.txt"), "local\n");
  git(repo, ["commit", "-am", "local"]);
  const localAhead = gitSyncStatus(repo);
  assert.equal(localAhead.ahead, 1);
  assert.equal(localAhead.behind, 0);
  assert.equal(localAhead.upstream, "origin/main");

  const noUpstream = gitSyncStatus(scratchRepo());
  assert.equal(noUpstream.upstream, null);
  assert.equal(noUpstream.ahead, null);
  assert.equal(noUpstream.behind, null);
});

const DIFF_SAMPLE = `diff --git a/app.txt b/app.txt
index 1111111..2222222 100644
--- a/app.txt
+++ b/app.txt
@@ -1,3 +1,3 @@
 line1
-old2
+new2
 line3
@@ -17,3 +17,3 @@ line17
-old18
+new18
 line19
`;

test("git: hunk parsing splits files and rebuilds headers", () => {
  const { parseDiffHunks, fileHeaderFor } = require("../dist/git");
  const files = parseDiffHunks(DIFF_SAMPLE);
  assert.equal(files.length, 1);
  assert.equal(files[0].file, "app.txt");
  assert.equal(files[0].hunks.length, 2);
  assert.equal(files[0].hunks[0].index, 0);
  assert.equal(files[0].hunks[1].index, 1);
  assert.match(files[0].hunks[0].header, /@@/);
  assert.ok(files[0].hunks[0].lines.some((l) => l === "-old2"));
  const header = fileHeaderFor(DIFF_SAMPLE, "app.txt");
  assert.ok(header[0].startsWith("diff --git"));
  assert.ok(header.some((l) => l.startsWith("+++")));
  assert.deepEqual(parseDiffHunks(""), []);
  assert.deepEqual(fileHeaderFor(DIFF_SAMPLE, "missing.txt"), []);
});

function scratchHunkRepo() {
  const ws = scratchRepo();
  const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
  fs.writeFileSync(path.join(ws, "app.txt"), `${lines.join("\n")}\n`);
  spawnSync("git", ["add", "."], { cwd: ws, windowsHide: true });
  spawnSync("git", ["commit", "-m", "base"], { cwd: ws, windowsHide: true });
  return ws;
}

test("git: stage and revert one hunk without touching the other", () => {
  if (!gitAvailable()) return;
  const { gitDiffFiles, gitApplyHunk } = require("../dist/git");
  const repo = scratchHunkRepo();
  const changed = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
  changed[1] = "CHANGED2";
  changed[17] = "CHANGED18";
  fs.writeFileSync(path.join(repo, "app.txt"), `${changed.join("\n")}\n`);
  const before = gitDiffFiles(repo);
  assert.equal(before.files.length, 1);
  assert.equal(before.files[0].hunks.length, 2);
  assert.match(gitApplyHunk(repo, "app.txt", 0, "stage"), /Hunk 0 .*staging|mis en staging/i);
  const staged = spawnSync("git", ["diff", "--cached"], { cwd: repo, encoding: "utf8", windowsHide: true }).stdout;
  assert.match(staged, /CHANGED2/);
  assert.doesNotMatch(staged, /CHANGED18/);
  assert.match(gitApplyHunk(repo, "app.txt", 9, "stage"), /n’existe plus/);
  assert.match(gitApplyHunk(repo, "app.txt", 0, "revert"), /Hunk 0 .*annulé/);
  const content = fs.readFileSync(path.join(repo, "app.txt"), "utf8");
  assert.match(content, /CHANGED2/);
  assert.doesNotMatch(content, /CHANGED18/);
  const unstaged = spawnSync("git", ["diff"], { cwd: repo, encoding: "utf8", windowsHide: true }).stdout;
  assert.equal(unstaged.trim(), "", "nothing left unstaged");
});

test("git: unstage returns the index to HEAD while the working tree keeps every change", () => {
  if (!gitAvailable()) return;
  const { gitUnstage, gitApplyHunk } = require("../dist/git");
  const repo = scratchHunkRepo();
  const changed = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
  changed[1] = "CHANGED2";
  changed[17] = "CHANGED18";
  fs.writeFileSync(path.join(repo, "app.txt"), `${changed.join("\n")}\n`);
  const cached = () => spawnSync("git", ["diff", "--cached"], { cwd: repo, encoding: "utf8", windowsHide: true }).stdout;

  assert.match(gitUnstage(repo, ["app.txt"]), /Rien en staging pour app\.txt/, "says so before anything is staged");
  assert.match(queryGit(repo, { action: "stage", path: "app.txt" }), /Mis en staging : app\.txt/);
  assert.match(gitUnstage(repo, ["app.txt"]), /Retiré du staging : app\.txt/);
  assert.equal(cached().trim(), "", "the index is back to HEAD");
  const onDisk = fs.readFileSync(path.join(repo, "app.txt"), "utf8");
  assert.match(onDisk, /CHANGED2/, "the working tree keeps every change");
  assert.match(onDisk, /CHANGED18/);

  // one hunk staged, then taken back out of the index
  assert.match(gitApplyHunk(repo, "app.txt", 0, "stage"), /Hunk 0 .*staging|mis en staging/i);
  assert.match(cached(), /CHANGED2/);
  assert.match(gitApplyHunk(repo, "app.txt", 0, "unstage"), /Hunk 0 .*retiré du staging/);
  assert.equal(cached().trim(), "", "the hunk left the index");
  assert.match(fs.readFileSync(path.join(repo, "app.txt"), "utf8"), /CHANGED2/, "still in the working tree");
  assert.match(gitApplyHunk(repo, "app.txt", 0, "unstage"), /n’est pas en staging/, "an honest second try");
  assert.match(gitApplyHunk(repo, "app.txt", 0, "explode"), /l’action doit être/);

  assert.match(queryGit(repo, { action: "unstage", path: "app.txt" }, { canWrite: false }), /lecture seule/);
  assert.match(queryGit(repo, { action: "unstage_hunk", path: "app.txt", hunk: 0 }, { canWrite: false }), /lecture seule/);
  assert.match(queryGit(repo, {}), /unstage_hunk/, "the help lists it");
});

test("git: unstage also works before the first commit", () => {
  if (!gitAvailable()) return;
  const { gitUnstage } = require("../dist/git");
  const ws = scratchRepo();
  fs.writeFileSync(path.join(ws, "a.txt"), "hi\n");
  spawnSync("git", ["add", "a.txt"], { cwd: ws, windowsHide: true });
  assert.match(gitUnstage(ws, ["a.txt"]), /Retiré du staging : a\.txt/);
  assert.equal(
    spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: ws, encoding: "utf8", windowsHide: true }).stdout.trim(),
    "",
    "the path left the empty index"
  );
  assert.ok(fs.existsSync(path.join(ws, "a.txt")), "the file itself is untouched");
});

test("git: review actions through the tool, gated in read-only", () => {
  if (!gitAvailable()) return;
  const repo = scratchHunkRepo();
  fs.writeFileSync(path.join(repo, "new.txt"), "hello\n");
  assert.match(queryGit(repo, { action: "review" }), /Non suivis.*new\.txt/);
  assert.match(queryGit(repo, { action: "review" }, { canWrite: false }), /Non suivis/);
  assert.match(queryGit(repo, { action: "stage_hunk", path: "new.txt", hunk: 0 }, { canWrite: false }), /lecture seule/);
  assert.match(queryGit(repo, { action: "revert_hunk", path: "new.txt", hunk: 0 }, { canWrite: false }), /lecture seule/);
  assert.match(queryGit(repo, { action: "stage_hunk", path: "app.txt", hunk: 5 }), /n’existe plus/);
  assert.match(queryGit(repo, {}), /stage_hunk/);
});

test("git: revert one file to HEAD", () => {
  if (!gitAvailable()) return;
  const { gitRevertFile } = require("../dist/git");
  const repo = scratchHunkRepo();
  const changed = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
  changed[1] = "CHANGED2";
  fs.writeFileSync(path.join(repo, "app.txt"), `${changed.join("\n")}\n`);
  assert.match(gitRevertFile(repo, "app.txt"), /"app\.txt" restauré à HEAD/);
  assert.ok(fs.readFileSync(path.join(repo, "app.txt"), "utf8").includes("line2"));
  assert.doesNotMatch(fs.readFileSync(path.join(repo, "app.txt"), "utf8"), /CHANGED2/);
  assert.match(gitRevertFile(repo, "."), /tout l’espace de travail/);
  assert.match(gitRevertFile(repo, "../evil.txt"), /à l’intérieur du dépôt/);
  assert.match(gitRevertFile(repo, "missing.txt"), /does not exist|échoué/);
});

test("git: stage selected lines with honest recounts", () => {
  const { rewriteHunkHeader } = require("../dist/git");
  assert.equal(rewriteHunkHeader("@@ -5,7 +5,6 @@ fn", 1, 2, 3), "@@ -5,4 +5,5 @@ fn");
  assert.equal(rewriteHunkHeader("garbage", 1, 1, 1), "garbage");
  if (!gitAvailable()) return;
  const { gitStageLines, gitDiffFiles } = require("../dist/git");
  const repo = scratchHunkRepo();
  const changed = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
  changed[1] = "L2x";
  changed[2] = "L3x";
  fs.writeFileSync(path.join(repo, "app.txt"), `${changed.join("\n")}\n`);
  const { files } = gitDiffFiles(repo);
  assert.equal(files.length, 1);
  const hunk = files[0].hunks[0];
  const delIdx = hunk.lines.findIndex((l) => l.startsWith("-"));
  const addIdx = hunk.lines.findIndex((l) => l.startsWith("+"));
  assert.ok(delIdx >= 0 && addIdx >= 0);
  assert.match(gitStageLines(repo, "app.txt", 0, []), /au moins/);
  assert.match(gitStageLines(repo, "app.txt", 9, [delIdx]), /n’existe plus/);
  assert.match(gitStageLines(repo, "app.txt", 0, [delIdx, addIdx]), /Mis en staging : 2 ligne/);
  const { spawnSync } = require("node:child_process");
  const staged = spawnSync("git", ["diff", "--cached"], { cwd: repo, encoding: "utf8", windowsHide: true }).stdout;
  assert.match(staged, /L2x/);
  assert.doesNotMatch(staged, /L3x/);
  const unstaged = spawnSync("git", ["diff"], { cwd: repo, encoding: "utf8", windowsHide: true }).stdout;
  assert.match(unstaged, /L3x/);
});

test("git: turn summary counts +/-, newcomers, and status badges", () => {
  if (!gitAvailable()) return;
  const { gitTurnSummary, gitStatusMap } = require("../dist/git");
  const repo = scratchHunkRepo();
  assert.equal(gitTurnSummary(repo, new Set()), null);
  assert.equal(gitTurnSummary(repo, new Set(["app.txt"])), null, "clean tree says nothing");
  fs.writeFileSync(path.join(repo, "app.txt"), "line1\nCHANGED\n");
  fs.writeFileSync(path.join(repo, "fresh.txt"), "new\n");
  const summary = gitTurnSummary(repo, new Set(["app.txt", "fresh.txt"]));
  assert.match(summary, /Fichiers modifiés : 1 \(\+\d+ −\d+\)/);
  assert.match(summary, /nouveau : fresh\.txt/);
  const map = gitStatusMap(repo, repo);
  assert.equal(map.get("app.txt"), "M");
  assert.equal(map.get("fresh.txt"), "U");
  spawnSync("git", ["add", "fresh.txt"], { cwd: repo, windowsHide: true });
  assert.equal(gitStatusMap(repo, repo).get("fresh.txt"), "A");
  fs.unlinkSync(path.join(repo, "app.txt"));
  assert.equal(gitStatusMap(repo, repo).get("app.txt"), "D");
  assert.equal(gitStatusMap(path.join(repo, "missing-dir"), repo).size, 0);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FileHistory } = require("../dist/file-history");

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smol-history-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "smol-ws-"));
  const fh = new FileHistory(root);
  return { root, workspace, fh };
}

test("beginTurn numbers turns persistently across instances", () => {
  const { root, fh } = setup();
  assert.equal(fh.beginTurn("s1", "first"), 1);
  assert.equal(fh.beginTurn("s1", "second"), 2);
  const reopened = new FileHistory(root);
  assert.equal(reopened.beginTurn("s1", "third"), 3);
  assert.equal(reopened.readIndex("s1").length, 3);
  assert.equal(reopened.readIndex("s1")[0].prompt, "first");
});

test("capture before overwrite and restore bring the previous content back", () => {
  const { workspace, fh } = setup();
  const file = path.join(workspace, "a.txt");
  fs.writeFileSync(file, "v1");
  fh.beginTurn("s1", "change a");
  fh.capture("s1", workspace, "a.txt", "edit");
  fs.writeFileSync(file, "v2");
  const outcome = fh.restore("s1", 1, workspace);
  assert.deepEqual(outcome.restored, ["a.txt"]);
  assert.equal(fs.readFileSync(file, "utf8"), "v1");
});

test("a file created during a turn is deleted by restore", () => {
  const { workspace, fh } = setup();
  const file = path.join(workspace, "new.txt");
  fh.beginTurn("s1", "create new");
  fh.capture("s1", workspace, "new.txt", "write");
  fs.writeFileSync(file, "created");
  const outcome = fh.restore("s1", 1, workspace);
  assert.deepEqual(outcome.deleted, ["new.txt"]);
  assert.equal(fs.existsSync(file), false);
});

test("multi-turn restore rewinds to the state before the chosen turn", () => {
  const { workspace, fh } = setup();
  const file = path.join(workspace, "a.txt");
  fs.writeFileSync(file, "v1");
  fh.beginTurn("s1", "tour 1");
  fh.capture("s1", workspace, "a.txt", "edit");
  fs.writeFileSync(file, "v2");
  fh.beginTurn("s1", "tour 2");
  fh.capture("s1", workspace, "a.txt", "edit");
  fs.writeFileSync(file, "v3");

  const back2 = fh.restore("s1", 2, workspace);
  assert.deepEqual(back2.restored, ["a.txt"]);
  assert.equal(fs.readFileSync(file, "utf8"), "v2");

  const back1 = fh.restore("s1", 1, workspace);
  assert.deepEqual(back1.restored, ["a.txt"]);
  assert.equal(fs.readFileSync(file, "utf8"), "v1");
});

test("only the first capture of a file counts within one turn", () => {
  const { workspace, fh } = setup();
  const file = path.join(workspace, "a.txt");
  fs.writeFileSync(file, "before");
  fh.beginTurn("s1", "two edits");
  fh.capture("s1", workspace, "a.txt", "edit");
  fs.writeFileSync(file, "middle");
  fh.capture("s1", workspace, "a.txt", "edit"); // must be ignored
  fs.writeFileSync(file, "after");
  fh.restore("s1", 1, workspace);
  assert.equal(fs.readFileSync(file, "utf8"), "before");
  assert.equal(fh.readIndex("s1")[0].files.length, 1);
});

test("a move is rewound on both ends", () => {
  const { workspace, fh } = setup();
  const from = path.join(workspace, "old.txt");
  const to = path.join(workspace, "new.txt");
  fs.writeFileSync(from, "payload");
  fh.beginTurn("s1", "move it");
  fh.capture("s1", workspace, "old.txt", "move");
  fh.capture("s1", workspace, "new.txt", "move");
  fs.renameSync(from, to);
  const outcome = fh.restore("s1", 1, workspace);
  assert.deepEqual(outcome.restored, ["old.txt"]);
  assert.deepEqual(outcome.deleted, ["new.txt"]);
  assert.equal(fs.readFileSync(from, "utf8"), "payload");
  assert.equal(fs.existsSync(to), false);
});

test("an empty folder created during a turn is removed by restore", () => {
  const { workspace, fh } = setup();
  const dir = path.join(workspace, "fresh");
  fh.beginTurn("s1", "mkdir");
  fh.capture("s1", workspace, "fresh", "mkdir");
  fs.mkdirSync(dir);
  const outcome = fh.restore("s1", 1, workspace);
  assert.deepEqual(outcome.deleted, ["fresh"]);
  assert.equal(fs.existsSync(dir), false);
});

test("oversized files are skipped and reported by restore", () => {
  const { workspace, fh } = setup();
  const file = path.join(workspace, "big.bin");
  fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024 + 1, 1));
  fh.beginTurn("s1", "touch big");
  fh.capture("s1", workspace, "big.bin", "edit");
  assert.equal(fh.readIndex("s1")[0].files[0].blob, null);
  assert.equal(fh.readIndex("s1")[0].files[0].skipped, "too-large");
  fs.writeFileSync(file, "overwritten");
  const outcome = fh.restore("s1", 1, workspace);
  assert.equal(outcome.restored.length, 0);
  assert.match(outcome.failed[0].reason, /too-large|trop volumineux|2/);
});

test("suspect relative paths are never captured", () => {
  const { workspace, fh } = setup();
  fh.beginTurn("s1", "evil");
  fh.capture("s1", workspace, "../outside.txt", "write");
  fh.capture("s1", workspace, "/abs.txt", "write");
  fh.capture("s1", workspace, "C:\\win.txt", "write");
  assert.equal(fh.readIndex("s1")[0].files.length, 0);
});

test("identical contents share one blob", () => {
  const { root, workspace, fh } = setup();
  fs.writeFileSync(path.join(workspace, "a.txt"), "same");
  fs.writeFileSync(path.join(workspace, "b.txt"), "same");
  fh.beginTurn("s1", "both");
  fh.capture("s1", workspace, "a.txt", "edit");
  fh.capture("s1", workspace, "b.txt", "edit");
  const sid = "s1";
  const blobs = fs.readdirSync(path.join(root, sid, "blobs"));
  assert.equal(blobs.length, 1);
});

test("a corrupted index reads empty and never throws", () => {
  const { root, workspace, fh } = setup();
  const dir = path.join(root, "s1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.json"), "{not json");
  assert.deepEqual(fh.readIndex("s1"), []);
  assert.deepEqual(fh.list("s1"), []);
  assert.equal(fh.beginTurn("s1", "recover"), 1);
  // capture works again on the fresh index
  fs.writeFileSync(path.join(workspace, "x.txt"), "x");
  fh.capture("s1", workspace, "x.txt", "edit");
  assert.equal(fh.readIndex("s1")[0].files.length, 1);
});

test("restoring an unknown turn changes nothing", () => {
  const { workspace, fh } = setup();
  fs.writeFileSync(path.join(workspace, "a.txt"), "keep");
  fh.beginTurn("s1", "one");
  const outcome = fh.restore("s1", 99, workspace);
  assert.equal(outcome.restored.length + outcome.deleted.length + outcome.failed.length, 0);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "keep");
});

test("tool writes are captured through the tool context and rewound", async () => {
  const { root, workspace } = setup();
  const { executeTool } = require("../dist/tools");
  const fh = new FileHistory(root);
  const ctx = {
    workspace,
    filesTouched: new Set(),
    commandsRun: [],
    fileHistory: fh,
    sessionId: "s1",
  };
  fs.writeFileSync(path.join(workspace, "a.txt"), "v1\n");
  fh.beginTurn("s1", "tour outils");
  await executeTool("write_file", { path: "a.txt", content: "v2\n" }, ctx);
  await executeTool("write_file", { path: "new.txt", content: "fresh\n" }, ctx);
  await executeTool("edit_file", { path: "a.txt", old_text: "v2", new_text: "v3" }, ctx);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "v3\n");
  assert.equal(fs.existsSync(path.join(workspace, "new.txt")), true);

  const outcome = fh.restore("s1", 1, workspace);
  assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "v1\n");
  assert.equal(fs.existsSync(path.join(workspace, "new.txt")), false);
  assert.deepEqual(outcome.failed, []);
  assert.equal(outcome.restored.length + outcome.deleted.length, 2);
});

test("without a session id the tools never touch the history", async () => {
  const { root, workspace } = setup();
  const { executeTool } = require("../dist/tools");
  const fh = new FileHistory(root);
  const ctx = { workspace, filesTouched: new Set(), commandsRun: [], fileHistory: fh };
  fh.beginTurn("s1", "sans session");
  const result = await executeTool("write_file", { path: "a.txt", content: "x" }, ctx);
  assert.doesNotMatch(result, /^Error/);
  assert.equal(fh.readIndex("s1")[0].files.length, 0);
});

test("list returns newest turns first and is bounded", () => {
  const { fh } = setup();
  for (let i = 1; i <= 25; i++) fh.beginTurn("s1", `tour ${i}`);
  const recent = fh.list("s1", 5);
  assert.equal(recent.length, 5);
  assert.equal(recent[0].turn, 25);
  assert.equal(recent[4].turn, 21);
});

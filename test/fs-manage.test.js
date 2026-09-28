// The file-shape tools: move_path, delete_path, create_folder — sandbox
// containment, no silent overwrite, folder deletes that ask first, and the
// read-only gate that keeps them out of ro mode entirely.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { movePath, deletePath, createFolder } = require("../dist/tools/fs-tools");
const { executeTool, buildToolSpecs } = require("../dist/tools/index");
const { Plan } = require("../dist/plan");
const { TaskManager } = require("../dist/tools/tasks");

function scratch(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-manage-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    if (content === null) fs.mkdirSync(p, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, "utf8");
    }
  }
  return dir;
}
function ctxFor(dir) {
  return { workspace: dir, taskManager: new TaskManager(dir), plan: new Plan(), filesTouched: new Set(), commandsRun: [] };
}

test("move_path reorganizes files and folders and never overwrites silently", () => {
  const dir = scratch({ "draft.ts": "export const x = 1;\n", "keep.ts": "keep\n", "src/real.ts": "real\n" });
  assert.match(movePath(dir, { from: "draft.ts", to: "src/draft.ts" }), /Moved file "draft\.ts" → "src\/draft\.ts"/);
  assert.ok(fs.existsSync(path.join(dir, "src", "draft.ts")), "the file landed at the new path");
  assert.ok(!fs.existsSync(path.join(dir, "draft.ts")), "the old path is gone");
  assert.match(movePath(dir, { from: "keep.ts", to: "src/draft.ts" }), /already exists/);
  assert.match(fs.readFileSync(path.join(dir, "src", "draft.ts"), "utf8"), /export const x/, "the existing file was not clobbered");
  assert.ok(fs.existsSync(path.join(dir, "keep.ts")), "the source of a refused move stays put");
  assert.match(movePath(dir, { from: "ghost.ts", to: "x.ts" }), /does not exist/);
  assert.match(movePath(dir, { from: "", to: "x.ts" }), /both "from" and "to"/);
  assert.match(movePath(dir, { from: "keep.ts", to: "keep.ts" }), /Nothing to do/);
  fs.mkdirSync(path.join(dir, "old"), { recursive: true });
  fs.writeFileSync(path.join(dir, "old", "inside.txt"), "deep\n", "utf8");
  assert.match(movePath(dir, { from: "old", to: "archive/old" }), /Moved folder "old" → "archive\/old"/);
  assert.match(fs.readFileSync(path.join(dir, "archive", "old", "inside.txt"), "utf8"), /deep/, "folder contents travel with it");
});

test("delete_path asks before a folder, guards the root, and undoes a text file", async () => {
  const dir = scratch({ "a.txt": "alpha\n", "sub/b.txt": "beta\n" });
  assert.match(deletePath(dir, { path: "sub" }), /recursive.*true/is, "a non-empty folder asks for confirmation");
  assert.ok(fs.existsSync(path.join(dir, "sub", "b.txt")), "nothing was deleted yet");
  assert.match(deletePath(dir, { path: "sub", recursive: true }), /Deleted folder "sub" \(1 item/);
  assert.ok(!fs.existsSync(path.join(dir, "sub")), "the confirmed folder is gone");
  assert.match(deletePath(dir, { path: "." }), /workspace root/);
  assert.match(deletePath(dir, { path: "ghost.txt" }), /does not exist/);
  const ctx = ctxFor(dir);
  assert.match(await executeTool("delete_path", { path: "a.txt" }, ctx), /Deleted file "a\.txt"/);
  assert.ok(!fs.existsSync(path.join(dir, "a.txt")), "the file is gone");
  assert.equal(ctx.undoStack.length, 1, "a small text file is restorable");
  assert.equal(ctx.undoStack[0].kind, "delete", "redo knows how to take it out again");
  assert.equal(ctx.undoStack[0].prev, "alpha\n", "the content to restore was captured");
  assert.ok(ctx.filesTouched.has("a.txt"), "the UI is told the workspace changed");
});

test("create_folder is idempotent and refuses a file in the way", () => {
  const dir = scratch({ "exists.txt": "hi\n" });
  assert.match(createFolder(dir, { path: "src/components/ui" }), /Created folder "src\/components\/ui"/);
  assert.ok(fs.statSync(path.join(dir, "src", "components", "ui")).isDirectory());
  assert.match(createFolder(dir, { path: "src/components/ui" }), /already exists/);
  assert.match(createFolder(dir, { path: "exists.txt" }), /exists as a file/);
  assert.match(createFolder(dir, { path: "" }), /path is required/);
  assert.match(createFolder(dir, { path: "." }), /workspace root/);
});

test("the shape tools are absent in read-only mode and guarded anyway", async () => {
  const dir = scratch({ "a.txt": "x\n" });
  const ro = buildToolSpecs("ro").map((s) => s.name);
  assert.ok(!ro.includes("move_path") && !ro.includes("delete_path") && !ro.includes("create_folder"), "ro mode hides them");
  const edit = buildToolSpecs("edit").map((s) => s.name);
  assert.ok(edit.includes("move_path") && edit.includes("delete_path") && edit.includes("create_folder"), "edit mode offers them");
  const ctx = { ...ctxFor(dir), canWrite: false };
  assert.match(await executeTool("move_path", { from: "a.txt", to: "b.txt" }, ctx), /read-only/);
  assert.match(await executeTool("delete_path", { path: "a.txt" }, ctx), /read-only/);
  assert.match(await executeTool("create_folder", { path: "newdir" }, ctx), /read-only/);
  assert.ok(fs.existsSync(path.join(dir, "a.txt")), "read-only really touches nothing");
  assert.ok(!fs.existsSync(path.join(dir, "b.txt")) && !fs.existsSync(path.join(dir, "newdir")));
});

test("paths that escape the workspace are refused by the sandbox", () => {
  const dir = scratch({ "inside.txt": "here\n" });
  assert.throws(() => movePath(dir, { from: "../outside.txt", to: "x.txt" }), /hors du dossier de travail|outside/i);
  assert.throws(() => deletePath(dir, { path: "../" }), /hors du dossier de travail|outside/i);
  assert.throws(() => createFolder(dir, { path: "../evil" }), /hors du dossier de travail|outside/i);
});

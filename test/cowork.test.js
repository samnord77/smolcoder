const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CoworkBoard } = require("../dist/tools/cowork");
const { buildToolSpecs, executeTool } = require("../dist/tools");

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "smol-cowork-"));
}

test("work items persist across board instances and support filters and completion", () => {
  const root = workspace();
  const board = new CoworkBoard(root);
  const created = board.run({
    action: "create",
    title: "Prepare quarterly report",
    area: "work",
    due: "2026-10-02",
    priority: "high",
    notes: "Include Excel figures",
  });
  const id = created.match(/(w_[a-f0-9-]{36})/)?.[1];
  assert.ok(id, created);
  assert.match(new CoworkBoard(root).run({ action: "list", area: "work" }), /Prepare quarterly report/);
  assert.doesNotMatch(board.run({ action: "list", area: "personal" }), /Prepare quarterly report/);
  assert.match(board.run({ action: "complete", task_id: id }), /completed/);
  assert.match(new CoworkBoard(root).run({ action: "list", status: "completed" }), /Prepare quarterly report/);
  assert.doesNotMatch(board.run({ action: "list", status: "open" }), /Prepare quarterly report/);
});

test("work item fields are validated and update keeps the stable id", () => {
  const board = new CoworkBoard(workspace());
  assert.match(board.run({ action: "create", title: "   " }), /^Error:/);
  assert.match(board.run({ action: "create", title: "Trip", due: "2026-02-30" }), /^Error:/);
  assert.match(board.run({ action: "create", title: "Task", priority: "impossible" }), /^Error:/);
  const created = board.run({ action: "create", title: "Book appointment" });
  const id = created.match(/(w_[a-f0-9-]{36})/)?.[1];
  assert.match(board.run({ action: "update", task_id: id, title: "Book dentist appointment", due: "2026-10-01" }), /Updated/);
  assert.match(board.run({ action: "list" }), new RegExp(id));
  assert.match(board.run({ action: "list" }), /2026-10-01/);
  assert.match(board.run({ action: "archive", task_id: "missing" }), /^Error:/);
});

test("the unified work tool is available to read-only agents for listing and gates mutations", async () => {
  const root = workspace();
  const names = buildToolSpecs("ro").map((spec) => spec.name);
  assert.ok(names.includes("work"));
  const ctx = { workspace: root, canWrite: false };
  assert.match(await executeTool("work", { action: "create", title: "Must not be added" }, ctx), /^Error:/);
  assert.match(await executeTool("work", { action: "list" }, ctx), /No work items/);
});

test("a restricted sub-agent cannot bypass its allowlist through direct tool execution", async () => {
  const root = workspace();
  const result = await executeTool(
    "write_file",
    { path: "blocked.txt", content: "no" },
    {
      workspace: root,
      role: "architect",
      allowedTools: new Set(["read_file", "search"]),
    }
  );
  assert.match(result, /write_file is unavailable for the architect role/);
  assert.equal(fs.existsSync(path.join(root, "blocked.txt")), false);
});

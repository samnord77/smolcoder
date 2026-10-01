const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { CoworkBoard } = require("../dist/tools/cowork");
const { buildToolSpecs, executeTool } = require("../dist/tools");

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "smol-cowork-"));
}

test("work items persist across board instances and support filters and completion", async () => {
  const root = workspace();
  const board = new CoworkBoard(root);
  const created = await board.run({
    action: "create",
    title: "Prepare quarterly report",
    area: "work",
    due: "2026-10-02",
    priority: "high",
    notes: "Include Excel figures",
  });
  const id = created.match(/(w_[a-f0-9-]{36})/)?.[1];
  assert.ok(id, created);
  assert.match(await new CoworkBoard(root).run({ action: "list", area: "work" }), /Prepare quarterly report/);
  assert.equal(new CoworkBoard(root).items().length, 1);
  assert.equal(new CoworkBoard(root).items()[0].status, "open");
  assert.doesNotMatch(await board.run({ action: "list", area: "personal" }), /Prepare quarterly report/);
  assert.match(await board.run({ action: "complete", task_id: id }), /completed/);
  assert.match(await new CoworkBoard(root).run({ action: "list", status: "completed" }), /Prepare quarterly report/);
  assert.doesNotMatch(await board.run({ action: "list", status: "open" }), /Prepare quarterly report/);
});

test("work item fields are validated and update keeps the stable id", async () => {
  const board = new CoworkBoard(workspace());
  assert.match(await board.run({ action: "create", title: "   " }), /^Error:/);
  assert.match(await board.run({ action: "create", title: "Trip", due: "2026-02-30" }), /^Error:/);
  assert.match(await board.run({ action: "create", title: "Task", priority: "impossible" }), /^Error:/);
  const created = await board.run({ action: "create", title: "Book appointment" });
  const id = created.match(/(w_[a-f0-9-]{36})/)?.[1];
  assert.match(await board.run({ action: "update", task_id: id, title: "Book dentist appointment", due: "2026-10-01" }), /Updated/);
  assert.match(await board.run({ action: "list" }), new RegExp(id));
  assert.match(await board.run({ action: "list" }), /2026-10-01/);
  assert.match(await board.run({ action: "archive", task_id: "missing" }), /^Error:/);
});

test("concurrent Smolcoder processes do not overwrite shared work-item updates", async () => {
  const root = workspace();
  const modulePath = path.resolve(__dirname, "../dist/tools/cowork");
  const script = `
    const { CoworkBoard } = require(process.argv[1]);
    const board = new CoworkBoard(process.argv[2]);
    (async () => {
      for (let i = 0; i < 30; i++) {
        const result = await board.run({ action: "create", title: process.argv[3] + "-" + i });
        if (result.startsWith("Error:")) throw new Error(result);
      }
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const runWorker = (prefix) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", script, modulePath, root, prefix], { stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`work-item worker exited ${code}`))));
    });

  await Promise.all([runWorker("first"), runWorker("second")]);
  const items = new CoworkBoard(root).items();
  assert.equal(items.length, 60);
  assert.equal(new Set(items.map((item) => item.title)).size, 60);
});

test("a stale lock left by a crashed process does not block future work", async () => {
  const root = workspace();
  const lock = path.join(root, ".smol", "work-items.json.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: "orphaned" }));

  assert.match(await new CoworkBoard(root).run({ action: "create", title: "Recover board" }), /^Created/);
  assert.equal(fs.existsSync(lock), false);
});

test("waiting for another process's board lock does not block the event loop", async () => {
  const root = workspace();
  const lock = path.join(root, ".smol", "work-items.json.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "held-by-test" }));

  const pending = new CoworkBoard(root).run({ action: "create", title: "Responsive board" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fs.existsSync(lock), true, "the live lock remains owned by this process");
  fs.unlinkSync(lock);
  assert.match(await pending, /^Created/);
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

test("pro cowork supports role assignment, acceptance criteria, snapshots and verified execution reports", async () => {
  const root = workspace();
  const board = new CoworkBoard(root);
  const created = await board.run({
    action: "create",
    title: "Implement OAuth flow",
    role: "architect",
    acceptance: "All 10 tests green and zero security leaks",
  });
  const id = created.match(/(w_[a-f0-9-]{36})/)?.[1];
  assert.ok(id, created);
  assert.match(created, /assigned to architect/);

  let items = board.items();
  assert.equal(items.length, 1);
  assert.equal(items[0].assignedRole, "architect");
  assert.equal(items[0].acceptanceCriteria, "All 10 tests green and zero security leaks");
  assert.equal(items[0].executionStatus, "idle");

  // Re-assign to implementer
  const assigned = await board.run({
    action: "assign",
    task_id: id,
    role: "implementer",
    acceptance: "Re-run test suite with 100% pass",
  });
  assert.match(assigned, /Assigned work item/);
  assert.match(assigned, /implementer/);

  // Record execution report with verification and snapshot
  const reported = await board.run({
    action: "record_report",
    task_id: id,
    report: "Successfully wired OAuth endpoint and passed acceptance checks.",
    execution_status: "verified",
    mark_completed: true,
    snapshot: { file: "src/auth.ts", summary: "Added OAuth routes" },
  });
  assert.match(reported, /Recorded execution report/);
  assert.match(reported, /status=completed/);
  assert.match(reported, /execution=verified/);

  items = board.items();
  assert.equal(items[0].status, "completed");
  assert.equal(items[0].executionStatus, "verified");
  assert.equal(items[0].assignedRole, "implementer");
  assert.equal(items[0].snapshots?.length, 1);
  assert.equal(items[0].snapshots?.[0].file, "src/auth.ts");

  // Listing reflects role and verified state
  const list = await board.run({ action: "list", status: "completed" });
  assert.match(list, /@implementer/);
  assert.match(list, /\[verified\]/);
  assert.match(list, /Report: Successfully wired OAuth/);
});

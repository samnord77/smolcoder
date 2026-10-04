const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { searchLocalFilesBounded } = require("../dist/tools/local-search");
const { buildToolSpecs, executeTool } = require("../dist/tools/index");
const { Plan } = require("../dist/plan");
const { TaskManager } = require("../dist/tools/tasks");

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-local-search-"));
  return dir;
}

test("local filename search finds matching files and folders without reading contents", async (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "DeepSeek-models"));
  fs.writeFileSync(path.join(root, "deepseek-config.json"), "secret contents");
  fs.writeFileSync(path.join(root, "DeepSeek-models", "weights.bin"), "model data");

  const result = await searchLocalFilesBounded(root, { query: "deepseek", path: root });

  assert.match(result, /DeepSeek-models/);
  assert.match(result, /deepseek-config\.json/);
  assert.doesNotMatch(result, /secret contents|model data/);
  assert.match(result, /File contents were not opened/);
});

test("local filename search skips generated directories, validates roots, and reports bounded results", async (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "node_modules", "deepseek-hidden"), { recursive: true });
  fs.mkdirSync(path.join(root, "DeepSeek-one"));
  fs.mkdirSync(path.join(root, "DeepSeek-two"));

  const limited = await searchLocalFilesBounded(root, { query: "deepseek", path: root, max_results: 1 });
  assert.match(limited, /DeepSeek-(one|two)/);
  assert.doesNotMatch(limited, /deepseek-hidden/);
  assert.match(limited, /bounded and may be incomplete/);
  assert.match(
    await searchLocalFilesBounded(root, { query: "deepseek", path: path.join(root, "missing") }),
    /^Error:.*cannot read search folder/
  );
  assert.match(await searchLocalFilesBounded(root, { query: "x" }), /^Error: query must be 2–120 characters/);
});

test("find_local is available in read-only mode and invokes the bounded local search", async (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "deepseek-dir"));
  const names = buildToolSpecs("ro").map((tool) => tool.name);
  assert.ok(names.includes("find_local"));

  const output = await executeTool(
    "find_local",
    { query: "deepseek", path: "." },
    { workspace: root, taskManager: new TaskManager(root), plan: new Plan(), filesTouched: new Set(), commandsRun: [], canWrite: false }
  );

  assert.match(output, /deepseek-dir/);
  assert.doesNotMatch(output, /^Error:/);
});

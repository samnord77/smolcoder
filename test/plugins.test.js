// Tool plugins: block, rewrite, after-transform, broken plugin safety.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadPlugins } = require("../dist/plugins");
const { executeTool } = require("../dist/tools/index");
const { Plan } = require("../dist/plan");
const { TaskManager } = require("../dist/tools/tasks");

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "smol-plugins-"));
}

function writePlugin(ws, name, content) {
  const dir = path.join(ws, ".smol", "plugins");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content, "utf8");
}

function makeCtx(ws, plugins) {
  return { workspace: ws, taskManager: new TaskManager(ws), plan: new Plan(), filesTouched: new Set(), commandsRun: [], plugins };
}

test("before-hook block stops the tool and returns the block message", async () => {
  const ws = scratch();
  assert.deepEqual(loadPlugins(ws), []);
  writePlugin(
    ws,
    "block.cjs",
    'module.exports = { beforeTool(name) { if (name === "write_file") return { block: "no writes in test" }; return null; } };'
  );
  const plugins = loadPlugins(ws);
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].ok, true);
  const ctx = makeCtx(ws, plugins);
  const r = await executeTool("write_file", { path: "oops.txt", content: "hi" }, ctx);
  assert.match(r, /no writes in test/);
  assert.ok(!fs.existsSync(path.join(ws, "oops.txt")));
});

test("before-hook rewrite replaces args", async () => {
  const ws = scratch();
  fs.writeFileSync(path.join(ws, "orig.txt"), "ORIG", "utf8");
  fs.writeFileSync(path.join(ws, "rewritten.txt"), "REWRITTEN", "utf8");
  writePlugin(
    ws,
    "rewrite.cjs",
    'module.exports = { beforeTool(name, args) { if (name === "read_file" && args.path === "orig.txt") return { args: { ...args, path: "rewritten.txt" } }; return null; } };'
  );
  const plugins = loadPlugins(ws);
  assert.equal(plugins[0].ok, true);
  const ctx = makeCtx(ws, plugins);
  const r = await executeTool("read_file", { path: "orig.txt" }, ctx);
  assert.match(r, /REWRITTEN/);
});

test("after-hook transforms the result", async () => {
  const ws = scratch();
  fs.writeFileSync(path.join(ws, "a.txt"), "hello", "utf8");
  writePlugin(
    ws,
    "after.cjs",
    'module.exports = { afterTool(name, result) { if (name === "read_file") return result + "\\n[via-plugin]"; } };'
  );
  const plugins = loadPlugins(ws);
  assert.equal(plugins[0].ok, true);
  const ctx = makeCtx(ws, plugins);
  const r = await executeTool("read_file", { path: "a.txt" }, ctx);
  assert.match(r, /via-plugin/);
});

test("broken plugin is listed as error without crashing", async () => {
  const ws = scratch();
  writePlugin(ws, "broken.cjs", 'throw new Error("boom-load");');
  const plugins = loadPlugins(ws);
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].ok, false);
  assert.match(plugins[0].error, /boom-load/);
  const ctx = makeCtx(ws, plugins);
  fs.writeFileSync(path.join(ws, "ok.txt"), "hello", "utf8");
  const r = await executeTool("read_file", { path: "ok.txt" }, ctx);
  assert.match(r, /hello/);
});

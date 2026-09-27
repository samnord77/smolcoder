// Plugin marketplace: manifests, broken plugins, and the empty state.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadPlugins, readPluginManifest, listPluginInfos, describePlugins } = require("../dist/plugins");

function scratchWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-plug-"));
  fs.mkdirSync(path.join(ws, ".smol", "plugins"), { recursive: true });
  return ws;
}

function plugDir(ws) {
  return path.join(ws, ".smol", "plugins");
}

test("plugins: manifest cards, defaults, and broken plugins", () => {
  const ws = scratchWs();
  const dir = plugDir(ws);
  fs.writeFileSync(
    path.join(dir, "guard.cjs"),
    "module.exports = { beforeTool(n, a) { return null; }, afterTool(n, r) { return r; } };"
  );
  fs.writeFileSync(
    path.join(dir, "guard.json"),
    JSON.stringify({ version: "1.2.0", description: "Guards shell calls.", author: "team" })
  );
  fs.writeFileSync(path.join(dir, "naked.cjs"), "module.exports = {};");
  fs.writeFileSync(path.join(dir, "broken.cjs"), "throw new Error('boom');");
  fs.writeFileSync(path.join(dir, "broken.json"), "{oops");

  const loaded = loadPlugins(ws);
  assert.equal(loaded.length, 3);
  assert.ok(loaded.find((p) => p.name === "guard").ok);
  assert.ok(!loaded.find((p) => p.name === "broken").ok);

  const card = readPluginManifest(ws, "guard");
  assert.deepEqual(card, { name: "guard", version: "1.2.0", description: "Guards shell calls.", author: "team" });
  assert.equal(readPluginManifest(ws, "naked"), null);
  assert.equal(readPluginManifest(ws, "broken"), null, "invalid JSON is ignored");
  assert.equal(readPluginManifest(ws, "../evil"), null, "path traversal is refused");

  const infos = listPluginInfos(ws);
  const guard = infos.find((p) => p.name === "guard");
  assert.deepEqual(guard.hooks, ["beforeTool", "afterTool"]);
  const naked = infos.find((p) => p.name === "naked");
  assert.equal(naked.version, "0.0.0");
  assert.deepEqual(naked.hooks, []);

  const text = describePlugins(ws);
  assert.match(text, /guard v1\.2\.0 by team/);
  assert.match(text, /BROKEN: boom/);
});

test("plugins: empty workspace gets setup coaching", () => {
  const ws = scratchWs();
  assert.match(describePlugins(ws), /No plugins installed/);
  assert.match(describePlugins(ws), /\.smol\/plugins\/my-guard\.cjs/);
});

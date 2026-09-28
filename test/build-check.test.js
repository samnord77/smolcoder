// Build self-heal: missing/stale/ok detection without running npm.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { distState, distIndex } = require("../dist/build-check");

function scratchRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smol-buildcheck-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  return root;
}

test("distState reports missing, stale and ok", () => {
  const root = scratchRoot();
  assert.equal(distState(root), "missing");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "const x = 1;\n");
  const old = Date.now() - 60000;
  fs.writeFileSync(distIndex(root), "// built");
  fs.utimesSync(distIndex(root), new Date(old), new Date(old));
  assert.equal(distState(root), "stale");
  const now = new Date();
  fs.utimesSync(distIndex(root), now, now);
  fs.utimesSync(path.join(root, "src", "a.ts"), new Date(old), new Date(old));
  assert.equal(distState(root), "ok");
});

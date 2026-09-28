const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { searchWorkspace } = require("../dist/workspace-search");

test("workspace search is literal, bounded, ignores generated folders, and reports source locations", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smol-workspace-search-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.ts"), "const Value = 1;\nValue += 2;\n");
  fs.writeFileSync(path.join(root, "src", "image.bin"), Buffer.from([0, 1, 2, 0]));
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "skip.js"), "Value");

  const result = searchWorkspace(root, "value");
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].path, "src/app.ts");
  assert.equal(result.matches[0].line, 1);
  assert.equal(result.matches[0].text, "const Value = 1;");
  assert.equal(result.matches[1].line, 2);
  assert.equal(result.truncated, false);
});

test("workspace search validates the query and caps result count", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smol-workspace-search-cap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "many.txt"), Array.from({ length: 20 }, (_, i) => `hit ${i}`).join("\n"));
  assert.throws(() => searchWorkspace(root, "   "), /query/i);
  const result = searchWorkspace(root, "hit", { maxMatches: 3 });
  assert.equal(result.matches.length, 3);
  assert.equal(result.truncated, true);
});

test("workspace search caps total bytes read, even across many small files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smol-workspace-search-bytes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "a.txt"), "hit\n");
  fs.writeFileSync(path.join(root, "b.txt"), "hit\n");
  const result = searchWorkspace(root, "hit", { maxBytes: 5 });
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.matches.length, 1);
  assert.equal(result.truncated, true);
});

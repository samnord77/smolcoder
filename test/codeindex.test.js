// Code index: offline symbol search over a scratch workspace.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodeIndex, indexFor, clearIndexCache, queryIndex } = require("../dist/codeindex");

function scratchWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-index-"));
  fs.writeFileSync(
    path.join(ws, "a.ts"),
    "export function alpha(x: number): number { return x; }\nexport class Beta {}\nconst gamma = () => 1;\n"
  );
  fs.writeFileSync(path.join(ws, "b.py"), "def delta():\n    pass\n\nclass Epsilon:\n    pass\n");
  fs.writeFileSync(path.join(ws, "c.rs"), "pub fn zeta() {}\npub struct Eta;\n");
  fs.writeFileSync(path.join(ws, "notes.md"), "# alpha beta gamma\n");
  fs.mkdirSync(path.join(ws, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(ws, "node_modules", "dep", "x.js"), "function hidden() {}\n");
  return ws;
}

test("index: refresh scans supported files and skips the rest", () => {
  clearIndexCache();
  const ws = scratchWs();
  const st = indexFor(ws).refresh();
  assert.ok(st.files >= 3, `expected >=3 files, got ${st.files}`);
  assert.ok(st.symbols >= 7, `expected >=7 symbols, got ${st.symbols}`);
  const hit = indexFor(ws).search("alpha");
  assert.equal(hit[0].name, "alpha");
  assert.equal(hit[0].file, "a.ts");
  assert.equal(hit[0].line, 1);
  assert.ok(!indexFor(ws).search("hidden").length, "node_modules is never indexed");
  assert.ok(!indexFor(ws).search("notes").length, "markdown is not a code language");
});

test("index: ranking puts exact matches first", () => {
  clearIndexCache();
  const ws = scratchWs();
  fs.writeFileSync(path.join(ws, "d.ts"), "export function alphabet() {}\nexport function alpha2() {}\n");
  indexFor(ws).refresh();
  const found = indexFor(ws)
    .search("alpha")
    .map((s) => s.name);
  assert.equal(found[0], "alpha");
  assert.ok(found.includes("alphabet") && found.includes("alpha2"));
});

test("index: file listing and stats", () => {
  clearIndexCache();
  const ws = scratchWs();
  indexFor(ws).refresh();
  const names = indexFor(ws)
    .symbolsIn("b.py")
    .map((s) => s.name)
    .sort();
  assert.deepEqual(names, ["Epsilon", "delta"]);
  assert.match(queryIndex(ws, { action: "stats" }), /fichiers.*symboles/);
  assert.match(queryIndex(ws, { action: "file", path: "c.rs" }), /zeta/);
});

test("index: query validation and read-only guard", () => {
  clearIndexCache();
  const ws = scratchWs();
  assert.match(queryIndex(ws, {}), /l['’]action doit être l['’]une de/);
  assert.match(queryIndex(ws, { action: "search" }), /a besoin d['’]une requête/);
  assert.match(queryIndex(ws, { action: "search", query: "zzz-no-such-symbol" }), /Aucun symbole correspondant/);
  assert.match(queryIndex(ws, { action: "file" }), /a besoin d['’]un chemin/);
  assert.match(queryIndex(ws, { action: "refresh" }, { canWrite: false }), /lecture seule/);
  assert.match(queryIndex(ws, { action: "refresh" }), /Index reconstruit/);
});

test("index: disk cache reloads without a rescan", () => {
  clearIndexCache();
  const ws = scratchWs();
  indexFor(ws).refresh();
  const fresh = new CodeIndex(ws);
  assert.ok(fresh.isEmpty());
  assert.ok(fresh.loadCache());
  assert.ok(fresh.search("zeta").length > 0);
  clearIndexCache();
});

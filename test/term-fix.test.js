// Terminal auto-repair (Plan Puissance, Pilier 2): source-file extraction from
// the stack traces real tools print, plus the bounded prompt handed to the AI.
// Pure functions, no Electron, no network, no model.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTermErrorText, extractSourcePath } = require("../dist/term-fix");

const ROOT = "C:\\Users\\DELL\\smolcoder-source";

test("extractSourcePath turns an absolute trace into a workspace-relative path", () => {
  const trace = "Error: boom\n    at run (C:\\Users\\DELL\\smolcoder-source\\src\\agent.ts:42:7)";
  assert.equal(extractSourcePath(trace, ROOT), "src/agent.ts");
  assert.equal(extractSourcePath("C:/Users/DELL/smolcoder-source/desktop/preload.js:10:2", ROOT), "desktop/preload.js");
});

test("extractSourcePath keeps workspace-relative paths as reported", () => {
  assert.equal(extractSourcePath("  test/x.test.js:10:3\nexpected false"), "test/x.test.js");
  assert.equal(extractSourcePath("src/deep/module.ts(10,5): error TS2304"), "src/deep/module.ts");
  assert.equal(extractSourcePath("src/app.js(1,1): panic: index out of range"), "src/app.js");
});

test("extractSourcePath reads Python reports and paths containing spaces", () => {
  assert.equal(
    extractSourcePath('  File "C:\\Users\\DELL\\smolcoder-source\\my app\\main.py", line 12, in <module>', ROOT),
    "my app/main.py"
  );
  assert.equal(extractSourcePath('File "utils/helper.py", line 3'), "utils/helper.py");
});

test("extractSourcePath skips dependencies, build output and the runtime", () => {
  const trace = [
    "Error: x",
    "    at Object.<anonymous> (C:\\repo\\node_modules\\lib\\index.js:1:1)",
    "    at Object.<anonymous> (C:\\repo\\dist\\bundle.js:2:2)",
    "    at Object.<anonymous> (C:\\Users\\DELL\\smolcoder-source\\src\\app.ts:3:3)",
  ].join("\n");
  assert.equal(extractSourcePath(trace, ROOT), "src/app.ts");
});

test("extractSourcePath never leaves the workspace and never invents a file", () => {
  assert.equal(extractSourcePath("C:\\other\\project\\src\\a.ts:1", ROOT), null);
  assert.equal(extractSourcePath("", ROOT), null);
  assert.equal(extractSourcePath("tout va bien, aucune trace ici"), null);
  assert.equal(extractSourcePath("https://site.example/src/app.ts", ROOT), null);
  assert.equal(extractSourcePath(null, ROOT), null);
});

test("extractSourcePath does not truncate compound extensions", () => {
  assert.equal(extractSourcePath("src/native.cpp(4,1): error: bad token"), "src/native.cpp");
  assert.equal(extractSourcePath("src/view.html:9"), "src/view.html");
  assert.equal(extractSourcePath("src/entry.tsx:3"), "src/entry.tsx");
});

test("buildTermErrorText formats the command and bounds the AI prompt", () => {
  const text = buildTermErrorText("npm run build", "out", "boom");
  assert.match(text, /Commande : npm run build/);
  assert.match(text, /Sortie :\nout\nboom/);
  const bounded = buildTermErrorText("x".repeat(5000), "y".repeat(9000));
  assert.ok(bounded.length < 6000, "la trace reste bornée pour le contexte IA");
  assert.equal(buildTermErrorText(""), "");
  assert.equal(buildTermErrorText("", "", ""), "");
});

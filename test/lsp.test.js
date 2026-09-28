// symbols (LSP): framing and validation run offline; live queries run
// against typescript-language-server and skip when it cannot start.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildToolSpecs } = require("../dist/tools/index");
const { encodeLsp, isTsLike, querySymbols } = require("../dist/lsp");

function scratchTs(content) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-lsp-"));
  fs.writeFileSync(path.join(ws, "a.ts"), content);
  return ws;
}

test("lsp framing round trip and file filter", () => {
  const buf = encodeLsp('{"a":1}');
  assert.match(buf.toString("utf8"), /Content-Length: 7\r\n\r\n\{"a":1\}/);
  assert.ok(isTsLike("x.ts") && isTsLike("x.TSX") && isTsLike("x.mjs") && !isTsLike("x.py") && !isTsLike("x.md"));
});

test("symbols validation answers without a server", async () => {
  const ws = scratchTs("const x = 1;\n");
  assert.match(await querySymbols(ws, {}), /action must be one of/);
  assert.match(await querySymbols(ws, { action: "hover" }), /TypeScript/);
  assert.match(await querySymbols(ws, { action: "hover", path: "nope.ts" }), /does not exist/);
  fs.writeFileSync(path.join(ws, "note.txt"), "hi");
  assert.match(await querySymbols(ws, { action: "hover", path: "note.txt", line: 1, col: 1 }), /not a TypeScript/);
  assert.match(await querySymbols(ws, { action: "hover", path: "../evil.ts", line: 1, col: 1 }), /outside|path/i);
});

test("symbols tool exists in edit and bypass, hidden in read-only", () => {
  assert.ok(buildToolSpecs("edit").some((t) => t.name === "symbols"));
  assert.ok(buildToolSpecs("bypass").some((t) => t.name === "symbols"));
  assert.ok(!buildToolSpecs("ro").some((t) => t.name === "symbols"));
  assert.equal(buildToolSpecs("edit").length, 22);
});

test("live hover, definition and diagnostics", async (t) => {
  const ws = scratchTs('export function add(a: number, b: number): number { return a + b; }\nconst bad: number = "oops";\nadd(1, 2);\n');
  // typescript-language-server resolves its peer `typescript` from the
  // workspace: point it at this repo's node_modules for the test.
  process.env.NODE_PATH = path.join(__dirname, "..", "node_modules");
  const hover = await querySymbols(ws, { action: "hover", path: "a.ts", line: 3, col: 2 });
  if (hover.startsWith("Error: language server unavailable")) {
    t.skip("typescript-language-server could not start here");
    return;
  }
  assert.match(hover, /add/);
  const def = await querySymbols(ws, { action: "def", path: "a.ts", line: 3, col: 2 });
  assert.match(def, /a\.ts:1/);
  const diag = await querySymbols(ws, { action: "diag", path: "a.ts" });
  assert.match(diag, /error/i);
});

// Formatter: error paths always; a real format when prettier is available.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { formatFile, formattersStatus } = require("../dist/format");
const { resolveCommand } = require("../dist/mcp");

function scratchWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-fmt-"));
  fs.writeFileSync(path.join(ws, "doc.md"), "# hi\n");
  return ws;
}

test("format: refuses unsupported languages and missing files", () => {
  const ws = scratchWs();
  assert.match(formatFile(ws, "doc.md").message, /no formatter supported/);
  assert.match(formatFile(ws, "nope.ts").message, /does not exist/);
  assert.match(formatFile(ws, "../evil.ts").message, /outside|path/i);
});

test("format: status lists every toolchain", async () => {
  const lines = (await formattersStatus()).split("\n");
  assert.equal(lines.length, 5);
  for (const l of lines) assert.match(l, /^[✓✗] .+/);
});

test("format: prettier formats a messy file when installed", async (t) => {
  try {
    resolveCommand("prettier");
  } catch {
    try {
      resolveCommand("npx");
    } catch {
      t.skip("neither prettier nor npx on PATH");
      return;
    }
  }
  const ws = scratchWs();
  fs.writeFileSync(path.join(ws, "messy.js"), "const   x   =   1\n");
  const r = formatFile(ws, "messy.js");
  if (!r.ok) {
    t.skip("prettier is not installed here");
    return;
  }
  assert.match(fs.readFileSync(path.join(ws, "messy.js"), "utf8"), /const x = 1;/);
  const again = formatFile(ws, "messy.js");
  assert.match(again.message, /already perfectly formatted/);
});

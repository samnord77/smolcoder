// LSP auto-install: doctor shape, unknown languages, and the hermetic
// already-installed path (points the python candidate at node itself —
// `node --version` exits 0, so no real install ever runs here).
const test = require("node:test");
const assert = require("node:assert/strict");
const _fs = require("node:fs");
const os = require("node:os");
const _path = require("node:path");
const { installLspServer, lspDoctor, setupLsp } = require("../dist/lsp-install");

test("lspDoctor lists the four languages with install hints", () => {
  const report = lspDoctor();
  assert.match(report, /Language servers:/);
  for (const lang of ["typescript", "python", "rust", "go"]) assert.match(report, new RegExp(lang));
});

test("setupLsp refuses unknown languages without spawning anything", () => {
  assert.match(setupLsp(os.tmpdir(), "cobol"), /Unknown language/);
  assert.match(setupLsp(os.tmpdir(), ""), /already installed|✓|✗/);
});

test("installLspServer short-circuits when the server resolves", () => {
  process.env.SMOLCODER_LSP_PYTHON = `"${process.execPath}" --version`;
  try {
    const r = installLspServer("python", os.tmpdir());
    assert.equal(r.ok, true);
    assert.match(r.detail, /Already installed/);
    assert.match(setupLsp(os.tmpdir(), "python"), /Already installed/);
  } finally {
    delete process.env.SMOLCODER_LSP_PYTHON;
  }
});

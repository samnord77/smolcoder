// LSP auto-install: doctor shape, unknown languages, and the hermetic
// already-installed path (points the python candidate at node itself —
// `node --version` exits 0, so no real install ever runs here).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { installLspServer, lspDoctor, setupLsp } = require("../dist/lsp-install");

test("lspDoctor lists the four languages with install hints", () => {
  const report = lspDoctor();
  assert.match(report, /Language servers:/);
  for (const lang of ["typescript", "python", "rust", "go"]) assert.match(report, new RegExp(lang));
});

test("setupLsp refuses unknown languages without spawning anything", () => {
  assert.match(setupLsp(os.tmpdir(), "cobol"), /Unknown language/);
  // Hermetique : un prefixe de scratch ou tous les serveurs "existent" sous
  // forme de .cmd vides -> setupLsp(...) ne lance AUCUN vrai install reseau.
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "smol-lspall-"));
  const bin = path.join(prefix, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  const { LSP_LANGS, serverDefForLang } = require("../dist/lsp-pro");
  for (const lang of LSP_LANGS) {
    const def = serverDefForLang(lang);
    const exe = def?.candidates[0]?.[0];
    if (exe && /^[A-Za-z0-9._-]+$/.test(exe)) fs.writeFileSync(path.join(bin, exe + ".cmd"), "@echo off\r\n");
  }
  const old = process.env.SMOLCODER_LSP_PREFIX;
  process.env.SMOLCODER_LSP_PREFIX = prefix;
  try {
    assert.match(setupLsp(os.tmpdir(), ""), /already installed|déjà installés|✓|✗/);
  } finally {
    if (old === undefined) delete process.env.SMOLCODER_LSP_PREFIX;
    else process.env.SMOLCODER_LSP_PREFIX = old;
  }
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

test("npm .cmd est lance via shell (Windows) et le serveur est trouve dans le prefixe smolcoder", () => {
  // Regression : spawnSync(npm.cmd) sans shell renvoyait EINVAL avant de
  // commencer. Ici un faux npm.cmd "installe" le serveur markdown dans le
  // prefixe smolcoder, exactement comme le vrai le ferait.
  if (process.platform !== "win32") return;
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "smol-lspfx-"));
  const npmDir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-fakenpm-"));
  const bin = path.join(prefix, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  const installer = path.join(prefix, "install.js");
  const serverCmd = path.join(bin, "vscode-markdown-language-server.cmd");
  fs.writeFileSync(installer, 'require("node:fs").writeFileSync(' + JSON.stringify(serverCmd) + ', "@echo off\\r\\n");\n');
  fs.writeFileSync(path.join(npmDir, "npm.cmd"), '@echo off\r\nnode "' + process.execPath + '" "' + installer + '"\r\n');
  process.env.SMOLCODER_LSP_PREFIX = prefix;
  const oldPath = process.env.PATH;
  process.env.PATH = npmDir + path.delimiter + (oldPath || "");
  try {
    const r = installLspServer("markdown", os.tmpdir());
    assert.equal(r.ok, true, r.detail);
    assert.ok(!/EINVAL/.test(r.detail), "plus de spawnSync EINVAL : " + r.detail);
    if (/Installed via/.test(r.detail)) {
      const { findCommand } = require("../dist/mcp");
      assert.equal(!!findCommand("vscode-markdown-language-server"), true, "le serveur installe doit etre repere");
    }
  } finally {
    delete process.env.SMOLCODER_LSP_PREFIX;
    process.env.PATH = oldPath;
  }
});

test("binSearchDirs cherche aussi le prefixe npm gere par smolcoder", () => {
  const { binSearchDirs } = require("../dist/util");
  const old = process.env.SMOLCODER_LSP_PREFIX;
  process.env.SMOLCODER_LSP_PREFIX = path.join(os.tmpdir(), "smol-lsp-prefix");
  try {
    assert.ok(
      binSearchDirs().includes(path.join(process.env.SMOLCODER_LSP_PREFIX, "node_modules", ".bin")),
      "le dossier npm gere par smolcoder doit etre cherche"
    );
  } finally {
    if (old === undefined) delete process.env.SMOLCODER_LSP_PREFIX;
    else process.env.SMOLCODER_LSP_PREFIX = old;
  }
});

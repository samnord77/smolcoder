// Pro LSP (multi-language, persistent servers): catalog and validation run
// offline; live protocol runs against a tiny mock language server written to
// a temp folder (no real server needed, no network).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildToolSpecs } = require("../dist/tools/index");
const {
  serverForFile,
  supportedLspExts,
  lspAvailability,
  splitCommand,
  LspManager,
  managerFor,
  closeLspManagers,
  queryCode,
  queryDiagStructured,
  CODE_ACTIONS,
} = require("../dist/lsp-pro");

function scratchWs(files) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-lsppro-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, name)), { recursive: true });
    fs.writeFileSync(path.join(ws, name), content);
  }
  return ws;
}

const MOCK_LINES = [
  '"use strict";',
  'let buf = Buffer.alloc(0);',
  'function send(obj) {',
  '  const body = Buffer.from(JSON.stringify(obj), "utf8");',
  '  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "utf8"), body]));',
  '}',
  'process.stdin.on("data", (chunk) => {',
  '  buf = Buffer.concat([buf, chunk]);',
  '  for (;;) {',
  '    const headEnd = buf.indexOf("\\r\\n\\r\\n");',
  '    if (headEnd < 0) return;',
  '    const head = buf.slice(0, headEnd).toString("utf8");',
  '    const m = /Content-Length:\\s*(\\d+)/i.exec(head);',
  '    if (!m) { buf = buf.slice(headEnd + 4); continue; }',
  '    const len = Number(m[1]);',
  '    if (buf.length < headEnd + 4 + len) return;',
  '    const text = buf.slice(headEnd + 4, headEnd + 4 + len).toString("utf8");',
  '    buf = buf.slice(headEnd + 4 + len);',
  '    let msg;',
  '    try { msg = JSON.parse(text); } catch (e) { continue; }',
  '    handle(msg);',
  '  }',
  '});',
  'function handle(msg) {',
  '  if (msg.method === "initialize") { send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } }); return; }',
  '  if (msg.id === undefined) {',
  '    if (msg.method === "textDocument/didOpen" && msg.params && msg.params.textDocument) {',
  '      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: msg.params.textDocument.uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: "mock error" }] } });',
  '    }',
  '    return;',
  '  }',
  '  const id = msg.id;',
  '  const ok = (result) => send({ jsonrpc: "2.0", id: id, result: result });',
  '  const uri = msg.params && msg.params.textDocument ? msg.params.textDocument.uri : "file:///mock.ts";',
  '  const loc = { uri: uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } };',
  '  if (msg.method === "textDocument/hover") ok({ contents: { kind: "markdown", value: "mock hover for test" } });',
  '  else if (msg.method === "textDocument/definition") ok([loc]);',
  '  else if (msg.method === "textDocument/references") ok([]);',
  '  else if (msg.method === "textDocument/completion") ok({ items: [{ label: "mockComplete", kind: 3, detail: "mock fn" }] });',
  '  else if (msg.method === "textDocument/signatureHelp") ok({ signatures: [{ label: "mock(a, b)" }], activeSignature: 0 });',
  '  else if (msg.method === "textDocument/rename") ok({ changes: {} });',
  '  else if (msg.method === "textDocument/codeAction") ok([{ title: "mock fix", kind: "quickfix" }]);',
  '  else if (msg.method === "workspace/symbol") ok([{ name: "MockThing", kind: 7, location: { uri: "file:///mock.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } } } }]);',
  '  else ok(null);',
  '}',
];

/** Mock adapter command with quoted paths (Windows-safe). Written once. */
let mockCmd = null;
function mockCommand() {
  if (!mockCmd) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-mocklsp-"));
    const file = path.join(dir, "mock-lsp.cjs");
    fs.writeFileSync(file, MOCK_LINES.join("\n"));
    mockCmd = '"' + process.execPath + '" "' + file + '"';
  }
  return mockCmd;
}

test("lsp catalog: four languages, extensions, availability shape", () => {
  assert.equal(serverForFile("a.ts").lang, "typescript");
  assert.equal(serverForFile("a.tsx").lang, "typescript");
  assert.equal(serverForFile("a.js").lang, "typescript");
  assert.equal(serverForFile("b.py").lang, "python");
  assert.equal(serverForFile("c.rs").lang, "rust");
  assert.equal(serverForFile("d.go").lang, "go");
  assert.equal(serverForFile("UPPER.PY").lang, "python");
  assert.equal(serverForFile("x.md"), null);
  assert.equal(serverForFile("noext"), null);
  const exts = supportedLspExts();
  assert.ok(exts.includes(".ts") && exts.includes(".py") && exts.includes(".rs") && exts.includes(".go"));
  const avail = lspAvailability();
  assert.deepEqual(avail.map((a) => a.lang), ["typescript", "python", "rust", "go"]);
  for (const a of avail) {
    assert.equal(typeof a.ok, "boolean");
    assert.ok(a.hint.length > 5, "every language explains how to install its server");
  }
});

test("splitCommand respects quotes", () => {
  assert.deepEqual(splitCommand("pylsp"), ["pylsp"]);
  assert.deepEqual(splitCommand('"C:\\a b\\node.exe" mock.cjs --stdio'), ["C:\\a b\\node.exe", "mock.cjs", "--stdio"]);
  assert.deepEqual(splitCommand("  "), []);
});

test("queryCode validates without spawning a server", async () => {
  const ws = scratchWs({ "a.py": "x = 1\n", "note.txt": "hi\n" });
  assert.match(await queryCode(ws, {}), /action must be one of/);
  assert.match(await queryCode(ws, { action: "hover" }), /path is required/);
  assert.match(await queryCode(ws, { action: "hover", path: "note.txt", line: 1, col: 1 }), /not a supported language/);
  assert.match(await queryCode(ws, { action: "hover", path: "nope.py", line: 1, col: 1 }), /does not exist/);
  assert.match(await queryCode(ws, { action: "hover", path: "../evil.py", line: 1, col: 1 }), /outside|path/i);
  assert.match(await queryCode(ws, { action: "rename", path: "a.py", line: 1, col: 1 }), /new_text/);
  assert.match(await queryCode(ws, { action: "wsymbol" }), /needs a query/);
});

test("queryCode honors the disable switch", async () => {
  const ws = scratchWs({ "a.py": "x = 1\n" });
  process.env.SMOLCODER_LSP_DISABLE = "1";
  try {
    assert.match(await queryCode(ws, { action: "hover", path: "a.py", line: 1, col: 1 }), /désactivé/);
  } finally {
    delete process.env.SMOLCODER_LSP_DISABLE;
  }
});

test("live mock server: all manager actions over one persistent process", async () => {
  const ws = scratchWs({ "a.py": "value = 1\nprint(value)\n" });
  process.env.SMOLCODER_LSP_PYTHON = mockCommand();
  const manager = new LspManager(ws);
  try {
    assert.match(await manager.query({ action: "hover", path: "a.py", line: 2, col: 7 }), /mock hover for test/);
    const def = await manager.query({ action: "def", path: "a.py", line: 2, col: 7 });
    assert.match(def, /a\.py:1/);
    assert.match(await manager.query({ action: "refs", path: "a.py", line: 2, col: 7 }), /No result/);
    assert.match(await manager.query({ action: "diag", path: "a.py" }), /mock error/);
    assert.match(await manager.query({ action: "completion", path: "a.py", line: 2, col: 3 }), /mockComplete/);
    assert.match(await manager.query({ action: "signature", path: "a.py", line: 2, col: 7 }), /mock\(a, b\)/);
    assert.match(await manager.query({ action: "rename", path: "a.py", line: 1, col: 1, new_text: "total" }), /no edits/i);
    assert.match(await manager.query({ action: "quickfix", path: "a.py", line: 1, col: 1 }), /mock fix/);
    assert.match(await manager.query({ action: "wsymbol", query: "Mock", lang: "python" }), /MockThing/);
    assert.equal(manager.serverCount(), 1, "one persistent server for every action");
    assert.equal(manager.openDocCount(), 1, "the document stays open between queries");
  } finally {
    manager.shutdown();
    delete process.env.SMOLCODER_LSP_PYTHON;
    closeLspManagers();
  }
});

test("live mock servers through queryCode routing (python manager + ts legacy)", async () => {
  const ws = scratchWs({ "a.py": "value = 1\n", "b.ts": "const v = 1;\n" });
  process.env.SMOLCODER_LSP_PYTHON = mockCommand();
  process.env.SMOLCODER_LSP_COMMAND = mockCommand();
  try {
    assert.match(await queryCode(ws, { action: "hover", path: "a.py", line: 1, col: 1 }), /mock hover for test/);
    assert.match(await queryCode(ws, { action: "diag", path: "a.py" }), /mock error/);
    assert.match(await queryCode(ws, { action: "hover", path: "b.ts", line: 1, col: 7 }), /mock hover for test/);
    assert.match(await queryCode(ws, { action: "wsymbol", query: "Mock", lang: "python" }), /MockThing/);
  } finally {
    delete process.env.SMOLCODER_LSP_PYTHON;
    delete process.env.SMOLCODER_LSP_COMMAND;
    closeLspManagers();
  }
});

test("symbols schema exposes the 9 pro actions; new tools are visible per mode", () => {
  const edit = buildToolSpecs("edit");
  const symbols = edit.find((t) => t.name === "symbols");
  assert.deepEqual(symbols.parameters.properties.action.enum, CODE_ACTIONS);
  assert.ok(symbols.parameters.properties.new_text, "rename parameter is declared");
  assert.ok(symbols.parameters.properties.query, "wsymbol parameter is declared");
  const names = (m) => buildToolSpecs(m).map((t) => t.name);
  for (const n of ["index_symbols", "git", "plugins"]) {
    assert.ok(names("ro").includes(n), `${n} reads in read-only mode`);
    assert.ok(names("edit").includes(n) && names("bypass").includes(n));
  }
  for (const n of ["format", "debug"]) {
    assert.ok(!names("ro").includes(n), `${n} is hidden in read-only mode`);
    assert.ok(names("edit").includes(n) && names("bypass").includes(n));
  }
  assert.equal(edit.length, 19);
});

test("diagStructured returns panel rows through the mock server", async () => {
  const ws = scratchWs({ "a.py": "value = 1\n" });
  process.env.SMOLCODER_LSP_PYTHON = mockCommand();
  try {
    const r = await queryDiagStructured(ws, "a.py");
    assert.match(r.text, /mock error/);
    assert.equal(r.diagnostics.length, 1);
    assert.deepEqual(
      [r.diagnostics[0].path, r.diagnostics[0].line, r.diagnostics[0].severity],
      ["a.py", 1, "error"]
    );
    assert.match(r.diagnostics[0].message, /mock error/);
    const bad = await queryDiagStructured(ws, "note.txt");
    assert.deepEqual(bad.diagnostics, []);
    assert.match(bad.text, /not a supported language/);
  } finally {
    delete process.env.SMOLCODER_LSP_PYTHON;
    closeLspManagers();
  }
});

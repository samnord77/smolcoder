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
  closeLspManagers,
  queryCode,
  queryDiagStructured,
  queryDefStructured,
  querySymbolsStructured,
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
  "let buf = Buffer.alloc(0);",
  "function send(obj) {",
  '  const body = Buffer.from(JSON.stringify(obj), "utf8");',
  '  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "utf8"), body]));',
  "}",
  'process.stdin.on("data", (chunk) => {',
  "  buf = Buffer.concat([buf, chunk]);",
  "  for (;;) {",
  '    const headEnd = buf.indexOf("\\r\\n\\r\\n");',
  "    if (headEnd < 0) return;",
  '    const head = buf.slice(0, headEnd).toString("utf8");',
  "    const m = /Content-Length:\\s*(\\d+)/i.exec(head);",
  "    if (!m) { buf = buf.slice(headEnd + 4); continue; }",
  "    const len = Number(m[1]);",
  "    if (buf.length < headEnd + 4 + len) return;",
  '    const text = buf.slice(headEnd + 4, headEnd + 4 + len).toString("utf8");',
  "    buf = buf.slice(headEnd + 4 + len);",
  "    let msg;",
  "    try { msg = JSON.parse(text); } catch (e) { continue; }",
  "    handle(msg);",
  "  }",
  "});",
  "function handle(msg) {",
  '  if (msg.method === "initialize") { send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } }); return; }',
  "  if (msg.id === undefined) {",
  '    if (msg.method === "textDocument/didOpen" && msg.params && msg.params.textDocument) {',
  '      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: msg.params.textDocument.uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: "mock error" }] } });',
  "    }",
  "    return;",
  "  }",
  "  const id = msg.id;",
  '  const symUri = process.env.SMOLCODE_MOCK_SYMBOL_URI || "file:///mock.ts";',
  '  const ok = (result) => send({ jsonrpc: "2.0", id: id, result: result });',
  '  const uri = msg.params && msg.params.textDocument ? msg.params.textDocument.uri : "file:///mock.ts";',
  "  const loc = { uri: uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } };",
  '  if (msg.method === "textDocument/hover") ok({ contents: { kind: "markdown", value: "mock hover for test" } });',
  '  else if (msg.method === "textDocument/definition") ok([loc]);',
  '  else if (msg.method === "textDocument/references") ok([]);',
  '  else if (msg.method === "textDocument/completion") ok({ items: [{ label: "mockComplete", kind: 3, detail: "mock fn" }] });',
  '  else if (msg.method === "textDocument/signatureHelp") ok({ signatures: [{ label: "mock(a, b)" }], activeSignature: 0 });',
  '  else if (msg.method === "textDocument/rename") ok({ changes: {} });',
  '  else if (msg.method === "textDocument/codeAction") ok([{ title: "mock fix", kind: "quickfix" }]);',
  '  else if (msg.method === "workspace/symbol") ok([{ name: "MockThing", kind: 7, location: { uri: symUri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } } } }]);',
  "  else ok(null);",
  "}",
];

/** Mock adapter command with quoted paths (Windows-safe). Written once. */
let mockCmd = null;
function mockCommand() {
  if (!mockCmd) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-mocklsp-"));
    const file = path.join(dir, "mock-lsp.cjs");
    fs.writeFileSync(file, MOCK_LINES.join("\n"));
    mockCmd = `"${process.execPath}" "${file}"`;
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
  // Markdown is now supported
  assert.equal(serverForFile("x.md").lang, "markdown");
  assert.equal(serverForFile("noext"), null);
  const exts = supportedLspExts();
  assert.ok(exts.includes(".ts") && exts.includes(".py") && exts.includes(".rs") && exts.includes(".go"));
  const avail = lspAvailability();
  // Verify at minimum the original 4 languages are present
  const langs = avail.map((a) => a.lang);
  assert.ok(langs.includes("typescript"), "typescript present");
  assert.ok(langs.includes("python"), "python present");
  assert.ok(langs.includes("rust"), "rust present");
  assert.ok(langs.includes("go"), "go present");
  // LSP_LANGS defines 37 languages (availability depends on installed servers)
  const { LSP_LANGS } = require("../dist/lsp-pro");
  assert.ok(LSP_LANGS.length >= 37, "at least 37 languages defined");
  for (const a of avail) {
    assert.equal(typeof a.ok, "boolean");
    assert.ok(a.hint.length > 5, "every language explains how to install its server");
  }
});

test("availability tells the truth: ok only when the binary really exists", () => {
  // Regression guard. resolveCommand() echoes its input back when a binary is
  // missing, so using it for availability reported all 37 languages as
  // installed. Availability must use findCommand and reflect reality.
  const { findCommand } = require("../dist/mcp");
  const { serverDefForLang } = require("../dist/lsp-pro");
  const avail = lspAvailability();
  for (const a of avail) {
    const def = serverDefForLang(a.lang);
    const reallyThere = def.candidates.some((c) => !!findCommand(c[0]));
    assert.equal(a.ok, reallyThere, `${a.lang} availability must match the real filesystem`);
  }
  // A command that cannot exist anywhere must never be reported as installed.
  assert.equal(findCommand("definitely-not-a-real-lsp-binary-xyz"), null);
  assert.equal(findCommand(""), null);
});

test("splitCommand respects quotes", () => {
  assert.deepEqual(splitCommand("pylsp"), ["pylsp"]);
  assert.deepEqual(splitCommand('"C:\\a b\\node.exe" mock.cjs --stdio'), ["C:\\a b\\node.exe", "mock.cjs", "--stdio"]);
  assert.deepEqual(splitCommand("  "), []);
});

test("queryCode validates without spawning a server", async () => {
  const ws = scratchWs({ "a.py": "x = 1\n", "note.txt": "hi\n" });
  assert.match(await queryCode(ws, {}), /l'action doit être l'une de/);
  assert.match(await queryCode(ws, { action: "hover" }), /le chemin est requis/);
  assert.match(await queryCode(ws, { action: "hover", path: "note.txt", line: 1, col: 1 }), /n'est pas un langage pris en charge/);
  assert.match(await queryCode(ws, { action: "hover", path: "nope.py", line: 1, col: 1 }), /n'existe pas/);
  assert.match(await queryCode(ws, { action: "hover", path: "../evil.py", line: 1, col: 1 }), /en dehors|chemin/i);
  assert.match(await queryCode(ws, { action: "rename", path: "a.py", line: 1, col: 1 }), /new_text/);
  assert.match(await queryCode(ws, { action: "wsymbol" }), /a besoin d'une requête/);
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
    assert.match(await manager.query({ action: "refs", path: "a.py", line: 2, col: 7 }), /Aucun résultat/);
    assert.match(await manager.query({ action: "diag", path: "a.py" }), /mock error/);
    assert.match(await manager.query({ action: "completion", path: "a.py", line: 2, col: 3 }), /mockComplete/);
    assert.match(await manager.query({ action: "signature", path: "a.py", line: 2, col: 7 }), /mock\(a, b\)/);
    assert.match(
      await manager.query({ action: "rename", path: "a.py", line: 1, col: 1, new_text: "total" }),
      /n'a proposé aucune modification/i
    );
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

test("live mock servers through queryCode routing (persistent manager, python + typescript)", async () => {
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

test("symbols schema exposes the 10 pro actions; new tools are visible per mode", () => {
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
  for (const n of ["move_path", "delete_path", "create_folder"]) {
    assert.ok(names("edit").includes(n), `${n} is offered in edit mode`);
    assert.ok(names("bypass").includes(n), `${n} is offered in bypass mode`);
  }
  assert.equal(edit.length, 23);
});

test("diagStructured returns panel rows through the mock server", async () => {
  const ws = scratchWs({ "a.py": "value = 1\n" });
  process.env.SMOLCODER_LSP_PYTHON = mockCommand();
  try {
    const r = await queryDiagStructured(ws, "a.py");
    assert.match(r.text, /mock error/);
    assert.equal(r.diagnostics.length, 1);
    assert.deepEqual([r.diagnostics[0].path, r.diagnostics[0].line, r.diagnostics[0].severity], ["a.py", 1, "error"]);
    assert.match(r.diagnostics[0].message, /mock error/);
    const bad = await queryDiagStructured(ws, "note.txt");
    assert.deepEqual(bad.diagnostics, []);
    assert.match(bad.text, /n['’]est pas un langage pris en charge/);
  } finally {
    delete process.env.SMOLCODER_LSP_PYTHON;
    closeLspManagers();
  }
});

test("structured definition targets resolve to exact workspace paths", async () => {
  const ws = scratchWs({ "a.py": "value = 1\n" });
  process.env.SMOLCODER_LSP_PYTHON = mockCommand();
  try {
    const r = await queryDefStructured(ws, "a.py", 1, 1);
    assert.equal(r.defs.length, 1);
    assert.deepEqual([r.defs[0].path, r.defs[0].line, r.defs[0].col], ["a.py", 1, 1]);
    assert.match(r.text, /a\.py:1/);
    assert.ok(!r.text.includes(".."), "les chemins Windows ne montent plus vers ../../C:/...");
    const bad = await queryDefStructured(ws, "note.txt", 1, 1);
    assert.deepEqual(bad.defs, []);
    assert.match(bad.text, /pas un langage pris en charge/);
  } finally {
    delete process.env.SMOLCODER_LSP_PYTHON;
    closeLspManagers();
  }
});

test("structured workspace symbols feed the editor palette", async () => {
  const ws = scratchWs({ "a.py": "x = 1\n" });
  process.env.SMOLCODER_LSP_PYTHON = mockCommand();
  process.env.SMOLCODE_MOCK_SYMBOL_URI = `file:///${ws.replace(/\\/g, "/")}/a.py`;
  try {
    const r = await querySymbolsStructured(ws, "Mock", "python");
    assert.ok(r.symbols.length >= 1);
    assert.deepEqual([r.symbols[0].name, r.symbols[0].path, r.symbols[0].line, r.symbols[0].col], ["MockThing", "a.py", 2, 1]);
    assert.match(r.text, /MockThing/);
    const missing = await querySymbolsStructured(ws, "", "python");
    assert.deepEqual(missing.symbols, []);
    assert.match(missing.text, /a besoin d'une requête/);
    // The text form used by the CLI symbols tool routes through the same path.
    const cli = await queryCode(ws, { action: "wsymbol", query: "Mock", lang: "python" });
    assert.match(cli, /MockThing/);
  } finally {
    delete process.env.SMOLCODER_LSP_PYTHON;
    delete process.env.SMOLCODE_MOCK_SYMBOL_URI;
    closeLspManagers();
  }
});

test("symbols setup installs only in edit modes", async () => {
  const { executeTool } = require("../dist/tools/index");
  const { TaskManager } = require("../dist/tools/tasks");
  const { Plan } = require("../dist/plan");
  const ws = scratchWs({ "a.py": "x = 1\n" });
  const tm = new TaskManager(ws);
  try {
    const ctx = (canWrite) => ({
      workspace: ws,
      taskManager: tm,
      plan: new Plan(),
      filesTouched: new Set(),
      commandsRun: [],
      canWrite,
    });
    assert.match(await executeTool("symbols", { action: "setup", lang: "cobol" }, ctx(true)), /Unknown language/);
    assert.match(await executeTool("symbols", { action: "setup", lang: "cobol" }, ctx(false)), /lecture seule/);
  } finally {
    try {
      tm.killAll();
    } catch {}
  }
});

test("startServer reports an installed server's failure, never a missing candidate's ENOENT", async () => {
  // Regression: with the first candidate installed but failing, and later
  // candidates absent, the panel used to report "spawn
  // basedpyright-langserver ENOENT" — the LAST candidate's error — hiding
  // the real cause, which left Python panels empty on machines where pylsp
  // is installed but slow on its first handshake.
  const ws = scratchWs({});
  const manager = new LspManager(ws);
  try {
    const failFast = {
      lang: "fake",
      languageId: "fake",
      exts: [],
      candidates: [[process.execPath, "-e", "process.exit(2)"], ["definitely-not-a-real-lsp-binary-xyz"]],
      installHint: "hint",
    };
    await assert.rejects(
      () => manager.ensureServer(failFast),
      (err) =>
        /exited \(code 2\)/.test(String(err.message)) && !/ENOENT/.test(String(err.message)) && !/not-a-real/.test(String(err.message))
    );
    const noneInstalled = {
      lang: "fake2",
      languageId: "fake2",
      exts: [],
      candidates: [["definitely-not-a-real-lsp-binary-xyz"], ["also-not-a-real-binary-abc"]],
      installHint: "hint",
    };
    await assert.rejects(
      () => manager.ensureServer(noneInstalled),
      (err) => /no server installed/.test(String(err.message)) && /definitely-not-a-real-lsp-binary-xyz/.test(String(err.message))
    );
  } finally {
    manager.shutdown();
    closeLspManagers();
  }
});

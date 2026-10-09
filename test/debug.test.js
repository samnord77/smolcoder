// Minimal DAP debugger: protocol runs against a mock adapter written to a
// temp folder (no real debugger needed, no network).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DapClient, runDebugSession, queryDebug } = require("../dist/debug");

const MOCK_LINES = [
  '"use strict";',
  'const SRC = process.argv[2] || "prog.py";',
  "let buf = Buffer.alloc(0);",
  "function send(obj) {",
  '  const body = Buffer.from(JSON.stringify(obj), "utf8");',
  '  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "utf8"), body]));',
  "}",
  'function event(name, body) { send({ seq: 0, type: "event", event: name, body: body }); }',
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
  '  if (msg.type !== "request") return;',
  "  const id = msg.seq;",
  '  const ok = (body) => send({ seq: 100 + id, type: "response", request_seq: id, success: true, command: msg.command, body: body });',
  "  const lines = (msg.arguments && msg.arguments.breakpoints ? msg.arguments.breakpoints : []).map((b) => ({ verified: true, line: b.line }));",
  '  if (msg.command === "initialize") ok({ supportsConfigurationDoneRequest: true });',
  '  else if (msg.command === "launch" || msg.command === "attach") ok({});',
  '  else if (msg.command === "setBreakpoints") ok({ breakpoints: lines });',
  '  else if (msg.command === "configurationDone") { ok({}); event("stopped", { reason: "breakpoint", threadId: 1 }); }',
  '  else if (msg.command === "threads") ok({ threads: [{ id: 1, name: "main" }] });',
  '  else if (msg.command === "stackTrace") ok({ stackFrames: [{ id: 11, name: "main", source: { path: SRC }, line: 3, column: 0 }], totalFrames: 1 });',
  '  else if (msg.command === "scopes") ok({ scopes: [{ name: "Local", variablesReference: 77 }] });',
  '  else if (msg.command === "variables") ok({ variables: [{ name: "x", value: "42", variablesReference: 0 }] });',
  '  else if (msg.command === "next" || msg.command === "continue") { ok({}); event("terminated", {}); }',
  '  else if (msg.command === "disconnect") { ok({}); process.exit(0); }',
  "  else ok({});",
  "}",
];

let mockPath = null;
function mockAdapter() {
  if (!mockPath) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-mockdap-"));
    mockPath = path.join(dir, "mock-dap.cjs");
    fs.writeFileSync(mockPath, MOCK_LINES.join("\n"));
  }
  return mockPath;
}

function scratchWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-debug-"));
  fs.writeFileSync(path.join(ws, "prog.py"), "x = 1\ny = 2\nprint(x + y)\n");
  return ws;
}

test("debug: full session against the mock adapter", async () => {
  const ws = scratchWs();
  const prog = path.join(ws, "prog.py");
  const client = new DapClient();
  try {
    await client.startStdio([process.execPath, mockAdapter(), prog], ws);
    const transcript = await runDebugSession(
      client,
      { request: "launch", program: prog, programArgs: [], breakpoints: [{ path: "prog.py", lines: [3] }], budgetMs: 20000 },
      ws
    );
    assert.match(transcript, /breakpoints: 1\/1 verified/);
    assert.match(transcript, /stopped \(breakpoint\)/);
    assert.match(transcript, /at main .*prog\.py:3/);
    assert.match(transcript, /x = 42/);
    assert.match(transcript, /stepped once/);
    assert.match(transcript, /terminated/);
  } finally {
    client.close();
  }
});

test("debug: socket connect fails fast on a closed port", async () => {
  const client = new DapClient();
  try {
    await assert.rejects(client.connectSocket("127.0.0.1", 1, 800), /connect|timed out/);
  } finally {
    client.close();
  }
});

test("debug: setup coaching without config, errors on bad config", async () => {
  const ws = scratchWs();
  assert.match(await queryDebug(ws, { action: "run" }), /debug\.json/);
  fs.mkdirSync(path.join(ws, ".smol"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".smol", "debug.json"), "{oops");
  assert.match(await queryDebug(ws, { action: "run" }), /n['’]est pas un JSON valide/);
  assert.match(await queryDebug(ws, { action: "run" }, { canWrite: false }), /lecture seule/);
  assert.match(await queryDebug(ws, { action: " dance" }), /doit être "run"/);
});

test("debug: stdio run through .smol/debug.json", async () => {
  const ws = scratchWs();
  fs.mkdirSync(path.join(ws, ".smol"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".smol", "debug.json"),
    JSON.stringify({
      transport: "stdio",
      adapter: [process.execPath, mockAdapter(), path.join(ws, "prog.py")],
      request: "launch",
      program: "prog.py",
      breakpoints: [{ path: "prog.py", lines: [2] }],
      budgetSec: 20,
    })
  );
  const transcript = await queryDebug(ws, { action: "run" });
  assert.match(transcript, /breakpoints: 1\/1 verified/);
  assert.match(transcript, /x = 42/);
});

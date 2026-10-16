// Minimal DAP debugger: protocol runs against a mock adapter written to a
// temp folder (no real debugger needed, no network).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DapClient, runDebugSession, queryDebug, autoAdapter } = require("../dist/debug");

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

test("debug: autoAdapter infers the built-in node adapter for js/mjs/cjs/ts", async () => {
  for (const ext of [".js", ".mjs", ".cjs", ".ts"]) {
    const auto = await autoAdapter({ program: `app${ext}` }, undefined);
    assert.ok(auto, `auto doit trouver un plan pour ${ext}`);
    assert.equal(auto.transport, "stdio");
    assert.equal(auto.request, "launch");
    assert.equal(auto.adapter?.[0], "node");
    assert.match(auto.adapter?.[1] ?? "", /dap-node\.cjs$/);
    assert.equal(auto.program, `app${ext}`);
  }
});

test("debug: autoAdapter builds a debugpy bootstrap on a free port for .py", async () => {
  const auto = await autoAdapter({ program: "app.py" }, undefined);
  assert.ok(auto);
  assert.equal(auto.transport, "socket");
  assert.equal(auto.request, "attach");
  assert.equal(auto.spawn?.[0], "python");
  assert.ok(Number.isSafeInteger(auto.port) && auto.port > 0, "port libre attendu");
  const snippet = auto.spawn?.[2] ?? "";
  assert.match(snippet, /debugpy\.listen\(\d+, in_process_debug_adapter=True\)/);
  assert.match(snippet, /runpy\.run_path\("app\.py"/);
  assert.equal(auto.program, "app.py");
});

test("debug: autoAdapter uses the first breakpoint path when program is absent", async () => {
  const auto = await autoAdapter({}, "sub/app.py");
  assert.ok(auto);
  assert.equal(auto.program, "sub/app.py");
  assert.match(auto.spawn?.[2] ?? "", /sub\/app\.py/);
});

test("debug: autoAdapter stays off with an explicit transport, adapter or spawn", async () => {
  assert.equal(await autoAdapter({ transport: "socket" }, "app.py"), null);
  assert.equal(await autoAdapter({ adapter: ["mock"] }, "app.py"), null);
  assert.equal(await autoAdapter({ spawn: ["python", "-m", "debugpy"] }, "app.py"), null);
  assert.equal(await autoAdapter({}, "app.rs"), null);
  assert.equal(await autoAdapter({}, undefined), null);
});

test("debug: auto run refuses an unsupported extension with a clear message", async () => {
  const ws = scratchWs();
  fs.writeFileSync(path.join(ws, "app.rs"), "fn main() {}\n");
  fs.mkdirSync(path.join(ws, ".smol"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".smol", "debug.json"), JSON.stringify({ program: "app.rs", breakpoints: [] }));
  const out = await queryDebug(ws, { action: "run" });
  assert.match(out, /extension « \.rs » non gérée en automatique/);
  assert.match(out, /Node intégré/);
});

// Certains environnements très restreints (bac à sable) interdisent le spawn
// avec des pipes : les parcours réels sont alors sautés, la logique restant
// couverte par les tests d'autoAdapter ci-dessus.
function canSpawnPipes() {
  try {
    const { spawnSync } = require("node:child_process");
    const r = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
      windowsHide: true,
    });
    return r.status === 0 && !r.error;
  } catch {
    return false;
  }
}
const pipesAllowed = canSpawnPipes();

test(
  "debug: real node adapter end-to-end through the auto mode",
  { skip: !pipesAllowed && "spawn avec pipes indisponible (bac à sable)" },
  async () => {
    const ws = scratchWs();
    fs.writeFileSync(
      path.join(ws, "app.js"),
      [
        '"use strict";',
        "function total(values) {",
        "  let running = 0;",
        "  for (const v of values) running += v;",
        "  return running;",
        "}",
        "const x = 42;",
        'console.log("total:", total([1, 2, 3]));',
        'console.log("x =", x);',
      ].join("\n")
    );
    fs.mkdirSync(path.join(ws, ".smol"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".smol", "debug.json"),
      JSON.stringify({ program: "app.js", breakpoints: [{ path: "app.js", lines: [8] }], budgetSec: 40 })
    );
    const transcript = await queryDebug(ws, { action: "run" });
    assert.match(transcript, /breakpoints: 1\/1 verified/);
    assert.match(transcript, /▶ stopped/);
    assert.match(transcript, /app\.js:8/);
    assert.match(transcript, /x = 42/);
    assert.match(transcript, /exited \(code 0\)/);
  }
);

test("debug: real python debugpy end-to-end through the auto mode", async (t) => {
  if (!pipesAllowed || !hasRealDebugpy() || !(await childSocketsReachable())) {
    t.skip("debugpy indisponible ou réseau des enfants isolé (bac à sable)");
    return;
  }
  const ws = scratchWs();
  fs.writeFileSync(
    path.join(ws, "app.py"),
    "def total(values):\n    running = 0\n    for v in values:\n        running += v\n    return running\n\nx = 42\nprint('total:', total([1, 2, 3]))\nprint('x =', x)\n"
  );
  fs.mkdirSync(path.join(ws, ".smol"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".smol", "debug.json"),
    JSON.stringify({ program: "app.py", breakpoints: [{ path: "app.py", lines: [8] }], budgetSec: 60 })
  );
  const transcript = await queryDebug(ws, { action: "run" });
  assert.match(transcript, /breakpoints: 1\/1 verified/);
  assert.match(transcript, /▶ stopped/);
  assert.match(transcript, /x = 42/);
  assert.match(transcript, /exited|terminated/);
});

function hasRealDebugpy() {
  try {
    const { spawnSync } = require("node:child_process");
    const r = spawnSync("python", ["-c", "import debugpy"], { stdio: "ignore", timeout: 15_000, windowsHide: true });
    return r.status === 0 && !r.error;
  } catch {
    return false;
  }
}

/** Vrai quand un processus enfant (python) peut réellement être joint sur son
 * port par le processus parent. Certains environnements (bac à sable, policy)
 * isolent le réseau des enfants : le parcours réel est alors sauté, sans
 * perdre la couverture logique des tests d'autoAdapter. */
function childSocketsReachable() {
  return new Promise((resolve) => {
    const cp = require("node:child_process");
    const net = require("node:net");
    const port = 49_000 + Math.floor(Math.random() * 900);
    let dir = null;
    let errFd = -1;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-reach-"));
      errFd = fs.openSync(path.join(dir, "err.txt"), "w");
    } catch {
      resolve(false);
      return;
    }
    const cmd = `import debugpy; debugpy.listen(${port}, in_process_debug_adapter=True); import time; time.sleep(30)`;
    let child = null;
    try {
      child = cp.spawn("python", ["-c", cmd], { stdio: [errFd, errFd, errFd], windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 5000);
    const sock = net.createConnection({ host: "127.0.0.1", port });
    sock.on("connect", () => {
      sock.destroy();
      finish(true);
    });
    sock.on("error", () => sock.destroy());
  });
}

// MCP client: handshake, list, call, errors and timeouts against a tiny
// fake server over stdio. Scratch workspaces only, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// Isolate from the machine's user-scope servers.
process.env.SMOLCODER_MCP_CONFIG = path.join(os.tmpdir(), "smol-mcp-no-global.json");
const { buildToolSpecs } = require("../dist/tools/index");
const { createMcpBridge, loadMcpConfig } = require("../dist/mcp");
const { resolveCommand } = require("../dist/mcp");

const FAKE_SERVER = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "notifications/initialized") continue;
    const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "repeats args", inputSchema: { type: "object" } }, { name: "boom", description: "fails", inputSchema: { type: "object" } }] } });
    } else if (msg.method === "tools/call" && msg.params?.name === "echo") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + JSON.stringify(msg.params.arguments ?? {}) }] } });
    } else if (msg.method === "tools/call" && msg.params?.name === "boom") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "bad" }], isError: true } });
    } else if (msg.method === "tools/call" && msg.params?.name === "hang") {
      // never answer: the caller times out
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown" } });
    }
  }
});
`;

function scratchWithServer(extra = []) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-mcp-"));
  const script = path.join(ws, "fake-server.cjs");
  fs.writeFileSync(script, FAKE_SERVER);
  const servers = [{ name: "fake", command: process.execPath, args: [script] }, ...extra];
  fs.mkdirSync(path.join(ws, ".smol"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".smol", "mcp.json"), JSON.stringify(servers));
  return { ws, bridge: createMcpBridge(ws) };
}

test("missing or broken config coaches instead of crashing", async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-mcp-"));
  const bridge = createMcpBridge(ws);
  assert.match(await bridge.list(), /Aucun serveur MCP configuré/);
  assert.match(await bridge.call("nope", "x", ""), /aucun serveur MCP nommé/);
  t.after(() => bridge.closeAll());
  assert.deepEqual(loadMcpConfig(ws), []);
  fs.mkdirSync(path.join(ws, ".smol"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".smol", "mcp.json"), "{broken");
  assert.deepEqual(loadMcpConfig(ws), []);
});

test("bad config entries are skipped, good ones kept", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-mcp-"));
  fs.mkdirSync(path.join(ws, ".smol"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".smol", "mcp.json"),
    JSON.stringify([
      { name: "../../evil", command: "x" },
      { name: "ok", command: "node", args: ["a"], env: { K: "v", N: 3 }, timeoutMs: 5000 },
      { name: "nocmd" },
      "junk",
    ])
  );
  assert.deepEqual(loadMcpConfig(ws), [{ name: "ok", command: "node", args: ["a"], env: { K: "v" }, timeoutMs: 5000 }]);
});

test("list, call, server errors and bad args", async (t) => {
  const { bridge } = scratchWithServer();
  t.after(() => bridge.closeAll());
  assert.match(await bridge.list(), /fake \(2 outils\) : echo, boom/);
  assert.match(await bridge.call("?", "", ""), /fake \(2 outils\)/);
  assert.match(await bridge.call("fake", "echo", '{"a": 1}'), /echo:\{"a":1\}/);
  assert.match(await bridge.call("fake", "boom", ""), /^Error: bad/);
  assert.match(await bridge.call("fake", "nope", ""), /Error: unknown/);
  assert.match(await bridge.call("fake", "echo", "{oops"), /n'est pas un JSON valide/);
  assert.match(await bridge.call("fake", "echo", "[1]"), /doit être un objet JSON/);
  assert.match(await bridge.call("ghost", "echo", ""), /aucun serveur MCP nommé/);
});

test("a silent server times out instead of hanging", async (t) => {
  const { ws } = scratchWithServer();
  const script = path.join(ws, "fake-server.cjs");
  const servers = loadMcpConfig(ws).concat([{ name: "slow", command: process.execPath, args: [script], timeoutMs: 300 }]);
  fs.writeFileSync(path.join(ws, ".smol", "mcp.json"), JSON.stringify(servers));
  const slow = createMcpBridge(ws);
  t.after(() => slow.closeAll());
  assert.match(await slow.call("slow", "hang", ""), /timed out/);
});

test("mcp tool exists in edit and bypass, hidden in read-only", () => {
  assert.ok(buildToolSpecs("edit").some((t) => t.name === "mcp"));
  assert.ok(buildToolSpecs("bypass").some((t) => t.name === "mcp"));
  assert.ok(!buildToolSpecs("ro").some((t) => t.name === "mcp"));
  // 23 edit tools and 11 read-only tools, including local filename search.
  assert.equal(buildToolSpecs("edit").length, 23);
  assert.equal(buildToolSpecs("ro").length, 11);
});

test("windows wrappers resolve to their real file", () => {
  if (process.platform === "win32") {
    assert.match(resolveCommand("npx"), /npx\.cmd$/i);
  } else {
    assert.equal(resolveCommand("npx"), "npx");
  }
  assert.equal(resolveCommand("definitely-not-a-real-command-xyz"), "definitely-not-a-real-command-xyz");
});

test("status lights: green with tools, red with reason", async (t) => {
  const { bridge } = scratchWithServer([{ name: "dead", command: "definitely-not-a-real-command-xyz" }]);
  t.after(() => bridge.closeAll());
  const rows = await bridge.status(10000);
  const fake = rows.find((r) => r.name === "fake");
  const dead = rows.find((r) => r.name === "dead");
  assert.ok(fake?.ok && fake.tools?.includes("echo"), JSON.stringify(rows));
  assert.ok(dead && !dead.ok && dead.error);
  assert.match(dead.error, /introuvable/, "a missing command must say what to do");
});

test("status is cached: it survives closeAll and answers instantly", async (t) => {
  const { ws, bridge } = scratchWithServer();
  t.after(() => bridge.closeAll());
  const first = await bridge.status(10000);
  assert.equal(first[0]?.ok, true, JSON.stringify(first));
  bridge.closeAll(); // a real recheck would have to start the server over
  fs.rmSync(path.join(ws, "fake-server.cjs")); // and its script is gone now
  const t0 = Date.now();
  const second = await bridge.status(10000);
  assert.ok(Date.now() - t0 < 1500, "cached status must not restart anything");
  assert.equal(second[0]?.ok, true, JSON.stringify(second));
});

test("a slow server gets one background retry, then the cache tells the truth", async (t) => {
  process.env.SMOLCODER_MCP_STATUS_RETRY_MS = "3000";
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-mcp-"));
  const script = path.join(ws, "slow-server.cjs");
  fs.writeFileSync(script, `setTimeout(() => {\n${FAKE_SERVER}\n}, 700);`);
  fs.mkdirSync(path.join(ws, ".smol"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".smol", "mcp.json"),
    JSON.stringify([{ name: "slow", command: process.execPath, args: [script], timeoutMs: 5000 }])
  );
  const bridge = createMcpBridge(ws);
  t.after(() => {
    bridge.closeAll();
    delete process.env.SMOLCODER_MCP_STATUS_RETRY_MS;
  });
  const first = await bridge.status(250); // too fast for a 700 ms boot
  assert.equal(first[0]?.ok, false, JSON.stringify(first));
  assert.match(first[0]?.error ?? "", /too slow/);
  await new Promise((r) => setTimeout(r, 1400)); // background retry lands
  const second = await bridge.status(250);
  assert.equal(second[0]?.ok, true, JSON.stringify(second));
  assert.ok(second[0]?.tools?.includes("echo"));
});

test("user-scope servers merge under workspace ones", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-mcp-"));
  const globalFile = path.join(ws, "global.json");
  fs.mkdirSync(path.join(ws, ".smol"), { recursive: true });
  fs.writeFileSync(
    globalFile,
    JSON.stringify([
      { name: "g", command: "gc" },
      { name: "shared", command: "old" },
    ])
  );
  fs.writeFileSync(
    path.join(ws, ".smol", "mcp.json"),
    JSON.stringify([
      { name: "shared", command: "new" },
      { name: "w", command: "wc" },
    ])
  );
  process.env.SMOLCODER_MCP_CONFIG = globalFile;
  try {
    assert.deepEqual(
      loadMcpConfig(ws).map((s) => `${s.name}=${s.command}`),
      ["g=gc", "shared=new", "w=wc"]
    );
  } finally {
    process.env.SMOLCODER_MCP_CONFIG = path.join(os.tmpdir(), "smol-mcp-no-global.json");
  }
});

test("enabled:false listé désactivé et jamais appelé", async (t) => {
  const { ws, bridge } = scratchWithServer([{ name: "off", command: "definitely-not-a-real-command-xyz", enabled: false }]);
  t.after(() => bridge.closeAll());
  assert.equal(loadMcpConfig(ws).find((s) => s.name === "off")?.enabled, false);
  const rows = await bridge.status(5000);
  const off = rows.find((r) => r.name === "off");
  assert.ok(off && !off.ok && /désactivé.*enabled: false/.test(off.error ?? ""), JSON.stringify(rows));
  const listed = await bridge.list();
  assert.ok(!listed.includes("off"), listed);
  assert.match(listed, /fake/);
  assert.match(await bridge.call("off", "echo", ""), /désactivé.*enabled: false/);
  assert.match(await bridge.debugServer("off"), /off.*(ECHEC|désactivé)/i);
});

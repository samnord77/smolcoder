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
  assert.match(await bridge.list(), /No MCP servers configured/);
  assert.match(await bridge.call("nope", "x", ""), /no MCP server named/);
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
  assert.deepEqual(loadMcpConfig(ws), [
    { name: "ok", command: "node", args: ["a"], env: { K: "v" }, timeoutMs: 5000 },
  ]);
});

test("list, call, server errors and bad args", async (t) => {
  const { bridge } = scratchWithServer();
  t.after(() => bridge.closeAll());
  assert.match(await bridge.list(), /fake \(2 tools\): echo, boom/);
  assert.match(await bridge.call("?", "", ""), /fake \(2 tools\)/);
  assert.match(await bridge.call("fake", "echo", '{"a": 1}'), /echo:\{"a":1\}/);
  assert.match(await bridge.call("fake", "boom", ""), /^Error: bad/);
  assert.match(await bridge.call("fake", "nope", ""), /Error: unknown/);
  assert.match(await bridge.call("fake", "echo", "{oops"), /not valid JSON/);
  assert.match(await bridge.call("fake", "echo", "[1]"), /must be a JSON object/);
  assert.match(await bridge.call("ghost", "echo", ""), /no MCP server named/);
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
  assert.equal(buildToolSpecs("edit").length, 14);
  assert.equal(buildToolSpecs("ro").length, 7);
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
});

test("user-scope servers merge under workspace ones", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-mcp-"));
  const globalFile = path.join(ws, "global.json");
  fs.mkdirSync(path.join(ws, ".smol"), { recursive: true });
  fs.writeFileSync(globalFile, JSON.stringify([{ name: "g", command: "gc" }, { name: "shared", command: "old" }]));
  fs.writeFileSync(path.join(ws, ".smol", "mcp.json"), JSON.stringify([{ name: "shared", command: "new" }, { name: "w", command: "wc" }]));
  process.env.SMOLCODER_MCP_CONFIG = globalFile;
  try {
    assert.deepEqual(loadMcpConfig(ws).map((s) => `${s.name}=${s.command}`), ["g=gc", "shared=new", "w=wc"]);
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

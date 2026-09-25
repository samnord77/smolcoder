// Remote MCP over Streamable HTTP: plain JSON, SSE, session ids, key
// refusal and ${VAR} secrets — all against a local stub, offline.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { McpClient, createMcpBridge, expandEnvVars, loadMcpConfig } = require("../dist/mcp");

process.env.SMOLCODER_MCP_CONFIG = path.join(os.tmpdir(), "smol-mcp-no-global.json");

/** Stub remote server. mode: "json" answers plain JSON, "sse" answers an
 * event stream. Records session ids and auth headers it saw. */
function stubServer(mode, { needKey = false } = {}) {
  const seen = { sessions: [], auth: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.sessions.push(req.headers["mcp-session-id"] || null);
      seen.auth.push(req.headers["authorization"] || null);
      let msg = {};
      try {
        msg = JSON.parse(body);
      } catch {
        /* fall through */
      }
      if (needKey && req.headers["authorization"] !== "Bearer secret") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32000, message: "bad key" } }));
        return;
      }
      const answer = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
      if (msg.method === "initialize") {
        const payload = answer({ protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "stub", version: "1" } });
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
        res.end(JSON.stringify(payload));
      } else if (!msg.id) {
        res.writeHead(202);
        res.end();
      } else if (msg.method === "tools/list") {
        const payload = answer({ tools: [{ name: "ping", description: "pong" }] });
        if (mode === "sse") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`: hello\n\ndata: ${JSON.stringify(payload)}\n\n`);
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        }
      } else if (msg.method === "tools/call") {
        const payload = answer({ content: [{ type: "text", text: "pong:" + (msg.params?.name ?? "?") }] });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown" } }));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/mcp` })));
}

test("remote list and call over plain JSON, session id reused", async (t) => {
  const { server, seen, url } = await stubServer("json");
  t.after(() => server.close());
  const c = new (require("../dist/mcp").McpClient)({ name: "r", url, timeoutMs: 10000 });
  t.after(() => c.close());
  assert.deepEqual((await c.listTools()).map((x) => x.name), ["ping"]);
  assert.match(await c.callTool("ping", {}), /pong:ping/);
  assert.ok(seen.sessions.includes("sess-1"), "session id sent back, got: " + JSON.stringify(seen.sessions));
});

test("remote list over SSE", async (t) => {
  const { server, url } = await stubServer("sse");
  t.after(() => server.close());
  const c = new (require("../dist/mcp").McpClient)({ name: "r", url, timeoutMs: 10000 });
  t.after(() => c.close());
  assert.deepEqual((await c.listTools()).map((x) => x.name), ["ping"]);
});

test("wrong key is refused with a clear message", async (t) => {
  const { server, url } = await stubServer("json", { needKey: true });
  t.after(() => server.close());
  const c = new (require("../dist/mcp").McpClient)({ name: "r", url, timeoutMs: 10000 });
  t.after(() => c.close());
  await assert.rejects(c.listTools(), /refused the key/);
});

test("secrets expand from the environment, never from files", async (t) => {
  process.env.SMOKE_MCP_KEY = "secret";
  const { server, seen, url } = await stubServer("json", { needKey: true });
  t.after(() => server.close());
  delete process.env.SMOKE_MCP_KEY;
  const c = new (require("../dist/mcp").McpClient)({
    name: "r",
    url,
    headers: { Authorization: "Bearer ${SMOKE_MCP_KEY}" },
    timeoutMs: 10000,
  });
  t.after(() => c.close());
  assert.equal(expandEnvVars("Bearer ${SMOKE_MCP_KEY}"), "Bearer ");
  process.env.SMOKE_MCP_KEY = "secret";
  assert.deepEqual((await c.listTools()).map((x) => x.name), ["ping"]);
  assert.ok(seen.auth.includes("Bearer secret"));
  delete process.env.SMOKE_MCP_KEY;
});

test("config accepts addresses and rejects junk", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-mcp-"));
  fs.mkdirSync(path.join(ws, ".smol"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".smol", "mcp.json"),
    JSON.stringify([
      { name: "ok", url: "https://mcp.example.com/mcp" },
      { name: "both", command: "x", url: "https://mcp.example.com/y" },
      { name: "bad-url", url: "ftp://x" },
      { name: "empty" },
    ])
  );
  const cfgs = loadMcpConfig(ws);
  assert.equal(cfgs.find((s) => s.name === "ok")?.url, "https://mcp.example.com/mcp");
  assert.ok(cfgs.find((s) => s.name === "both")?.command);
  assert.ok(!cfgs.find((s) => s.name === "bad-url"));
  assert.ok(!cfgs.find((s) => s.name === "empty"));
});

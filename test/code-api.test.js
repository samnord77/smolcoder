// Web code API: /code/availability, /code/symbols, /code/lsp on a live hub
// with a stub session factory (no model backend needed).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { WebHub } = require("../dist/web/hub");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, label = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + label);
    await sleep(25);
  }
}

function stubFactory(calls) {
  return async (ui, workspace, prefs) => {
    calls.push(workspace);
    return {
      chosen: { id: "fake", backend: "ollama" },
      workspace,
      agent: { mode: "edit" },
      toolCtx: { filesTouched: new Set() },
      onExit: null,
      taskManager: { killAll() {}, runningSummary: () => [] },
      state: () => ({ mode: "edit", model: "fake", backend: "ollama", workspace }),
      announce() {},
      restore() {},
      snapshot: () => ({
        messages: [], plan: [], filesTouched: [], commandsRun: [],
        originalRequest: "", currentRequest: "", mode: "edit", effort: null, model: "fake", backend: "ollama",
      }),
      async suggestTitle() { return null; },
      async run() { await new Promise(() => {}); },
    };
  };
}

function request(hub, method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: hub.port, method, path: p, headers: { "content-type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test("code api: availability, symbol search, and lsp coaching", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-codeapi-"));
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "calc.py"), "def add(a, b):\n    return a + b\n");
  fs.writeFileSync(path.join(ws, "note.txt"), "plain text\n");
  const calls = [];
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: stubFactory(calls), quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: ws })).body);
    assert.ok(id);
    await until(() => calls.length === 1, 3000, "factory call");

    const avail = await request(hub, "GET", "/code/availability" + k);
    assert.equal(avail.status, 200);
    const servers = JSON.parse(avail.body).servers;
    assert.deepEqual(servers.map((s) => s.lang), ["typescript", "python", "rust", "go"]);

    const sym = JSON.parse((await request(hub, "GET", `/code/symbols${k}&sid=${id}&q=add`)).body);
    assert.match(sym.result, /add \(function\) — calc\.py:1/);

    const stats = JSON.parse((await request(hub, "GET", `/code/symbols${k}&sid=${id}`)).body);
    assert.match(stats.result, /Index:/);

    const diag = JSON.parse((await request(hub, "GET", `/code/lsp${k}&sid=${id}&action=diag&path=note.txt`)).body);
    assert.match(diag.result, /not a supported language/);

    const hover = JSON.parse((await request(hub, "GET", `/code/lsp${k}&sid=${id}&action=hover`)).body);
    assert.match(hover.result, /path is required/);

    const missing = await request(hub, "GET", `/code/symbols${k}&sid=deadbeef`);
    assert.equal(missing.status, 404);
  } finally {
    hub.close();
  }
});

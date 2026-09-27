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

function followShare(hub, path) {
  return new Promise((resolve) => {
    const events = [];
    const req = http.get({ host: "127.0.0.1", port: hub.port, path }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve({ status: res.statusCode, events, req });
        return;
      }
      let buf = "";
      res.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith("data: ")) {
            try {
              events.push(JSON.parse(chunk.slice(6)));
            } catch {}
          }
        }
      });
      resolve({ status: 200, events, req });
    });
    req.on("error", () => {});
    setTimeout(() => resolve({ status: -1, events, req }), 8000);
  });
}

test("code api: share links, presence, and hunk review", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-codeapi2-"));
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  let haveGit = false;
  try {
    const { spawnSync } = require("node:child_process");
    const run = (a) => spawnSync("git", a, { cwd: ws, encoding: "utf8", timeout: 15000, windowsHide: true });
    if (run(["--version"]).status === 0) {
      run(["init", "-b", "main"]);
      if (run(["rev-parse", "--is-inside-work-tree"]).status !== 0) run(["init"]);
      run(["config", "user.email", "t@t"]);
      run(["config", "user.name", "t"]);
      const lines = Array.from({ length: 20 }, (_, i) => "line" + (i + 1));
      fs.writeFileSync(path.join(ws, "app.txt"), lines.join("\n") + "\n");
      run(["add", "."]);
      run(["commit", "-m", "base"]);
      const changed = [...lines];
      changed[1] = "CHANGED2";
      changed[17] = "CHANGED18";
      fs.writeFileSync(path.join(ws, "app.txt"), changed.join("\n") + "\n");
      fs.writeFileSync(path.join(ws, "new.txt"), "untracked\n");
      haveGit = run(["diff", "--name-only"]).status === 0;
    }
  } catch {
    haveGit = false;
  }
  const calls = [];
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: stubFactory(calls), quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: ws })).body);
    assert.ok(id);
    await until(() => calls.length === 1, 3000, "factory call");

    const share = JSON.parse((await request(hub, "POST", "/sessions/share" + k, { sid: id })).body);
    assert.match(share.token, /^[0-9a-f]{32}$/);
    assert.match((await request(hub, "POST", "/sessions/share" + k, { sid: "deadbeef" })).body, /no such session/);

    const ping = JSON.parse((await request(hub, "GET", "/shared/ping?k=" + share.token + "&name=" + encodeURIComponent("Zoé"))).body);
    assert.equal(ping.sid, id);
    assert.deepEqual(hub.snapshot().workspaces[0].sessions[0].viewers, ["Zoé"]);
    assert.equal((await request(hub, "GET", "/shared/ping?k=nope&name=x")).status, 403);

    const f = await followShare(hub, "/shared?k=" + share.token);
    assert.equal(f.status, 200);
    await until(() => f.events.some((e) => e.t === "shared" && e.sid === id), 3000, "shared hello");
    hub.send({ t: "user", sid: id, s: "hello follower" });
    await until(() => f.events.some((e) => e.t === "user" && e.s === "hello follower"), 3000, "followed event");
    hub.send({ t: "user", sid: "00000000", s: "not yours" });
    await sleep(300);
    assert.ok(!f.events.some((e) => e.s === "not yours"), "other sessions stay private");
    f.req.destroy();
    assert.equal((await followShare(hub, "/shared?k=nope")).status, 403);

    if (!haveGit) return;
    const diff = JSON.parse((await request(hub, "GET", `/code/diff${k}&sid=${id}`)).body);
    assert.equal(diff.files.length, 1);
    assert.equal(diff.files[0].hunks.length, 2);
    assert.match(diff.note, /Untracked.*new\.txt/);
    const st = JSON.parse((await request(hub, "POST", "/code/diff/hunk" + k, { sid: id, path: "app.txt", hunk: 0, action: "stage" })).body);
    assert.match(st.message, /Staged hunk 0/);
    const stagedView = JSON.parse((await request(hub, "GET", `/code/diff${k}&sid=${id}&staged=1`)).body);
    assert.equal(stagedView.files.length, 1);
    const bad = JSON.parse((await request(hub, "POST", "/code/diff/hunk" + k, { sid: id, path: "app.txt", hunk: 0, action: "explode" })).body);
    assert.match(bad.error, /stage.*revert/);
    const rv = JSON.parse((await request(hub, "POST", "/code/diff/hunk" + k, { sid: id, path: "app.txt", hunk: 0, action: "revert" })).body);
    assert.match(rv.message, /Reverted hunk 0/);
    const content = fs.readFileSync(path.join(ws, "app.txt"), "utf8");
    assert.match(content, /CHANGED2/);
    assert.doesNotMatch(content, /CHANGED18/);

    const ds = JSON.parse((await request(hub, "GET", `/code/diag-structured${k}&sid=${id}&path=new.txt`)).body);
    assert.match(ds.text, /not a supported language/);
    assert.deepEqual(ds.diagnostics, []);
  } finally {
    hub.close();
  }
});

test("code api: file ops, plan checklist, and cursor presence", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-codeapi3-"));
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "keep.txt"), "keep\n");
  const calls = [];
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: stubFactory(calls), quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: ws })).body);
    await until(() => calls.length === 1, 3000, "factory call");
    const live = () => hub.live.get(id);

    const created = JSON.parse((await request(hub, "POST", "/workspace/file/new" + k, { sid: id, path: "sub/n.txt" })).body);
    assert.equal(created.path, "sub/n.txt");
    assert.ok(fs.existsSync(path.join(ws, "sub", "n.txt")));
    assert.match((await request(hub, "POST", "/workspace/file/new" + k, { sid: id, path: "sub/n.txt" })).body, /already exists/);
    const made = JSON.parse((await request(hub, "POST", "/workspace/file/new" + k, { sid: id, path: "docs", dir: true })).body);
    assert.equal(made.path, "docs");
    assert.ok(fs.statSync(path.join(ws, "docs")).isDirectory());

    const renamed = JSON.parse((await request(hub, "POST", "/workspace/file/rename" + k, { sid: id, path: "sub/n.txt", to: "sub/m.txt" })).body);
    assert.equal(renamed.path, "sub/m.txt");
    assert.ok(!fs.existsSync(path.join(ws, "sub", "n.txt")) && fs.existsSync(path.join(ws, "sub", "m.txt")));
    assert.match((await request(hub, "POST", "/workspace/file/rename" + k, { sid: id, path: "sub/m.txt", to: "keep.txt" })).body, /already exists/);

    await request(hub, "POST", "/workspace/file/delete" + k, { sid: id, path: "sub/m.txt" });
    assert.ok(!fs.existsSync(path.join(ws, "sub", "m.txt")));
    assert.match((await request(hub, "POST", "/workspace/file/delete" + k, { sid: id, path: "." })).body, /workspace itself/);
    assert.match((await request(hub, "POST", "/workspace/file/delete" + k, { sid: id, path: "../evil.txt" })).body, /outside|workspace/i);

    live().session.agent.mode = "ro";
    assert.match((await request(hub, "POST", "/workspace/file/new" + k, { sid: id, path: "x.txt" })).body, /read-only/);
    live().session.agent.mode = "edit";

    const emptyPlan = JSON.parse((await request(hub, "GET", `/plan${k}&sid=${id}`)).body);
    assert.equal(emptyPlan.exists, false);
    const { Plan } = require("../dist/plan");
    const { Session } = require("../dist/session");
    const plan = new Plan(ws, "testkey");
    assert.match(plan.set("alpha\nbeta"), /Plan set/);
    live().session.toolCtx.plan = plan;
    live().session.planLine = Session.prototype.planLine;
    const full = JSON.parse((await request(hub, "GET", `/plan${k}&sid=${id}`)).body);
    assert.equal(full.total, 2);
    assert.equal(full.done, 0);
    const done = JSON.parse((await request(hub, "POST", "/plan/done" + k, { sid: id, step: 1 })).body);
    assert.match(done.message, /Done: 1/);
    assert.equal(done.plan.done, 1);
    assert.deepEqual(hub.snapshot().workspaces[0].sessions[0].plan, "Plan 1/2 · beta");
    assert.match((await request(hub, "POST", "/plan/done" + k, { sid: id, step: 9 })).body, /does not exist/);

    await request(hub, "POST", "/cursor" + k, { sid: id, path: "keep.txt", line: 3, name: "Zoe" });
    const editing = hub.snapshot().workspaces[0].sessions[0].editing;
    assert.deepEqual(editing, [{ name: "Zoe", path: "keep.txt", line: 3 }]);
    await request(hub, "POST", "/cursor" + k, { sid: id, path: "", name: "Zoe" });
    assert.deepEqual(hub.snapshot().workspaces[0].sessions[0].editing, []);
  } finally {
    hub.close();
  }
});

test("code api: collaborative editing relay", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-codeapi4-"));
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "note.txt"), "hi\n");
  const calls = [];
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: stubFactory(calls), quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: ws })).body);
    await until(() => calls.length === 1, 3000, "factory call");

    const opened = JSON.parse((await request(hub, "POST", "/edit/open" + k, { sid: id, path: "note.txt" })).body);
    assert.equal(opened.text, "hi\n");
    assert.equal(opened.version, 1);
    assert.match((await request(hub, "POST", "/edit/open" + k, { sid: id, path: "missing.txt" })).body, /does not exist/);

    const { docFromText, localInsert } = require("../dist/crdt");
    const d = docFromText("hi\n");
    d.site = "t";
    const ops = localInsert(d, 3, "!");
    const applied = JSON.parse((await request(hub, "POST", "/edit/op" + k, { sid: id, path: "note.txt", ops })).body);
    assert.deepEqual(applied, { version: 2, applied: 1 });
    const again = JSON.parse((await request(hub, "POST", "/edit/op" + k, { sid: id, path: "note.txt", ops })).body);
    assert.equal(again.applied, 0);
    const doc = JSON.parse((await request(hub, "GET", `/edit/doc${k}&sid=${id}&path=note.txt`)).body);
    assert.equal(doc.version, 2);
    assert.equal(doc.chars.filter((c) => !c.dead).map((c) => c.ch).join(""), "hi\n!");
    assert.match((await request(hub, "POST", "/edit/op" + k, { sid: id, path: "other.txt", ops })).body, /open the file/);
    assert.match((await request(hub, "POST", "/edit/op" + k, { sid: id, path: "note.txt", ops: [] })).body, /non-empty array/);
  } finally {
    hub.close();
  }
});

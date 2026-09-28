// Web code API: /code/availability, /code/symbols, /code/lsp on a live hub
// with a stub session factory (no model backend needed).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { WebHub } = require("../dist/web/hub");
const { runCommand, liveShellList } = require("../dist/tools/shell");

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

test("code api: review file actions with read-only guard", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-codeapi5-"));
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
      fs.writeFileSync(path.join(ws, "a.txt"), "one\n");
      fs.writeFileSync(path.join(ws, "b.txt"), "two\n");
      run(["add", "."]);
      run(["commit", "-m", "base"]);
      fs.writeFileSync(path.join(ws, "a.txt"), "ONE\n");
      fs.writeFileSync(path.join(ws, "b.txt"), "TWO\n");
      haveGit = run(["diff", "--name-only"]).status === 0;
    }
  } catch {
    haveGit = false;
  }
  if (!haveGit) return;
  const calls = [];
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: stubFactory(calls), quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: ws })).body);
    await until(() => calls.length === 1, 3000, "factory call");
    const post = (p, body) => request(hub, "POST", p + k, { sid: id, ...body });

    const st = JSON.parse((await post("/code/diff/stage", { path: "a.txt" })).body);
    assert.match(st.message, /Staged/);
    const stagedView = JSON.parse((await request(hub, "GET", `/code/diff${k}&sid=${id}&staged=1`)).body);
    assert.equal(stagedView.files.length, 1);

    // unstage: file and hunk leave the index, the working tree is untouched
    const un = JSON.parse((await post("/code/diff/unstage", { path: "a.txt" })).body);
    assert.match(un.message, /Unstaged: a\.txt/);
    assert.match(un.message, /working tree keeps every change/i);
    assert.equal(
      JSON.parse((await request(hub, "GET", `/code/diff${k}&sid=${id}&staged=1`)).body).files.length,
      0,
      "the file left the staging area"
    );
    assert.match(JSON.parse((await post("/code/diff/unstage", { path: "a.txt" })).body).message, /Nothing staged/);
    assert.match(
      JSON.parse((await post("/code/diff/hunk", { path: "a.txt", hunk: 0, action: "unstage" })).body).message,
      /not staged/
    );
    assert.match(JSON.parse((await post("/code/diff/stage", { path: "a.txt" })).body).message, /Staged/);

    const rv = JSON.parse((await post("/code/diff/revert-file", { path: "b.txt" })).body);
    assert.match(rv.message, /Reverted/);
    assert.equal(fs.readFileSync(path.join(ws, "b.txt"), "utf8").replace(/\r\n/g, "\n"), "two\n");
    assert.match(JSON.parse((await post("/code/diff/revert-file", { path: "missing.txt" })).body).message, /does not exist|failed/);

    const cm = JSON.parse((await post("/code/commit", { message: "Second" })).body);
    assert.match(cm.message, /Second|master|main|create/i);

    const sl1 = JSON.parse((await post("/code/diff/stage-lines", { sid: id, path: "app.txt", hunk: 0, lines: [] })).body);
    assert.match(sl1.message, /at least one|no longer exists/);

    hub.live.get(id).session.agent.mode = "ro";
    for (const [p, body] of [
      ["/code/diff/stage", { path: "a.txt" }],
      ["/code/diff/unstage", { path: "a.txt" }],
      ["/code/diff/revert-file", { path: "a.txt" }],
      ["/code/commit", { message: "x" }],
      ["/code/diff/hunk", { path: "a.txt", hunk: 0, action: "stage" }],
      ["/code/diff/hunk", { path: "a.txt", hunk: 0, action: "unstage" }],
      ["/code/diff/stage-lines", { path: "a.txt", hunk: 0, lines: [0] }],
    ]) {
      assert.match((await post(p, body)).body, /read-only/, p + " is gated");
    }
    hub.live.get(id).session.agent.mode = "edit";
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

test("code api: inline edit generates a preview without writing", async () => {
  const { Agent } = require("../dist/agent");
  const { ContextManager } = require("../dist/context");
  const { EventBus } = require("../dist/events");
  const { Plan } = require("../dist/plan");
  const { TaskManager } = require("../dist/tools/tasks");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-codeapi5-"));
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "app.js"), "const x = 1;\nconsole.log(x);\n");
  const fakeProvider = {
    label: "fake",
    modelId: "fake",
    contextWindow: 8000,
    maxOutputTokens: 500,
    setEffort() {},
    effortLabel: () => null,
    chat: async () => ({ content: "```js\nconst x = 2;\n```", toolCalls: [] }),
  };
  const factory = () => async (ui, workspace) => {
    const toolCtx = {
      workspace,
      taskManager: new TaskManager(workspace),
      plan: new Plan(),
      filesTouched: new Set(),
      commandsRun: [],
      canWrite: true,
    };
    const agent = new Agent(
      fakeProvider, "edit", "sys", toolCtx, new ContextManager(8000, 500),
      new EventBus(),
      { token() {}, thinking() {}, toolCall() {}, toolResult() {}, println() {}, status() {}, warn() {}, error() {}, startSpinner() {}, stopSpinner() {}, turnEnd() {}, planUpdated() {} },
      false, 10
    );
    return {
      chosen: { id: "fake", backend: "ollama" },
      workspace, agent, toolCtx,
      onExit: null,
      taskManager: toolCtx.taskManager,
      state: () => ({}),
      announce() {}, restore() {},
      snapshot: () => ({}),
      async suggestTitle() { return null; },
      async run() { await new Promise(() => {}); },
    };
  };
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: factory(), quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, ms = 15000, label = "condition") {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + label);
      await sleep(50);
    }
  }
  try {
    const { id } = JSON.parse((await request(hub, "POST", "/sessions/new" + k, { workspace: ws })).body);
    assert.ok(id);
    const started = JSON.parse(
      (await request(hub, "POST", "/code/inline/start" + k, { sid: id, path: "app.js", selection: "const x = 1;", start: 1, end: 1, instruction: "bump to 2" })).body
    );
    assert.match(started.op, /^[0-9a-f]+$/);
    const done = await until(async () => {
      const r = JSON.parse((await request(hub, "GET", `/code/inline/result${k}&id=${started.op}`)).body);
      return r.status === "done" ? r : r.status === "error" ? Promise.reject(new Error(r.error)) : null;
    }, 15000, "inline result");
    assert.equal(done.newText, "const x = 2;");
    assert.match(done.diff, /const x = 2/);
    assert.equal(fs.readFileSync(path.join(ws, "app.js"), "utf8"), "const x = 1;\nconsole.log(x);\n", "preview only — disk untouched");
    const bad = JSON.parse((await request(hub, "POST", "/code/inline/start" + k, { sid: id, path: "app.js", selection: "x", start: 1, end: 1, instruction: "" })).body);
    assert.match(bad.error, /instruction is required/);
    hub.live.get(id).session.agent.mode = "ro";
    const ro = JSON.parse((await request(hub, "POST", "/code/inline/start" + k, { sid: id, path: "app.js", selection: "x", start: 1, end: 1, instruction: "y" })).body);
    assert.match(ro.error || (await request(hub, "GET", `/code/inline/result${k}&id=${ro.op}`)).body, /read-only/);
    hub.live.get(id).session.agent.mode = "edit";
    assert.match((await request(hub, "GET", `/code/inline/result${k}&id=nope`)).body, /unknown edit job/);
  } finally {
    hub.close();
  }
});

test("shell api: live list, extend and cancel act on a real run", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-shellapi-"));
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: stubFactory([]), quiet: true });
  await hub.start();
  const k = "?k=" + hub.authToken;
  try {
    const idle = JSON.parse((await request(hub, "GET", "/shell/live" + k)).body);
    assert.deepEqual(idle, { items: [] }, "nothing running yet");
    const miss = JSON.parse((await request(hub, "POST", "/shell" + k, { action: "detach", command: "nope" })).body);
    assert.equal(miss.ok, false);
    assert.match(miss.reason, /no longer running/);

    const cmd = 'node -e "setTimeout(()=>{},6000)"';
    const p = runCommand(cmd, process.cwd(), undefined, () => {});
    await until(() => liveShellList().some((i) => i.command === cmd), 3000, "run registered");
    const live = JSON.parse((await request(hub, "GET", "/shell/live" + k)).body);
    const mine = live.items.filter((i) => i.command === cmd);
    assert.equal(mine.length, 1, "the run shows up with a real deadline");
    assert.ok(mine[0].deadline > Date.now());

    const ext = JSON.parse((await request(hub, "POST", "/shell" + k, { action: "extend", command: cmd, ms: 60000 })).body);
    assert.equal(ext.ok, true, "extend accepted");
    assert.ok(ext.deadline >= mine[0].deadline, "the deadline moved out");
    const bad = JSON.parse((await request(hub, "POST", "/shell" + k, { action: "unknown-action", command: cmd })).body);
    assert.equal(bad.ok, false, "unknown actions are refused with a reason");

    const cancel = JSON.parse((await request(hub, "POST", "/shell" + k, { action: "cancel", command: cmd })).body);
    assert.equal(cancel.ok, true, "cancel acts for real");
    assert.match(await p, /cancelled/, "and the run resolves as cancelled");
    const gone = JSON.parse((await request(hub, "GET", "/shell/live" + k)).body);
    assert.ok(!gone.items.some((i) => i.command === cmd), "a finished run leaves the list");
  } finally {
    hub.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

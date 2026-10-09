// The web hub and its parts: session channel semantics (input, approvals,
// cancel, close), on-disk session/workspace stores, the folder picker
// listing, the embedded terminal (a real shell), and the hub's HTTP surface
// driven with a fake session factory (no model backend needed).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { SessionChannel } = require("../dist/web/channel");
const { SessionStore, WorkspaceStore, workspaceKey } = require("../dist/web/store");
const { Terminal, stripControl, toOsPath } = require("../dist/web/terminal");
const { WebHub, browseDir, readHubRecord } = require("../dist/web/hub");
const { cleanTitle, suggestTitle } = require("../dist/session");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, label = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}
function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---- channel -----------------------------------------------------------------

function makeChannel(id = "s1") {
  const sent = [];
  const changes = [];
  const ch = new SessionChannel(id, { send: (ev) => sent.push(ev), changed: () => changes.push(ch.phase), touched() {} });
  return { ch, sent, changes };
}

test("channel: tool lifecycle keeps execution ids and classifies the actual tool", () => {
  const { ch, sent } = makeChannel();
  ch.toolCall("write_file", { path: "src/app.ts" }, "tool-write-1");
  ch.toolResult("Created src/app.ts", "tool-write-1");
  assert.deepEqual(
    sent.filter((event) => event.t === "tool" || event.t === "result").map((event) => [event.t, event.executionId, event.category]),
    [
      ["tool", "tool-write-1", "modification"],
      ["result", "tool-write-1", undefined],
    ]
  );
});

test("channel: cancelled turns are replayable lifecycle events", () => {
  const { ch, sent } = makeChannel();
  ch.turnCancelled();
  assert.deepEqual(sent.at(-1), { t: "turn_cancelled", sid: "s1" });
  assert.ok(ch.replay.some((event) => event.t === "turn_cancelled"));
});

test("channel: a message resolves readInput, is echoed with the session id, and titles the session", async () => {
  const { ch, sent } = makeChannel();
  const p = ch.readInput();
  assert.equal(ch.phase, "idle");
  ch.handleMessage("  build the game  ");
  assert.equal(await p, "build the game");
  assert.equal(ch.phase, "busy");
  assert.equal(ch.title, "build the game");
  const user = sent.find((e) => e.t === "user");
  assert.deepEqual({ t: user.t, s: user.s, sid: user.sid }, { t: "user", s: "build the game", sid: "s1" });
  assert.ok(
    ch.replay.some((e) => e.t === "user"),
    "user events are replayed"
  );
  assert.ok(!ch.replay.some((e) => e.t === "state"), "state events are not replayed");
});
test("channel: Cowork execution ID survives the input queue without changing the prompt", async () => {
  const { ch, sent } = makeChannel();
  const id = "w_01234567-89ab-cdef-0123-456789abcdef";
  const pending = ch.readInput();
  ch.handleMessage("Run this work item", [], id);
  assert.deepEqual(await pending, { text: "Run this work item", attachments: [], workItemId: id });
  const event = sent.find((item) => item.t === "user");
  assert.equal(event.s, "Run this work item");
  assert.equal(event.workItemId, id);
});
test("channel: messages sent while busy queue up and a slash command does not become the title", async () => {
  const { ch } = makeChannel();
  ch.handleMessage("/models");
  ch.handleMessage("second");
  assert.equal(await ch.readInput(), "/models");
  assert.equal(ch.title, "");
  assert.equal(await ch.readInput(), "second");
  assert.equal(ch.title, "second");
});

test("channel: approvals flip the phase to waiting and resolve through handleAnswer", async () => {
  const { ch, sent } = makeChannel();
  const p = ch.confirmCommand("rm -rf /tmp/x", "reaches outside the workspace");
  assert.equal(ch.phase, "waiting");
  const ask = sent.find((e) => e.t === "confirm");
  ch.handleAnswer(ask.id, "always");
  assert.equal(await p, "always");
  assert.equal(ch.phase, "busy");
  assert.ok(
    sent.some((e) => e.t === "answered" && e.id === ask.id),
    "the settled prompt is recorded for replay"
  );
  assert.ok(
    ch.replay.some((e) => e.t === "line" && /always allow — rm -rf \/tmp\/x/.test(e.s)),
    "and so is the answer"
  );
  const sel = ch.select("Pick", [{ label: "a" }, { label: "b" }]);
  ch.handleAnswer(sent.find((e) => e.t === "select").id, 1);
  assert.equal(await sel, 1);
});

test("channel: a text prompt resolves with the typed line, null when empty or cancelled, and is not replayed live", async () => {
  const { ch, sent } = makeChannel();
  const p = ch.prompt("Address of the machine", "192.168.1.50");
  assert.equal(ch.phase, "waiting");
  const ask = sent.find((e) => e.t === "prompt");
  assert.deepEqual({ title: ask.title, placeholder: ask.placeholder }, { title: "Address of the machine", placeholder: "192.168.1.50" });
  ch.handleAnswer(ask.id, "  gpu-box.local ");
  assert.equal(await p, "gpu-box.local");
  assert.ok(
    ch.replay.some((e) => e.t === "line" && e.s === "Address of the machine: gpu-box.local"),
    "the answer is kept in the transcript"
  );

  const empty = ch.prompt("Name");
  ch.handleAnswer(sent.filter((e) => e.t === "prompt")[1].id, "   ");
  assert.equal(await empty, null);
  const open = ch.prompt("Name");
  ch.cancel();
  assert.equal(await open, null);

  const { ch: restored } = makeChannel("s2");
  restored.restoreReplay(ch.replay);
  assert.ok(!restored.replay.some((e) => e.t === "prompt"), "a saved session does not come back with a live text box");
});

test("channel: cancel answers an open prompt with no/null before aborting the turn", async () => {
  const { ch } = makeChannel();
  let cancelled = 0;
  ch.onCancel = () => cancelled++;
  const conf = ch.confirmCommand("npm i -g x");
  const sel = ch.select("Pick", [{ label: "a" }]);
  ch.cancel();
  assert.equal(await conf, "no");
  assert.equal(await sel, null);
  assert.equal(cancelled, 1);
});

test("channel: requestExit hands the loop /exit silently, now and on later reads", async () => {
  const { ch, sent } = makeChannel();
  const p = ch.readInput();
  ch.requestExit();
  assert.equal(await p, "/exit");
  assert.equal(await ch.readInput(), "/exit");
  assert.ok(!sent.some((e) => e.t === "user"), "no user echo for the synthetic /exit");
});

test("channel: the state event carries the busy label so a reconnecting page restores its spinner", () => {
  const { ch } = makeChannel();
  ch.getState = () => ({ mode: "edit" });
  ch.startSpinner("thinking");
  assert.deepEqual(ch.stateEvent().s, {
    mode: "edit",
    busy: "thinking",
    title: "",
    subagent: null,
    subagentRuns: 0,
    skills: [],
  });
  ch.stopSpinner();
  assert.equal(ch.stateEvent().s.busy, null);
});

test("channel: a finished turn releases its autopilot phase so the status bar has no ghost chip", () => {
  const { ch } = makeChannel();
  ch.autopilotPhase("thinking", "raisonnement du modèle — étape 1/1000");
  assert.equal(ch.stateEvent().s.autopilot.phase, "thinking");
  ch.autopilotPhase("completed", "tâche terminée et résultat vérifié");
  assert.equal(ch.autopilot, null, "the terminal phase is released");
  assert.ok(!("autopilot" in ch.stateEvent().s), "the live state carries no phase once the turn is over");
  assert.ok(
    ch.replay.some((e) => e.t === "autopilot" && e.phase === "completed"),
    "the phase still streams while it happens"
  );
});

test("channel: a cancelled turn releases its autopilot phase too", () => {
  const { ch } = makeChannel();
  ch.autopilotPhase("thinking", "raisonnement du modèle");
  ch.turnCancelled();
  assert.equal(ch.autopilot, null, "cancel is terminal as well");
  assert.ok(!("autopilot" in ch.stateEvent().s), "no phase survives the cancel");
  assert.ok(ch.replay.some((e) => e.t === "turn_cancelled"));
});

test("channel: returning to idle drops a leftover error phase", async () => {
  const { ch } = makeChannel();
  ch.autopilotPhase("error", "provider down", { message: "provider down" });
  assert.equal(ch.stateEvent().s.autopilot.phase, "error");
  const p = ch.readInput();
  assert.ok(!("autopilot" in ch.stateEvent().s), "no phase survives into the next wait for input");
  ch.handleMessage("suite");
  assert.equal(await p, "suite");
});

test("channel: the status view sees live sub-agents and auto-loaded skills", () => {
  const { ch, sent } = makeChannel();
  ch.subagent("start", "explore login flow");
  assert.equal(ch.stateEvent().s.subagent, "explore login flow");
  assert.equal(ch.stateEvent().s.subagentRuns, 1);
  ch.subagent("done", "completed: 2 actions", {
    outcome: "completed",
    verification: "passed",
    report: "Found the login handler.",
    filesTouched: ["src/login.ts"],
    toolCalls: 2,
  });
  assert.equal(ch.stateEvent().s.subagent, null);
  assert.deepEqual(sent.find((e) => e.t === "sub" && e.phase === "done").details, {
    outcome: "completed",
    verification: "passed",
    report: "Found the login handler.",
    filesTouched: ["src/login.ts"],
    toolCalls: 2,
  });
  ch.skills(["impeccable-design", 42, "  "]);
  assert.deepEqual(ch.stateEvent().s.skills, ["impeccable-design"]);
  assert.ok(sent.some((e) => e.t === "skills" && e.names[0] === "impeccable-design"));
  assert.ok(sent.some((e) => e.t === "sub" && e.phase === "start"));
});

// ---- stores ------------------------------------------------------------------

test("store: session meta/body round trip, listing and delete", async () => {
  const dir = tmpdir("smol-store-");
  const store = new SessionStore(dir);
  const meta = { id: "ab12", workspace: dir, title: "hello", createdAt: 1, updatedAt: 2, model: "m", backend: "ollama" };
  store.saveMeta(meta);
  await store.saveBody("ab12", { snapshot: { messages: [{ role: "user", content: "hi" }], plan: [] }, events: [{ t: "user", s: "hi" }] });
  assert.deepEqual(store.listMetas(), [meta]);
  const body = store.loadBody("ab12");
  assert.equal(body.snapshot.messages[0].content, "hi");
  assert.equal(body.events.length, 1);
  assert.equal(store.loadBody("nope"), null);
  fs.writeFileSync(path.join(dir, "sessions", "broken.meta.json"), "{not json");
  assert.equal(store.listMetas().length, 1, "broken files are skipped");
  store.delete("ab12");
  assert.equal(store.listMetas().length, 0);
  assert.equal(store.loadBody("ab12"), null);
});

test("store: workspaces dedupe by normalized path and survive a reload", () => {
  const dir = tmpdir("smol-ws-");
  const ws = new WorkspaceStore(dir);
  const p = path.join(dir, "proj");
  fs.mkdirSync(p);
  ws.add(p + path.sep);
  ws.add(p);
  assert.equal(ws.list().length, 1);
  assert.ok(ws.has(p));
  assert.equal(workspaceKey(p + path.sep), workspaceKey(p));
  const again = new WorkspaceStore(dir);
  assert.equal(again.list().length, 1);
  again.remove(p);
  assert.equal(again.list().length, 0);
});

// ---- folder picker -----------------------------------------------------------

test("browseDir lists subfolders, flags projects, hides dot folders and reports errors", () => {
  const dir = tmpdir("smol-fs-");
  fs.mkdirSync(path.join(dir, "app"));
  fs.writeFileSync(path.join(dir, "app", "package.json"), "{}");
  fs.mkdirSync(path.join(dir, "notes"));
  fs.mkdirSync(path.join(dir, ".hidden"));
  fs.writeFileSync(path.join(dir, "file.txt"), "x");
  const d = browseDir(dir);
  assert.equal(d.error, undefined);
  assert.deepEqual(
    d.dirs.map((x) => [x.name, x.project]),
    [
      ["app", true],
      ["notes", false],
    ]
  );
  assert.equal(d.parent, path.dirname(dir));
  assert.ok(Array.isArray(d.roots) && d.roots.length > 0);
  assert.match(browseDir(path.join(dir, "missing")).error, /not a folder/);
  assert.match(browseDir(path.join(dir, "file.txt")).error, /not a folder/);
  assert.equal(browseDir("").path, os.homedir());
});

// ---- terminal ----------------------------------------------------------------

test("terminal helpers: control sequences are stripped but colors kept; msys paths map back", () => {
  assert.equal(stripControl("\x1b[32mok\x1b[0m \x1b[2J\x1b[H\x1b]0;title\x07x"), "\x1b[32mok\x1b[0m x");
  if (process.platform === "win32") assert.equal(toOsPath("/c/Projects/x"), "C:\\Projects\\x");
  else assert.equal(toOsPath("/home/x"), "/home/x");
});

test("terminal: runs commands in a persistent shell, reports exit codes and tracks cwd", async () => {
  const dir = fs.realpathSync(tmpdir("smol-term-"));
  fs.mkdirSync(path.join(dir, "sub"));
  let out = "";
  const dones = [];
  const term = new Terminal("t1", dir, { output: (s) => (out += s), done: (code, cwd) => dones.push({ code, cwd }) });
  try {
    term.write("echo hello-from-shell");
    await until(() => dones.length >= 1, 15000, "first command");
    assert.equal(dones[0].code, 0);
    assert.match(out, /hello-from-shell/);
    assert.match(out.replace(/\x1b\[[0-9;]*m/g, ""), /❯ echo hello-from-shell\n/, "the command is echoed into the stream");
    term.write("cd sub");
    await until(() => dones.length >= 2, 15000, "cd");
    assert.equal(path.basename(dones[1].cwd), "sub");
    assert.equal(path.basename(term.cwd), "sub");
    term.write("exit 3");
    await until(() => /starting a new one/.test(out), 15000, "respawn after exit");
    term.write("echo again");
    await until(() => /again\n/.test(out) || dones.length >= 3, 15000, "command after respawn");
    assert.ok(term.buffer.includes("hello-from-shell"), "the replay buffer keeps output");
  } finally {
    term.close();
  }
});

// ---- hub -------------------------------------------------------------------------

/** A stand-in for Session: echoes each input back, honours /exit. */
function fakeFactory(log) {
  return async (ui, workspace, prefs, planKey) => {
    log.push({ workspace, prefs, planKey });
    const session = {
      chosen: { id: "fake-model", backend: "ollama" },
      workspace,
      agent: { mode: prefs.mode || "edit" },
      toolCtx: { filesTouched: new Set() },
      onExit: null,
      restored: null,
      taskManager: { killAll() {}, runningSummary: () => [], recentUrls: () => ["http://localhost:5173"] },
      state: () => ({
        mode: prefs.mode || "edit",
        model: session.chosen.id,
        backend: "ollama",
        workspace,
        urls: ["http://localhost:5173"],
        commands: [],
      }),
      announce() {
        ui.status("· fake session ready");
      },
      restore(s) {
        session.restored = s;
      },
      snapshot: () => ({
        messages: [{ role: "user", content: "x" }],
        plan: [],
        filesTouched: [],
        commandsRun: [],
        originalRequest: "x",
        currentRequest: "x",
        mode: "edit",
        effort: null,
        model: "fake-model",
        backend: "ollama",
      }),
      // The "model" takes a moment to name the session, like a real one.
      async suggestTitle() {
        await sleep(300);
        return "Hello Session";
      },
      async run() {
        for (;;) {
          const input = await ui.readInput();
          if (input === "/exit") {
            ui.close();
            session.onExit?.();
            return;
          }
          if (input === "/models") {
            const options = [{ label: "fake-model" }, { label: "late:7b" }];
            const index = await ui.select("Choisir un modèle", options);
            if (index === null) {
              ui.warn("chargement annulé — rechoisissez le modèle une fois son serveur prêt");
              continue;
            }
            session.chosen = { id: options[index].label, backend: "ollama" };
            ui.startSpinner(`loading ${session.chosen.id}`);
            await sleep(60);
            ui.stopSpinner();
            ui.turnEnd("model");
            continue;
          }
          ui.startSpinner("thinking");
          ui.token(`echo: ${input}`);
          ui.stopSpinner();
          ui.turnEnd("done");
          if (session.onTurnDone) session.onTurnDone();
        }
      },
    };
    return session;
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

/** Read SSE events from /events until one satisfies `stopWhen` (or 3s pass). */
function readEvents(hub, stopWhen) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get({ host: "127.0.0.1", port: hub.port, path: `/events?k=${hub.authToken}` }, (res) => {
      let buf = "";
      const finish = () => {
        req.destroy();
        resolve(events);
      };
      const timer = setTimeout(finish, 3000);
      res.on("data", (d) => {
        buf += d;
        while (true) {
          const i = buf.indexOf("\n\n");
          if (i < 0) break;
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith("data: ")) events.push(JSON.parse(chunk.slice(6)));
        }
        if (events.some(stopWhen)) {
          clearTimeout(timer);
          finish();
        }
      });
    });
    req.on("error", (e) => (e.code === "ECONNRESET" ? resolve(events) : reject(e)));
  });
}

test("hub: token guard, page, ping, folder listing, and the running-hub record", async () => {
  const dataDir = tmpdir("smol-hub-");
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: fakeFactory([]), quiet: true });
  await hub.start();
  try {
    assert.equal((await request(hub, "GET", "/")).status, 403);
    assert.equal((await request(hub, "GET", "/?k=wrong")).status, 403);
    const page = await request(hub, "GET", `/?k=${hub.authToken}`);
    assert.equal(page.status, 200);
    assert.match(page.body, /id="side"/);
    assert.match(page.body, /id="panel"/);
    assert.match(page.body, /id="systemmonitor"/);
    assert.match(page.body, /id="sessionstats"/);
    const ping = JSON.parse((await request(hub, "GET", `/ping?k=${hub.authToken}`)).body);
    assert.equal(ping.ok, true);
    const rec = readHubRecord(dataDir);
    assert.equal(rec.port, hub.port);
    assert.equal(rec.token, hub.authToken);
    const fsr = JSON.parse((await request(hub, "GET", `/fs?k=${hub.authToken}&path=${encodeURIComponent(dataDir)}`)).body);
    assert.deepEqual(
      fsr.dirs.map((d) => d.name),
      ["sessions"]
    );
    const bad = await request(hub, "POST", `/nope?k=${hub.authToken}`, {});
    assert.equal(bad.status, 400);
  } finally {
    hub.close();
  }
  assert.equal(readHubRecord(dataDir), null, "the record is removed on shutdown");
});

test("hub: sessions start, echo, save, close, resume, delete; workspaces add and remove", async () => {
  const dataDir = tmpdir("smol-hub2-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  const calls = [];
  const hub = new WebHub({
    port: 0,
    prefs: { effort: "off" },
    help: "help",
    version: "9.9.9",
    dataDir,
    factory: fakeFactory(calls),
    quiet: true,
  });
  await hub.start();
  const k = `?k=${hub.authToken}`;
  try {
    // add a workspace without starting anything
    const added = JSON.parse((await request(hub, "POST", `/workspaces/add${k}`, { path: ws })).body);
    assert.equal(added.path, ws);
    assert.equal(added.id, undefined);
    const snap = hub.snapshot();
    assert.equal(snap.workspaces.length, 1);
    assert.equal(snap.workspaces[0].sessions.length, 0);
    assert.match((await request(hub, "POST", `/workspaces/add${k}`, { path: path.join(dataDir, "missing") })).body, /not a folder/);

    // start a session and talk to it
    const { id } = JSON.parse((await request(hub, "POST", `/sessions/new${k}`, { workspace: ws })).body);
    assert.ok(id);
    await until(() => calls.length === 1, 2000, "factory call");
    assert.equal(calls[0].prefs.effort, "off");
    assert.equal(calls[0].planKey, id, "each web conversation gets an isolated durable plan key");
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "idle session");
    const workCreated = JSON.parse(
      (
        await request(hub, "POST", `/work/items${k}`, {
          sid: id,
          action: "create",
          title: "Review cowork integration",
          area: "IDE",
          priority: "high",
        })
      ).body
    );
    assert.match(workCreated.result, /Created work item/);
    assert.equal(workCreated.items.length, 1);
    assert.equal(workCreated.items[0].title, "Review cowork integration");
    const workCompleted = await request(hub, "POST", `/work/items${k}`, {
      sid: id,
      action: "complete",
      task_id: workCreated.items[0].id,
    });
    assert.equal(JSON.parse(workCompleted.body).items[0].status, "completed");
    const workStatus = JSON.parse((await request(hub, "GET", `/status?k=${hub.authToken}&sid=${encodeURIComponent(id)}`)).body);
    assert.equal(workStatus.workItems[0].title, "Review cowork integration");
    hub.live.get(id).session.agent.mode = "ro";
    const readOnlyWrite = JSON.parse(
      (
        await request(hub, "POST", `/work/items${k}`, {
          sid: id,
          action: "create",
          title: "Must be blocked",
        })
      ).body
    );
    assert.match(readOnlyWrite.error, /read-only mode/i);
    hub.live.get(id).session.agent.mode = "edit";
    await request(hub, "POST", `/msg${k}`, { sid: id, text: "hello there" });
    await until(() => hub.snapshot().workspaces[0].sessions[0].title === "hello there", 2000, "verbatim title");
    await until(() => hub.snapshot().workspaces[0].sessions[0].title === "Hello Session", 2000, "model-written title");
    const events = await readEvents(hub, (e) => e.t === "state" && e.sid === id);
    assert.equal(events[0].t, "hub");
    assert.ok(
      events.some((e) => e.t === "user" && e.sid === id && e.s === "hello there"),
      "replay includes the user message"
    );
    assert.ok(
      events.some((e) => e.t === "token" && e.s === "echo: hello there"),
      "replay includes the reply"
    );
    assert.ok(
      events.some((e) => e.t === "state" && e.sid === id && e.s.model === "fake-model"),
      "state follows the replay"
    );

    // a terminal on the session shows up in the snapshot and is replayed to new pages
    const term = JSON.parse((await request(hub, "POST", `/term/open${k}`, { sid: id })).body);
    assert.ok(term.tid);
    assert.equal(hub.snapshot().workspaces[0].sessions[0].terminals[0].tid, term.tid);
    await request(hub, "POST", `/term/close${k}`, { sid: id, tid: term.tid });
    assert.equal(hub.snapshot().workspaces[0].sessions[0].terminals.length, 0);

    // saved to disk after the debounce
    const metaFile = path.join(dataDir, "sessions", `${id}.meta.json`);
    await until(() => fs.existsSync(metaFile) && fs.existsSync(path.join(dataDir, "sessions", `${id}.json`)), 4000, "save");
    assert.equal(JSON.parse(fs.readFileSync(metaFile, "utf8")).title, "Hello Session");

    // close: it stays listed as a stored session
    await request(hub, "POST", `/sessions/close${k}`, { id });
    await until(() => hub.snapshot().workspaces[0].sessions[0].live === false, 2000, "closed");
    assert.equal(hub.snapshot().workspaces[0].sessions[0].status, "stored");

    // resume: the factory runs again with the saved prefs and the transcript is restored
    await request(hub, "POST", `/sessions/resume${k}`, { id });
    await until(() => calls.length === 2, 2000, "second factory call");
    assert.equal(calls[1].prefs.model, "fake-model");
    assert.equal(calls[1].planKey, id, "resuming a conversation reuses its plan key");
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "resumed idle");
    const events2 = await readEvents(hub, (e) => e.t === "state" && e.sid === id);
    assert.ok(
      events2.some((e) => e.t === "user" && e.s === "hello there"),
      "old transcript replays after resume"
    );

    // rename, then delete while live: gone from disk and from the list
    await request(hub, "POST", `/sessions/rename${k}`, { id, title: "renamed" });
    assert.equal(hub.snapshot().workspaces[0].sessions[0].title, "renamed");
    await request(hub, "POST", `/sessions/delete${k}`, { id });
    await until(() => hub.snapshot().workspaces[0].sessions.length === 0, 2000, "deleted");
    await sleep(100);
    assert.equal(fs.existsSync(metaFile), false);

    // remove the workspace
    await request(hub, "POST", `/workspaces/remove${k}`, { path: ws });
    assert.equal(hub.snapshot().workspaces.length, 0);
    assert.match((await request(hub, "POST", `/sessions/resume${k}`, { id: "zzz" })).body, /unknown session/);
  } finally {
    hub.close();
  }
});

test("hub: the /models picker reaches the page, backing out keeps the session alive, picking switches it", async () => {
  const dataDir = tmpdir("smol-hub-models-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws);
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: fakeFactory([]), quiet: true });
  await hub.start();
  const k = `?k=${hub.authToken}`;
  try {
    const { id } = JSON.parse((await request(hub, "POST", `/sessions/new${k}`, { workspace: ws })).body);
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "idle session");

    // The slash command opens a picker over the wire, and the page waits on it.
    await request(hub, "POST", `/msg${k}`, { sid: id, text: "/models" });
    const picks = await readEvents(hub, (e) => e.t === "select" && e.sid === id);
    const pick = picks.find((e) => e.t === "select" && e.sid === id);
    assert.equal(pick.title, "Choisir un modèle");
    assert.deepEqual(
      pick.options.map((o) => o.label),
      ["fake-model", "late:7b"]
    );
    assert.equal(hub.snapshot().workspaces[0].sessions[0].status, "waiting", "the session waits on the picker");

    // Backing out says so plainly and leaves the session usable.
    const cancelledSeen = readEvents(hub, (e) => e.t === "line" && e.kind === "warn" && e.sid === id);
    await sleep(80); // let the event stream connect before the answer arrives
    await request(hub, "POST", `/select${k}`, { sid: id, id: pick.id, index: null });
    assert.ok(
      (await cancelledSeen).some((e) => e.t === "line" && e.kind === "warn" && /chargement annulé — rechoisissez le modèle/.test(e.s)),
      "the cancel is reported in the transcript"
    );
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "idle after backing out");

    // Picking one really switches the session's model, seen by the page.
    await request(hub, "POST", `/msg${k}`, { sid: id, text: "/models" });
    const again = await readEvents(hub, (e) => e.t === "select" && e.sid === id && e.id !== pick.id);
    const pick2 = again.find((e) => e.t === "select" && e.id !== pick.id);
    assert.ok(pick2, "a second picker opens after the cancel");
    const switchedSeen = readEvents(hub, (e) => e.t === "state" && e.sid === id && e.s && e.s.model === "late:7b");
    await sleep(80); // ditto: the live state event only reaches open streams
    await request(hub, "POST", `/select${k}`, { sid: id, id: pick2.id, index: 1 });
    assert.ok(
      (await switchedSeen).some((e) => e.s && e.s.model === "late:7b"),
      "the page sees the chosen model"
    );
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "idle after the pick");
  } finally {
    hub.close();
  }
});

// ---- titles ----------------------------------------------------------------------

test("titles: cleanTitle normalizes what a model writes", () => {
  assert.equal(cleanTitle('"Fix login bug".\n'), "Fix login bug");
  assert.equal(cleanTitle("Title: Add dark mode toggle"), "Add dark mode toggle");
  assert.equal(cleanTitle("<think>hmm, what to call it</think>\nRefactor session loop"), "Refactor session loop");
  assert.equal(cleanTitle("  **Snake game in canvas**  "), "Snake game in canvas");
  assert.equal(cleanTitle(""), null);
  assert.equal(cleanTitle("<not a title>"), null);
  const long = cleanTitle("word ".repeat(30));
  assert.ok(long.length <= 60 && !/\s$/.test(long), "long titles are cut at a word boundary");
});

test("titles: suggestTitle asks with thinking off and a small cap, and falls back to null", async () => {
  const calls = [];
  const provider = {
    async chat(messages, _tools, opts) {
      calls.push({ messages, opts });
      return { content: " 'Sidebar Session Titles' ", toolCalls: [] };
    },
  };
  const msgs = [
    { role: "system", content: "s" },
    { role: "user", content: "add titles to the sidebar" },
    { role: "assistant", content: "Done: titles added." },
  ];
  assert.equal(await suggestTitle(msgs, provider), "Sidebar Session Titles");
  assert.equal(calls[0].opts.effortOverride, "off");
  assert.ok(calls[0].opts.maxTokens <= 40);
  assert.match(calls[0].messages[1].content, /add titles to the sidebar/);
  assert.match(calls[0].messages[1].content, /Done: titles added/);
  assert.equal(await suggestTitle([{ role: "system", content: "s" }], provider), null, "no user message, no call");
  assert.equal(calls.length, 1);
  const failing = {
    async chat() {
      throw new Error("backend down");
    },
  };
  assert.equal(await suggestTitle(msgs, failing), null);
});

test("hub: a manual rename is never overwritten by the model-written title", async () => {
  const dataDir = tmpdir("smol-hub4-");
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: fakeFactory([]), quiet: true });
  await hub.start();
  const k = `?k=${hub.authToken}`;
  try {
    const { id } = JSON.parse((await request(hub, "POST", `/sessions/new${k}`, { workspace: dataDir })).body);
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "idle");
    await request(hub, "POST", `/msg${k}`, { sid: id, text: "first message" });
    await until(() => hub.snapshot().workspaces[0].sessions[0].title === "first message", 2000, "verbatim title");
    await request(hub, "POST", `/sessions/rename${k}`, { id, title: "My Name" });
    await sleep(600); // past the fake model's naming delay
    assert.equal(hub.snapshot().workspaces[0].sessions[0].title, "My Name");
  } finally {
    hub.close();
  }
});

test("hub: a session that fails to start shows the error and can be retried", async () => {
  const dataDir = tmpdir("smol-hub3-");
  let attempts = 0;
  const factory = async (ui, workspace, prefs) => {
    attempts++;
    if (attempts === 1) throw new Error("No local model backend found.");
    return fakeFactory([])(ui, workspace, prefs);
  };
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory, quiet: true });
  await hub.start();
  const k = `?k=${hub.authToken}`;
  try {
    const { id } = JSON.parse((await request(hub, "POST", `/sessions/new${k}`, { workspace: dataDir })).body);
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "error", 2000, "error status");
    const events = await readEvents(hub, (e) => e.t === "line" && e.kind === "error");
    assert.ok(events.some((e) => e.t === "line" && e.kind === "error" && /No local model/.test(e.s)));
    await request(hub, "POST", `/sessions/resume${k}`, { id });
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "retried");
    assert.equal(attempts, 2);
  } finally {
    hub.close();
  }
});

test("hub: workspace file explorer lists, reads and safely saves files", async () => {
  const dataDir = tmpdir("smol-hub-files-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "app.js"), "const answer = 42;\n");
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: fakeFactory([]), quiet: true });
  await hub.start();
  const k = `?k=${hub.authToken}`;
  try {
    const { id } = JSON.parse((await request(hub, "POST", `/sessions/new${k}`, { workspace: ws })).body);
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "idle");
    const tree = JSON.parse((await request(hub, "GET", `/workspace/tree${k}&sid=${id}&path=.`)).body);
    assert.equal(tree.entries.find((e) => e.name === "src").dir, true);
    const found = JSON.parse((await request(hub, "GET", `/workspace/search${k}&sid=${id}&q=answer`)).body);
    assert.equal(found.matches[0].path, "src/app.js");
    assert.equal(found.matches[0].line, 1);
    const file = JSON.parse((await request(hub, "GET", `/workspace/file${k}&sid=${id}&path=src%2Fapp.js`)).body);
    assert.match(file.content, /answer = 42/);
    const saved = JSON.parse(
      (
        await request(hub, "POST", `/workspace/file${k}`, {
          sid: id,
          path: "src/app.js",
          content: "const answer = 43;\n",
          expectedMtimeMs: file.mtimeMs,
        })
      ).body
    );
    assert.equal(saved.path, "src/app.js");
    assert.match(fs.readFileSync(path.join(ws, "src", "app.js"), "utf8"), /43/);
    const conflict = await request(hub, "POST", `/workspace/file${k}`, {
      sid: id,
      path: "src/app.js",
      content: "stale",
      expectedMtimeMs: file.mtimeMs,
    });
    assert.match(conflict.body, /changed on disk/);
    const invalidVersion = await request(hub, "POST", `/workspace/file${k}`, {
      sid: id,
      path: "src/app.js",
      content: "must reject",
      expectedMtimeMs: "not-a-version",
    });
    assert.match(invalidVersion.body, /invalid file version/i);
    fs.unlinkSync(path.join(ws, "src", "app.js"));
    const removed = await request(hub, "POST", `/workspace/file${k}`, {
      sid: id,
      path: "src/app.js",
      content: "must not recreate",
      expectedMtimeMs: fs.statSync(path.join(ws, "src")).mtimeMs,
    });
    assert.match(removed.body, /removed from disk/i);
  } finally {
    hub.close();
  }
});

test("hub: a .gz archive opens decompressed, read-only, and binaries say why", async () => {
  const dataDir = tmpdir("smol-hub-gz-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "run.jsonl.gz"), zlib.gzipSync(Buffer.from('{"n":1}\n{"n":2}\n')));
  fs.writeFileSync(path.join(ws, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
  fs.writeFileSync(path.join(ws, "broken.gz"), Buffer.from("not gzip at all"));
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: fakeFactory([]), quiet: true });
  await hub.start();
  const k = `?k=${hub.authToken}`;
  try {
    const { id } = JSON.parse((await request(hub, "POST", `/sessions/new${k}`, { workspace: ws })).body);
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "idle");

    // Le .gz s'ouvre décompressé : le texte du dedans est lisible.
    const gz = JSON.parse((await request(hub, "GET", `/workspace/file${k}&sid=${id}&path=run.jsonl.gz`)).body);
    assert.match(gz.content, /"n":1/);
    assert.match(gz.content, /"n":2/);

    // L'éditeur ne peut jamais écraser une archive avec du texte.
    const overwrite = await request(hub, "POST", `/workspace/file${k}`, {
      sid: id,
      path: "run.jsonl.gz",
      content: "must not replace the archive",
      expectedMtimeMs: gz.mtimeMs,
    });
    assert.match(overwrite.body, /archive \.gz/);

    // Un vrai binaire nomme le fichier et explique pourquoi.
    const bin = await request(hub, "GET", `/workspace/file${k}&sid=${id}&path=blob.bin`);
    assert.match(bin.body, /« blob\.bin » est un fichier binaire/);

    // Une archive cassée donne une erreur .gz dédiée, pas une erreur binaire.
    const broken = await request(hub, "GET", `/workspace/file${k}&sid=${id}&path=broken.gz`);
    assert.match(broken.body, /\.gz illisible/);
  } finally {
    hub.close();
  }
});

test("hub: /status is the control centre report and /agents/draft writes a bounded delegation", async () => {
  const dataDir = tmpdir("smol-status-");
  const ws = tmpdir("smol-status-ws-");
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: fakeFactory([]), quiet: true });
  await hub.start();
  const k = `?k=${hub.authToken}`;
  try {
    const opened = JSON.parse((await request(hub, "POST", `/sessions/new${k}`, { workspace: ws })).body);
    const status = JSON.parse((await request(hub, "GET", `/status${k}&sid=${opened.id}`)).body);
    const overview = JSON.parse((await request(hub, "GET", `/session/overview${k}&sid=${opened.id}`)).body);
    assert.equal(overview.backgroundTasks, 0);
    assert.equal(overview.artifacts, 0);
    assert.equal(overview.changes, null, "Git counters are explicitly unavailable outside a repository");
    assert.ok(overview.system.memory.totalBytes > 0);
    assert.ok(overview.system.memory.percent >= 0 && overview.system.memory.percent <= 100);
    assert.ok(overview.system.gpu === null || overview.system.gpu.memoryTotalBytes > 0);
    assert.equal(status.sid, opened.id);
    assert.ok(Array.isArray(status.tools), "tools list is always present");
    assert.ok(
      status.skills.some((s) => s.builtin && s.name === "impeccable-design"),
      `built-in skills show up: ${JSON.stringify(status.skills)}`
    );
    const roles = status.subagents.roles.map((r) => r.name);
    assert.ok(roles.includes("architect") && roles.includes("quality_reviewer") && roles.includes("office_assistant"), roles.join(","));
    assert.equal(status.subagents.running, null);
    assert.deepEqual(status.skillsActive, []);
    assert.match(status.runtime.node, /^v\d+/);
    assert.equal(status.version, "9.9.9");
    assert.match((await request(hub, "GET", `/status${k}&sid=nope`)).body, /no such session/);

    const draft = JSON.parse(
      (await request(hub, "POST", `/agents/draft${k}`, { sid: opened.id, role: "architect", task: "map the login flow" })).body
    );
    assert.equal(draft.role, "architect");
    assert.match(draft.text, /map the login flow/);
    assert.match(draft.text, /delegate/);
    assert.match(draft.text, /role="architect"/);
    assert.match((await request(hub, "POST", `/agents/draft${k}`, { sid: opened.id, role: "nobody", task: "x" })).body, /inconnu/);
    assert.match((await request(hub, "POST", `/agents/draft${k}`, { sid: opened.id, role: "architect", task: "   " })).body, /tâche/);
  } finally {
    hub.close();
  }
});

/** Construit un .zip valide à la main (deflate + stocké), sans dépendance. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, store } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const comp = store ? raw : zlib.deflateRawSync(raw);
    const method = store ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

test("hub: a .zip shows a listing and opens members read-only", async () => {
  const dataDir = tmpdir("smol-hub-zip-");
  const ws = path.join(dataDir, "proj");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(
    path.join(ws, "evidence.zip"),
    makeZip([
      { name: "README.md", data: "# preuve\ndedans le zip\n" },
      { name: "nested/data.json", data: '{"ok":true}', store: true },
      { name: "logo.bin", data: Buffer.from([0x00, 0x01, 0x02]) },
    ])
  );
  const hub = new WebHub({ port: 0, prefs: {}, help: "help", version: "9.9.9", dataDir, factory: fakeFactory([]), quiet: true });
  await hub.start();
  const k = `?k=${hub.authToken}`;
  try {
    const { id } = JSON.parse((await request(hub, "POST", `/sessions/new${k}`, { workspace: ws })).body);
    await until(() => hub.snapshot().workspaces[0].sessions[0].status === "idle", 2000, "idle");

    // Le .zip affiche un listing lisible (noms + tailles), pas des octets bruts.
    const list = JSON.parse((await request(hub, "GET", `/workspace/file${k}&sid=${id}&path=evidence.zip`)).body);
    assert.match(list.content, /Archive \.zip « evidence\.zip » — 3 fichiers/);
    assert.match(list.content, /Double-cliquez sur un nom de fichier/);
    assert.match(list.content, /README\.md\s+23 o/);
    assert.match(list.content, /nested\/data\.json\s+11 o/);
    assert.doesNotMatch(list.content, /\0/);

    // Membre deflate : le texte du dedans est lisible.
    const member = JSON.parse(
      (await request(hub, "GET", `/workspace/file${k}&sid=${id}&path=${encodeURIComponent("evidence.zip › README.md")}`)).body
    );
    assert.equal(member.path, "evidence.zip › README.md");
    assert.match(member.content, /# preuve/);
    assert.match(member.content, /dedans le zip/);
    assert.equal(member.mtimeMs, list.mtimeMs, "un membre partage le mtime du .zip");

    // Membre stocké (méthode 0, non compressé).
    const stored = JSON.parse(
      (await request(hub, "GET", `/workspace/file${k}&sid=${id}&path=${encodeURIComponent("evidence.zip › nested/data.json")}`)).body
    );
    assert.match(stored.content, /"ok":true/);

    // Un membre binaire est nommé et expliqué, pas ouvert en texte corrompu.
    const bin = await request(hub, "GET", `/workspace/file${k}&sid=${id}&path=${encodeURIComponent("evidence.zip › logo.bin")}`);
    assert.match(bin.body, /« logo\.bin » est un fichier binaire/);
    assert.match(bin.body, /à l'intérieur de « evidence\.zip »/);

    // Un membre absent donne une erreur claire.
    const missing = await request(hub, "GET", `/workspace/file${k}&sid=${id}&path=${encodeURIComponent("evidence.zip › nope.txt")}`);
    assert.match(missing.body, /introuvable dans l'archive/);

    // L'éditeur ne peut jamais écraser une archive .zip (ni un de ses membres).
    const overZip = await request(hub, "POST", `/workspace/file${k}`, {
      sid: id,
      path: "evidence.zip",
      content: "must not replace the zip",
      expectedMtimeMs: list.mtimeMs,
    });
    assert.match(overZip.body, /archive \.zip/);
    const overMember = await request(hub, "POST", `/workspace/file${k}`, {
      sid: id,
      path: "evidence.zip › README.md",
      content: "must not write into the zip",
    });
    assert.match(overMember.body, /lecture seule/);
  } finally {
    hub.close();
  }
});

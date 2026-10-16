// Background routines service (src/service.ts): honest status, the REAL
// start/stop lifecycle (it spawns the actual detached service with a fast
// tick and an isolated data dir where no routine is ever due, so no agent
// turn can run), the tick claim + result recording with an injected
// executor, and the honest message paths.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BASE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "smol-service-data-"));
process.env.SMOLCODER_DATA_DIR = BASE_DATA;
// Inherited by the spawned service: a fast tick keeps start/stop snappy.
process.env.SMOLCODER_SERVICE_TICK_MS = "250";

const {
  formatServiceReport,
  isProcessAlive,
  readServiceRecord,
  serviceFilePath,
  serviceStatus,
  serviceTargets,
  startServiceDetached,
  stopService,
  tickOnce,
  uninstallServiceAtLogon,
} = require("../dist/service");
const { RoutineBook } = require("../dist/routines");
const { WorkspaceStore } = require("../dist/web/store");

function scratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Each test gets its own data dir so records and workspaces never leak. */
function isolatedData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-svc-"));
  process.env.SMOLCODER_DATA_DIR = dir;
  t.after(() => {
    process.env.SMOLCODER_DATA_DIR = BASE_DATA;
  });
  return dir;
}

function registerWorkspace(dataDir, ws) {
  new WorkspaceStore(dataDir).add(ws);
}

/** Rewrites the stored routine so its next run is in the past (it is due). */
function forceDue(ws, index = 0) {
  const file = path.join(ws, ".smol", "routines.json");
  const items = JSON.parse(fs.readFileSync(file, "utf8"));
  items[index].next = Date.now() - 1000;
  fs.writeFileSync(file, JSON.stringify(items, null, 2));
}

async function addRoutine(ws, prompt) {
  const added = await new RoutineBook(ws).add("hourly", prompt);
  assert.equal(added.ok, true, added.error);
  return added.routine;
}

test("status is an honest stopped state when nothing ever started", (t) => {
  isolatedData(t);
  assert.deepEqual(serviceStatus(), { running: false, stale: false });
  assert.equal(readServiceRecord(), null);
  assert.match(formatServiceReport(), /arrêté/);
});

test("real lifecycle: start sees the detached service, a second start is refused, stop kills it", (t) => {
  isolatedData(t);
  const first = startServiceDetached();
  assert.equal(first.ok, true, first.message);
  const st = serviceStatus();
  assert.equal(st.running, true);
  assert.ok(isProcessAlive(st.pid));
  assert.equal(readServiceRecord().pid, st.pid);
  const second = startServiceDetached();
  assert.match(second.message, /déjà actif/);
  const stopped = stopService();
  assert.equal(stopped.ok, true, stopped.message);
  assert.equal(isProcessAlive(st.pid), false);
  assert.equal(serviceStatus().running, false);
  assert.equal(fs.existsSync(serviceFilePath()), false);
});

test("tickOnce claims a due routine, runs the injected executor and records the result", async (t) => {
  const data = isolatedData(t);
  const ws = scratch("smol-ws-");
  registerWorkspace(data, ws);
  await addRoutine(ws, "relis le dernier commit");
  forceDue(ws);
  const calls = [];
  const ran = await tickOnce({
    exec: async (workspace, prompt) => {
      calls.push({ workspace, prompt });
      return { code: 0, output: "rapport final : tout est vert" };
    },
    log: () => {},
  });
  assert.equal(ran, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workspace, ws);
  assert.equal(calls[0].prompt, "relis le dernier commit");
  const after = new RoutineBook(ws).listSorted()[0];
  assert.equal(after.lastStatus, "ok");
  assert.ok(after.next > Date.now(), "next run was moved forward");
  // A failing run is recorded with its exit code.
  forceDue(ws);
  const ran2 = await tickOnce({ exec: async () => ({ code: 7, output: "" }), log: () => {} });
  assert.equal(ran2, 1);
  assert.equal(new RoutineBook(ws).listSorted()[0].lastStatus, "erreur (code 7)");
});

test("serviceTargets lists only existing workspaces that have routines", async (t) => {
  const data = isolatedData(t);
  const withRoutines = scratch("smol-ws-r-");
  const empty = scratch("smol-ws-e-");
  registerWorkspace(data, withRoutines);
  registerWorkspace(data, empty);
  registerWorkspace(data, path.join(data, "gone-forever"));
  await addRoutine(withRoutines, "vérifie la doc");
  const targets = serviceTargets();
  assert.equal(targets.length, 1);
  assert.equal(targets[0].workspace, withRoutines);
  assert.equal(targets[0].routines.length, 1);
});

test("a record owned by a live process reads as running; a dead pid reads stale", (t) => {
  isolatedData(t);
  fs.writeFileSync(serviceFilePath(), JSON.stringify({ pid: process.pid, startedAt: Date.now(), version: "test" }));
  const st = serviceStatus();
  assert.equal(st.running, true);
  assert.equal(st.pid, process.pid);
  assert.equal(st.stale, false);
  let deadPid = 999999;
  while (isProcessAlive(deadPid)) deadPid -= 1;
  fs.writeFileSync(serviceFilePath(), JSON.stringify({ pid: deadPid, startedAt: Date.now(), version: "test" }));
  const stale = serviceStatus();
  assert.equal(stale.running, false);
  assert.equal(stale.stale, true);
});

test("uninstall is honest when the scheduled task does not exist", (t) => {
  isolatedData(t);
  const prev = process.env.SMOLCODER_SERVICE_TASK;
  process.env.SMOLCODER_SERVICE_TASK = `Smolcoder Test ${process.pid} ${Date.now()}`;
  t.after(() => {
    if (prev === undefined) delete process.env.SMOLCODER_SERVICE_TASK;
    else process.env.SMOLCODER_SERVICE_TASK = prev;
  });
  const res = uninstallServiceAtLogon();
  if (process.platform === "win32") {
    assert.equal(res.ok, true, res.message);
    assert.match(res.message, /absente|supprimée/);
  } else {
    assert.equal(res.ok, false);
    assert.match(res.message, /Windows/);
  }
});

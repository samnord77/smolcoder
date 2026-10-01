// The offload path, end to end on the process side: a shell run whose
// deadline can be pushed out, handed to the background task runner (the
// process really keeps running), or cancelled — plus the registry the UI
// countdown reads.
const test = require("node:test");
const assert = require("node:assert/strict");
const { runCommand, liveShellList, findLiveShell } = require("../dist/tools/shell");
const { TaskManager } = require("../dist/tools/tasks");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a live run exposes a deadline that extend pushes out", async () => {
  let ctl;
  const cmd = 'node -e "setTimeout(()=>{},4000)"';
  const p = runCommand(cmd, process.cwd(), undefined, (c) => {
    ctl = c;
  });
  assert.ok(ctl, "the caller gets a handle while the command runs");
  assert.ok(ctl.deadline > Date.now(), "the deadline sits in the future");
  const before = ctl.deadline;
  assert.equal(ctl.extend(5000), true, "extend is accepted");
  assert.ok(ctl.deadline >= before + 4000, "the kill moved out by roughly the requested time");
  assert.ok(
    liveShellList().some((i) => i.command === cmd),
    "the run is listed for the UI countdown"
  );
  assert.equal(findLiveShell(cmd)?.command, cmd, "lookup by command finds it");
  ctl.cancel();
  const out = await p;
  assert.match(out, /cancelled/, "cancel stops waiting immediately");
  assert.ok(!liveShellList().some((i) => i.command === cmd), "a finished run drops off the list");
  assert.equal(ctl.extend(1000), false, "no extension after the run is over");
});

test("detach keeps the process alive as a real background task", async () => {
  const exits = [];
  const tm = new TaskManager(process.cwd(), (t) => exits.push(`${t.id}:${t.exitCode}`));
  let ctl;
  const cmd = "node -e \"console.log('debut'); setTimeout(()=>{console.log('fini')},4500)\"";
  const p = runCommand(cmd, process.cwd(), undefined, (c) => {
    c.adopt = (proc, cm, seed) => tm.adopt(proc, cm, seed);
    ctl = c;
  });
  // On Windows the PowerShell startup can take longer than 500 ms; detach
  // only after the child has had time to produce its first output.
  await sleep(2000);
  const id = ctl.detach();
  assert.match(String(id), /^t\d+$/, "detach returns the background task id");
  const out = await p;
  assert.match(out, /moved to background as task t\d+/, "the agent is told where to follow it");
  assert.match(out, /Output so far/, "the output already printed travels with the result");
  assert.match(out, /debut/, "and it is the real output");
  assert.ok(!liveShellList().some((i) => i.command === cmd), "a detached run stops counting down");
  assert.match(tm.list(), new RegExp(`\\b${id}\\s+running`), "the manager now owns a running task");
  const finishDeadline = Date.now() + 10_000;
  while (exits.length === 0 && Date.now() < finishDeadline) await sleep(100);
  assert.deepEqual(exits, [`${id}:0`], "the adopted process exits successfully within the bounded wait");
  const log = tm.logs(id);
  assert.match(log, /fini/, "the command ran to completion AFTER the tool call returned");
  assert.match(log, /exited/, "the task reports its final state");
  assert.equal(ctl.detach(), null, "detaching twice is refused");
});

test("SMOL_SHELL_TIMEOUT_MS shortens the auto-kill (last: module reload)", async () => {
  process.env.SMOL_SHELL_TIMEOUT_MS = "1000";
  delete require.cache[require.resolve("../dist/tools/shell")];
  const fresh = require("../dist/tools/shell");
  const out = await fresh.runCommand('node -e "setTimeout(()=>{},8000)"', process.cwd());
  assert.match(out, /timed out after 1s/, "the configurable deadline is the real one");
  delete process.env.SMOL_SHELL_TIMEOUT_MS;
  delete require.cache[require.resolve("../dist/tools/shell")];
});

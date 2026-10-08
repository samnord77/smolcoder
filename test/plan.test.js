const test = require("node:test");
const assert = require("node:assert/strict");
const { Plan } = require("../dist/plan");
const { executeTool } = require("../dist/tools");

test("a local-model semicolon plan remains a checklist after the first done call", async () => {
  const plan = new Plan();
  const result = await executeTool("plan", { steps: "scaffold vite; implement world; add movement; verify gameplay" }, { plan });
  assert.match(result, /Plan set \(4 steps\)/);
  assert.match(plan.markDone(), /Next: 2. implement world/);
  assert.equal(plan.doneCount, 1);
  plan.checkpoint("World.getBlock(x,y,z); next: collision");
  assert.match(plan.compactLine(), /World.getBlock/);
  const before = JSON.stringify(plan.steps);
  assert.match(await executeTool("plan", { action: "set", steps: ["a", "b"] }, { plan }), /^Error:/);
  assert.equal(JSON.stringify(plan.steps), before);
  plan.set("Inspect foo(); preserve API\nRun tests");
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].text, "Inspect foo(); preserve API");
});

test("working checkpoints survive a JSON session round trip and do not complete a step", () => {
  const p = new Plan();
  assert.match(p.checkpoint("x"), /^Error/);
  p.set("wire entry point\nverify build");
  p.checkpoint("save.js: makeSaver(storage, size); next: replace missing imports");
  const restored = new Plan();
  restored.steps = JSON.parse(JSON.stringify(p.steps));
  assert.equal(restored.doneCount, 0);
  assert.match(restored.compactLine(), /makeSaver\(storage, size\)/);
  assert.match(restored.checkpoint("x".repeat(1001)), /^Error/);
  assert.match(restored.modelView(), /makeSaver/);
  restored.checkpoint("replacement checkpoint");
  assert.doesNotMatch(restored.modelView(), /makeSaver/);
  restored.markDone();
  assert.doesNotMatch(restored.modelView(), /replacement checkpoint/);
  assert.equal(restored.steps[0].note, "replacement checkpoint");
});

test("a workspace plan and its checkpoint survive a fresh CLI session without mixing session plans", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "smol-plan-"));
  const cli = new Plan(workspace, "cli");
  cli.set("Inspect the project\nImplement the fix\nVerify everything");
  cli.markDone();
  cli.checkpoint("src/app.ts: update handler; next: run build");

  const resumedCli = new Plan(workspace, "cli");
  assert.equal(resumedCli.doneCount, 1);
  assert.match(resumedCli.modelView(), /update handler/);
  assert.equal(new Plan(workspace, "web-session-2").exists, false);
});

test("invalid plan updates do not corrupt the last persisted plan", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "smol-plan-"));
  const plan = new Plan(workspace, "cli");
  plan.set("Keep this plan");
  const before = fs.readFileSync(path.join(workspace, ".smol", "plans", "cli.json"), "utf8");
  assert.match(plan.set("   "), /^Error:/);
  assert.equal(fs.readFileSync(path.join(workspace, ".smol", "plans", "cli.json"), "utf8"), before);
});

test("clearing a workspace plan survives another CLI launch", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "smol-plan-"));
  const plan = new Plan(workspace, "cli");
  plan.set("A task");
  assert.equal(plan.reset(), null);
  assert.equal(new Plan(workspace, "cli").exists, false);
});

test("renderPlan prints the checkbox checklist for terminals", () => {
  const { renderPlan } = require("../dist/ui");
  const plan = new Plan();
  plan.set("alpha\nbeta");
  plan.markDone(1);
  const text = renderPlan(plan);
  assert.match(text, /1 tâches sur 2 terminées/);
  assert.match(text, /☑ alpha/);
  assert.match(text, /◉ beta/);
});

test("setDone toggles a step both ways so the task rail can uncheck", () => {
  const plan = new Plan();
  plan.set("first step\nsecond step");
  assert.match(plan.setDone(1, true), /Step 1 done/);
  assert.equal(plan.steps[0].done, true);
  assert.equal(plan.doneCount, 1);
  assert.match(plan.setDone(1, false), /Step 1 reopened/);
  assert.equal(plan.steps[0].done, false);
  assert.equal(plan.doneCount, 0);
  assert.match(plan.setDone(1, false), /already open/);
  assert.match(plan.setDone(9, true), /^Error/);
  assert.match(plan.setDone("x", true), /^Error/);
  assert.match(new Plan().setDone(1, true), /^Error/);
});

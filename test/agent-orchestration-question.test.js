const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Agent } = require("../dist/agent");
const { ContextManager } = require("../dist/context");
const { EventBus } = require("../dist/events");
const { Plan } = require("../dist/plan");
const { TaskManager } = require("../dist/tools/tasks");

test("broad explanatory questions do not launch unsolicited planning or sub-agents", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "smol-agent-question-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const seen = [];
  const subagentEvents = [];
  const provider = {
    label: "fake",
    modelId: "fake",
    contextWindow: 8000,
    maxOutputTokens: 2000,
    setEffort() {},
    effortLabel() { return null; },
    async chat(messages) {
      seen.push(messages);
      return { content: "Here is how the IDE workflows fit together.", toolCalls: [] };
    },
  };
  const ui = {
    token() {},
    thinking() {},
    toolCall() {},
    toolResult() {},
    println() {},
    status() {},
    warn() {},
    error() {},
    startSpinner() {},
    stopSpinner() {},
    async confirmCommand() { return "yes"; },
    turnEnd() {},
    planUpdated() {},
    subagent(...event) { subagentEvents.push(event); },
  };
  const plan = new Plan(workspace);
  const agent = new Agent(
    provider,
    "edit",
    "system",
    { workspace, taskManager: new TaskManager(workspace), plan, filesTouched: new Set(), commandsRun: [] },
    new ContextManager(8000, 2000),
    new EventBus(),
    ui,
    false,
    20
  );
  await agent.runTurn(
    "Explain how I could improve all of the IDE, Cowork, file navigation, live editing, task tracking, command transcript, Git status badges, and model interaction workflows across this project."
  );
  assert.equal(agent.outcome, "completed");
  assert.deepEqual(subagentEvents, []);
  assert.equal(plan.exists, false);
  assert.equal(seen.length, 1);
});

test("requests for advice about broad improvements stay informational", async (t) => {
  for (const request of [
    "What are the best ways to improve all of the IDE, Cowork, file navigation, task tracking, and model workflows across this project?",
    "Tell me how to improve the full IDE experience, including live file editing, the task board, command output, Git indicators, Electron startup, and local-model support.",
    "Should I improve all of the IDE, Cowork, project navigation, task tracking, command output, and local-model workflows, and what should I prioritize?",
    "Can you recommend improvements for the entire IDE, Cowork workspace, live editing, task board, Git review, Electron startup, and model integration?",
  ]) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "smol-agent-advice-"));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const subagentEvents = [];
    const provider = {
      label: "fake",
      modelId: "fake",
      contextWindow: 8000,
      maxOutputTokens: 2000,
      setEffort() {},
      effortLabel() { return null; },
      async chat() { return { content: "Here is some advice.", toolCalls: [] }; },
    };
    const ui = {
      token() {},
      thinking() {},
      toolCall() {},
      toolResult() {},
      println() {},
      status() {},
      warn() {},
      error() {},
      startSpinner() {},
      stopSpinner() {},
      async confirmCommand() { return "yes"; },
      turnEnd() {},
      planUpdated() {},
      subagent(...event) { subagentEvents.push(event); },
    };
    const plan = new Plan(workspace);
    const agent = new Agent(
      provider,
      "edit",
      "system",
      { workspace, taskManager: new TaskManager(workspace), plan, filesTouched: new Set(), commandsRun: [] },
      new ContextManager(8000, 2000),
      new EventBus(),
      ui,
      false,
      20
    );
    await agent.runTurn(request);
    assert.equal(agent.outcome, "completed");
    assert.deepEqual(subagentEvents, [], request);
    assert.equal(plan.exists, false, request);
  }
});

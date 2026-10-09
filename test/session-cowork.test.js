const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Session } = require("../dist/session");
const { CoworkBoard } = require("../dist/tools/cowork");

function createSessionHarness(workspace, agent) {
  const session = Object.create(Session.prototype);
  session.workspace = workspace;
  session.agent = agent;
  session.toolCtx = { filesTouched: new Set() };
  session.ui = {
    error(message) {
      throw new Error(message);
    },
    warn(message) {
      throw new Error(message);
    },
  };
  return session;
}

async function addWorkItem(board) {
  const created = await board.run({ action: "create", title: "Execute Cowork task" });
  const id = created.match(/(w_[a-f0-9-]{36})/)?.[1];
  assert.ok(id, created);
  return id;
}

test("session lifecycle completes Cowork work only when the agent reports real passing checks", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "smol-session-cowork-"));
  const board = new CoworkBoard(workspace);
  const id = await addWorkItem(board);
  const agent = {
    outcome: "idle",
    lastError: null,
    verificationResult: null,
    async runTurn() {
      this.outcome = "completed";
      this.verificationResult = { passed: true };
    },
  };
  const session = createSessionHarness(workspace, agent);

  await session.handleUserMessage("execute this task", [], id);

  const item = board.items().find((row) => row.id === id);
  assert.equal(item.executionStatus, "verified");
  assert.equal(item.status, "completed");
  assert.match(item.lastReport, /automated acceptance checks passed/);
});

test("session lifecycle leaves completed Cowork work open when no checks passed", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "smol-session-cowork-"));
  const board = new CoworkBoard(workspace);
  const id = await addWorkItem(board);
  const agent = {
    outcome: "idle",
    lastError: null,
    verificationResult: null,
    async runTurn() {
      this.outcome = "completed";
      this.verificationResult = null;
    },
  };
  const session = createSessionHarness(workspace, agent);

  await session.handleUserMessage("execute this task", [], id);

  const item = board.items().find((row) => row.id === id);
  assert.equal(item.executionStatus, "unverified");
  assert.equal(item.status, "open");
  assert.match(item.lastReport, /no successful automated acceptance check/);
});

test("session state exposes recoverable Auto Copilot phases but clears terminal phases", async () => {
  const session = Object.create(Session.prototype);
  session.workspace = fs.mkdtempSync(path.join(os.tmpdir(), "smol-session-phase-"));
  session.chosen = { id: "fake", backend: "ollama", contextWindow: 8000 };
  session.effort = null;
  session.agent = {
    mode: "edit",
    outcome: "running",
    lastError: null,
    autopilotPhase: "starting",
    autopilotLabel: "",
    autopilotDetails: null,
    contextTokens: () => 10,
    contextPercent: () => 1,
    contextBudget: () => ({ window: 8000 }),
    provider: { effortLabel: () => null },
    tools: [],
  };
  session.toolCtx = {
    plan: { exists: false },
    filesTouched: new Set(),
    commandsRun: [],
  };
  session.taskManager = { runningSummary: () => [], recentUrls: () => [] };
  session.allSlash = [];
  session.agent.autopilotPhase = "paused";
  session.agent.autopilotLabel = "limite d'étapes atteinte";
  session.agent.autopilotDetails = { step: 30, maxSteps: 30 };
  assert.equal(session.state().autopilot.phase, "paused");
  session.agent.autopilotPhase = "error";
  session.agent.autopilotLabel = "backend indisponible";
  assert.equal(session.state().autopilot.phase, "error");
  session.agent.autopilotPhase = "completed";
  assert.equal(session.state().autopilot, null);
  session.agent.autopilotPhase = "cancelled";
  assert.equal(session.state().autopilot, null);
  fs.rmSync(session.workspace, { recursive: true, force: true });
});

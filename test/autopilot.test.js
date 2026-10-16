const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Session } = require("../dist/session");
const { Plan } = require("../dist/plan");

function harness() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "smol-autopilot-"));
  const lines = [];
  const plan = new Plan(workspace, "cli");
  const session = Object.create(Session.prototype);
  session.workspace = workspace;
  session.sid = "auto-1";
  session.autoMission = null;
  session.ui = {
    lines,
    println: (t) => lines.push(String(t)),
    status: (t) => lines.push(String(t)),
    warn: (t) => lines.push("WARN " + String(t)),
    error: (t) => lines.push("ERR " + String(t)),
  };
  session.toolCtx = { plan, canWrite: true };
  session.agent = { outcome: "completed" };
  return { session, plan, lines };
}

test("autopilot runs turn after turn until the plan is complete", async () => {
  const { session, plan, lines } = harness();
  const messages = [];
  let turn = 0;
  session.handleUserMessage = async (msg) => {
    turn += 1;
    messages.push(msg);
    if (turn === 1) plan.set("creer index.html\ncreer style.css\nverifier la page");
    if (turn === 2) {
      plan.markDone(1);
      plan.markDone(2);
    }
    if (turn === 3) plan.markDone(3);
  };
  await session.autopilotCommand(["creer", "un", "site", "vitrine"]);
  assert.equal(turn, 3);
  assert.match(messages[0], /Pilote automatique — objectif/);
  assert.match(messages[1], /Étapes restantes :\n1\. creer index\.html/);
  assert.ok(lines.some((l) => /objectif atteint en 3 tour/.test(l)));
  assert.ok(lines.some((l) => l.includes("☑ 3. verifier la page")));
  assert.equal(session.autoMission, null);
});

test("autopilot stops at the turn limit when the plan never advances", async () => {
  const { session, plan, lines } = harness();
  let turn = 0;
  session.handleUserMessage = async () => {
    turn += 1;
    if (turn === 1) plan.set("un\nb\nc");
  };
  await session.autopilotCommand(["mega", "tache"]);
  assert.equal(turn, 6);
  assert.ok(lines.some((l) => /limite atteinte \(6 tour/.test(l)));
});

test("two error turns stop the mission", async () => {
  const { session, plan, lines } = harness();
  let turn = 0;
  session.handleUserMessage = async () => {
    turn += 1;
    if (turn === 1) plan.set("a\nb");
    session.agent.outcome = "error";
  };
  await session.autopilotCommand(["tache"]);
  assert.equal(turn, 2);
  assert.ok(lines.some((l) => /arrêt après 2 tours en erreur/.test(l)));
});

test("a cancelled turn stops the mission", async () => {
  const { session, plan, lines } = harness();
  let turn = 0;
  session.handleUserMessage = async () => {
    turn += 1;
    if (turn === 1) plan.set("a\nb");
    session.agent.outcome = "cancelled";
  };
  await session.autopilotCommand(["tache"]);
  assert.equal(turn, 1);
  assert.ok(lines.some((l) => /pilote automatique : annulé/.test(l)));
});

test("no plan after the first turn stops the loop honestly", async () => {
  const { session, lines } = harness();
  let turn = 0;
  session.handleUserMessage = async () => {
    turn += 1;
  };
  await session.autopilotCommand(["dis", "bonjour"]);
  assert.equal(turn, 1);
  assert.ok(lines.some((l) => /n'a pas créé de plan/.test(l)));
});

test("stop without a mission and the help text stay honest", async () => {
  const { session, lines } = harness();
  await session.autopilotCommand(["stop"]);
  assert.ok(lines.some((l) => /aucune mission autonome en cours/.test(l)));
  await session.autopilotCommand([]);
  assert.ok(lines.some((l) => /\/autopilot <objectif>/.test(l)));
});

test("read-only mode refuses to start a mission", async () => {
  const { session, lines } = harness();
  session.toolCtx.canWrite = false;
  await session.autopilotCommand(["creer", "un", "site"]);
  assert.ok(lines.some((l) => /impossible en mode lecture seule/.test(l)));
  assert.equal(session.autoMission, null);
});

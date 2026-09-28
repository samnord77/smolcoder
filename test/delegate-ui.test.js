// ChildUI (dist/agent.js) : le sous-agent ruisselle dans l'UI parent,
// chaque ligne signee ⇄, spinner "sous-agent · …", fin de tour sans clochette.
const test = require("node:test");
const assert = require("node:assert/strict");
const { ChildUI } = require("../dist/agent");

// 1) Faux UI parent qui enregistre les appels.
//    Le compteur turnEnd = la clochette : le parent ne doit jamais sonner
//    pour un tour sous-agent.
function makeParent() {
  const calls = {
    status: [],
    println: [],
    startSpinner: [],
    turnEnd: [],
    thinking: [],
    toolCall: [],
    toolResult: [],
    confirmCommand: [],
  };
  const ui = {
    calls,
    token() {},
    thinking(text) {
      calls.thinking.push(text);
    },
    toolCall(name, args) {
      calls.toolCall.push([name, args]);
    },
    toolResult(result) {
      calls.toolResult.push(result);
    },
    println(s) {
      calls.println.push(s);
    },
    status(s) {
      calls.status.push(s);
    },
    warn() {},
    error() {},
    startSpinner(label) {
      calls.startSpinner.push(label);
    },
    stopSpinner() {},
    async confirmCommand(command, reason) {
      calls.confirmCommand.push([command, reason]);
      return "always";
    },
    turnEnd(label) {
      calls.turnEnd.push(label);
    },
    planUpdated() {},
  };
  return ui;
}

test('status("x") => parent reçoit "⇄ x"', () => {
  const parent = makeParent();
  const child = new ChildUI(parent);
  child.status("x");
  assert.deepEqual(parent.calls.status, ["⇄ x"]);
});

test('startSpinner("t") => parent reçoit "sous-agent · t"', () => {
  const parent = makeParent();
  const child = new ChildUI(parent);
  child.startSpinner("t");
  assert.deepEqual(parent.calls.startSpinner, ["sous-agent · t"]);
});

test('turnEnd("fini") => status "✓ sous-agent" et AUCUN turnEnd parent (pas de clochette)', () => {
  const parent = makeParent();
  const child = new ChildUI(parent);
  child.turnEnd("fini");
  assert.equal(parent.calls.turnEnd.length, 0);
  assert.equal(parent.calls.status.length, 1);
  assert.match(parent.calls.status[0], /✓ sous-agent/);
  assert.match(parent.calls.status[0], /fini/);
});

test("thinking/toolCall/toolResult/println traversent inchangés", () => {
  const parent = makeParent();
  const child = new ChildUI(parent);
  child.thinking("ref...");
  child.toolCall("read_file", { path: "a.txt" });
  child.toolResult("contenu");
  child.println("ligne");
  assert.deepEqual(parent.calls.thinking, ["ref..."]);
  assert.deepEqual(parent.calls.toolCall, [["read_file", { path: "a.txt" }]]);
  assert.deepEqual(parent.calls.toolResult, ["contenu"]);
  assert.deepEqual(parent.calls.println, ["ligne"]);
});

test("confirmCommand est délégué au parent (retourne sa valeur)", async () => {
  const parent = makeParent();
  const child = new ChildUI(parent);
  const res = await child.confirmCommand("npm test", "verif");
  assert.equal(res, "always");
  assert.deepEqual(parent.calls.confirmCommand, [["npm test", "verif"]]);
});

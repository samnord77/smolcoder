const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeArgs } = require("../dist/ui");

test("long shell commands are compact in the transcript summary", () => {
  const command = `node -e print(${"a".repeat(120)})`;
  const summary = summarizeArgs("run_command", { command });
  assert.ok(summary.length <= 73);
  assert.ok(summary.endsWith("…"));
});

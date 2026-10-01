const test = require("node:test");
const assert = require("node:assert/strict");
const { stripControl, toOsPath } = require("../dist/web/terminal");

test("terminal pro: stripControl drops screen clears and cursor moves but preserves SGR colors", () => {
  const input = "\x1b[32mPASS\x1b[0m \x1b[2K\x1b[1Goutput text";
  const cleaned = stripControl(input);
  assert.ok(cleaned.includes("PASS"));
  assert.ok(cleaned.includes("output text"));
  assert.ok(!cleaned.includes("\x1b[2K"));
});

test("terminal pro: toOsPath normalizes git-bash unix style paths on windows", () => {
  if (process.platform === "win32") {
    assert.equal(toOsPath("/c/Users/DELL/project"), "C:\\Users\\DELL\\project");
    assert.equal(toOsPath("/d/repo"), "D:\\repo");
  } else {
    assert.equal(toOsPath("/var/log"), "/var/log");
  }
});

test("terminal pro: regex extracts exit code and elapsed duration correctly", () => {
  const line = "[exit code 0 in 1.4s]";
  const m = line.match(/\[exit code (-?\d+) in ([^\]]+)\]/i);
  assert.ok(m);
  assert.equal(m[1], "0");
  assert.equal(m[2], "1.4s");

  const failLine = "[exit code 1 in 0.8s]";
  const mFail = failLine.match(/\[exit code (-?\d+) in ([^\]]+)\]/i);
  assert.ok(mFail);
  assert.equal(mFail[1], "1");
  assert.equal(mFail[2], "0.8s");
});

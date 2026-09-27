// Terminal result coloring: fences, errors and exit-code trailers.
const test = require("node:test");
const assert = require("node:assert/strict");
const { colorizeResultBlock, stripAnsiDisplay } = require("../dist/highlight");

test("stripAnsiDisplay removes escapes without touching text", () => {
  assert.equal(stripAnsiDisplay("\x1b[32mgreen\x1b[0m and plain"), "green and plain");
  assert.equal(stripAnsiDisplay("no escapes"), "no escapes");
});

test("colorizeResultBlock colors fences, errors and exit codes", () => {
  const src = '```js\nconst x = 1;\n```\n[exit code 0 in 0.2s]';
  const colored = colorizeResultBlock(src, true);
  assert.match(colored, /\x1b\[35mconst/);
  assert.match(colored, /\x1b\[32m\[exit code 0/);
  assert.match(colorizeResultBlock("[exit code 2 in 0.1s]", true), /\x1b\[31m/);
  assert.match(colorizeResultBlock("Error: boom", true), /\x1b\[31mError/);
  assert.equal(colorizeResultBlock(src, false), src);
  assert.equal(colorizeResultBlock("plain output\nsecond line", true), "plain output\nsecond line");
  assert.match(colorizeResultBlock("\x1b[32m```js\nconst x = 1;\n```", true), /\x1b\[35mconst/);
});

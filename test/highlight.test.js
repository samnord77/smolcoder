const test = require("node:test");
const assert = require("node:assert/strict");
const { highlightHtml, highlightAnsi } = require("../dist/highlight.js");

test("syntax highlighting separates keywords, strings, numbers and comments", () => {
  const html = highlightHtml('const answer = "yes"; const count = 42; // ready', "javascript");
  assert.match(html, /tok-k/);
  assert.match(html, /tok-s/);
  assert.match(html, /tok-n/);
  assert.match(html, /tok-c/);
});

test("syntax highlighting escapes model-provided HTML before adding spans", () => {
  const html = highlightHtml("<script>alert(1)</script>", "html");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("ANSI output uses multiple colors and preserves source text", () => {
  const source = "const answer = 42;";
  const ansi = highlightAnsi(source, "ts");
  assert.notEqual(ansi, source);
  assert.match(ansi, /\u001b\[/);
  assert.match(ansi, /answer/);
  assert.match(ansi, /42/);
});
test("plain streaming prose is immediate and fenced code is colorized across chunks", () => {
  let output = "";
  const stream = require("../dist/highlight.js").createCodeStreamColorizer((text) => {
    output += text;
  }, true);
  stream.push("plain");
  assert.equal(output, "plain");
  stream.push(" text\n```ts\nconst x = 1;\n```");
  stream.flush();
  assert.ok(output.includes("\x1b[35mconst"));
  assert.ok(output.includes("\x1b[33m1"));
  assert.ok(output.includes("```ts"));
});

// Web edit diffs: pure LCS engine, offline, deterministic.
const test = require("node:test");
const assert = require("node:assert/strict");
const { diffLines, renderEditDiff } = require("../dist/web/diff");

test("identical texts produce only same lines", () => {
  const out = diffLines("a\nb", "a\nb");
  assert.ok(out.length > 0 && out.every((l) => l.kind === "same"));
  assert.ok(!renderEditDiff("a\nb", "a\nb").includes("- "));
});

test("one changed line shows del and add", () => {
  const text = renderEditDiff("const x = 1;", "const x = 2;");
  assert.match(text, /- const x = 1;/);
  assert.match(text, /\+ const x = 2;/);
});

test("added and removed blocks are detected", () => {
  const out = diffLines("a\nb\nc", "a\nx\nc\nd");
  const kinds = out.map((l) => l.kind).join(",");
  assert.ok(kinds.includes("del") && kinds.includes("add"), kinds);
  assert.ok(out.some((l) => l.kind === "same" && l.text === "a"));
});

test("long unchanged runs collapse", () => {
  const filler = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  const text = renderEditDiff(`${filler}\nold`, `${filler}\nnew`);
  assert.match(text, /unchanged lines/);
  assert.ok(text.split("\n").length < 25, `collapsed, got ${text.split("\n").length}`);
});

test("output stays capped on large inputs", () => {
  const big = Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n");
  assert.ok(renderEditDiff(big, `${big}\nend`).split("\n").length <= 80);
});

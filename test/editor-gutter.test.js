// The editor gutter: which lines differ from the committed version. Blue/green/
// red bars next to the line numbers (web + Electron share this module).
const test = require("node:test");
const assert = require("node:assert/strict");
const { diffLines, gutterDecorations } = require("../dist/editor-gutter");

test("an untouched file shows no mark", () => {
  assert.deepEqual(gutterDecorations("a\nb\nc\n", "a\nb\nc\n"), []);
  assert.deepEqual(gutterDecorations("", ""), []);
});

test("an added line is green on its own line", () => {
  assert.deepEqual(gutterDecorations("a\nc\n", "a\nb\nc\n"), [{ line: 2, kind: "added" }]);
  assert.deepEqual(diffLines("a\n", "a\nb\n").added, [2]);
});

test("a rewritten line is blue, not one add plus one delete", () => {
  assert.deepEqual(gutterDecorations("a\nb\nc\n", "a\nX\nc\n"), [{ line: 2, kind: "modified" }]);
});

test("a deleted line hangs under the line it followed", () => {
  assert.deepEqual(gutterDecorations("a\nb\nc\n", "a\nc\n"), [{ line: 1, kind: "removed" }]);
  assert.deepEqual(gutterDecorations("x\na\n", "a\n"), [{ line: 1, kind: "removed" }]);
});

test("several hunks are reported independently and in line order", () => {
  assert.deepEqual(gutterDecorations("a\nb\nc\nd\ne\n", "a\nB\nc\nd\nE\n"), [
    { line: 2, kind: "modified" },
    { line: 5, kind: "modified" },
  ]);
  assert.deepEqual(gutterDecorations("a\nb\nc\n", "a\nNEW\nb\nc\nTAIL\n"), [
    { line: 2, kind: "added" },
    { line: 5, kind: "added" },
  ]);
});

test("CRLF files compare like LF ones", () => {
  assert.deepEqual(gutterDecorations("a\r\nb\r\n", "a\r\nX\r\n"), [{ line: 2, kind: "modified" }]);
});

test("an untracked file reads as entirely new", () => {
  assert.deepEqual(gutterDecorations(null, "a\nb\n"), [
    { line: 1, kind: "added" },
    { line: 2, kind: "added" },
  ]);
});

test("a huge rewrite stays bounded instead of blowing up", () => {
  const head = Array.from({ length: 4000 }, (_, i) => `old ${i}`).join("\n");
  const current = Array.from({ length: 4000 }, (_, i) => `new ${i}`).join("\n");
  const started = Date.now();
  const rows = gutterDecorations(head, current);
  assert.ok(Date.now() - started < 2000, "must not go quadratic on a full rewrite");
  assert.equal(rows.length, 4000);
  assert.ok(rows.every((r) => r.kind === "modified"));
});

test("a trailing newline is a terminator, not an extra empty line", () => {
  assert.deepEqual(gutterDecorations("a\nb\n", "a\nb"), []);
  assert.deepEqual(diffLines("a\nb", "a\nb\n").added, []);
});

test("makeHeadCache reads HEAD once per TTL, then refreshes", async () => {
  const { makeHeadCache } = require("../dist/editor-gutter");
  let calls = 0;
  const fetchHead = async () => {
    calls++;
    return { tracked: true, content: "a\n" };
  };
  const cache = makeHeadCache({ ttlMs: 60_000 });
  assert.equal(await cache.head("x.ts", fetchHead), "a\n");
  assert.equal(await cache.head("x.ts", fetchHead), "a\n");
  assert.equal(calls, 1, "un second appel dans le delai ne doit pas relire git");
  assert.equal(cache.size(), 1);
  cache.invalidate("x.ts");
  assert.equal(cache.size(), 0);
});

test("makeHeadCache re-reads after the TTL and never throws on a failed fetch", async () => {
  const { makeHeadCache } = require("../dist/editor-gutter");
  let calls = 0;
  const cache = makeHeadCache({ ttlMs: 1 });
  const ok = async () => {
    calls++;
    return { tracked: true, content: "b\n" };
  };
  await cache.head("y.ts", ok);
  await new Promise((r) => setTimeout(r, 10));
  await cache.head("y.ts", ok);
  assert.equal(calls, 2, "apres le delai, HEAD est relu");
  const boom = async () => {
    throw new Error("git indisponible");
  };
  assert.equal(await cache.head("z.ts", boom), null);
  assert.equal(await cache.head("untracked.ts", async () => ({ tracked: false, content: null })), null);
});

test("a giant new file is capped so Monaco stays responsive", () => {
  const huge = Array.from({ length: 5000 }, (_, i) => `ligne ${i}`).join("\n");
  const rows = gutterDecorations(null, huge);
  assert.equal(rows.length, 4000, "au-dela de 4000 marques, Monaco n'affiche plus rien d'utile");
  assert.ok(rows.every((r) => r.kind === "added"));
});

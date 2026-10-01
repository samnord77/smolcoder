// Fractional-index CRDT: ordering, convergence across replicas in any
// order, idempotence, textarea diffs — plus the exact browser bundle
// executed standalone (what the page runs).
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const {
  posBetween,
  comparePos,
  docFromText,
  docText,
  localInsert,
  localDelete,
  applyOp,
  diffForSync,
  browserCrdtSource,
} = require("../dist/crdt");

test("positions stay ordered between neighbors", () => {
  let prev = null;
  const seq = [];
  for (let i = 0; i < 100; i++) {
    const p = posBetween(prev, null);
    if (prev) assert.ok(comparePos(prev, p) < 0);
    seq.push(p);
    prev = p;
  }
  const a = posBetween(seq[10], seq[11]);
  assert.ok(comparePos(seq[10], a) < 0 && comparePos(a, seq[11]) < 0);
  const b = posBetween(seq[10], a);
  assert.ok(comparePos(seq[10], b) < 0 && comparePos(b, a) < 0);
});

test("concurrent inserts at the same spot converge both ways", () => {
  for (const order of [
    [0, 1],
    [1, 0],
  ]) {
    const A = docFromText("hello");
    A.site = "a";
    const B = docFromText("hello");
    B.site = "b";
    const oa = localInsert(A, 1, "X");
    const ob = localInsert(B, 1, "Y");
    const first = order[0] === 0 ? [B, oa] : [A, ob];
    const second = order[0] === 0 ? [A, ob] : [B, oa];
    first[1].forEach((op) => applyOp(first[0], op));
    second[1].forEach((op) => applyOp(second[0], op));
    assert.equal(docText(A), docText(B));
    assert.equal(docText(A).length, 7);
    assert.match(docText(A), /X/);
    assert.match(docText(A), /Y/);
  }
});

test("deletes converge and ops are idempotent", () => {
  const A = docFromText("abcdef");
  A.site = "a";
  const B = docFromText("abcdef");
  B.site = "b";
  const del = localDelete(A, 1, 2);
  assert.equal(docText(A), "adef");
  del.forEach((op) => applyOp(B, op));
  assert.equal(docText(B), "adef");
  const before = docText(B);
  del.forEach((op) => applyOp(B, op));
  assert.equal(docText(B), before);
  assert.equal(applyOp(B, { op: "ins", id: "x", pos: [], site: "", ch: "z" }), false);
  assert.equal(applyOp(B, null), false);
});

test("diffForSync expresses typing, paste and deletes", () => {
  assert.deepEqual(diffForSync("abc", "aXc"), { at: 1, del: 1, ins: "X" });
  assert.deepEqual(diffForSync("", "hi"), { at: 0, del: 0, ins: "hi" });
  assert.deepEqual(diffForSync("hello", "hell"), { at: 4, del: 1, ins: "" });
  assert.deepEqual(diffForSync("same", "same"), { at: 4, del: 0, ins: "" });
});

test("the shipped browser bundle runs standalone", () => {
  const api = vm.runInNewContext(`${browserCrdtSource}\n({posBetween,docFromText,docText,localInsert,localDelete,applyOp,diffForSync});`);
  const doc = api.docFromText("hi");
  doc.site = "s1";
  assert.equal(api.docText(doc), "hi");
  const ops = api.localInsert(doc, 1, "X");
  assert.equal(api.docText(doc), "hXi");
  const other = api.docFromText("hi");
  other.site = "s2";
  ops.forEach((op) => api.applyOp(other, op));
  assert.equal(api.docText(other), "hXi");
  assert.deepEqual(JSON.parse(JSON.stringify(api.diffForSync("ab", "aXb"))), { at: 1, del: 0, ins: "X" });
});

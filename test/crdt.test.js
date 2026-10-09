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
  localUndo,
  localRedo,
  canUndo,
  canRedo,
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
    for (const op of first[1]) applyOp(first[0], op);
    for (const op of second[1]) applyOp(second[0], op);
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
  for (const op of del) applyOp(B, op);
  assert.equal(docText(B), "adef");
  const before = docText(B);
  for (const op of del) applyOp(B, op);
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

test("localUndo and localRedo isolate local edits and restore state", () => {
  const doc = docFromText("hello");
  doc.site = "s1";
  assert.equal(canUndo(doc), false);
  assert.equal(canRedo(doc), false);

  // Insert " world"
  localInsert(doc, 5, " world");
  assert.equal(docText(doc), "hello world");
  assert.equal(canUndo(doc), true);

  // Undo insert
  const undoOps = localUndo(doc);
  assert.ok(undoOps.length > 0);
  assert.equal(docText(doc), "hello");
  assert.equal(canUndo(doc), false);
  assert.equal(canRedo(doc), true);

  // Redo insert
  const redoOps = localRedo(doc);
  assert.ok(redoOps.length > 0);
  assert.equal(docText(doc), "hello world");
  assert.equal(canUndo(doc), true);
  assert.equal(canRedo(doc), false);

  // Delete "world"
  localDelete(doc, 6, 5);
  assert.equal(docText(doc), "hello ");
  const undoDelOps = localUndo(doc);
  assert.ok(undoDelOps.length > 0);
  assert.equal(docText(doc), "hello world");
});

test("isolated undo does not undo concurrent edits from other sites", () => {
  const A = docFromText("start ");
  A.site = "alice";
  const B = docFromText("start ");
  B.site = "bob";

  // Alice inserts "[A]" at end
  const opsA = localInsert(A, 6, "[A]");
  // Bob inserts "[B]" at end
  const opsB = localInsert(B, 6, "[B]");

  // Exchange ops
  for (const op of opsA) applyOp(B, op);
  for (const op of opsB) applyOp(A, op);

  // Both have converged
  assert.equal(docText(A), docText(B));
  const merged = docText(A);
  assert.ok(merged.includes("A") && merged.includes("B"));

  // Alice undos her edit: only her characters disappear, Bob's [B] remains!
  const undoOpsA = localUndo(A);
  assert.ok(undoOpsA.length > 0);
  assert.equal(docText(A), "start [B]");

  // Bob receives Alice's undo ops and converges to start [B]
  for (const op of undoOpsA) applyOp(B, op);
  assert.equal(docText(B), "start [B]");
  assert.equal(docText(A), docText(B));

  // Alice redoes her edit: merged text is perfectly restored on both replicas
  const redoOpsA = localRedo(A);
  assert.equal(docText(A), merged);
  for (const op of redoOpsA) applyOp(B, op);
  assert.equal(docText(B), merged);
});

test("the shipped browser bundle runs standalone", () => {
  const api = vm.runInNewContext(
    `${browserCrdtSource}\n({posBetween,docFromText,docText,localInsert,localDelete,localUndo,localRedo,canUndo,canRedo,applyOp,diffForSync});`
  );
  const doc = api.docFromText("hi");
  doc.site = "s1";
  assert.equal(api.docText(doc), "hi");
  const ops = api.localInsert(doc, 1, "X");
  assert.equal(api.docText(doc), "hXi");
  assert.equal(api.canUndo(doc), true);
  api.localUndo(doc);
  assert.equal(api.docText(doc), "hi");
  assert.equal(api.canRedo(doc), true);
  api.localRedo(doc);
  assert.equal(api.docText(doc), "hXi");

  const other = api.docFromText("hi");
  other.site = "s2";
  for (const op of ops) api.applyOp(other, op);
  assert.equal(api.docText(other), "hXi");
  assert.deepEqual(JSON.parse(JSON.stringify(api.diffForSync("ab", "aXb"))), { at: 1, del: 0, ins: "X" });
});

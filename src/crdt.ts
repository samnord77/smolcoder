// Character-level collaborative text (fractional-index CRDT, zero deps).
// Every character carries a fractional position; concurrent inserts at the
// same spot order deterministically by site id, so all replicas converge to
// the same text by sorting. Deletes are tombstones. Plain data plus pure
// functions: node tests simulate N editors exchanging ops in any order, and
// the browser wires textarea diffs to local ops / remote ops to the textarea.
// The file on disk stays authoritative: saves and agent writes re-bootstrap
// every replica (see /edit/open). Native undo across remote edits is a known
// limitation (remote apply replaces the textarea value).
export interface CrdtChar {
  pos: number[];
  site: string;
  ch: string;
  dead: boolean;
}

export interface CrdOp {
  op: "ins" | "del";
  /** site:counter — the idempotence key (applied twice = applied once). */
  id: string;
  pos: number[];
  site: string;
  ch?: string;
}

const BASE = 65536;

/** A position strictly between a and b (null = start/end of document).
 * Deterministic per (a, b): two sites inserting between the same neighbors
 * compute the same array and order by site id. */
export function posBetween(a: number[] | null, b: number[] | null): number[] {
  const out: number[] = [];
  let i = 0;
  for (;;) {
    const ca = a && i < a.length ? a[i] : 0;
    const cb = b && i < b.length ? b[i] : BASE;
    if (cb - ca > 1) {
      out.push(Math.floor((ca + cb) / 2));
      return out;
    }
    out.push(ca);
    i++;
    if (i > 64) {
      out.push(1);
      return out;
    }
  }
}

/** Lexicographic order with 0-padding (shorter sorts first on a tie). */
export function comparePos(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ca = i < a.length ? a[i] : 0;
    const cb = i < b.length ? b[i] : 0;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return 0;
}

export interface CrdtDoc {
  chars: CrdtChar[];
  seen: string[];
  counter: number;
  site: string;
}

export function emptyDoc(site: string): CrdtDoc {
  return { chars: [], seen: [], counter: 0, site };
}

/** Bootstrap from file text. Split by UTF-16 unit to match textarea offsets
 * (an emoji counts 2, exactly like selectionStart). Bootstrap characters
 * share the reserved "boot" site on every replica: all copies of the same
 * file start with byte-identical identities, so deletes match everywhere.
 * Only live edits carry the replica's own site. */
export function docFromText(text: string): CrdtDoc {
  const doc = emptyDoc("boot");
  let prev: number[] | null = null;
  for (const ch of String(text ?? "").split("")) {
    const pos = posBetween(prev, null);
    doc.chars.push({ pos, site: "boot", ch, dead: false });
    prev = pos;
  }
  return doc;
}

export function docText(doc: CrdtDoc): string {
  return doc.chars
    .filter((c) => !c.dead)
    .map((c) => c.ch)
    .join("");
}

function sortDoc(doc: CrdtDoc): void {
  doc.chars.sort(
    (a, b) => comparePos(a.pos, b.pos) || (a.site < b.site ? -1 : a.site > b.site ? 1 : 0)
  );
}

function liveChars(doc: CrdtDoc): CrdtChar[] {
  return doc.chars.filter((c) => !c.dead);
}

/** Insert text at a visible index. Returns the ops to broadcast. */
export function localInsert(doc: CrdtDoc, visibleIndex: number, text: string): CrdOp[] {
  const live = liveChars(doc);
  const ops: CrdOp[] = [];
  let idx = Math.max(0, Math.min(Math.floor(visibleIndex) || 0, live.length));
  for (const ch of String(text ?? "").split("")) {
    const a = idx > 0 ? live[idx - 1].pos : null;
    const b = idx < live.length ? live[idx].pos : null;
    const pos = posBetween(a, b);
    const op: CrdOp = { op: "ins", id: `${doc.site}:${++doc.counter}`, pos, site: doc.site, ch };
    applyOp(doc, op);
    ops.push(op);
    live.splice(idx, 0, { pos, site: doc.site, ch, dead: false });
    idx++;
  }
  return ops;
}

/** Delete count visible chars from a visible index. Returns the broadcast ops. */
export function localDelete(doc: CrdtDoc, visibleIndex: number, count: number): CrdOp[] {
  const live = liveChars(doc);
  const ops: CrdOp[] = [];
  const idx = Math.max(0, Math.min(Math.floor(visibleIndex) || 0, Math.max(0, live.length - 1)));
  for (let k = 0; k < Math.max(0, Math.floor(count) || 0); k++) {
    const target = live[idx];
    if (!target) break;
    target.dead = true;
    live.splice(idx, 1);
    ops.push({ op: "del", id: `${doc.site}:${++doc.counter}`, pos: target.pos, site: target.site });
  }
  return ops;
}

/** Apply a remote (or replayed local) op. Idempotent; malformed ops are
 * refused without throwing. Returns true when the document changed. */
export function applyOp(doc: CrdtDoc, op: CrdOp): boolean {
  if (!op || (op.op !== "ins" && op.op !== "del")) return false;
  if (typeof op.id !== "string" || !op.id || typeof op.site !== "string" || !op.site) return false;
  if (!Array.isArray(op.pos) || op.pos.some((n) => typeof n !== "number" || !Number.isFinite(n))) return false;
  if (doc.seen.indexOf(op.id) >= 0) return false;
  doc.seen.push(op.id);
  if (doc.seen.length > 50000) doc.seen.splice(0, doc.seen.length - 50000);
  if (op.op === "ins") {
    if (typeof op.ch !== "string" || op.ch.length !== 1) return false;
    const dup = doc.chars.some((c) => c.site === op.site && comparePos(c.pos, op.pos) === 0);
    if (dup) return false;
    doc.chars.push({ pos: [...op.pos], site: op.site, ch: op.ch, dead: false });
    sortDoc(doc);
    return true;
  }
  const target = doc.chars.find((c) => c.site === op.site && comparePos(c.pos, op.pos) === 0);
  if (target) target.dead = true;
  return !!target;
}

/** Minimal diff between shadow and current textarea value: one contiguous
 * change expressed as {at, del, ins}. Enough for typing, paste, cut and
 * (single-caret) deletes — the 99% case. */
export function diffForSync(before: string, after: string): { at: number; del: number; ins: string } {
  const a = String(before ?? "");
  const b = String(after ?? "");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { at: start, del: endA - start, ins: b.slice(start, endB) };
}

/** Plain-JavaScript source injected into the web page (same pattern as the
 * syntax highlighter): every function the browser needs, self-contained. */
export const browserCrdtSource = [
  "const BASE = 65536;",
  ...[posBetween, comparePos, emptyDoc, docFromText, docText, sortDoc, liveChars, localInsert, localDelete, applyOp, diffForSync].map(
    (f) => `const ${f.name} = (${f.toString()});`
  ),
].join("\n");

// Editor gutter: which lines of the OPEN file differ from the committed one.
//
// The bar next to the line numbers (green added, blue modified, red removed) is
// the same information every IDE shows. The comparison lives here so the web
// editor and the Electron editor cannot drift apart, and so it can be tested
// without a browser.
//
// Deliberately dependency-free: the desktop preload requires this file from
// dist/, and the web client inlines `editorGutterBrowserSource` into the page.

export type GutterKind = "added" | "modified" | "removed";

export interface GutterDecoration {
  /** 1-based line in the CURRENT file the mark hangs on. */
  line: number;
  kind: GutterKind;
}

export interface GutterDiff {
  /** 1-based lines with no committed counterpart. */
  added: number[];
  /** 1-based lines whose committed counterpart differs. */
  modified: number[];
  /** 1-based line the removal sits under (the line before the gap). */
  removed: number[];
}

/**
 * Builds the whole gutter comparison. Everything lives inside this single
 * function on purpose: `toString()` is inlined into the web page, so the body
 * may not reference anything from module scope.
 */
export function makeGutterHelpers() {
  /** A quadratic alignment is only worth it for edits; two rewrites of a huge
   * file fall back to "everything changed", which is what the eye sees anyway. */
  const MAX_ALIGN_CELLS = 1200 * 1200;

  /** Past a few thousand marks the bars stop informing anyone and Monaco starts
   * to cost more than the eye gain: a brand-new 30k-line file is one green block.
   */
  const MAX_MARKS = 4000;

  /** Cache of "the file at HEAD": one fetch per path per TTL. Computing the bars
   * is local and cheap, but re-reading HEAD is not (a `git show` costs ~200 ms
   * on Windows), so editors must not do it on every keystroke. */
  const makeHeadCache = (opts?: { ttlMs?: number }) => {
    const ttl = Number(opts?.ttlMs) > 0 ? Number(opts?.ttlMs) : 15000;
    const entries = new Map<string, { content: string | null; at: number }>();
    return {
      /** HEAD text for `path`; the fetch is skipped while the entry is fresh. */
      async head(path: string, fetchHead: (p: string) => any): Promise<string | null> {
        const hit = entries.get(path);
        if (hit && Date.now() - hit.at < ttl) return hit.content;
        let content: string | null = null;
        try {
          const shown = await fetchHead(path);
          content = shown && shown.tracked === true ? (typeof shown.content === "string" ? shown.content : "") : null;
        } catch {
          content = null;
        }
        entries.set(path, { content: content, at: Date.now() });
        return content;
      },
      /** Forget one path (after a commit) or everything. */
      invalidate(path?: string): void {
        if (path === undefined) entries.clear();
        else entries.delete(path);
      },
      size(): number {
        return entries.size;
      },
    };
  };

  const splitLines = (text: string): string[] => {
    const normalized = String(text === undefined || text === null ? "" : text).replace(/\r\n?/g, "\n");
    const lines = normalized.split("\n");
    // A trailing newline is a terminator, not an empty last line.
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  };

  /** LCS walk over the changed middles: a deleted line paired with an added one
   * is a modification, a one-sided leftover is an addition or a deletion. */
  const align = (a: string[], b: string[], base: number, diff: GutterDiff): void => {
    const n = a.length;
    const m = b.length;
    if (!n && !m) return;
    if (n * m > MAX_ALIGN_CELLS) {
      const paired = Math.min(n, m);
      for (let i = 0; i < paired; i++) diff.modified.push(base + i + 1);
      for (let i = paired; i < m; i++) diff.added.push(base + i + 1);
      if (n > m) diff.removed.push(Math.max(1, base + m));
      return;
    }
    // lengths[i*(m+1) + j] = LCS length of a[i:] and b[j:]
    const lengths = new Int32Array((n + 1) * (m + 1));
    const at = (i: number, j: number): number => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lengths[at(i, j)] = a[i] === b[j] ? lengths[at(i + 1, j + 1)] + 1 : Math.max(lengths[at(i + 1, j)], lengths[at(i, j + 1)]);
      }
    }
    const ops: Array<"=" | "-" | "+"> = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push("=");
        i++;
        j++;
      } else if (lengths[at(i + 1, j)] >= lengths[at(i, j + 1)]) {
        ops.push("-");
        i++;
      } else {
        ops.push("+");
        j++;
      }
    }
    while (i++ < n) ops.push("-");
    while (j++ < m) ops.push("+");
    // Walk the ops: the current-file line counter only moves on "=" and "+", so
    // every mark lands on a real line of the file the user is looking at.
    let cur = base;
    let k = 0;
    while (k < ops.length) {
      if (ops[k] === "=") {
        cur++;
        k++;
        continue;
      }
      const blockAdds: number[] = [];
      let dels = 0;
      while (k < ops.length && ops[k] !== "=") {
        if (ops[k] === "-") dels++;
        else {
          cur++;
          blockAdds.push(cur);
        }
        k++;
      }
      const paired = Math.min(dels, blockAdds.length);
      for (let t = 0; t < paired; t++) diff.modified.push(blockAdds[t]);
      for (let t = paired; t < blockAdds.length; t++) diff.added.push(blockAdds[t]);
      if (dels > paired) diff.removed.push(Math.max(1, blockAdds.length ? blockAdds[0] - 1 : cur));
    }
  };

  /** Lines of `current` that differ from `head`, for the editor gutter.
   * `head === null` (untracked file) makes every line read as added. */
  const diffLines = (head: string | null, current: string): GutterDiff => {
    const diff: GutterDiff = { added: [], modified: [], removed: [] };
    const b = splitLines(current);
    if (head === null || head === undefined) {
      for (let i = 0; i < b.length; i++) diff.added.push(i + 1);
      return diff;
    }
    const a = splitLines(head);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
      endA--;
      endB--;
    }
    // The middles hold every difference: what aligns inside them is a
    // modification, what only the new side has is an addition, the rest is a
    // deletion hanging under the line it followed.
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    if (!midA.length && !midB.length) return diff;
    if (!midA.length) {
      for (let i = 0; i < midB.length; i++) diff.added.push(start + i + 1);
      return diff;
    }
    if (!midB.length) {
      diff.removed.push(Math.max(1, start === 0 ? 1 : start));
      return diff;
    }
    align(midA, midB, start, diff);
    return diff;
  };

  /** Rows ready for Monaco: one entry per marked line, sorted by line. */
  const gutterDecorations = (head: string | null, current: string): GutterDecoration[] => {
    const diff = diffLines(head, current);
    const rows: GutterDecoration[] = [];
    for (const line of diff.added) rows.push({ line: line, kind: "added" });
    for (const line of diff.modified) rows.push({ line: line, kind: "modified" });
    for (const line of diff.removed) rows.push({ line: line, kind: "removed" });
    rows.sort((p, q) => p.line - q.line);
    return rows.length > MAX_MARKS ? rows.slice(0, MAX_MARKS) : rows;
  };

  return { diffLines: diffLines, gutterDecorations: gutterDecorations, makeHeadCache: makeHeadCache };
}

const gutterHelpers = makeGutterHelpers();

/** Lines of `current` that differ from `head` (see GutterDiff). */
export const diffLines = gutterHelpers.diffLines;

/** Rows ready for Monaco: one entry per marked line, sorted by line. */
export const gutterDecorations = gutterHelpers.gutterDecorations;

/** One HEAD fetch per path per TTL, shared by the web and Electron editors. */
export const makeHeadCache = gutterHelpers.makeHeadCache;

/**
 * Browser-side source of the gutter comparison, inlined into the served page
 * by the web client. Exposes a page-global `gutterDecorations(head, current)`.
 */
export const editorGutterBrowserSource = `const { gutterDecorations, makeHeadCache } = (${makeGutterHelpers.toString()})();`;

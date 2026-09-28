// Tiny line diff for edit_file calls, shown in the web transcript.
// LCS on lines (snippets are small), unchanged runs collapse, output capped.
// Pure and DOM-free so node tests cover it; the browser page colors it.
export type DiffKind = "same" | "del" | "add" | "skip";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

const MAX_INPUT_LINES = 200;
const MAX_OUT_LINES = 80;
const COLLAPSE_AFTER = 3;

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = String(oldText ?? "")
    .split("\n")
    .slice(0, MAX_INPUT_LINES);
  const b = String(newText ?? "")
    .split("\n")
    .slice(0, MAX_INPUT_LINES);
  const n = a.length;
  const m = b.length;
  // LCS lengths, two rows.
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  const trace: Uint8Array[] = [];
  for (let i = 1; i <= n; i++) {
    cur = new Array<number>(m + 1).fill(0);
    const row = new Uint8Array(m + 1);
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        row[j] = 1; // diagonal
      } else if (prev[j] >= cur[j - 1]) {
        cur[j] = prev[j];
        row[j] = 2; // up (delete)
      } else {
        cur[j] = cur[j - 1];
        row[j] = 3; // left (add)
      }
    }
    trace.push(row);
    prev = cur;
  }
  const out: DiffLine[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const step = trace[i - 1][j];
    if (step === 1) {
      out.push({ kind: "same", text: a[i - 1] });
      i--;
      j--;
    } else if (step === 2) {
      out.push({ kind: "del", text: a[i - 1] });
      i--;
    } else {
      out.push({ kind: "add", text: b[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    out.push({ kind: "del", text: a[i - 1] });
    i--;
  }
  while (j > 0) {
    out.push({ kind: "add", text: b[j - 1] });
    j--;
  }
  out.reverse();
  return collapseRuns(out).slice(0, MAX_OUT_LINES);
}

function collapseRuns(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let run: DiffLine[] = [];
  const flush = (): void => {
    if (run.length > COLLAPSE_AFTER * 2) {
      out.push(...run.slice(0, COLLAPSE_AFTER));
      out.push({ kind: "skip", text: `… ${run.length - COLLAPSE_AFTER * 2} unchanged lines …` });
      out.push(...run.slice(-COLLAPSE_AFTER));
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const l of lines) {
    if (l.kind === "same") run.push(l);
    else {
      flush();
      out.push(l);
    }
  }
  flush();
  return out;
}

/** Render an edit_file replacement as a capped unified-style block. */
export function renderEditDiff(oldText: string, newText: string): string {
  const prefix = { same: "  ", del: "- ", add: "+ ", skip: "" } as const;
  return diffLines(oldText, newText)
    .map((l) => prefix[l.kind] + l.text.slice(0, 300))
    .join("\n");
}

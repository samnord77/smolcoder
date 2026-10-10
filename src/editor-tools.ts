export interface TextEditResult {
  text: string;
  start: number;
  end: number;
}

export interface TextMatch {
  start: number;
  end: number;
}
export interface FindMatchesResult {
  matches: TextMatch[];
  truncated: boolean;
}
export interface FindOptions {
  caseSensitive?: boolean;
  limit?: number;
}
export interface ReplaceResult {
  text: string;
  count: number;
  error?: string;
}

const MAX_FIND_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_FIND_RESULTS = 1000;
const MAX_REPLACED_CHARS = 1024 * 1024;
const MAX_REPLACEMENTS = 50_000;

function literalPattern(query: string, caseSensitive: boolean): RegExp | null {
  if (typeof query !== "string" || !query || query.length > 4096) return null;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, caseSensitive ? "g" : "gi");
}

/** Bounded, literal matches for a file-local find panel. Offsets remain UTF-16
 * positions so they can be passed directly to textarea.setSelectionRange. */
export function findMatches(text: string, query: string, options: FindOptions = {}): FindMatchesResult {
  if (typeof text !== "string" || text.length > MAX_FIND_TEXT_CHARS) return { matches: [], truncated: true };
  const pattern = literalPattern(query, options.caseSensitive === true);
  if (!pattern) return { matches: [], truncated: false };
  const asked = Number(options.limit);
  const limit = Number.isFinite(asked) ? Math.max(1, Math.min(MAX_FIND_RESULTS, Math.trunc(asked))) : 200;
  const matches: TextMatch[] = [];
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (matches.length === limit) return { matches, truncated: true };
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return { matches, truncated: false };
}

/** Find the next or previous literal occurrence and wrap at the document edge. */
export function findNextMatch(text: string, query: string, offset: number, backwards = false, caseSensitive = false): TextMatch | null {
  if (typeof text !== "string" || text.length > MAX_FIND_TEXT_CHARS) return null;
  const pattern = literalPattern(query, caseSensitive);
  if (!pattern) return null;
  const from = Math.max(0, Math.min(text.length, Math.trunc(Number(offset) || 0)));
  if (!backwards) {
    pattern.lastIndex = from;
    const next = pattern.exec(text);
    if (next) return { start: next.index, end: next.index + next[0].length };
    pattern.lastIndex = 0;
    const wrapped = pattern.exec(text);
    return wrapped ? { start: wrapped.index, end: wrapped.index + wrapped[0].length } : null;
  }

  let previous: RegExpExecArray | null = null;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index >= from) break;
    previous = match;
  }
  if (previous) return { start: previous.index, end: previous.index + previous[0].length };
  pattern.lastIndex = 0;
  let wrapped: RegExpExecArray | null = null;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) wrapped = match;
  return wrapped ? { start: wrapped.index, end: wrapped.index + wrapped[0].length } : null;
}

/** Replace literal occurrences without regex replacement-token expansion.
 * Refuses oversized results before returning a partial edit. */
export function replaceAllLiteral(text: string, query: string, replacement: string, caseSensitive = false): ReplaceResult {
  if (typeof text !== "string" || typeof replacement !== "string")
    return {
      text: String(text ?? ""),
      count: 0,
      error: "Le texte de remplacement est invalide.",
    };
  if (text.length > MAX_FIND_TEXT_CHARS)
    return {
      text,
      count: 0,
      error: "Fichier trop volumineux pour une recherche sûre.",
    };
  if (replacement.length > MAX_REPLACED_CHARS)
    return {
      text,
      count: 0,
      error: "Le remplacement dépasserait la limite de 1 Mo.",
    };
  const pattern = literalPattern(query, caseSensitive);
  if (!pattern) return { text, count: 0 };
  const parts: string[] = [];
  let cursor = 0,
    count = 0,
    size = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (count >= MAX_REPLACEMENTS)
      return {
        text,
        count: 0,
        error: "Plus de 50 000 occurrences : précisez votre recherche.",
      };
    const unchanged = text.slice(cursor, match.index);
    size += unchanged.length + replacement.length;
    if (size > MAX_REPLACED_CHARS)
      return {
        text,
        count: 0,
        error: "Le résultat dépasserait la limite de 1 Mo.",
      };
    parts.push(unchanged, replacement);
    cursor = match.index + match[0].length;
    count++;
  }
  if (!count) return { text, count: 0 };
  const tail = text.slice(cursor);
  if (size + tail.length > MAX_REPLACED_CHARS)
    return {
      text,
      count: 0,
      error: "Le résultat dépasserait la limite de 1 Mo.",
    };
  parts.push(tail);
  return { text: parts.join(""), count };
}

export function cursorPosition(text: string, offset: number): { line: number; column: number } {
  const safe = Math.max(0, Math.min(text.length, Math.trunc(Number(offset) || 0)));
  const before = text.slice(0, safe);
  const line = (before.match(/\n/g) || []).length + 1;
  return { line, column: safe - before.lastIndexOf("\n") };
}

export function offsetForPosition(text: string, line: number, column = 1): number {
  const wantedLine = Math.max(1, Math.trunc(Number(line) || 1));
  const wantedColumn = Math.max(1, Math.trunc(Number(column) || 1));
  let start = 0;
  for (let current = 1; current < wantedLine; current++) {
    const newline = text.indexOf("\n", start);
    if (newline < 0) return text.length;
    start = newline + 1;
  }
  const end = text.indexOf("\n", start);
  return Math.min(end < 0 ? text.length : end, start + wantedColumn - 1);
}

export function changeIndent(text: string, start: number, end: number, direction: 1 | -1, indent = "  "): TextEditResult {
  const a = Math.max(0, Math.min(text.length, Math.trunc(start)));
  const b = Math.max(a, Math.min(text.length, Math.trunc(end)));
  const unit = indent || "  ";
  if (a === b) {
    if (direction === 1)
      return {
        text: text.slice(0, a) + unit + text.slice(b),
        start: a + unit.length,
        end: a + unit.length,
      };
    const lineStart = text.lastIndexOf("\n", a - 1) + 1;
    const before = text.slice(lineStart, a);
    const remove = before.endsWith("\t") ? 1 : Math.min(unit.length, (before.match(/ +$/) || [""])[0].length);
    if (!remove) return { text, start: a, end: a };
    return {
      text: text.slice(0, a - remove) + text.slice(a),
      start: a - remove,
      end: a - remove,
    };
  }
  const lineStart = text.lastIndexOf("\n", a - 1) + 1;
  const endProbe = b > a && text[b - 1] === "\n" ? b - 1 : b;
  const lastLineStart = text.lastIndexOf("\n", endProbe - 1) + 1;
  const lineBlockEnd = text.indexOf("\n", lastLineStart);
  const blockEnd = lineBlockEnd < 0 ? text.length : lineBlockEnd;
  const lines = text.slice(lineStart, blockEnd).split("\n");
  let firstDelta = 0,
    totalDelta = 0;
  const edited = lines
    .map((line, index) => {
      if (direction === 1) {
        totalDelta += unit.length;
        if (index === 0) firstDelta = unit.length;
        return unit + line;
      }
      const remove = line.startsWith("\t") ? 1 : Math.min(unit.length, (line.match(/^ +/) || [""])[0].length);
      totalDelta -= remove;
      if (index === 0) firstDelta = -remove;
      return line.slice(remove);
    })
    .join("\n");
  return {
    text: text.slice(0, lineStart) + edited + text.slice(blockEnd),
    start: Math.max(lineStart, a + firstDelta),
    end: Math.max(lineStart, b + totalDelta),
  };
}

export function insertNewlineWithIndent(text: string, start: number, end: number, indent = "  "): TextEditResult {
  const a = Math.max(0, Math.min(text.length, Math.trunc(start)));
  const b = Math.max(a, Math.min(text.length, Math.trunc(end)));
  const lineStart = text.lastIndexOf("\n", a - 1) + 1;
  const prefix = text.slice(lineStart, a);
  const baseIndent = (prefix.match(/^\s*/) || [""])[0];
  const pairs: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
  const trimmedPrefix = prefix.trimEnd();
  const opener = trimmedPrefix.slice(-1);
  const openerAt = lineStart + trimmedPrefix.length - 1;
  const lineEnd = text.indexOf("\n", b);
  const suffix = text.slice(b, lineEnd < 0 ? text.length : lineEnd);
  const afterSpace = (suffix.match(/^\s*/) || [""])[0];
  const closer = suffix.slice(afterSpace.length, afterSpace.length + 1);
  const nested = !!pairs[opener] && pairs[opener] === closer;
  const continuation = baseIndent + (pairs[opener] ? indent : "");
  const replacement = nested ? `\n${continuation}\n${baseIndent}` : `\n${continuation}`;
  const editStart = nested ? openerAt + 1 : a;
  const editEnd = nested ? b + afterSpace.length : b;
  const cursor = editStart + 1 + continuation.length;
  return {
    text: text.slice(0, editStart) + replacement + text.slice(editEnd),
    start: cursor,
    end: cursor,
  };
}

/**
 * Anchor for the small "edit this line" popup: right under the clicked line,
 * kept inside the visible area, and flipped above the line when there is no
 * room below. Pure maths so both editors place the popup the same way.
 */
export function linePopupTop(opts: {
  lineTop: number;
  scrollTop: number;
  lineHeight: number;
  hostHeight: number;
  popupHeight?: number;
}): number {
  const lineTop = Number(opts.lineTop) || 0;
  const scrollTop = Number(opts.scrollTop) || 0;
  const lineHeight = Number(opts.lineHeight) > 0 ? Number(opts.lineHeight) : 20;
  const hostHeight = Number(opts.hostHeight) > 0 ? Number(opts.hostHeight) : 400;
  const popupHeight = Number(opts.popupHeight) > 0 ? Number(opts.popupHeight) : 120;
  const max = Math.max(6, hostHeight - popupHeight - 8);
  const below = lineTop - scrollTop + lineHeight + 6;
  if (below <= max) return Math.max(6, below);
  const above = lineTop - scrollTop - popupHeight - 6;
  return Math.max(6, Math.min(above, max));
}
export const editorToolsBrowserSource = `(() => { const MAX_FIND_TEXT_CHARS=${MAX_FIND_TEXT_CHARS}, MAX_FIND_RESULTS=${MAX_FIND_RESULTS}, MAX_REPLACED_CHARS=${MAX_REPLACED_CHARS}, MAX_REPLACEMENTS=${MAX_REPLACEMENTS}; const literalPattern=${literalPattern.toString()}; return ({cursorPosition:${cursorPosition.toString()},offsetForPosition:${offsetForPosition.toString()},changeIndent:${changeIndent.toString()},insertNewlineWithIndent:${insertNewlineWithIndent.toString()},findMatches:${findMatches.toString()},findNextMatch:${findNextMatch.toString()},replaceAllLiteral:${replaceAllLiteral.toString()},linePopupTop:${linePopupTop.toString()}}); })()`;

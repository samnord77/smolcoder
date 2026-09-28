export type SyntaxTokenKind = "plain" | "tok-k" | "tok-s" | "tok-n" | "tok-c" | "tok-f" | "tok-o" | "tok-tag" | "tok-t" | "tok-d";
export interface SyntaxToken { kind: SyntaxTokenKind; text: string }

/** Small dependency-free lexer shared by the browser UI, desktop editor and CLI. */
export function tokenizeCode(source: string, language = ""): SyntaxToken[] {
  const lang = language.toLowerCase().replace(/^language-/, "");
  const html = ["html", "xml", "svg", "vue", "svelte"].includes(lang);
  const hashComments = ["py", "python", "yaml", "yml", "toml", "sh", "bash", "shell", "ps1", "powershell", "rb", "ruby", "r", "makefile"].includes(lang);
  const dashComments = ["sql", "lua", "haskell", "hs"].includes(lang);
  const keywords = new Set(("async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield " +
    "as assert def elif except False from global import in is lambda None nonlocal not or pass raise return True try while and " +
    "abstract boolean byte char double enum float implements int interface long native package private protected public short static strictfp synchronized throws transient volatile " +
    "fn impl let loop match mod move mut pub ref self Self struct trait type use where async await dyn enum crate " +
    "func go defer chan map range select var const fallthrough goto " +
    "begin end module require ensure class do if elsif nil unless until when alias and or not " +
    "select insert update delete create alter drop table from where join on as group by order having limit offset null is into values set returning " +
    "echo exit export function if else elseif fi then elif for in do done case esac while until local readonly source " +
    "null true false yes no on off").split(/\s+/));
  const tokens: SyntaxToken[] = [];
  const add = (kind: SyntaxTokenKind, text: string) => { if (text) tokens.push({ kind, text }); };
  let i = 0;
  while (i < source.length) {
    const start = i;
    const ch = source[i];
    if (/\s/.test(ch)) { while (i < source.length && /\s/.test(source[i])) i++; add("plain", source.slice(start, i)); continue; }
    if (ch === "@" && i + 1 < source.length && /[A-Za-z_$]/.test(source[i + 1])) {
      i++;
      while (i < source.length && /[\w$]/.test(source[i])) i++;
      add("tok-d", source.slice(start, i)); continue;
    }
    if (html && ch === "<") {
      const end = source.indexOf(">", i + 1);
      if (end >= 0 && /^<\/?[A-Za-z!/?]/.test(source.slice(i, end + 1))) { i = end + 1; add("tok-tag", source.slice(start, i)); continue; }
    }
    if (source.startsWith("/*", i) || (hashComments && ch === "#") || (dashComments && source.startsWith("--", i)) || (!hashComments && !dashComments && source.startsWith("//", i))) {
      if (source.startsWith("/*", i)) { const end = source.indexOf("*/", i + 2); i = end < 0 ? source.length : end + 2; }
      else { const end = source.indexOf("\n", i); i = end < 0 ? source.length : end; }
      add("tok-c", source.slice(start, i)); continue;
    }
    if (ch === "'" || ch === '"' || (ch === "`" && ["js", "jsx", "ts", "tsx", "javascript", "typescript"].includes(lang))) {
      const quote = ch; i++;
      while (i < source.length) {
        if (source[i] === "\\") { i += Math.min(2, source.length - i); continue; }
        if (source[i++] === quote) break;
      }
      add("tok-s", source.slice(start, i)); continue;
    }
    if (/\d/.test(ch) && (i === 0 || !/[\w$]/.test(source[i - 1]))) {
      i++;
      while (i < source.length && /[\w.]/.test(source[i])) i++;
      add("tok-n", source.slice(start, i)); continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      i++;
      while (i < source.length && /[\w$]/.test(source[i])) i++;
      const word = source.slice(start, i);
      if (keywords.has(word)) add("tok-k", word);
      else if (/^[A-Z][a-z0-9]/.test(word)) add("tok-t", word);
      else {
        let next = i;
        while (next < source.length && /\s/.test(source[next])) next++;
        add(source[next] === "(" ? "tok-f" : "plain", word);
      }
      continue;
    }
    i++;
    add(/[=+*%!?|&^~<>:-]/.test(ch) ? "tok-o" : "plain", ch);
  }
  return tokens;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Source is trusted plain text; returned spans are the only HTML markup. */
export function highlightHtml(source: string, language = ""): string {
  return tokenizeCode(source, language).map(({ kind, text }) => {
    const safe = escapeHtml(text);
    return kind === "plain" ? safe : `<span class="${kind}">${safe}</span>`;
  }).join("");
}

/** For callers that already escaped model text before parsing Markdown. */
export function highlightEscapedHtml(source: string, language = ""): string {
  return tokenizeCode(source, language).map(({ kind, text }) =>
    kind === "plain" ? text : `<span class="${kind}">${text}</span>`
  ).join("");
}

export function highlightAnsi(source: string, language = ""): string {
  const colors: Partial<Record<SyntaxTokenKind, string>> = {
    "tok-k": "\x1b[35m", "tok-s": "\x1b[32m", "tok-n": "\x1b[33m",
    "tok-c": "\x1b[90m", "tok-f": "\x1b[36m", "tok-o": "\x1b[96m", "tok-tag": "\x1b[34m",
    "tok-t": "\x1b[94m", "tok-d": "\x1b[93m",
  };
  return tokenizeCode(source, language).map(({ kind, text }) => {
    const color = colors[kind];
    return color ? color + text + "\x1b[0m" : text;
  }).join("");
}

/** Incremental Markdown fence parser; ordinary prose is written byte-for-byte. */
export function createCodeStreamColorizer(write: (text: string) => void, enabled: boolean): { push(text: string): void; flush(): void } {
  let outside = "";
  let codeLine = "";
  let inFence = false;
  let language = "";
  const emitOutside = (char: string) => {
    if (!outside) {
      if (char === " " || char === "\t" || char === "`") { outside = char; return; }
      write(char); return;
    }
    outside += char;
    if (char === "\n") {
      const body = outside.replace(/\r?\n$/, "");
      const opening = /^\s*```([\w.+#-]*)\s*$/.exec(body);
      if (opening) { inFence = true; language = opening[1]; }
      write(outside); outside = ""; return;
    }
    const prefix = /^\s*(`{0,3})([\w.+#-]*)\s*$/.exec(outside);
    const ticks = prefix?.[1].length ?? 0;
    const possible = !!prefix && (ticks === 0 ? outside.trim() === "" : ticks < 3 || ticks === 3);
    if (!possible) { write(outside); outside = ""; }
  };
  const emitCode = (line: string) => {
    const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const body = ending ? line.slice(0, -ending.length) : line;
    if (/^\s*```\s*$/.test(body)) { inFence = false; language = ""; write(line); return; }
    write((enabled ? highlightAnsi(body, language) : body) + ending);
  };
  return {
    push(text: string) {
      for (const char of text) {
        if (!inFence) { emitOutside(char); continue; }
        codeLine += char;
        if (char === "\n") { emitCode(codeLine); codeLine = ""; }
      }
    },
    flush() {
      if (inFence) {
        if (codeLine) emitCode(codeLine);
        inFence = false; language = ""; codeLine = "";
      } else if (outside) { write(outside); outside = ""; }
    },
  };
}
/** Plain JavaScript source injected into the standalone web page. */
export const browserHighlighterSource = `const tokenizeCode = (${tokenizeCode.toString()});\nconst highlightEscapedHtml = (${highlightEscapedHtml.toString()});`;

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\r(?!\n)/g;

/** Strip terminal escapes so re-coloring never corrupts existing colors. */
export function stripAnsiDisplay(text: string): string {
  return String(text ?? "").replace(ANSI_RE, "");
}

/** Full short-result display for terminals: fenced code blocks get syntax
 * colors, "Error" lines go red, exit-code trailers green/red. Pure and
 * line-based (log-safe). Exported for tests. */
export function colorizeResultBlock(result: string, enabled: boolean): string {
  const lines = stripAnsiDisplay(result).split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceLang = "";
  for (const line of lines) {
    const fence = /^\s*```([\w.+#-]*)[\t ]*$/.exec(line);
    if (fence) {
      inFence = !inFence;
      if (inFence) fenceLang = fence[1] || "";
      out.push(enabled ? "\x1b[2m" + line + "\x1b[0m" : line);
      continue;
    }
    if (inFence) {
      out.push(enabled ? highlightAnsi(line, fenceLang) : line);
      continue;
    }
    if (/^\s*Error\b/.test(line)) out.push(enabled ? "\x1b[31m" + line + "\x1b[0m" : line);
    else if (/\[exit code 0 in /.test(line)) out.push(enabled ? "\x1b[32m" + line + "\x1b[0m" : line);
    else if (/\[exit code [1-9]/.test(line)) out.push(enabled ? "\x1b[31m" + line + "\x1b[0m" : line);
    else out.push(line);
  }
  return out.join("\n");
}
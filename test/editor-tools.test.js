const test = require("node:test");
const assert = require("node:assert/strict");
const tools = require("../dist/editor-tools");
const { editorToolsBrowserSource } = require("../dist/editor-tools");

test("cursor position and go-to-line use one-based line and column values", () => {
  const text = "first\nsecond\nthird";
  assert.deepEqual(tools.cursorPosition(text, 8), { line: 2, column: 3 });
  assert.equal(tools.offsetForPosition(text, 2, 3), 8);
  assert.equal(tools.offsetForPosition(text, 99, 1), text.length);
});

test("Tab indents selected lines and Shift+Tab reverses the change", () => {
  const text = "first\nsecond\nthird";
  const indented = tools.changeIndent(text, 0, text.length, 1);
  assert.equal(indented.text, "  first\n  second\n  third");
  const dedented = tools.changeIndent(indented.text, indented.start, indented.end, -1);
  assert.equal(dedented.text, text);
});

test("Tab at a cursor inserts indentation and Shift+Tab safely removes it", () => {
  const indented = tools.changeIndent("hello", 2, 2, 1);
  assert.equal(indented.text, "he  llo");
  assert.equal(indented.start, 4);
  const dedented = tools.changeIndent(indented.text, indented.start, indented.end, -1);
  assert.equal(dedented.text, "hello");
  assert.equal(dedented.start, 2);
});

test("Enter copies indentation and creates a nested line inside matching brackets", () => {
  const text = "  function f() {  }";
  const at = text.indexOf("}");
  const result = tools.insertNewlineWithIndent(text, at, at);
  assert.equal(result.text, "  function f() {\n    \n  }");
  assert.equal(result.text.slice(result.start - 4, result.start), "    ");
  const openOnly = tools.insertNewlineWithIndent("if (ready) {", 12, 12);
  assert.equal(openOnly.text, "if (ready) {\n  ");
});

test("browser editor helpers are serializable and preserve the tested behavior", () => {
  const browserTools = new Function(`return ${editorToolsBrowserSource}`)();
  assert.equal(browserTools.cursorPosition("a\nb", 2).line, 2);
  assert.equal(browserTools.changeIndent("x", 0, 0, 1).text, "  x");
  assert.deepEqual(browserTools.findNextMatch("Cat cat", "cat", 1), {
    start: 4,
    end: 7,
  });
});

test("literal search supports wrapping, backwards navigation, and regex characters", () => {
  const text = "one a+b, then A+B";
  assert.deepEqual(tools.findMatches(text, "a+b"), {
    matches: [
      { start: 4, end: 7 },
      { start: 14, end: 17 },
    ],
    truncated: false,
  });
  assert.deepEqual(tools.findNextMatch(text, "a+b", text.length), {
    start: 4,
    end: 7,
  });
  assert.deepEqual(tools.findNextMatch(text, "a+b", 14, true), {
    start: 4,
    end: 7,
  });
  assert.equal(tools.findNextMatch(text, "missing", 0), null);
  assert.deepEqual(tools.findMatches("Cat cat", "cat", { caseSensitive: true }).matches, [{ start: 4, end: 7 }]);
});

test("replace all is literal, bounded, and leaves the original untouched on overflow", () => {
  assert.deepEqual(tools.replaceAllLiteral("a+b A+B", "a+b", "$&!"), {
    text: "$&! $&!",
    count: 2,
  });
  const overflow = tools.replaceAllLiteral("x", "x", "y".repeat(1_048_577));
  assert.equal(overflow.text, "x");
  assert.equal(overflow.count, 0);
  assert.match(overflow.error, /1 Mo/i);
});

test("linePopupTop sits under the line, stays visible, flips above when needed", () => {
  const { linePopupTop } = require("../dist/editor-tools");
  // Ligne 3, defilement 0, hauteur 20 : sous la ligne (60).
  assert.equal(linePopupTop({ lineTop: 60, scrollTop: 0, lineHeight: 20, hostHeight: 600, popupHeight: 120 }), 86);
  // Le defilement est deduit : meme position visuelle.
  assert.equal(linePopupTop({ lineTop: 560, scrollTop: 500, lineHeight: 20, hostHeight: 600, popupHeight: 120 }), 86);
  // Pas de place en dessous -> au-dessus de la ligne.
  assert.equal(linePopupTop({ lineTop: 560, scrollTop: 0, lineHeight: 20, hostHeight: 600, popupHeight: 120 }), 434);
  // Toujours borne dans la zone visible.
  assert.ok(linePopupTop({ lineTop: 10, scrollTop: 0, lineHeight: 20, hostHeight: 100, popupHeight: 120 }) >= 6);
  assert.ok(linePopupTop({ lineTop: 10, scrollTop: 0, lineHeight: 20, hostHeight: 100, popupHeight: 120 }) <= 6);
});

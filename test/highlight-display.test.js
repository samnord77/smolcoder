// Terminal result coloring: fences, errors and exit-code trailers.
const test = require("node:test");
const assert = require("node:assert/strict");
const { colorizeResultBlock, stripAnsiDisplay } = require("../dist/highlight");

test("stripAnsiDisplay removes escapes without touching text", () => {
  assert.equal(stripAnsiDisplay("\x1b[32mgreen\x1b[0m and plain"), "green and plain");
  assert.equal(stripAnsiDisplay("no escapes"), "no escapes");
});

test("tokenizer colors PascalCase types and decorators", () => {
  const { tokenizeCode } = require("../dist/highlight");
  const kinds = (src, lang) => tokenizeCode(src, lang).map((t) => `${t.kind}:${t.text}`);
  const ts = kinds("const x: Agent = new Agent();", "ts");
  assert.ok(ts.includes("tok-t:Agent"), JSON.stringify(ts));
  assert.ok(!ts.includes("tok-t:x"), "lowercase stays plain");
  assert.ok(ts.includes("tok-k:const") && ts.includes("tok-k:new"));
  const py = kinds("@dataclass\nclass Foo:", "py");
  assert.ok(py.includes("tok-d:@dataclass"), JSON.stringify(py));
  assert.ok(kinds("MAX_SIZE = 1", "py").includes("plain:MAX_SIZE"), "SCREAMING stays plain");
});

test("tokenizer colors Markdown headings, links, fences and keeps prose plain", () => {
  const { tokenizeCode } = require("../dist/highlight");
  const kinds = (src, lang) => tokenizeCode(src, lang).map((t) => `${t.kind}:${t.text}`);
  const heading = kinds("# Titre\n", "md");
  assert.ok(heading.includes("tok-k:#"), JSON.stringify(heading));
  assert.ok(
    heading.some((k) => k.startsWith("tok-t:") && k.includes("Titre")),
    JSON.stringify(heading)
  );
  const link = kinds("[texte](https://x.fr)", "markdown");
  assert.ok(link.includes("tok-t:[texte]"), JSON.stringify(link));
  assert.ok(
    link.some((k) => k.startsWith("tok-v:(")),
    JSON.stringify(link)
  );
  const list = kinds("- item\n", "md");
  assert.ok(list.includes("tok-o:- "), JSON.stringify(list));
  const code = kinds("`inline`", "md");
  assert.ok(code.includes("tok-s:`inline`"), JSON.stringify(code));
  const prose = kinds("je suis le if de la maison", "md");
  assert.ok(!prose.some((k) => k.startsWith("tok-")), JSON.stringify(prose));
  const fenced = kinds("```html\n<b>x</b>\n```\n", "md");
  assert.ok(
    fenced.some((k) => k.startsWith("tok-tag:")),
    JSON.stringify(fenced)
  );
  assert.ok(fenced.filter((k) => k.startsWith("tok-c:")).length >= 2, JSON.stringify(fenced));
  const ts = kinds("const x: Agent = new Agent();", "ts");
  assert.ok(ts.includes("tok-k:const"), JSON.stringify(ts));
});

test("colorizeResultBlock colors fences, errors and exit codes", () => {
  const src = "```js\nconst x = 1;\n```\n[exit code 0 in 0.2s]";
  const colored = colorizeResultBlock(src, true);
  assert.match(colored, /\x1b\[35mconst/);
  assert.match(colored, /\x1b\[32m\[exit code 0/);
  assert.match(colorizeResultBlock("[exit code 2 in 0.1s]", true), /\x1b\[31m/);
  assert.match(colorizeResultBlock("Error: boom", true), /\x1b\[31mError/);
  assert.equal(colorizeResultBlock(src, false), src);
  assert.equal(colorizeResultBlock("plain output\nsecond line", true), "plain output\nsecond line");
  assert.match(colorizeResultBlock("\x1b[32m```js\nconst x = 1;\n```", true), /\x1b\[35mconst/);
});

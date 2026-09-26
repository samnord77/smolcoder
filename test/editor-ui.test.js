const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PAGE_HTML } = require("../dist/web/page");

function inlineScript(html, label) {
	const match = /<script>([\s\S]*?)<\/script>/i.exec(html);
	assert.ok(match, `${label} must contain its application script`);
	assert.doesNotThrow(
		() => new Function(match[1]),
		`${label} application script must parse`,
	);
}

test("Web editor bundle is valid browser JavaScript", () => {
	inlineScript(PAGE_HTML, "Web IDE");
});

test("Electron editor bundle is valid browser JavaScript", () => {
	const html = fs.readFileSync(
		path.join(__dirname, "..", "desktop", "editor.html"),
		"utf8",
	);
	inlineScript(html, "Electron IDE");
});

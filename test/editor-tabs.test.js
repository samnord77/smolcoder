const test = require("node:test");
const assert = require("node:assert/strict");
const { makeEditorTabStore } = require("../dist/editor-tabs");

test("editor tabs preserve independent buffers and dirty state across switches", () => {
  const tabs = makeEditorTabStore();
  tabs.open("src/a.ts", "one", 10);
  tabs.update("src/a.ts", "edited");
  tabs.open("src/b.ts", "two", 20);
  assert.equal(tabs.activate("src/a.ts").content, "edited");
  assert.equal(tabs.active().dirty, true);
  assert.equal(tabs.list().length, 2);
});

test("editor tabs become clean after save and refuse accidental dirty close", () => {
  const tabs = makeEditorTabStore();
  tabs.open("a.txt", "before");
  tabs.update("a.txt", "after");
  assert.equal(tabs.close("a.txt").closed, false);
  tabs.saved("a.txt", 123);
  assert.equal(tabs.active().dirty, false);
  assert.equal(tabs.active().mtimeMs, 123);
  assert.equal(tabs.close("a.txt").closed, true);
  assert.equal(tabs.active(), null);
});

test("editor tab close chooses a neighboring tab and explicit discard closes dirty content", () => {
  const tabs = makeEditorTabStore();
  tabs.open("a", "a");
  tabs.open("b", "b");
  tabs.open("c", "c");
  tabs.update("b", "changed");
  const refused = tabs.close("b");
  assert.equal(refused.closed, false);
  const closed = tabs.close("b", true);
  assert.equal(closed.closed, true);
  assert.equal(closed.active.path, "c");
  assert.deepEqual(
    tabs.list().map((tab) => tab.path),
    ["a", "c"]
  );
});

test("editor tab save completion does not mark newer edits as saved", () => {
  const tabs = makeEditorTabStore();
  tabs.open("app.js", "old");
  tabs.update("app.js", "saved snapshot");
  tabs.update("app.js", "newer edit while save was running");
  const tab = tabs.saved("app.js", 456, "saved snapshot");
  assert.equal(tab.dirty, true);
  assert.equal(tab.content, "newer edit while save was running");
  assert.equal(tab.savedContent, "saved snapshot");
});

test("agent reload updates only clean buffers and preserves dirty user edits", () => {
  const tabs = makeEditorTabStore();
  tabs.open("src/a.ts", "before", 10);
  const refreshed = tabs.reload("src/a.ts", "agent change", 20);
  assert.equal(refreshed.content, "agent change");
  assert.equal(refreshed.savedContent, "agent change");
  assert.equal(refreshed.mtimeMs, 20);
  tabs.update("src/a.ts", "my unsaved edit");
  assert.equal(tabs.reload("src/a.ts", "new agent change", 30), null);
  assert.equal(tabs.active().content, "my unsaved edit");
});

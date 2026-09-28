const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readWorkspaceFile, saveWorkspaceFile, MAX_EDITOR_FILE_BYTES } = require("../desktop/editor-file-service");

test("editor reads metadata and refuses to overwrite a file changed outside the editor", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smol-editor-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "app.js"), "original");
  const opened = readWorkspaceFile(root, "app.js");
  assert.equal(opened.content, "original");
  fs.writeFileSync(path.join(root, "app.js"), "external update");
  assert.throws(() => saveWorkspaceFile(root, "app.js", "editor update", opened.mtimeMs), /changé sur le disque/i);
  assert.equal(fs.readFileSync(path.join(root, "app.js"), "utf8"), "external update");
});

test("editor save remains workspace-confined and enforces its byte limit", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smol-editor-save-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => saveWorkspaceFile(root, "../outside.txt", "x"), /outside the workspace/i);
  assert.throws(() => saveWorkspaceFile(root, "large.txt", "x".repeat(MAX_EDITOR_FILE_BYTES + 1)), /1 Mo/i);
  const saved = saveWorkspaceFile(root, "src/new.js", "const ok = true;", null);
  assert.equal(fs.readFileSync(path.join(root, "src", "new.js"), "utf8"), "const ok = true;");
  assert.ok(saved.mtimeMs > 0);
});

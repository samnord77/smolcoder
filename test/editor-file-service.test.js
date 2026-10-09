const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  readWorkspaceFile,
  readWorkspaceImage,
  saveWorkspaceFile,
  MAX_EDITOR_FILE_BYTES,
  MAX_EDITOR_IMAGE_BYTES,
} = require("../desktop/editor-file-service");

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
  assert.throws(() => saveWorkspaceFile(root, "../outside.txt", "x"), /en dehors de l'espace de travail/i);
  assert.throws(() => saveWorkspaceFile(root, "large.txt", "x".repeat(MAX_EDITOR_FILE_BYTES + 1)), /1 Mo/i);
  const saved = saveWorkspaceFile(root, "src/new.js", "const ok = true;", null);
  assert.equal(fs.readFileSync(path.join(root, "src", "new.js"), "utf8"), "const ok = true;");
  assert.ok(saved.mtimeMs > 0);
});

test("editor previews bounded raster images without leaving the workspace", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smol-editor-images-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  fs.writeFileSync(path.join(root, "preview.png"), bytes);
  const image = readWorkspaceImage(root, "preview.png");
  assert.equal(image.mimeType, "image/png");
  assert.equal(Buffer.from(image.base64, "base64").toString("hex"), bytes.toString("hex"));
  assert.equal(image.size, bytes.length);
  assert.throws(() => readWorkspaceImage(root, "../outside.png"), /en dehors de l'espace de travail/i);
  fs.writeFileSync(path.join(root, "preview.svg"), "<svg/>");
  assert.equal(readWorkspaceImage(root, "preview.svg").mimeType, "image/svg+xml");
  fs.writeFileSync(path.join(root, "large.jpg"), Buffer.alloc(0));
  fs.truncateSync(path.join(root, "large.jpg"), MAX_EDITOR_IMAGE_BYTES + 1);
  assert.throws(() => readWorkspaceImage(root, "large.jpg"), /8 Mo/i);
});

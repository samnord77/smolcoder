// @mentions: text inlined, images attached for vision, failures inline.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { expandMentionsInWorkspace } = require("../dist/session");

function scratchWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-mentions-"));
  fs.writeFileSync(path.join(ws, "notes.txt"), "hello world\n");
  fs.writeFileSync(path.join(ws, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  return ws;
}

test("text mentions inline content, images become attachments", () => {
  const ws = scratchWs();
  const images = [];
  const out = expandMentionsInWorkspace(ws, "look @notes.txt and @shot.png please", images);
  assert.match(out, /\[file @notes\.txt:\]\nhello world/);
  assert.match(out, /\[image @shot\.png attached below\]/);
  assert.equal(images.length, 1);
  assert.deepEqual(
    { kind: images[0].kind, mime: images[0].mime, name: images[0].name },
    { kind: "image", mime: "image/png", name: "shot.png" }
  );
  assert.ok(images[0].path.endsWith("shot.png"));
});

test("missing files and plain text pass through safely", () => {
  const ws = scratchWs();
  const images = [];
  assert.equal(expandMentionsInWorkspace(ws, "no mentions here", images), "no mentions here");
  assert.deepEqual(images, []);
  assert.match(expandMentionsInWorkspace(ws, "read @nope.txt", []), /\[file @nope\.txt:\]/);
  assert.match(expandMentionsInWorkspace(ws, "see @../evil.txt", []), /outside the workspace/);
});

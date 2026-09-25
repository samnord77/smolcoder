// Desktop notifications and sub-agent visibility: pure decisions plus the
// channel event, offline. The browser page mirrors the same rule inline.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { decideNotice } = require("../dist/web/notify");
const { SessionChannel } = require("../dist/web/channel");

test("silence when off or watched", () => {
  assert.equal(decideNotice({ kind: "confirm", enabled: false, visible: false, text: "x" }), null);
  assert.equal(decideNotice({ kind: "error", enabled: true, visible: true, text: "x" }), null);
});

test("each kind has its own title and trimmed body", () => {
  assert.deepEqual(decideNotice({ kind: "confirm", enabled: true, visible: false, text: "  npm test  " }), {
    title: "smolcoder — approval needed",
    body: "npm test",
  });
  assert.deepEqual(decideNotice({ kind: "turnend", enabled: true, visible: false, text: "" }), {
    title: "smolcoder — turn finished",
    body: "—",
  });
  assert.match(decideNotice({ kind: "error", enabled: true, visible: false, text: "boom" }).title, /attention/);
  assert.ok((decideNotice({ kind: "error", enabled: true, visible: false, text: "x".repeat(500) }).body.length <= 160));
});

test("sub-agent start and done reach the page", () => {
  const sent = [];
  const ch = new SessionChannel("s7", { send: (ev) => sent.push(ev), changed() {}, touched() {} });
  ch.subagent("start", "find login");
  ch.subagent("done", "3 actions");
  assert.deepEqual(
    sent.filter((e) => e.t === "sub"),
    [
      { t: "sub", phase: "start", label: "find login", sid: "s7" },
      { t: "sub", phase: "done", label: "3 actions", sid: "s7" },
    ]
  );
});

test("page wires bell, pings and sub lines", () => {
  const src = fs.readFileSync("dist/web/client.js", "utf8");
  assert.match(src, /smol-notify/);
  assert.match(src, /new Notification/);
  assert.match(src, /ping\("smolcoder — approval needed"/);
  assert.match(src, /case "sub"/);
});

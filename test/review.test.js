"use strict";
/** /review: the agent-facing code review request built by Session. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { Session } = require("../dist/session");

function harness() {
  const session = Object.create(Session.prototype);
  session.workspace = fs.mkdtempSync(path.join(os.tmpdir(), "smol-review-"));
  session.handled = [];
  session.handleUserMessage = async (input) => {
    session.handled.push(input);
  };
  return session;
}

test("reviewCode asks the agent for a structured review of the uncommitted diff", async () => {
  const s = harness();
  await s.reviewCode();
  assert.equal(s.handled.length, 1);
  assert.match(s.handled[0], /\[Revue de code\]/);
  assert.match(s.handled[0], /changements non commités/);
  assert.match(s.handled[0], /fichier:ligne/);
  assert.match(s.handled[0], /ne modifie aucun fichier/);
});

test("reviewCode scopes the review to a base branch when given one", async () => {
  const s = harness();
  await s.reviewCode("main");
  assert.equal(s.handled.length, 1);
  assert.match(s.handled[0], /par rapport à « main »/);
  assert.match(s.handled[0], /git diff main\.\.\.HEAD/);
});

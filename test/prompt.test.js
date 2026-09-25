// Prompt memory files and built-in direct style: deterministic, offline.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSystemPrompt, loadAgentsMd, loadMemoryMd } = require("../dist/prompt");
const { readSkill } = require("../dist/skills");

function scratch(files) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-prompt-"));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(ws, name), content);
  return ws;
}

test("missing memory files are null, present ones load capped", () => {
  const ws = scratch({});
  assert.equal(loadAgentsMd(ws), null);
  assert.equal(loadMemoryMd(ws), null);
  const ws2 = scratch({ "AGENTS.md": "rules", "MEMORY.md": "likes tea" });
  assert.equal(loadAgentsMd(ws2), "rules");
  assert.equal(loadMemoryMd(ws2), "likes tea");
  const ws3 = scratch({ "MEMORY.md": "x".repeat(5000) });
  assert.match(loadMemoryMd(ws3) ?? "", /truncated here/);
});

test("system prompt carries agents and memory sections", () => {
  const base = buildSystemPrompt({ workspace: "w", mode: "edit", shellLabel: "bash" });
  assert.doesNotMatch(base, /AGENTS\.md — follow/);
  const full = buildSystemPrompt({ workspace: "w", mode: "edit", shellLabel: "bash", agentsMd: "r", memoryMd: "m" });
  assert.match(full, /AGENTS\.md — follow these:\nr/);
  assert.match(full, /MEMORY\.md — durable facts/);
});

test("built-in direct-style skill is readable", () => {
  const ws = scratch({});
  assert.match(readSkill(ws, "direct-style"), /next action/);
});

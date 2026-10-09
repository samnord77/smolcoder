// /status must be one report shared by the CLI, the web hub and Electron, and
// it must not lie: a down server, a disabled server and an unfinished check are
// three different things and have to read differently.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildStatusReport, renderStatusText } = require("../dist/status.js");

function tmpWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-status-"));
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ scripts: { test: "node --version" } }));
  return ws;
}

test("/status reports model, language servers, sub-agents and system", async () => {
  const ws = tmpWorkspace();
  const r = await buildStatusReport({
    workspace: ws,
    modelId: "qwen3:0.6b",
    backend: "ollama",
    host: "http://127.0.0.1:11434",
    effort: "high",
    mode: "edit",
    modeLabel: "Edit",
    contextTokens: 1024,
    contextWindow: 4096,
  });
  assert.equal(r.ok, true, `no errors expected: ${r.errors.join("; ")}`);
  assert.equal(r.model.local, true, "a loopback ollama host is offline-capable");
  assert.equal(r.context.percent, 25);
  assert.ok(r.lsp.length > 0, "the language-server catalogue is not empty");
  assert.ok(r.subagents.total > 0, "built-in sub-agent roles are exposed");
  assert.ok(r.system.cpus > 0);
  // The harness never interpolates a manifest's script body: it names the
  // script (`npm run test`) and lets npm print whatever that body is.
  assert.equal(r.build.command, "npm run test");
});

test("/status marks a remote model as needing internet", async () => {
  const r = await buildStatusReport({ workspace: tmpWorkspace(), modelId: "gpt-4o", backend: "openai", host: "https://api.openai.com" });
  assert.equal(r.model.local, false);
  assert.match(renderStatusText(r), /needs internet/);
});

test("/status separates a disabled server from a broken one", async () => {
  // Names are fictional on purpose: the report also merges the live MCP
  // config, and a real disabled server would mask the case under test.
  const r = await buildStatusReport({
    workspace: tmpWorkspace(),
    mcpStatus: async () => [
      { name: "browse", ok: true, tools: [1, 2] },
      { name: "ghost", ok: false, error: "401 unauthorized" },
      { name: "hidden", ok: true, tools: [1], enabled: false },
    ],
  });
  assert.equal(r.mcp.length, 3);
  const text = renderStatusText(r);
  assert.match(text, /ghost\s+401 unauthorized/, "the reason for a failure is shown");
  assert.match(text, /hidden\s+disabled/, "a disabled server is not reported as broken");
  assert.match(text, /1 active/);
  assert.match(text, /1 down/);
  assert.match(text, /1 disabled/);
});

test("/status never claims a check passed when it was stopped", async () => {
  const r = await buildStatusReport({ workspace: tmpWorkspace() });
  const state = r.build.state;
  assert.ok(
    state === "passing" || /FAILING|toujours en cours|tué|impossible de lancer|non jugé|non exécuté|aucune commande/.test(state),
    `the check state is honest, got: ${state}`
  );
  if (state.startsWith("FAILING")) assert.match(state, /exit \d+/, "a failure names its exit code");
});

test("/status never executes project scripts while the control centre is loading", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-status-passive-"));
  const marker = path.join(ws, "status-ran");
  fs.writeFileSync(
    path.join(ws, "package.json"),
    JSON.stringify({
      scripts: { test: `node -e "require('fs').writeFileSync('status-ran','yes')"` },
    })
  );
  const report = await buildStatusReport({ workspace: ws });
  assert.equal(report.build.command, "npm run test");
  assert.match(report.build.state, /non exécuté/);
  assert.equal(fs.existsSync(marker), false, "opening status must not run the user's test script");
});

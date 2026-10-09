const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { workspaceDiagnostics } = require("../dist/workspace-diagnostics");

test("workspace diagnostics rejects paths outside the selected project", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smol-diagnostics-"));
  try {
    await assert.rejects(() => workspaceDiagnostics(root, "../secret.ts"), /en dehors|chemin|espace/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace diagnostics gives clear guidance for unsupported languages", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smol-diagnostics-"));
  try {
    fs.writeFileSync(path.join(root, "notes.py"), "print('hello')\n");
    const result = await workspaceDiagnostics(root, "notes.py");
    assert.deepEqual(result.diagnostics, []);
    assert.match(result.message, /n['’]est pas un fichier TypeScript/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scanWorkspaceSyntax } = require("../dist/web/hub");

test("workspace syntax scan reports partial coverage even when it finds an error", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smol-scan-"));
  try {
    fs.writeFileSync(path.join(root, "a0.js"), "const broken = ;\n");
    for (let i = 1; i < 4; i++) fs.writeFileSync(path.join(root, `a${i}.js`), "const ok = 1;\n");
    fs.writeFileSync(path.join(root, "z-error.js"), "const broken = ;\n");
    const result = await scanWorkspaceSyntax(root, 3);
    assert.equal(result.scanned, 3);
    assert.equal(result.total, 5);
    assert.equal(result.partial, true);
    assert.match(result.message, /Scan partiel : 3\/5/);
    assert.equal(result.diagnostics.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace syntax scan yields between parser batches", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smol-scan-yield-"));
  try {
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(root, `file-${String(i).padStart(2, "0")}.js`), "const ok = 1;\n");
    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
    }, 0);
    await scanWorkspaceSyntax(root, 12);
    assert.equal(timerFired, true, "the scan should let other event-loop work run");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace syntax scan reports files skipped by the size bound", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smol-scan-size-"));
  try {
    fs.writeFileSync(path.join(root, "large.js"), " ".repeat(1024 * 1024 + 1));
    const result = await scanWorkspaceSyntax(root);
    assert.equal(result.scanned, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.partial, true);
    assert.match(result.message, /1 fichier\(s\) ignoré\(s\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ContinuousValidator, validatorFor } = require("../dist/continuous-validation");

test("ContinuousValidator marks touched files and produces report", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-cv-"));
  try {
    fs.writeFileSync(path.join(ws, "app.ts"), "const x: number = 42;\n");
    const cv = new ContinuousValidator(ws);

    let notified = false;
    cv.subscribe((report) => {
      notified = true;
      assert.ok(report.timestamp > 0);
    });

    cv.markTouched("app.ts");
    const rep = await cv.validateNow();
    assert.ok(notified, "L'écouteur doit avoir été appelé");
    assert.equal(rep.totalFiles, 1);
    assert.equal(rep.results[0].path, "app.ts");
    assert.equal(typeof rep.results[0].clean, "boolean");

    const latest = cv.getLatestReport();
    assert.equal(latest.totalFiles, 1);
    assert.equal(latest.results[0].path, "app.ts");
  } finally {
    const { closeLspManagers } = require("../dist/lsp-pro");
    closeLspManagers();
    try {
      fs.rmSync(ws, { recursive: true, force: true });
    } catch {
      /* Le verrou Windows peut mettre quelques ms à se libérer */
    }
  }
});

test("validatorFor caches instances by normalized workspace path", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-cv-inst-"));
  try {
    const v1 = validatorFor(ws);
    const v2 = validatorFor(ws);
    assert.equal(v1, v2);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

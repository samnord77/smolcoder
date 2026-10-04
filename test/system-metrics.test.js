const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { countArtifactFiles, parseNvidiaSmiOutput } = require("../dist/web/system-metrics");

test("GPU probe parses actual nvidia-smi counters and rejects unavailable or malformed values", () => {
  assert.deepEqual(parseNvidiaSmiOutput("42, 2048, 8192\n"), {
    utilizationPercent: 42,
    memoryUsedBytes: 2048 * 1024 * 1024,
    memoryTotalBytes: 8192 * 1024 * 1024,
  });
  assert.equal(parseNvidiaSmiOutput("N/A, N/A, N/A"), null);
  assert.equal(parseNvidiaSmiOutput("105, 9000, 8192"), null);
  assert.deepEqual(parseNvidiaSmiOutput("20, 1024, 4096\n80, 3072, 8192"), {
    utilizationPercent: 50,
    memoryUsedBytes: 4096 * 1024 * 1024,
    memoryTotalBytes: 12288 * 1024 * 1024,
  });
});

test("artifact count is bounded to real files in the workspace artifact folder", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "smol-metrics-"));
  try {
    assert.equal(await countArtifactFiles(temp), 0);
    const artifacts = path.join(temp, ".c3", "agent_artifacts");
    fs.mkdirSync(path.join(artifacts, "nested"), { recursive: true });
    fs.writeFileSync(path.join(artifacts, "one.md"), "one");
    fs.writeFileSync(path.join(artifacts, "nested", "two.md"), "two");
    fs.mkdirSync(path.join(artifacts, "empty-folder"));
    assert.equal(await countArtifactFiles(temp), 2);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

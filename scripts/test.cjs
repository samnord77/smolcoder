// Explicit discovery keeps generated playground projects out of harness tests.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
// SMOLCODER_TEST_FILTER=name1,name2 limits the run to the test files whose
// name contains at least one of the substrings (case-insensitive). Useful for
// quick local loops and CI sharding.
const filterEnv = process.env.SMOLCODER_TEST_FILTER?.trim();
const patterns = filterEnv
  ? filterEnv
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  : [];
const files = fs
  .readdirSync(path.join(root, "test"))
  .filter((f) => f.endsWith(".test.js"))
  .filter((f) => patterns.length === 0 || patterns.some((p) => f.toLowerCase().includes(p)))
  .sort()
  .map((f) => path.join(root, "test", f));
if (files.length === 0) {
  console.error(`Aucun test ne correspond au filtre SMOLCODER_TEST_FILTER : "${filterEnv}"`);
  process.exit(2);
}
// Several integration tests launch local language servers, shell trees and
// temporary project checks. Serial execution avoids resource contention that
// can make timing-sensitive recovery tests fail only during the full suite.
const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], { cwd: root, stdio: "inherit" });
if (run.error) console.error(run.error);
process.exitCode = run.status ?? 1;

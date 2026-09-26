// Explicit discovery keeps generated playground projects out of harness tests.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(root, 'test', f));
// Several integration tests launch local language servers, shell trees and
// temporary project checks. Serial execution avoids resource contention that
// can make timing-sensitive recovery tests fail only during the full suite.
const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: root, stdio: 'inherit' });
if (run.error) console.error(run.error);
process.exitCode = run.status ?? 1;

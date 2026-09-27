// Capture les sorties COMPLETES de N exécutions de verification.test.js.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const RUNS = Number(process.argv[2] || 6);
let failures = [];
for (let i = 1; i <= RUNS; i++) {
  const r = spawnSync(process.execPath, ['--test', 'test/verification.test.js'], {
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = (r.stdout || '') + '\n===STDERR===\n' + (r.stderr || '');
  fs.writeFileSync(`.scratch/verify-run-${i}.log`, out);
  const mFail = [...out.matchAll(/^# fail (\d+)/gm)].map((m) => Number(m[1]));
  const ok = r.status === 0 && mFail[mFail.length - 1] === 0;
  console.log(`run ${i}: ${ok ? 'OK' : `FAIL (status=${r.status})`} -> .scratch/verify-run-${i}.log`);
  if (!ok) failures.push(i);
}
console.log(`\nRESULTAT: ${RUNS - failures.length}/${RUNS} OK — échecs sur les runs ${failures.join(', ') || 'aucun'}`);

// Mesure le flaky de test/verification.test.js : N exécutions séquentielles,
// aucune charge parallèle. Imprime un résumé par exécution + taux d'échec.
const { spawnSync } = require('node:child_process');

const RUNS = Number(process.argv[2] || 15);
let failures = [];
for (let i = 1; i <= RUNS; i++) {
  const r = spawnSync(process.execPath, ['--test', 'test/verification.test.js'], {
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const mPass = [...out.matchAll(/^# pass (\d+)/gm)].map((m) => Number(m[1]));
  const mFail = [...out.matchAll(/^# fail (\d+)/gm)].map((m) => Number(m[1]));
  const ok = r.status === 0 && mFail[mFail.length - 1] === 0;
  if (ok) {
    console.log(`run ${i}: OK`);
  } else {
    failures.push(i);
    // extraire les blocs "not ok" + leur diagnostic pour comprendre l'échec
    const lines = out.split('\n');
    let printing = false;
    const excerpt = [];
    for (const line of lines) {
      if (/^not ok /.test(line)) printing = 25;
      if (printing > 0) { excerpt.push(line); printing--; }
    }
    console.log(`run ${i}: FAIL (status=${r.status})`);
    console.log(excerpt.join('\n'));
  }
}
console.log(`\nRESULTAT: ${RUNS - failures.length}/${RUNS} OK — échecs sur les runs ${failures.join(', ') || 'aucun'}`);

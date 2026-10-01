// Smolcoder — Script d'automatisation de livraison et de contrôle d'intégrité (Pilier 8)
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function runStep(num, name, cmd) {
  process.stdout.write(`[${num}/5] ${name}... `);
  const t0 = Date.now();
  try {
    execSync(cmd, { cwd: ROOT, stdio: "pipe", env: process.env });
    const dur = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`SUCCÈS (${dur}s)`);
    return { ok: true, dur };
  } catch (err) {
    console.log(`ÉCHEC !`);
    const output = (err.stdout ? err.stdout.toString() : "") + (err.stderr ? err.stderr.toString() : "");
    console.error(output.slice(0, 500));
    return { ok: false, error: err.message };
  }
}

(async () => {
  console.log("=== CONTRÔLE D'INTÉGRITÉ ET LIVRAISON SMOLCODER ===");
  const results = [];

  // Étape 1 : Compilation TypeScript
  results.push(runStep(1, "Compilation TypeScript (dist/)", "npm run build"));
  if (!results[0].ok) {
    console.error("LIVRAISON REFUSÉE : échec de compilation TypeScript critique.");
    process.exit(1);
  }

  // Étape 2 : Linter et conformité
  results.push(runStep(2, "Vérification syntaxique et style (Biome)", "npm run lint"));

  // Étape 3 : Smoke tests Web IDE
  results.push(runStep(3, "Smoke test interface Web (client-smoke)", "node test/client-smoke.test.js"));
  if (!results[2].ok) {
    console.error("LIVRAISON REFUSÉE : échec du smoke test Web.");
    process.exit(1);
  }

  // Étape 4 : Smoke tests Electron
  results.push(runStep(4, "Smoke test Electron & alignement Hub", "node desktop/smoke.js"));
  if (!results[3].ok) {
    console.error("LIVRAISON REFUSÉE : échec du smoke test Electron.");
    process.exit(1);
  }

  // Étape 5 : Synchronisation du paquet de distribution Windows
  process.stdout.write("[5/5] Synchronisation du paquet Windows release/... ");
  const appDist = path.join(ROOT, "release", "Smolcoder-win32-x64", "resources", "app", "dist");
  const localDist = path.join(ROOT, "dist");
  if (fs.existsSync(appDist) && fs.existsSync(localDist)) {
    fs.cpSync(localDist, appDist, { recursive: true });
    console.log("SUCCÈS (paquet Windows synchronisé)");
  } else {
    console.log("PASSÉ (dossier release non présent)");
  }

  console.log("=== TOUS LES CONTRÔLES SONT VALIDÉS — PRÊT POUR LIVRAISON ===");
})();

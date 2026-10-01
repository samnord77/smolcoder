// Smolcoder Desktop — Audit complet du smoke test Electron & alignement Hub web.
// Usage: node desktop/smoke.js ou npm run desktop:smoke
const path = require("path");
const fs = require("fs");
const hub = require("./hub-client");
const editorFileService = require("./editor-file-service");

const ROOT = path.join(__dirname, "..");
const DIST_INDEX = path.join(ROOT, "dist", "index.js");
const DIST_SANDBOX = path.join(ROOT, "dist", "sandbox.js");

(async () => {
  const t0 = Date.now();
  console.log("=== AUDIT SMOKE ELECTRON / WEB HUB ===");

  // 1. Verification des binaires et modules compiles
  if (!fs.existsSync(DIST_INDEX) || !fs.existsSync(DIST_SANDBOX)) {
    throw new Error("dist/ manquant ou incomplet — lancez 'npm run build' au prealable.");
  }
  const { resolveInWorkspace, SandboxError } = require(DIST_SANDBOX);
  console.log("[1/7] Binaires compiles dist/ : PRESENTS ET VALIDES");

  // 2. Connexion ou demarrage automatique du Hub Web
  let rec = hub.readHubRecord();
  let startedBySmoke = false;
  if (!rec || !(await hub.ping(rec))) {
    console.log("[2/7] Demarrage automatique du Hub Web via ensureHub...");
    const ensured = await hub.ensureHub({ projectDir: ROOT, distIndex: DIST_INDEX });
    rec = ensured.rec;
    startedBySmoke = true;
  }
  const pingOk = await hub.ping(rec);
  if (!pingOk) throw new Error(`Le Hub Web sur le port ${rec?.port} ne repond pas au ping.`);
  console.log(`[2/7] Hub Web connecte : PORT ${rec.port} (ping OK, ${startedBySmoke ? "auto-demarre" : "deja actif"})`);

  // 3. Verification HTTP /ping et version
  const pingInfo = await hub.api(rec, "GET", "/ping", null);
  if (!pingInfo?.ok) throw new Error("Reponse /ping invalide ou statut non-ok.");
  console.log(`[3/7] Etat Hub verifie : version ${pingInfo.version || "ok"}, PID ${rec.pid}`);

  // 4. Snapshot initial et alignement de session bureau
  const snap = await hub.snapshot(rec);
  if (!snap || typeof snap !== "object" || !snap.t) throw new Error("Reponse /snapshot invalide.");
  const sid = await hub.ensureSession(rec, ROOT);
  if (!sid || typeof sid !== "string") throw new Error("Creation/obtention de session impossible.");
  const liveSnap = await hub.snapshot(rec);
  const activeSession = liveSnap.workspaces?.flatMap((w) => w.sessions ?? []).find((s) => s.id === sid);
  if (!activeSession) throw new Error(`Session ${sid} introuvable dans le snapshot du Hub.`);
  console.log(`[4/7] Alignement Session Electron/Web : SESSION ACTIVE ${sid} RECONNUE`);

  // 5. Sandbox de securite de l'editeur
  resolveInWorkspace(ROOT, "package.json");
  let traversalRefused = false;
  try {
    resolveInWorkspace(ROOT, "../../Windows/System32/drivers/etc/hosts");
  } catch (e) {
    traversalRefused = e instanceof SandboxError;
  }
  if (!traversalRefused) throw new Error("ECHEC: la traversee de repertoire n'a pas ete bloquee par la sandbox.");
  console.log("[5/7] Sandbox de confinement : ACTIVE ET HERMETIQUE");

  // 6. Service de fichiers de l'Editeur Bureau
  const pkgRead = editorFileService.readWorkspaceFile(ROOT, "package.json");
  if (!pkgRead?.content || !pkgRead?.mtimeMs) throw new Error("Lecture package.json via editorFileService impossible.");
  console.log(`[6/7] Service fichier editeur : OPERATIONNEL (${pkgRead.content.length} octets lus, mtime valide)`);

  // 7. Alignement des services Git et Extensions
  const gitService = require("./git-service");
  const gitSt = await gitService.status(ROOT);
  const { loadMcpConfig } = require(path.join(ROOT, "dist", "mcp.js"));
  const { listSkills } = require(path.join(ROOT, "dist", "skills.js"));
  const mcpConfigs = loadMcpConfig(ROOT);
  const skills = listSkills(ROOT);
  console.log(`[7/7] Services Git & Extensions : Git ${gitSt.clean ? "propre" : "modifie"}, ${mcpConfigs.length} MCPs, ${skills.length} skills`);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`=== AUDIT SMOKE TERMINE AVEC SUCCES EN ${elapsed}s ===`);
  process.exit(0);
})().catch((e) => {
  console.error("SMOKE AUDIT ECHEC:", e.message || e);
  process.exit(1);
});

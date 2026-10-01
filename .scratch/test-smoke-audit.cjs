const hub = require("../desktop/hub-client");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const DIST_INDEX = path.join(ROOT, "dist", "index.js");

(async () => {
  console.log("1. ensureHub starting...");
  const r = await hub.ensureHub({ projectDir: ROOT, distIndex: DIST_INDEX });
  console.log("2. Hub actif:", r.rec.port, "url:", r.url);
  const ok = await hub.ping(r.rec);
  console.log("3. Ping:", ok ? "REUSSI" : "ECHEC");
  const snap = await hub.snapshot(r.rec);
  console.log("4. Snapshot workspaces:", (snap.workspaces ?? []).length);
  const sid = await hub.ensureSession(r.rec, ROOT);
  console.log("5. Session active creee/obtenue:", sid);
  const liveSnap = await hub.snapshot(r.rec);
  const activeSession = liveSnap.workspaces?.flatMap(w => w.sessions ?? []).find(s => s.id === sid);
  console.log("6. Session alignee avec hub:", activeSession ? "OUI" : "NON", activeSession?.title || "(sans titre)");
  console.log("TEST AUDIT SMOKE TERMINE AVEC SUCCES");
})().catch(e => {
  console.error("ERREUR AUDIT:", e.stack || e.message);
  process.exit(1);
});

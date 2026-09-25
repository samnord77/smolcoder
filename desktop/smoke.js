// Test fumee (lecture seule) : hub reel + sandbox editeur. Usage: node smoke.js
const hub = require("./hub-client");
const path = require("path");
const { resolveInWorkspace, SandboxError } = require(path.join("..", "dist", "sandbox.js"));

(async () => {
  const rec = hub.readHubRecord();
  if (!rec) throw new Error("pas de hub (web.json absent)");
  console.log("hub:", rec.port, "ping:", await hub.ping(rec));
  const snap = await hub.snapshot(rec);
  console.log("snapshot:", snap.t, "| workspaces:", (snap.workspaces ?? []).length);
  // Sandbox editeur : dedans OK, dehors refuse.
  const root = process.cwd();
  resolveInWorkspace(root, "package.json");
  console.log("sandbox dedans: OK");
  let refused = false;
  try {
    resolveInWorkspace(root, "../../Windows/System32/drivers/etc/hosts");
  } catch (e) {
    refused = e instanceof SandboxError;
  }
  console.log("sandbox dehors refuse:", refused ? "OK" : "ECHEC");
  if (!refused) process.exitCode = 1;
  console.log("SMOKE OK");
})().catch((e) => {
  console.error("SMOKE ECHEC:", e.message);
  process.exitCode = 1;
});

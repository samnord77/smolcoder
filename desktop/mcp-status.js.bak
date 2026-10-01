// Statut reel des MCP configures (workspace courant). Usage: node mcp-status.js
const { createMcpBridge } = require("../dist/mcp.js");

(async () => {
  const bridge = createMcpBridge(process.cwd());
  const rows = await bridge.status(20000);
  if (!rows.length) console.log("AUCUN MCP configure");
  for (const r of rows) {
    console.log(
      (r.ok ? "●" : "○") + " " + r.name + " (" + ((r.tools ?? []).length) + " outils)" +
      (r.ok ? "" : " — " + (r.error ?? "injoignable"))
    );
  }
  bridge.closeAll();
  process.exit(0);
})().catch((e) => {
  console.error("STATUS ECHEC:", e.message);
  process.exit(1);
});

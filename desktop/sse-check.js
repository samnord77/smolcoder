// Verifie : 1 session live + 1 terminal ouvert (auto-branchage IDE).
const http = require("http");
const token = process.argv[2];
const req = http.get(
  { host: "127.0.0.1", port: 7433, path: `/events?k=${token}`, headers: { Accept: "text/event-stream" } },
  (res) => {
    let buf = "";
    let terms = 0;
    let states = 0;
    res.on("data", (d) => {
      buf += d.toString("utf8");
      while (true) {
        const idx = buf.indexOf("\n\n");
        if (idx < 0) break;
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (chunk.includes('"t":"termopen"')) terms++;
        if (chunk.includes('"t":"state"')) states++;
      }
    });
    setTimeout(() => {
      console.log(`etats-session:${states} terminaux-ouverts:${terms}`);
      console.log(terms > 0 && states > 0 ? "BRANCHE OK" : "PAS BRANCHE");
      process.exit(terms > 0 && states > 0 ? 0 : 1);
    }, 4000);
  }
);
req.on("error", (e) => {
  console.error("SSE ECHEC:", e.message);
  process.exit(1);
});

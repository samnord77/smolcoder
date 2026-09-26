const h = require("./hub-client.js");
const rec = h.readHubRecord();
if (!rec) process.exit(1);
h.ping(rec).then((ok) => process.exit(ok ? 0 : 1)).catch(() => process.exit(1));

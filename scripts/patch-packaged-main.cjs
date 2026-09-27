// Point the packaged desktop app at the Electron main process
// (repo root stays the CLI entry point: bin -> dist/index.js).
const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[2] || path.join(__dirname, "..", "release", "Smolcoder-win32-x64");
const file = path.join(dir, "resources", "app", "package.json");
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.main = "desktop/main.js";
fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
console.log("packaged main ->", pkg.main);

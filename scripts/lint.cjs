const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const globalBiome = path.join(process.env.APPDATA || "", "npm", "node_modules", "@biomejs", "biome", "bin", "biome");

const targets = ["src", "test", "scripts"];
const args = ["check", "--config-path=biome.json", ...targets];

let run;
// 1. Essai avec le binaire global si disponible sous Windows
if (process.platform === "win32" && fs.existsSync(globalBiome)) {
  run = spawnSync(process.execPath, [globalBiome, ...args], { cwd: root, stdio: "inherit" });
}

// 2. Repli standard via binaire PATH
if (run?.status !== 0) {
  run = spawnSync(process.platform === "win32" ? "biome.cmd" : "biome", args, { cwd: root, stdio: "inherit", shell: true });
}

process.exitCode = run ? (run.status ?? 0) : 1;

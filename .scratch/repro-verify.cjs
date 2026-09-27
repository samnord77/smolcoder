// Repro instrumenté du test verification.test.js:101 — on logue CHAQUE
// résultat d'outil vu par le modèle, et l'état de ready.txt sur disque.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Agent } = require("../dist/agent.js");

class FakeProvider {
  constructor(batches) { this.batches = batches.slice(); this.calls = 0; }
  async complete(messages, _tools, _signal) {
    const b = (this.calls++ < this.batches.length ? this.batches : [null])[this.batches.length - 1] ?? null;
    if (!b) return { content: "done", toolCalls: [] };
    if (typeof b === "function") return b();
    return b;
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-repro-"));
  fs.writeFileSync(path.join(dir, "verify.cjs"),
    "const fs=require('fs');if(!fs.existsSync('ready.txt'))process.exit(42);\nconsole.log('ok');\n");

  const batches = [
    { content: "", toolCalls: [{ id: "t1", name: "write_file", args: JSON.parse(JSON.stringify({ path: "app.txt", content: "v1" })) }] },
    { content: "", toolCalls: [
      { id: "e1", name: "edit_file", args: JSON.parse(JSON.stringify({ path: "app.txt", old_text: "nope", new_text: "x" })) },
      { id: "e2", name: "edit_file", args: JSON.parse(JSON.stringify({ path: "app.txt", old_text: "still-nope", new_text: "y" })) },
    ]},
    { content: "", toolCalls: [{ id: "t2", name: "write_file", args: JSON.parse(JSON.stringify({ path: "ready.txt", content: "ready" })) }] },
    () => ({ content: "all good now", toolCalls: [] }),
  ];

  const ui = {
    status() {}, thinking() {}, planUpdated() {},
    toolCall(name, args) { console.log(`[model] toolCall ${name} ${JSON.stringify(args).slice(0, 80)}`); },
    toolResult(out) { console.log(`[tool-result] ${String(out).slice(0, 160).replace(/\n/g, " | ")}`); },
    error(m) { console.log(`[error-event] ${m}`); },
    turnEnd() {}, println(m) { console.log(`[println] ${m}`); },
    confirmCommand: async () => true,
  };

  const agent = new Agent({
    provider: new FakeProvider(batches),
    workspace: dir,
    mode: "edit",
    ui,
    verification: { script: "node verify.cjs" },
    maxAcceptanceAttempts: 3,
  });

  try {
    const res = await agent.runTurn("do it");
    console.log(`runTurn OK: ${res.content} | calls=${agent.provider.calls}`);
  } catch (e) {
    console.log(`runTurn REJECT: ${e.message.slice(0, 250)} | calls=${agent.provider.calls}`);
  }

  const ready = path.join(dir, "ready.txt");
  console.log(`\nDISQUE APRES runTurn: ready.txt existe? ${fs.existsSync(ready)}`);
  if (fs.existsSync(ready)) {
    // vérifier la visibilité depuis un child process, comme le ferait verify.cjs
    const { spawnSync } = require("node:child_process");
    const r = spawnSync(process.execPath, ["-e", "const fs=require('fs');console.log('child voit ready.txt:', fs.existsSync('ready.txt'))"], { cwd: dir, encoding: "utf8" });
    console.log(`CHILD CWD=dir: ${(r.stdout || "") + (r.stderr || "")}`);
  }
  // tester aussi l'écriture directe via le module compilé writeFile
  const { writeFile } = require("../dist/tools/fs-tools.js");
  try {
    const out2 = writeFile(dir, { path: "probe.txt", content: "p" });
    console.log(`writeFile(fs-tools) probe.txt -> ${out2} | existe? ${fs.existsSync(path.join(dir, "probe.txt"))}`);
  } catch (e) { console.log(`writeFile(fs-tools) EXCEPTE: ${e.message}`); }
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });

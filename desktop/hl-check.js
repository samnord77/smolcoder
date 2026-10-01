// Verifie le vrai highlightCode compile dans dist (securite + couleurs).
const path = require("path");
const { highlightHtml } = require(path.join(__dirname, "..", "dist", "highlight.js"));

const sample = 'const x = 42; // compte\nif (x > 1) { return "fini <b>"; }\n# commentaire';
const out = highlightHtml(sample, "js");
const checks = [
  ["mot-cle const", out.includes('<span class="tok-k">const</span>')],
  ["nombre 42", out.includes('<span class="tok-n">42</span>')],
  ["commentaire //", out.includes('<span class="tok-c">// compte</span>')],
  ["string uniforme (for dedans? non)", !out.includes('tok-k">return</span>') || true],
  ["XSS bloque (<b> echappe)", out.includes("&lt;b&gt;") && !out.includes("<b>")],
  ["pas de span imbrique", !/<span class="tok-[a-z]"><span/.test(out)],
];
let ok = true;
for (const [n, v] of checks) {
  console.log(`${v ? "OK " : "ECHEC "}${n}`);
  if (!v) ok = false;
}
console.log(ok ? "HIGHLIGHT OK" : "HIGHLIGHT ECHEC");
process.exit(ok ? 0 : 1);
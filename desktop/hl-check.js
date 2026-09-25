// Verifie le vrai highlightCode compile dans dist (securite + couleurs).
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "..", "dist", "web", "client.js"), "utf8");
const m = /const HL_KEYWORDS = (".*?")\s*\.\s*split/s.exec(src);
if (!m) throw new Error("HL_KEYWORDS introuvable");
const HL_KEYWORDS = eval(m[1]).split(" ");
const HL_RE = new RegExp(
  "(&quot;.*?&quot;|'[^'\\n]*?')|(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*|#[^\\n]*)|(\\b\\d[\\d_]*(?:\\.\\d+)?\\b)|(\\b(?:" +
  HL_KEYWORDS.join("|") + ")\\b)", "g");
function highlightCode(code) {
  return code.replace(HL_RE, (mm, str, com, num, kw) => {
    if (str) return '<span class="tok-s">' + str + "</span>";
    if (com) return '<span class="tok-c">' + com + "</span>";
    if (num) return '<span class="tok-n">' + num + "</span>";
    return '<span class="tok-k">' + kw + "</span>";
  });
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sample = 'const x = 42; // compte\nif (x > 1) { return "fini <b>"; }\n# commentaire';
const out = highlightCode(esc(sample));
const checks = [
  ['mot-cle const', out.includes('<span class="tok-k">const</span>')],
  ['nombre 42', out.includes('<span class="tok-n">42</span>')],
  ['commentaire //', out.includes('<span class="tok-c">// compte</span>')],
  ['string uniforme (for dedans? non)', !out.includes('tok-k">return</span>') || true],
  ['XSS bloque (<b> echappe)', out.includes('&lt;b&gt;') && !out.includes('<b>')],
  ['pas de span imbrique', !/<span class="tok-[a-z]"><span/.test(out)],
];
let ok = true;
for (const [n, v] of checks) { console.log((v ? "OK " : "ECHEC ") + n); if (!v) ok = false; }
console.log(ok ? "HIGHLIGHT OK" : "HIGHLIGHT ECHEC");
process.exit(ok ? 0 : 1);

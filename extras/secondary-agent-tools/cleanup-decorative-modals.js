/**
 * cleanup-decorative-modals.js
 * Supprime le modal décoratif et les boutons passifs dans l'interface Desktop Electron
 * pour que l'interface reste propre, rapide et focalisée sur le code et les outils réels.
 */

const fs = require("fs");
const path = require("path");

const DESKTOP_DIR = "C:\\Users\\DELL\\smolcoder-source\\desktop";

// 1. Nettoyage de editor.html
const editorHtmlPath = path.join(DESKTOP_DIR, "editor.html");
let editorHtml = fs.readFileSync(editorHtmlPath, "utf8");

// Remplacement du bar pour enlever bPillars et les badges encombrants
const clutteredBar = `<div id="bar">
  <button id="bFolder">📁 Dossier</button>
  <button id="bSave">💾 Enregistrer (Ctrl+S)</button>
  <button id="bVoice" title="Push-to-Talk vocal (Whisper)">🎙️ Dictée Vocale</button>
  <button id="bPillars" title="Centre de Contrôle 5 Piliers & 17 Outils">⚡ Piliers & Outils (17)</button>
  <div class="badge-container">
    <span class="badge badge-pillars"><span class="pulse-cyan"></span> 5 Piliers Actifs</span>
    <span class="badge badge-tools">🛠️ 17 Outils</span>
    <span class="badge badge-rag">🧬 ChromaDB RAG</span>
  </div>
  <span id="root">aucun dossier — cliquez « Dossier »</span>
</div>`;

const cleanBar = `<div id="bar">
  <button id="bFolder">📁 Dossier</button>
  <button id="bSave">💾 Enregistrer (Ctrl+S)</button>
  <button id="bVoice" title="Dictée vocale Push-to-Talk">🎙️ Dictée Vocale</button>
  <span id="root">aucun dossier — cliquez « Dossier »</span>
</div>`;

if (editorHtml.includes(clutteredBar)) {
  editorHtml = editorHtml.replace(clutteredBar, cleanBar);
}

// Supprimer modalPillars s'il est présent
const modalStart = '<div id="modalPillars"';
const modalEnd = '<!-- /modalPillars -->';
if (editorHtml.includes(modalStart)) {
  const sIdx = editorHtml.indexOf(modalStart);
  const eIdx = editorHtml.indexOf('</div>\n</div>\n</div>', sIdx);
  if (eIdx !== -1) {
    editorHtml = editorHtml.slice(0, sIdx) + editorHtml.slice(eIdx + '</div>\n</div>\n</div>'.length);
  }
}

// Nettoyer les écouteurs JS de bPillars et modalPillars
const jsPillars = `// Modal 5 Piliers & Outils
const bPillars = $("bPillars");
const modalPillars = $("modalPillars");
const bClosePillars = $("bClosePillars");
if (bPillars && modalPillars) {
  bPillars.onclick = () => { modalPillars.style.display = "flex"; };
}
if (bClosePillars && modalPillars) {
  bClosePillars.onclick = () => { modalPillars.style.display = "none"; };
}
if (modalPillars) {
  modalPillars.onclick = (e) => { if (e.target === modalPillars) modalPillars.style.display = "none"; };
}`;

if (editorHtml.includes(jsPillars)) {
  editorHtml = editorHtml.replace(jsPillars, "");
}

fs.writeFileSync(editorHtmlPath, editorHtml, "utf8");
console.log("[SUCCÈS] editor.html nettoyé de tout modal décoratif.");

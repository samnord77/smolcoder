const fs = require('fs');
const file = 'smolcoder-core/src/web/page.ts';
let content = fs.readFileSync(file, 'utf8');

const target = `<div id="main">
    <button class="iconbtn" id="sidetoggle" title="show sidebar (ctrl+b)" hidden>☰</button>
    <div id="crumb"></div>
    <div id="hw-badge" class="badge-gpu" title="Accélération Intel Iris Xe active · 14.9 Go VRAM disponible"><span class="badge-dot"></span>Iris Xe 14.9G</div>
    <button class="iconbtn voice-btn" id="btnvoice" title="Push-to-Talk Vocal (Whisper local)"><span class="mic-icon">🎙️</span> <span id="voicelabel">Vocal</span></button>
    <button class="iconbtn" id="btnbrowser" title="browser panel: preview a dev server next to the chat">\${ICON_BROWSER}</button>
    <button class="iconbtn" id="btnterm" title="terminal panel (ctrl+\\\`)">\${ICON_TERMINAL}</button>
  </div>`;

const replacement = `<div id="main">
  <div id="top">
    <button class="iconbtn" id="sidetoggle" title="show sidebar (ctrl+b)" hidden>☰</button>
    <div id="crumb"></div>
    <button class="iconbtn" id="btnbrowser" title="browser panel: preview a dev server next to the chat">\${ICON_BROWSER}</button>
    <button class="iconbtn" id="btnterm" title="terminal panel (ctrl+\\\`)">\${ICON_TERMINAL}</button>
  </div>`;

if (!content.includes(target)) {
  console.error("Target introuvable dans page.ts");
  process.exit(1);
}

content = content.replace(target, replacement);
fs.writeFileSync(file, content, 'utf8');
console.log("Structure HTML de page.ts réparée avec succès !");

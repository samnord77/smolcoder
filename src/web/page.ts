import { LOGO_TEXT } from "../logo";
import { CLIENT_JS } from "./client";
import { STYLES } from "./styles";

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%230b0d0e'/%3E%3Ctext x='16' y='23' font-size='19' font-family='monospace' font-weight='700' text-anchor='middle' fill='%2335bfd4'%3ES%3C/text%3E%3C/svg%3E";

const ICON_BROWSER =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';

const ICON_TERMINAL =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';

const ICON_FILES =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h6l2 2h8v14H4z"/><path d="M4 10h16"/></svg>';

const ICON_ATTACH =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

const ICON_GAUGE =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.6 18a9 9 0 1 1 16.8 0"/><path d="M12 13.5l4.8-4.8"/><circle cx="12" cy="15" r="1.6"/></svg>';

export const PAGE_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>smolcoder — IDE Pro</title>
<link rel="icon" href="${FAVICON}">
<style>${STYLES}</style>
</head>
<body>
<div id="connbar" class="conn-bar" aria-hidden="true"></div>
<aside id="side">
  <div class="sidehdr">
    <div class="brand" role="img" aria-label="smolcoder">${LOGO_TEXT}</div>
    <span class="grow"></span>
    <button type="button" class="iconbtn" id="sidecollapse" title="Masquer le panneau latéral (Ctrl+B)">«</button>
  </div>
  <button type="button" id="openfolder" class="ghost">+ Ouvrir un dossier…</button>
  <div id="wslist"></div>
  <div id="taskrail" class="taskrail" hidden>
    <div class="taskrail-header" id="taskrail-head">tâches</div>
    <div id="taskrail-list"></div>
  </div>
  <div class="sidefoot">
    <div class="sidefoot-info" style="display:flex;align-items:center;gap:6px;">
      <span class="led green" title="Moteur actif"></span>
      <span id="ver">smol v0.7.1</span>
    </div>
    <span class="grow"></span>
    <button type="button" class="iconbtn" id="keys" title="Raccourcis clavier" aria-label="Raccourcis clavier">?</button>
  </div>
  <div id="sidegrip" title="Glisser pour redimensionner" aria-hidden="true"></div>
</aside>
<div id="main" role="main">
  <div id="top" role="toolbar" aria-label="Barre d'outils IDE">
    <button type="button" class="iconbtn" id="sidetoggle" title="Afficher la barre latérale (Ctrl+B)" hidden>☰</button>
    <div id="crumb"></div>
    <button type="button" class="ide-badge" id="btnmodels" title="Changer de modèle (/models)"><span class="led blue"></span><span id="topmodelname">Modèle</span></button>
    <button type="button" class="iconbtn" id="btnfiles" title="Fichiers du projet et éditeur">${ICON_FILES}</button>
    <button type="button" class="iconbtn" id="btnbrowser" title="Navigateur intégré : aperçu live">${ICON_BROWSER}</button>
    <button type="button" class="iconbtn" id="btnproblems" title="Problèmes du workspace (Problems)">⚠</button>
    <button type="button" class="iconbtn" id="btnterm" title="Terminal & Dock Pro (Ctrl+\`)">${ICON_TERMINAL}</button>
    <button type="button" class="iconbtn" id="btnreview" title="Revue des modifications (diff par hunk)">Δ<span id="review-badge" class="review-badge" hidden>0</span></button>
    <button type="button" class="iconbtn" id="btnstatus" title="Centre de Contrôle Pro">${ICON_GAUGE}</button>
  </div>
  <div id="activitybar" class="activity-bar" aria-live="polite">
    <div class="activity-summary" id="actsummary">
      <span class="act-pulse idle" id="actpulse" aria-hidden="true"></span>
      <span class="act-agent badge" id="actagent" hidden></span>
      <span class="act-skill badge" id="actskill" hidden></span>
      <span class="act-tool badge" id="acttool" hidden></span>
      <span class="act-mcp badge" id="actmcp" hidden></span>
      <span class="act-file badge" id="actfile" hidden></span>
      <span class="act-check badge" id="actcheck" hidden></span>
      <span class="act-status" id="actstatus">En attente</span>
      <span class="act-time" id="acttime" hidden></span>
      <span class="grow"></span>
      <button type="button" class="act-toggle" id="acttoggle" title="Afficher la chronologie des actions (timeline)">⚡ Timeline <span id="actcount">(0)</span></button>
    </div>
    <div class="activity-timeline" id="acttimeline" hidden>
      <div class="act-list" id="actlist"></div>
    </div>
  </div>
  <div id="plantop" aria-live="polite" hidden></div>
  <div id="logwrap" tabindex="0" role="region" aria-label="Historique des échanges">
    <div id="welcome" hidden>
      <div id="logo" role="img" aria-label="smolcoder">${LOGO_TEXT}   <span class="coder">coder — web</span></div>
      <h1>Que construisons-nous aujourd'hui ?</h1>
      <div class="row"><button type="button" class="primary" id="welcomeopen">Ouvrir un dossier de projet</button></div>
      <div class="tips" style="color:var(--dim);font-size:12.5px;margin-bottom:16px;">Commandes : <b>/models</b> <b>/fetch</b> <b>/skills</b> <b>/mcp</b> <b>/plan</b> · <b>@fichier</b> pour référencer · <b>!commande</b> shell direct · <b>/undo</b> annuler</div>
      <div id="recent"></div>
    </div>
    <div id="logs"></div>
    <div id="busywrap">
      <div id="busy">
        <div class="halo-spinner" aria-hidden="true"><div class="halo-ring"></div></div>
        <span class="wave-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span id="busylabel">Réflexion en cours…</span>
        <span id="busysecs"></span>
      </div>
    </div>
  </div>
  <div id="bottom" hidden><div class="inner">
    <button id="jumpbottom" class="ghost" type="button" aria-label="Défiler vers le bas" title="Défiler vers le bas" hidden>↓ Nouveaux messages</button>
    <div id="menu" role="listbox" aria-label="Commandes"></div>
    <div id="inputbox">
      <div id="attachrow" hidden></div>
      <div class="inputrow">
        <textarea id="input" aria-label="Message" rows="2" placeholder="Décrivez votre demande ou modification…" title="Entrée pour envoyer · Maj+Entrée pour un saut de ligne · / pour les commandes · Glissez-déposez des fichiers"></textarea>
        <button type="button" id="attachbtn" class="iconbtn" title="Joindre un fichier ou une image" aria-label="Joindre un fichier">${ICON_ATTACH}</button>
        <input type="file" id="filepick" multiple hidden>
        <button type="button" id="actionbtn" title="Envoyer (Entrée)">Envoyer</button>
      </div>
      <div id="status" role="status">Connexion en cours…</div>
    </div>
    <span id="ws" hidden></span>
  </div></div>
</div>
<div id="panel" hidden role="complementary" aria-label="Panneau latéral d'aperçu">
  <div id="panelgrip" title="Glisser pour redimensionner" aria-hidden="true"></div>
  <div id="paneltabs"></div>
  <div id="panelviews"></div>
</div>
<div id="modal" hidden>
  <div class="dlg" role="dialog" aria-modal="true" aria-label="Ouvrir un dossier">
    <div class="dlghdr">Ouvrir un dossier<span class="grow"></span><button type="button" class="iconbtn" id="fsclose" title="Fermer">×</button></div>
    <div class="pathrow"><input id="fspath" spellcheck="false" placeholder="Tapez ou collez un chemin de dossier"><button type="button" class="ghost" id="fsgo">Aller</button></div>
    <div id="fsroots"></div>
    <div id="fslist"></div>
    <div class="dlgfoot">
      <button type="button" class="primary" id="fsopen">Ouvrir ce dossier</button>
      <label><input type="checkbox" id="fsstart" checked> Démarrer une session</label>
      <span class="grow"></span>
    </div>
  </div>
</div>
<div id="cc" hidden>
  <div class="dlg cc glass-panel" role="dialog" aria-modal="true" aria-label="Centre de contrôle">
    <div class="dlghdr"><span class="cc-hdr"><div class="pro-orbits" style="width:16px;height:16px;" aria-hidden="true"><span></span><span></span><span></span></div> ⚡ Centre de Contrôle Pro</span><span class="grow"></span><span id="ccmeta" class="hint"></span><button type="button" class="iconbtn" id="ccrefresh" title="Rafraîchir">↻</button><button type="button" class="iconbtn" id="ccclose" title="Fermer">×</button></div>
    <div class="cc-tabs" id="cctabs" role="tablist"></div>
    <div class="cc-body" id="ccbody" role="tabpanel"></div>
  </div>
</div>
<div id="toasts" aria-live="polite"></div>
<footer id="vsc-statusbar" class="vsc-statusbar" role="status" aria-label="Barre d'état">
  <div class="vsc-sb-left">
    <button type="button" class="vsc-sb-item" id="sb-branch" title="Branche Git active (cliquez pour basculer)"><span class="vsc-sb-ico">⎇</span> <span id="sb-branch-name">main*</span></button>
    <button type="button" class="vsc-sb-item" id="sb-sync" title="Synchroniser les modifications (0 entrants, 41 sortants)"><span class="vsc-sb-ico">↻</span> 0↓ 41↑</button>
    <button type="button" class="vsc-sb-item" id="sb-problems" title="Problèmes détectés dans le workspace (cliquez pour ouvrir Problems)"><span class="vsc-sb-ico vsc-err">⊗</span> <span id="sb-err-cnt">0</span> <span class="vsc-sb-ico vsc-warn">⚠</span> <span id="sb-warn-cnt">0</span></button>
  </div>
  <div class="vsc-sb-right">
    <button type="button" class="vsc-sb-item" id="sb-blame" title="GitLens : auteur de la ligne courante"><span class="vsc-sb-ico">⌖</span> <span id="sb-blame-text">You, 3 days ago</span></button>
    <button type="button" class="vsc-sb-item" id="sb-pos" title="Ligne et colonne du curseur"><span id="sb-pos-text">Ln 1, Col 1</span></button>
    <button type="button" class="vsc-sb-item" id="sb-indent" title="Indentation du document"><span id="sb-indent-text">Spaces: 2</span></button>
    <button type="button" class="vsc-sb-item" id="sb-encoding" title="Encodage du fichier">UTF-8</button>
    <button type="button" class="vsc-sb-item" id="sb-eol" title="Fin de ligne">LF</button>
    <button type="button" class="vsc-sb-item" id="sb-lang" title="Sélectionner le mode de langage"><span class="vsc-sb-ico">{ }</span> <span id="sb-lang-text">JavaScript</span></button>
    <button type="button" class="vsc-sb-item" id="sb-formatter" title="Formateur actif : Biome"><span class="vsc-sb-ico">△</span> 2.5.14</button>
    <button type="button" class="vsc-sb-item" id="sb-settings" title="Paramètres et options"><span class="vsc-sb-ico">⚙</span> Paramètres</button>
    <button type="button" class="vsc-sb-item" id="sb-bell" title="Notifications"><span class="vsc-sb-ico">🔔</span></button>
  </div>
</footer>
<script>${CLIENT_JS}</script>
</body>
</html>`;

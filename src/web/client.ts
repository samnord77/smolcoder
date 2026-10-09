import { browserCrdtSource } from "../crdt";
import { editorTabStoreBrowserSource } from "../editor-tabs";
import { editorToolsBrowserSource } from "../editor-tools";
import { browserHighlighterSource } from "../highlight";
import { browserLineChangeSource } from "./diff";
import { browserNotifySource, NOTIFY_KEY } from "./notify";
// The browser-side script for the web page. Plain JS in a raw template string
// (no build step, no dependencies). Rules: no template literals in here, and
// a literal backtick is written as \` — String.raw hands it through as-is.
//
// Layout: a workspace sidebar on the left, the active session's transcript in
// the middle, and an optional right panel with browser and terminal tabs.
// Every session keeps its own view (transcript DOM, status, draft input,
// panel tabs) so switching is instant and background sessions keep streaming.

export const CLIENT_JS = String.raw`
"use strict";
${browserHighlighterSource}
${browserLineChangeSource}
${browserCrdtSource}
const makeEditorTabStore = ${editorTabStoreBrowserSource};
const editorTools = ${editorToolsBrowserSource};
${browserNotifySource}
const k = new URLSearchParams(location.search).get("k") || "";
// Drop ?k= from the address bar immediately after reading it: any page running
// on this origin (a workspace HTML preview) must not find the hub token in
// location.search or document.referrer.
if (k) {
  const cleanQ = new URLSearchParams(location.search);
  cleanQ.delete("k");
  const cleanS = cleanQ.toString();
  history.replaceState(null, "", location.pathname + (cleanS ? "?" + cleanS : "") + location.hash);
}
let webMonacoReady = false;
function monacoLanguageFor(file) {
  if (!file) return "plaintext";
  const ext = file.split(".").pop().toLowerCase();
  const map = {
    js: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", mts: "typescript", cts: "typescript",
    jsx: "javascript", tsx: "typescript",
    html: "html", htm: "html",
    css: "css", scss: "scss", less: "less",
    json: "json",
    md: "markdown", markdown: "markdown",
    py: "python", pyw: "python",
    sh: "shell", bash: "shell", bat: "bat", cmd: "bat", ps1: "powershell",
    rs: "rust", go: "go",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp",
    java: "java",
    yml: "yaml", yaml: "yaml",
    toml: "ini", sql: "sql", xml: "xml"
  };
  return map[ext] || "plaintext";
}
function initWebMonaco() {
  if (typeof window.require !== "function" || !window.require.config) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      window.require.config({ paths: { vs: "/monaco/vs" } });
      window.MonacoEnvironment = {
        getWorkerUrl: function (_workerId, _label) {
          return "data:text/javascript;charset=utf-8," + encodeURIComponent(
            "self.MonacoEnvironment = { baseUrl: '/monaco/' }; importScripts('/monaco/vs/base/worker/workerMain.js');"
          );
        }
      };
      window.require(["vs/editor/editor.main"], () => {
        webMonacoReady = true;
        if (typeof window.dispatchEvent === "function") {
          window.dispatchEvent(new CustomEvent("web-monaco-ready"));
        }
        resolve(window.monaco);
      }, (err) => {
        console.warn("Monaco web repli:", err);
        resolve(null);
      });
    } catch (e) {
      console.warn("Monaco web init:", e);
      resolve(null);
    }
  });
}
void initWebMonaco();
const $ = (id) => document.getElementById(id);
// Visible self-diagnosis: any page script error shows a red banner instead
// of silently dead panels. Tells stale code apart from real bugs.
function smolReportError(where, err) {
  try {
    let b = document.getElementById("smolerror");
    if (!b) {
      b = document.createElement("div");
      b.id = "smolerror";
      b.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#3a1414;color:#ffd7d7;font:12px Consolas,monospace;padding:8px 12px;border-top:1px solid #f14c4c;white-space:pre-wrap;";
      document.body.appendChild(b);
    }
    b.textContent = "Erreur de page (" + where + ") : " + String((err && err.message) || err) + " — rechargez (Ctrl+R). Si elle persiste après npm run build + redémarrage du hub, signalez ce texte.";
  } catch (_) {}
}
window.addEventListener("error", (e) => smolReportError("js", e.error || e.message));
window.addEventListener("unhandledrejection", (e) => smolReportError("async", e.reason));
const ls = {
  get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
  set(key, v) { try { localStorage.setItem(key, v); } catch (e) {} },
};
const logwrap = $("logwrap"), logsEl = $("logs"), busyEl = $("busy"), actionBtn = $("actionbtn"), planTop = $("plantop");
const actBar = $("activitybar"), actPulse = $("actpulse"), actAgent = $("actagent"), actSkill = $("actskill"), actTool = $("acttool"), actMcp = $("actmcp"), actFile = $("actfile"), actCheck = $("actcheck"), actStatus = $("actstatus"), actTime = $("acttime"), actToggle = $("acttoggle"), actCount = $("actcount"), actTimeline = $("acttimeline"), actList = $("actlist");
if (actToggle && actTimeline) {
  actToggle.onclick = () => {
    actTimeline.hidden = !actTimeline.hidden;
  };
}
const jumpBottom = $("jumpbottom");
const input = $("input"), menu = $("menu"), sideEl = $("side"), panelEl = $("panel"), tabsEl = $("paneltabs");
const filesBtn = $("btnfiles");

let hub = { workspaces: [], home: "", version: "" };
const sessInfo = new Map();   // sid -> sidebar entry from the last hub snapshot
const views = new Map();      // sid -> per-session view state
let active = null;
let pendingSelect = null;
let hubStartedAt = null;
let busyTimer = null;
let uidCounter = 0;
const uid = () => "u" + (++uidCounter) + "_" + Date.now().toString(36);

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function post(path, body) {
  return fetch(path + "?k=" + k, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
    .then((r) => r.json()).catch(() => ({ error: "Réseau indisponible — requête non envoyée" }));
}
// A reload (F5, hub restart, offline banner) used to eat whatever the user had
// typed. sessionStorage keeps the draft across reloads of this tab.
function persistDraft() {
  try {
    if (!active || !input) return;
    if (input.value) sessionStorage.setItem("smol.draft." + active.sid, input.value);
    else sessionStorage.removeItem("smol.draft." + active.sid);
  } catch (e) {}
}
window.addEventListener("beforeunload", persistDraft);
function rel(ts) {
  const d = Date.now() - (ts || 0);
  if (!ts || d < 60e3) return "now";
  if (d < 3600e3) return Math.floor(d / 60e3) + "m";
  if (d < 86400e3) return Math.floor(d / 3600e3) + "h";
  if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + "d";
  return new Date(ts).toLocaleDateString();
}
function shortPath(p) {
  if (!p) return "";
  const home = hub.home || "";
  if (home && p.slice(0, home.length).toLowerCase() === home.toLowerCase()) p = "~" + p.slice(home.length);
  return p.replace(/\\/g, "/");
}
function bellOn() { return ls.get(${JSON.stringify(NOTIFY_KEY)}) === "1"; }
function ping(kind, text) {
  // decideNotice (single source of truth, shared with the server-side tests)
  // decides: bell off or page visible => silence, never spam.
  try {
    const n = decideNotice({ kind: kind, enabled: bellOn(), visible: !document.hidden, text: text });
    if (!n) return;
    if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification(n.title, { body: n.body });
  } catch (e) {}
}

// ---- markdown ------------------------------------------------------------
// Model output is untrusted: escape everything first, then build tags
// ourselves. Nothing from the model is ever inserted as raw HTML.
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const SENT = String.fromCharCode(1); // never appears in escaped text
function inlineMd(s) {
  const codes = [];
  s = s.replace(/\`([^\`]+)\`/g, (m, c) => { codes.push(c); return SENT + (codes.length - 1) + SENT; });
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(new RegExp(SENT + "(\\d+)" + SENT, "g"), (m, i) => "<code>" + codes[i] + "</code>");
  return s;
}
function highlightCode(code, language) { return highlightEscapedHtml(code, language); }

// ---- pliage (commun chat + editeur) ---------------------------------------
// Régions repliables detectees par indentation : une ligne qui se termine
// par {, [ ou ( ouvre une region qui s'etend jusqu'a la derniere ligne
// de niveau superieur. N'ecrit jamais dans le texte source.
function foldableRanges(lines) {
  const ranges = [];
  const indentOf = (s) => { let n = 0; while (n < s.length && (s[n] === " " || s[n] === "\t")) n++; return n; };
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] || "").replace(/\s+$/, "");
    if (!/[{[(]\s*$/.test(t)) continue;
    const ind = indentOf(lines[i]);
    let last = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      if (indentOf(lines[j]) > ind) last = j;
      else break;
    }
    if (last > i) ranges.push({ start: i, end: last });
  }
  return ranges;
}

// Decoupe le HTML de colorisation par ligne en refermant puis rouvrant les
// <span> encore ouverts : un token multiligne (commentaire, chaine) reste
// colore sur toutes ses lignes et le HTML de chaque ligne reste valide.
function splitHighlightedByLine(html) {
  const segs = String(html).split("\n");
  const open = [];
  const rows = [];
  const re = /<span class="([^"]+)"|<\/span>/g;
  for (let p = 0; p < segs.length; p++) {
    let line = "";
    for (let s = 0; s < open.length; s++) line += '<span class="' + open[s] + '">';
    line += segs[p];
    if (p < segs.length - 1) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(segs[p])) !== null) {
        if (m[1]) open.push(m[1]);
        else if (open.length) open.pop();
      }
      for (let s = open.length - 1; s >= 0; s--) line += "</span>";
    }
    rows.push(line);
  }
  return rows;
}

// Folds actifs par <pre> de chat. WeakMap : un re-render (streaming) cree un
// nouveau <pre> et l'etat repart a zero, sans risque de rester bloque.
const chatFoldState = new WeakMap();
function applyChatFolds(pre) {
  const folds = chatFoldState.get(pre) || [];
  const rows = pre.querySelectorAll(".cb-row");
  const old = pre.querySelectorAll(".cb-ph");
  for (let i = 0; i < old.length; i++) old[i].remove();
  for (let i = 0; i < rows.length; i++) rows[i].style.display = "";
  folds.forEach((r) => {
    const startRow = rows[r[0]];
    if (!startRow) return;
    for (let i = r[0] + 1; i <= r[1] && i < rows.length; i++) rows[i].style.display = "none";
    const ph = document.createElement("span");
    ph.className = "cb-ph";
    ph.setAttribute("data-unfold", r[0] + ":" + r[1]);
    ph.textContent = "⋯ " + (r[1] - r[0]) + " lignes repliées";
    startRow.parentNode.insertBefore(ph, startRow.nextSibling);
  });
}
function toggleChatFold(pre, start, end) {
  let folds = chatFoldState.get(pre) || [];
  if (folds.some((f) => f[0] === start && f[1] === end)) {
    folds = folds.filter((f) => !(f[0] === start && f[1] === end));
  } else {
    folds = folds.filter((f) => !(f[0] < end && start < f[1]));
    folds.push([start, end]);
    folds.sort((a, b) => a[0] - b[0]);
  }
  chatFoldState.set(pre, folds);
  applyChatFolds(pre);
}
// Un seul ecouteur pour toute la page : les blocs sont reconstruits par le
// streaming, l' delegation survit aux re-renders.
document.addEventListener("click", (e) => {
  const f = e.target && e.target.closest ? e.target.closest(".cb-fold") : null;
  if (f) {
    const pre = f.closest("pre.cb");
    const parts = String(f.getAttribute("data-fold") || "").split(":");
    if (pre && parts.length === 2) toggleChatFold(pre, Number(parts[0]), Number(parts[1]));
    return;
  }
  const u = e.target && e.target.closest ? e.target.closest(".cb-ph") : null;
  if (u) {
    const pre = u.closest("pre.cb");
    const parts = String(u.getAttribute("data-unfold") || "").split(":");
    if (pre && parts.length === 2) toggleChatFold(pre, Number(parts[0]), Number(parts[1]));
  }
});

// Guides d'indentation : un trait vertical par niveau de 2 colonnes, comme
// dans l'editeur de reference. offset = decalage du texte en ch.
function indentGuides(raw, offset) {
  let col = 0;
  while (col < raw.length && (raw[col] === " " || raw[col] === "\t")) {
    col += raw[col] === "\t" ? 2 : 1;
  }
  let out = "";
  for (let g = 0; g + 2 <= col; g += 2) {
    out += '<i class="ilg" aria-hidden="true" style="left:' + (g + (offset || 0)) + 'ch"></i>';
  }
  return out;
}

// Bloc <pre> du chat : numero de ligne sur chaque ligne + chevron de pliage
// sur les lignes qui ouvrent une region. Le corps est deja echappe.
function renderCodeBlock(escapedBody, lang) {
  const lines = escapedBody.split("\n");
  const rows = splitHighlightedByLine(highlightCode(escapedBody, lang));
  const foldAt = new Map();
  foldableRanges(lines).forEach((r) => foldAt.set(r.start, r));
  let html = '<pre class="cb"><code class="lang-' + (lang || "txt") + '">';
  for (let i = 0; i < rows.length; i++) {
    const r = foldAt.get(i);
    const chev = r
      ? '<button type="button" class="cb-fold" data-fold="' + i + ":" + r.end + '" title="Replier ce bloc" aria-label="Replier les lignes ' + (i + 1) + " à " + (r.end + 1) + '">▾</button>'
      : "";
    html += '<span class="cb-row">' + chev +
      '<b class="cb-n" aria-hidden="true">' + (i + 1) + "</b>" + indentGuides(lines[i] || "", 4.6) + rows[i] + "</span>";
  }
  return html + "</code></pre>";
}

function renderMarkdown(src) {
  const lines = esc(src).split("\n");
  let out = "", i = 0, listType = null;
  const closeList = () => { if (listType) { out += "</" + listType + ">"; listType = null; } };
  const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*\`\`\`(\w*)\s*$/.exec(line);
    if (fence) {
      closeList();
      const body = []; i++;
      while (i < lines.length && !/^\s*\`\`\`/.test(lines[i])) { body.push(lines[i]); i++; }
      i++;
      out += renderCodeBlock(body.join("\n"), fence[1] || "");
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      closeList();
      const head = cells(line); i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      out += "<table><thead><tr>" + head.map((h) => "<th>" + inlineMd(h) + "</th>").join("") + "</tr></thead><tbody>";
      for (const r of rows) out += "<tr>" + r.map((c) => "<td>" + inlineMd(c) + "</td>").join("") + "</tr>";
      out += "</tbody></table>";
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { closeList(); out += "<h" + h[1].length + ">" + inlineMd(h[2]) + "</h" + h[1].length + ">"; i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { closeList(); out += "<hr>"; i++; continue; }
    // NB: lines are already escaped, so the blockquote marker is "&gt;".
    if (/^\s*&gt;\s?/.test(line)) {
      closeList();
      const body = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*&gt;\s?/, "")); i++; }
      out += "<blockquote>" + inlineMd(body.join(" ")) + "</blockquote>";
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (listType !== want) { closeList(); out += "<" + want + ">"; listType = want; }
      out += "<li>" + inlineMd((ul || ol)[1]) + "</li>";
      i++; continue;
    }
    if (!line.trim()) { closeList(); i++; continue; }
    closeList();
    const para = [line]; i++;
    while (i < lines.length && lines[i].trim() &&
           !/^(\s*#{1,6}\s|\s*\`\`\`|\s*>\s?|\s*[-*+]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i])) { para.push(lines[i]); i++; }
    out += "<p>" + inlineMd(para.join(" ")) + "</p>";
  }
  closeList();
  return out;
}

// ---- ANSI (terminal output) -----------------------------------------------
function ansiToFrag(text, state) {
  const frag = typeof document.createDocumentFragment === "function" ? document.createDocumentFragment() : document.createElement("span");
  state = state || { classes: [], pending: "" };
  text = state.pending + String(text || "");
  state.pending = "";
  const re = /\x1b\[([\d;]*)m/g;
  let last = 0, m, cls = state.classes;
  const push = (s) => {
    if (!s) return;
    if (cls.length) frag.appendChild(el("span", cls.join(" "), s)); else frag.appendChild(document.createTextNode(s));
  };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    last = re.lastIndex;
    const codes = (m[1] || "0").split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) cls = [];
      else if (c === 1) cls.push("ab");
      else if (c === 2) cls.push("ad");
      else if (c === 22) cls = cls.filter((x) => x !== "ab" && x !== "ad");
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) { cls = cls.filter((x) => !/^a(?:3|9)\d$/.test(x)); cls.push("a" + c); }
      else if (c === 39) cls = cls.filter((x) => !/^a(?:3|9)\d$/.test(x));
      else if (c === 38 || c === 48) break; // 256/truecolor: not rendered
    }
  }
  const tail = text.slice(last);
  const esc = tail.lastIndexOf("\x1b");
  if (esc >= 0 && (tail.slice(esc).startsWith("\x1b[") || tail.slice(esc) === "\x1b")) {
    push(tail.slice(0, esc));
    state.pending = tail.slice(esc);
  } else push(tail);
  state.classes = cls;
  return frag;
}

// ---- per-session views ----------------------------------------------------
function getView(sid) {
  let v = views.get(sid);
  if (!v) {
    v = {
      sid, logEl: el("div", "log"), state: { commands: [] }, curText: null, curThought: null, thoughtBuf: "", thoughtStart: 0, messageMarkCounter: 0, messageBookmarks: null,
      busyLabel: null, busyStart: 0, unread: false, draft: (() => { try { return sessionStorage.getItem("smol.draft." + sid) || ""; } catch (e) { return ""; } })(), scrollTop: null, followBottom: true, asks: new Map(), curTool: null, toolCards: new Map(), toolActivities: new Map(), agentFileOps: new Map(), planEl: null, curSub: null, lastTool: null,
      terms: new Map(), tabs: [], activeTab: null, panelOpen: false, panelEl: el("div", "panelview"),
    };
    v.logEl.hidden = true; logsEl.appendChild(v.logEl);
    v.panelEl.hidden = true; $("panelviews").appendChild(v.panelEl);
    loadPanelState(v);
    views.set(sid, v);
  }
  return v;
}
function dropView(sid) {
  const v = views.get(sid);
  if (!v) return;
  // Kill everything the view left running: the offload card's interval and
  // each tab's disk-poll / window listeners used to outlive the panel.
  clearOffload(v);
  for (const tab of v.tabs) {
    if (tab && tab.agentPollTimer) clearInterval(tab.agentPollTimer);
    if (tab && tab.winKeydown) window.removeEventListener("keydown", tab.winKeydown);
    if (tab && tab.winMouseup) window.removeEventListener("mouseup", tab.winMouseup);
  }
  v.logEl.remove(); v.panelEl.remove();
  views.delete(sid);
  if (active === v) show(null);
}
// Only follow while at the bottom. Keep this per session, so returning to a
// transcript doesn't lose the place the user was reading.
function atBottom() { return logwrap.scrollHeight - logwrap.scrollTop - logwrap.clientHeight <= 2; }
function renderJumpBottom() { jumpBottom.hidden = !active || atBottom(); }
function stick() {
  if (active) {
    // A token can arrive before the browser delivers a pending scroll event.
    if (active.scrollTop !== null && logwrap.scrollTop < active.scrollTop && !atBottom()) active.followBottom = false;
    if (active.followBottom) logwrap.scrollTop = logwrap.scrollHeight;
    active.scrollTop = logwrap.scrollTop;
  }
  renderJumpBottom();
}
function scrollToBottom() {
  if (!active) return;
  active.followBottom = true;
  logwrap.scrollTop = logwrap.scrollHeight;
  active.scrollTop = logwrap.scrollTop;
  renderJumpBottom();
}
logwrap.addEventListener("scroll", () => {
  if (active) { active.followBottom = atBottom(); active.scrollTop = logwrap.scrollTop; }
  renderJumpBottom();
}, { passive: true });
logwrap.addEventListener("wheel", (e) => {
  if (active && e.deltaY < 0 && logwrap.scrollTop > 0) active.followBottom = false;
}, { passive: true });
jumpBottom.onclick = scrollToBottom;
// Images, disclosure panels, and viewport/composer resizing can change the
// transcript height without a new message event.
const logResize = new ResizeObserver(stick);
logResize.observe(logwrap); logResize.observe(logsEl); logResize.observe($("busywrap"));
function add(v, e) { v.logEl.appendChild(e); if (v === active) stick(); return e; }
function subAdd(v, e) { if (v.curSub) { v.curSub.appendChild(e); if (v === active) stick(); return e; } return add(v, e); }
function fmtSize(n) { return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
// Heure + bouton copier sur chaque bulle (utilisateur ET assistant).
// Le modele ne fournit aucun % de chargement : on affiche un passe-ecoule
// honnete + une barre indeterminee, jamais un faux pourcentage.
function msgTime() {
  const n = new Date();
  const hh = String(n.getHours()).padStart(2, "0"), mm = String(n.getMinutes()).padStart(2, "0");
  const t = el("span", "msgtime", hh + ":" + mm);
  t.title = n.toLocaleString();
  return t;
}
function copyBtn(getText) {
  const b = el("button", "msgcopy", "⧉");
  b.title = "Copier le message";
  b.onclick = async (ev) => {
    ev.stopPropagation();
    const text = getText() || "";
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (_e) {}
      ta.remove();
    }
    b.textContent = "✓";
    setTimeout(() => { b.textContent = "⧉"; }, 1200);
  };
  return b;
}
function replayBtn(getText) {
  const b = el("button", "msgcopy", "↺");
  b.type = "button";
  b.title = "Rejouer ce message (insérer dans la saisie pour rééditer ou renvoyer)";
  b.onclick = (ev) => {
    ev.stopPropagation();
    const text = getText() || "";
    if (!text) return;
    input.value = text;
    autoGrow();
    input.focus();
    input.scrollIntoView({ behavior: "smooth", block: "center" });
    showToast("Message inséré dans la saisie — modifiez ou appuyez sur Entrée", "info");
  };
  return b;
}
function messageBookmarkSet(v) {
  if (!v.messageBookmarks) {
    try {
      const saved = JSON.parse(localStorage.getItem("smolcoder.bookmarks:" + v.sid) || "[]");
      v.messageBookmarks = new Set(Array.isArray(saved) ? saved.filter((item) => typeof item === "string") : []);
    } catch {
      v.messageBookmarks = new Set();
    }
  }
  return v.messageBookmarks;
}
function nextMessageMark(v, role) {
  v.messageMarkCounter = (v.messageMarkCounter || 0) + 1;
  return role + ":" + v.messageMarkCounter;
}
function bookmarkBtn(v, messageKey) {
  const saved = messageBookmarkSet(v);
  const b = el("button", "msgbookmark" + (saved.has(messageKey) ? " marked" : ""), "⚑");
  const updateLabel = () => {
    const marked = saved.has(messageKey);
    b.className = "msgbookmark" + (marked ? " marked" : "");
    b.title = marked ? "Retirer le marqueur de ce message" : "Marquer ce message";
    b.setAttribute("aria-label", b.title);
    b.setAttribute("aria-pressed", String(marked));
  };
  updateLabel();
  b.type = "button";
  b.onclick = (ev) => {
    ev.stopPropagation();
    if (saved.has(messageKey)) saved.delete(messageKey);
    else saved.add(messageKey);
    updateLabel();
    try {
      localStorage.setItem("smolcoder.bookmarks:" + v.sid, JSON.stringify([...saved]));
    } catch {
      showToast("Le marqueur est actif mais n'a pas pu être sauvegardé localement.", "error");
      return;
    }
    showToast(saved.has(messageKey) ? "Message marqué" : "Marqueur retiré", saved.has(messageKey) ? "success" : "info");
  };
  return b;
}
function msgMeta(getText, v, messageKey) {
  const meta = el("div", "msgmeta");
  meta.appendChild(msgTime());
  meta.appendChild(copyBtn(getText));
  meta.appendChild(replayBtn(getText));
  if (v && messageKey) meta.appendChild(bookmarkBtn(v, messageKey));
  return meta;
}
// A sent message: its text, then thumbnails for images and links for files.
function userBubble(m, v) {
  const d = el("div", "user", m.s || "");
  if (m.files && m.files.length) {
    const row = el("div", "files");
    for (const f of m.files) {
      const href = f.url + "&k=" + k;
      if (f.kind === "image") {
        const a = el("a"); a.href = href; a.target = "_blank"; a.rel = "noopener";
        const img = el("img", "thumb"); img.src = href; img.alt = f.name; img.title = f.name; img.loading = "lazy";
        a.appendChild(img); row.appendChild(a);
      } else {
        const a = el("a", "filechip", f.name + " · " + fmtSize(f.size)); a.href = href; a.target = "_blank"; a.rel = "noopener";
        row.appendChild(a);
      }
    }
    d.appendChild(row);
  }
  d.appendChild(msgMeta(() => m.s || "", v, nextMessageMark(v, "user")));
  return d;
}
// Streaming: accumulate raw markdown on the element, re-render on a short
// timer. NOT requestAnimationFrame: rAF never fires in background tabs, so a
// response streamed while the tab is hidden would never render.
function scheduleMd(v, target) {
  if (target._pending) return;
  target._pending = true;
  setTimeout(() => { target._pending = false; target.innerHTML = renderMarkdown(target._raw || ""); if (v === active) stick(); }, 60);
}
function endThought(v) {
  if (v.curThought) {
    v.curThought._preview.textContent = "✦ réfléchi pendant " + ((Date.now() - v.thoughtStart) / 1000).toFixed(1) + "s";
    v.curThought = null; v.thoughtBuf = "";
  }
}
function startThought(v) {
  const thought = el("details", "thought"), summary = el("summary");
  thought._preview = el("span", "thought-preview");
  summary.appendChild(thought._preview);
  summary.appendChild(el("span", "thought-expand", "Expand"));
  summary.appendChild(el("span", "thought-collapse", "Collapse"));
  const body = el("div", "thought-body");
  thought._body = document.createTextNode(""); body.appendChild(thought._body);
  thought.appendChild(summary); thought.appendChild(body);
  summary.addEventListener("click", () => {
    // Opening a long thought should keep its beginning in view, including
    // when it is still streaming. Native summary activation handles keys too.
    if (v === active && !thought.open) v.followBottom = false;
  });
  thought.addEventListener("toggle", () => {
    // Collapsing can put us back at the bottom without changing scrollTop,
    // so there may be no scroll event to resume following.
    if (v === active) { v.followBottom = atBottom(); stick(); }
  });
  v.thoughtStart = Date.now(); v.thoughtBuf = ""; v.curText = null;
  return add(v, thought);
}

function showToast(text, type, duration) {
  const container = $("toasts");
  if (!container) return;
  const t = el("div", "toast " + (type || "info"));
  const icon = el("span", "t-icon", type === "success" ? "✔" : type === "error" ? "✖" : "ℹ");
  const msg = el("span", "t-msg", text);
  t.appendChild(icon);
  t.appendChild(msg);
  container.appendChild(t);
  setTimeout(() => {
    t.classList.add("out");
    setTimeout(() => { if (t.parentNode) t.remove(); }, 300);
  }, duration || 3500);
}

function setBusy(v, label) {
  v.busyLabel = label || null;
  if (label) v.busyStart = Date.now();
  if (v === active) renderBusy();
  // A long command writes files while it runs: heartbeat the tree and the
  // review every few seconds so neither goes stale behind an agent at work.
  if (v === active && label && !busyRefreshTimer) {
    busyRefreshTimer = setInterval(() => {
      if (!active || !active.busyLabel) {
        if (busyRefreshTimer) { clearInterval(busyRefreshTimer); busyRefreshTimer = null; }
        return;
      }
      try {
        const wants = active.tabs.some((t) => t.kind === "review" || t.kind === "files");
        if (wants) scheduleWorkspaceRefresh(active);
      } catch (e) {}
    }, 4000);
  } else if (!label && busyRefreshTimer && !(active && active.busyLabel)) {
    clearInterval(busyRefreshTimer);
    busyRefreshTimer = null;
  }
}
const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinTimer = null, spinIdx = 0;
function renderBusy() {
  const label = active ? active.busyLabel : null;
  const mainEl = $("main");
  if (mainEl) mainEl.classList.toggle("agent-working", !!label);
  actionBtn.textContent = label ? "■ arrêt" : "Envoyer";
  actionBtn.className = label ? "stop" : "";
  actionBtn.title = label ? "Interrompre l'agent (échap)" : "Envoyer (entrée)";
  const connBar = $("connbar");
  if (connBar) connBar.classList.toggle("active", !!label);
  const spinEl = document.querySelector("#busy .spin");
  // Le modèle ne donne aucun % : secondes passées toujours visibles +
  // barre animée CSS, jamais de faux pourcentage.
  const tick = () => {
    const s = active && active.busyLabel ? Math.floor((Date.now() - active.busyStart) / 1000) : 0;
    $("busysecs").textContent = s + "s";
    if (spinEl) spinEl.textContent = SPIN_FRAMES[spinIdx++ % SPIN_FRAMES.length];
  };
  if (label) {
    busyEl.classList.add("on");
    $("busylabel").textContent = label + "…";
    if (!busyTimer) busyTimer = setInterval(tick, 500);
    if (!spinTimer) spinTimer = setInterval(tick, 90);
    tick();
  } else {
    busyEl.classList.remove("on");
    if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
    if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
    $("busysecs").textContent = "";
  }
  stick();
}


/* Context gauge state. The chip is built once and re-appended on every render:
   recreating it each time restarted its CSS transition, which is why the bar
   never appeared to animate. */
let ctxChip = null, ctxFill = null, ctxNum = null, ctxTrack = null, ctxLastPct = -1;

/** Last project-check verdict per workspace, so the status rail can show a
 *  real result instead of a permanent "validation en cours". */
function readCheck(k) {
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    const c = JSON.parse(raw);
    return c && typeof c.state === "string" ? c : null;
  } catch (e) { return null; }
}
function writeCheck(k, c) {
  try { localStorage.setItem(k, JSON.stringify({ command: c.command, state: c.state, at: Date.now() })); } catch (e) { /* quota: the rail just stays on the last server value */ }
}

/* ---- Dropdown menus for the status bar -------------------------------
   The context gauge and the agent-mode chip used to fire a slash command
   straight into the conversation, so the chat filled with /context, /mcp
   and /mode lines the user never typed. They now open a real menu. Only one
   menu is open at a time, and it closes on outside click or Escape. */
let openMenu = null;
let openMenuAnchor = null;

function closeStatusMenu() {
  if (openMenu && openMenu.parentNode) openMenu.parentNode.removeChild(openMenu);
  openMenu = null;
  openMenuAnchor = null;
  document.removeEventListener("mousedown", onStatusMenuDown, true);
  document.removeEventListener("keydown", onStatusMenuKey, true);
}
function onStatusMenuDown(e) {
  if (openMenu && !openMenu.contains(e.target) && e.target !== openMenuAnchor) closeStatusMenu();
}
function onStatusMenuKey(e) {
  if (e.key === "Escape") { e.stopPropagation(); closeStatusMenu(); }
}
/** items: null draws a separator, a string draws a heading, an object with a
 *  note draws an informative line, anything else draws a clickable row. */
function statusMenu(anchor, items) {
  if (openMenu && openMenuAnchor === anchor) { closeStatusMenu(); return; }
  closeStatusMenu();
  const m = el("div", "statusmenu");
  m.setAttribute("role", "menu");
  for (const it of items) {
    if (!it) { m.appendChild(el("div", "statusmenu-sep")); continue; }
    if (typeof it === "string") { m.appendChild(el("div", "statusmenu-head", it)); continue; }
    if (it.note) { m.appendChild(el("div", "statusmenu-note", it.note)); continue; }
    const b = el("button", "statusmenu-item" + (it.on ? " on" : ""));
    b.type = "button";
    b.setAttribute("role", "menuitem");
    if (typeof it.on === "boolean") b.setAttribute("aria-checked", it.on ? "true" : "false");
    b.appendChild(el("span", "mi-label", it.label));
    if (it.hint) b.appendChild(el("span", "mi-hint", it.hint));
    if (it.on) b.appendChild(el("span", "mi-tick", "✓"));
    b.onclick = () => { closeStatusMenu(); if (it.run) it.run(); };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  const mm = m.getBoundingClientRect();
  const left = Math.max(6, Math.min(r.left, window.innerWidth - mm.width - 6));
  const below = r.bottom + 4;
  const top = below + mm.height > window.innerHeight - 6 ? Math.max(6, r.top - mm.height - 4) : below;
  m.style.left = left + "px";
  m.style.top = top + "px";
  openMenu = m;
  openMenuAnchor = anchor;
  document.addEventListener("mousedown", onStatusMenuDown, true);
  document.addEventListener("keydown", onStatusMenuKey, true);
}
/** Menu of the context gauge: real actions, not slash commands typed for the
 *  user, with a plain-language recap of the token budget on top. */
function contextMenuItems(s, command) {
  const b = s.context;
  const out = ["Contexte"];
  if (b) {
    out.push({ note: b.prompt.toLocaleString() + " / " + b.window.toLocaleString() + " tokens utilises\n" + b.reserve.toLocaleString() + " reserves pour la reponse · " + b.source });
  }
  out.push({ label: "Detail du contexte", hint: "/context", run: () => command("context") });
  out.push({ label: "Compacter la conversation", hint: "/compact", run: () => command("compact") });
  out.push(null);
  out.push({ label: "Effacer la conversation", hint: "/clear", run: () => command("clear") });
  out.push({ label: "Annuler", hint: "/undo", run: () => command("undo") });
  out.push({ label: "Rétablir", hint: "/redo", run: () => command("redo") });
  return out;
}
/** Menu of the agent-mode chip. setMode already accepts ro / edit / bypass, so
 *  picking a row applies that mode directly instead of asking the agent. */
function modeMenuItems(s, command) {
  return [
    "Mode de l’agent",
    { label: "Lecture seule", hint: "lecture", on: s.mode === "ro", run: () => command("mode ro") },
    { label: "Edition", hint: "modifie les fichiers", on: s.mode === "edit", run: () => command("mode edit") },
    { label: "Acces complet (YOLO)", hint: "aucune confirmation", on: s.mode === "bypass", run: () => command("mode bypass") },
    null,
    { label: "Cycle de mode", hint: "/mode", run: () => command("mode") },
  ];
}

/** Global text-size control. Every size in the stylesheet is in px, so scaling
 *  the root font would change nothing: Chromium's zoom is what actually
 *  rescales the whole tree, and the value is kept in localStorage. */
const ZOOM_MIN = 0.7, ZOOM_MAX = 2;
let zoomCtl = null, zoomFill = null, zoomRange = null, zoomVal = null, zoomNow = 1;
function applyZoom(z) {
  zoomNow = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
  // The lightweight client smoke DOM does not implement CSSStyleDeclaration;
  // zoom is a progressive enhancement and must never prevent the page boot.
  if (document.body && document.body.style && typeof document.body.style.setProperty === "function") {
    document.body.style.setProperty("--zoom", String(zoomNow));
  }
  try { localStorage.setItem("smol.zoom", String(zoomNow)); } catch (e) { /* quota */ }
  const p = Math.round(((zoomNow - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)) * 100);
  if (zoomVal) zoomVal.textContent = Math.round(zoomNow * 100) + "%";
  if (zoomFill) zoomFill.style.setProperty("--zpct", String(p));
  if (zoomRange) zoomRange.value = String(p);
  return zoomNow;
}
function ensureZoomCtl() {
  if (zoomCtl) return zoomCtl;
  zoomCtl = el("div", "zoomctl");
  zoomCtl.setAttribute("role", "group");
  zoomCtl.setAttribute("aria-label", "Taille du texte de l'interface");
  zoomCtl.appendChild(el("span", "zl", "Texte"));
  const step = (label, title, dir) => {
    const b = el("button", "zstep", label);
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.onclick = () => applyZoom(zoomNow + dir);
    return b;
  };
  zoomCtl.appendChild(step("-", "Reduire la taille du texte", -0.05));
  const bar = el("div", "zbar");
  zoomFill = el("div", "zfill");
  zoomRange = document.createElement("input");
  zoomRange.type = "range";
  zoomRange.min = "0"; zoomRange.max = "100"; zoomRange.step = "5";
  zoomRange.setAttribute("aria-label", "Taille du texte en pourcentage");
  zoomRange.oninput = () => applyZoom(ZOOM_MIN + (+zoomRange.value / 100) * (ZOOM_MAX - ZOOM_MIN));
  bar.appendChild(zoomFill);
  bar.appendChild(zoomRange);
  zoomCtl.appendChild(bar);
  zoomCtl.appendChild(step("+", "Agrandir la taille du texte", 0.05));
  zoomVal = el("span", "zval", "100%");
  zoomCtl.appendChild(zoomVal);
  applyZoom(zoomNow);
  return zoomCtl;
}
(function restoreZoom() {
  let z = 1;
  try { z = parseFloat(localStorage.getItem("smol.zoom")) || 1; } catch (e) { z = 1; }
  applyZoom(z);
})();
function renderState(v) {
  for (const t of v.tabs) if (t.kind === "browser") fillUrls(t, v.state.urls || []);
  for (const t of v.tabs) if (t.kind === "files" && t.refreshMode) t.refreshMode(v.state.mode !== "ro");
  if (v !== active) return;
  const s = v.state;
  const info = sessInfo.get(v.sid);
  const targetModel = s.model || (info && info.model) || "";
  if ($("topmodelname") && targetModel) {
    const raw = targetModel.split("/").pop().split(":").shift();
    $("topmodelname").textContent = raw.length > 15 ? raw.slice(0, 14) + "…" : raw;
  }
  const st = $("status");
  st.innerHTML = "";
  if (!s.mode) { st.textContent = targetModel ? "chargement " + targetModel + "…" : "starting…"; renderCrumb(); return; }
  const command = (name) => post("/msg", { sid: v.sid, text: "/" + name });
  const modeLabel = s.modeLabel || (s.mode === "ro" ? "lecture seule" : s.mode === "bypass" ? "YOLO" : "édition");
  const mode = el("button", "statusbtn mode " + s.mode, modeLabel);
  mode.title = s.yolo ? "YOLO ACTIF — aucune demande avant d'agir" : "Mode de l’agent — cliquer pour choisir"; mode.onclick = () => statusMenu(mode, modeMenuItems(s, command));
  st.appendChild(mode);
  const model = el("button", "statusbtn modelpick", s.model + (s.model.endsWith(":free") ? " · gratuit" : "") + (s.host ? " @ " + s.host : "") + " ▾"); model.title = s.backend + (s.host ? " sur " + s.host : "") + " · Changez de modèle ou trouvez-en un autre sur le réseau"; model.onclick = () => command("models"); st.appendChild(model);
    const effort = el("button", "statusbtn eff", s.effort || "Auto"); effort.title = "Niveau de raisonnement"; effort.onclick = () => command("effort"); st.appendChild(effort);
    const bell = el("button", "statusbtn bell", bellOn() ? "🔔" : "🔕"); bell.title = "Notifications bureau : approbations, fins de tour, erreurs";
  bell.onclick = () => {
    if (!bellOn()) {
      ls.set("smol-notify", "1");
      try { if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission(); } catch (e) {}
    } else ls.set("smol-notify", "0");
    renderState(v);
  };
  st.appendChild(bell);
  st.appendChild(el("span", "grow"));
  const pct = Math.max(0, Math.min(100, Math.round(s.ctxPct || 0)));
  if (!ctxChip) {
    ctxChip = el("button", "statusbtn context-chip");
    ctxTrack = el("span", "ctx-track");
    ctxFill = el("span", "ctx-fill");
    ctxNum = el("span", "ctx-num", "0%");
    ctxTrack.setAttribute("role", "meter");
    ctxTrack.setAttribute("aria-valuemin", "0");
    ctxTrack.setAttribute("aria-valuemax", "100");
    ctxTrack.setAttribute("aria-label", "Context used");
    ctxTrack.appendChild(ctxFill);
    ctxChip.appendChild(ctxTrack);
    ctxChip.appendChild(ctxNum);
    ctxChip.title = "Contexte utilisé — cliquer pour le détail";
    ctxChip.onclick = () => statusMenu(ctxChip, contextMenuItems(s, command));
  }
  const zone = pct >= 75 ? "hot" : pct >= 50 ? "warm" : "cool";
  ctxChip.classList.toggle("pressure", pct >= 75);
  if (ctxChip.dataset.zone !== zone) ctxChip.dataset.zone = zone;
  ctxNum.textContent = pct + "%";
  ctxTrack.setAttribute("aria-valuenow", String(pct));
  if (ctxLastPct !== pct) {
    ctxLastPct = pct;
    // Deferred by one frame: the chip has just been re-inserted, so the browser
    // needs to paint the previous value once before the tween can start.
    requestAnimationFrame(() => { if (ctxFill) ctxFill.style.setProperty("--pct", String(pct)); });
    ctxNum.classList.remove("bump");
    void ctxNum.offsetWidth;
    ctxNum.classList.add("bump");
  }
  const b = s.context; ctxChip.title = b ? b.prompt.toLocaleString() + " / " + b.window.toLocaleString() + " tokens · " + b.reserve.toLocaleString() + " réservés à la réponse · " + b.source : "Utilisation du contexte";
  st.appendChild(ctxChip);
  if (s.plan) {
    const done = s.plan.steps.filter((x) => x.done).length;
    st.appendChild(el("span", "plan-chip" + (s.plan.current < 0 ? " done" : ""), "plan " + done + "/" + s.plan.steps.length));
  }
  const touched = Number.isFinite(s.filesTouchedCount) ? s.filesTouchedCount : (Array.isArray(s.filesTouched) ? s.filesTouched.length : 0);
  const filesChip = el("button", "statusbtn files-chip" + (touched ? " active" : ""), "fichiers " + touched);
  filesChip.title = touched ? (s.filesTouched || []).join("\n") : "Aucun fichier modifié par cette session";
  filesChip.onclick = () => openFilesTab(v, false);
  st.appendChild(filesChip);
  if (s.commandsRun && s.commandsRun.length) {
    const cmdChip = el("span", "task-chip", "commandes " + s.commandsRun.length);
    cmdChip.title = s.commandsRun.join("\n");
    st.appendChild(cmdChip);
  }
  if (s.tasks) st.appendChild(el("span", "task-chip", s.tasks + " en cours"));
  if (s.autopilot && s.autopilot.label) {
    const phase = String(s.autopilot.phase || "starting");
    const phaseClass =
      phase === "completed" ? "done" : phase === "error" || phase === "paused" ? "warn" : phase === "cancelled" ? "stopped" : "live";
    const phaseChip = el("span", "task-chip autopilot-phase " + phaseClass);
    const marker = phase === "completed" ? "✓" : phase === "error" || phase === "paused" ? "!" : phase === "cancelled" ? "Ⅱ" : "·";
    phaseChip.textContent = marker + " " + String(s.autopilot.label).slice(0, 100);
    const details = s.autopilot.details || {};
    phaseChip.title =
      String(s.autopilot.label) +
      (details.tool ? "\noutil : " + details.tool : "") +
      (details.path ? "\nfichier : " + details.path : "") +
      (details.step ? "\nétape : " + details.step + (details.maxSteps ? "/" + details.maxSteps : "") : "");
    st.appendChild(phaseChip);
  }
  if (s.verification && (s.outcome === "running" || s.outcome === "idle")) {
    const vchip = el("span", "task-chip", s.verification.passed ? "vérifié ✓" : "réparation auto " + s.verification.attempts);
    vchip.title = "Contrôles automatiques en cours";
    st.appendChild(vchip);
  }
    const agVerify = s.verification || null;
    const agBusy = agVerify && (s.outcome === "running" || s.outcome === "idle");
    const checkLS = "smol.check." + (v.workspace || v.sid);
    const check = agVerify ? null : readCheck(checkLS);
    const verdict = agVerify ? (agVerify.passed ? "pass" : "fail") : check ? (check.state === "passing" ? "pass" : check.state.indexOf("FAILING") >= 0 ? "fail" : check.state === "none" ? "none" : "idle") : "idle";
    const validation = el("button", "validation-rail " + (agBusy ? "pending" : verdict));
    validation.type = "button";
    if (agVerify) {
      validation.title = agVerify.passed ? "Validation du code passée par la commande du projet" : agBusy ? "L'agent vérifie le code qu'il vient d'écrire" : "Le code ne passe pas encore la vérification du projet";
    } else if (check) {
      validation.title = check.command + " → " + check.state + " (" + new Date(check.at).toLocaleTimeString() + ")\nCliquer pour relancer la vérification";
    } else {
      validation.title = "Aucun contrôle du projet pour l'instant — cliquer pour lancer " + "la commande de vérification";
    }
    const vdot = el("span", "validation-dot");
    validation.appendChild(vdot);
    const vlabel = el("span", "validation-label", agBusy ? "validation en cours" : verdict === "pass" ? "code validé" : verdict === "fail" ? "problèmes détectés" : verdict === "none" ? "aucun contrôle" : "vérifier le code");
    validation.appendChild(vlabel);
    if (!agBusy) {
      validation.onclick = () => {
        if (validation.disabled) return;
        validation.disabled = true;
        vlabel.textContent = "vérification...";
        validation.className = "validation-rail pending";
        v.validationActive = true;
        renderActivity(v);
        post("/check", { sid: v.sid }).then((r) => {
          const c = r && r.check ? r.check : null;
          v.validationActive = false;
          if (c) {
            writeCheck(checkLS, c);
            const isOk = c.state === "passing";
            v.lastCheckResult = { ok: isOk, label: c.command };
            recordActivity(v, "check", "validation", c.command + " (" + c.state + ")", "", false);
            completeActivity(v, "check", isOk);
          } else {
            vlabel.textContent = "vérification impossible";
            v.lastCheckResult = { ok: false, label: "impossible" };
          }
          renderActivity(v);
        }).catch(() => {
          v.validationActive = false;
          vlabel.textContent = "vérification impossible";
          v.lastCheckResult = { ok: false, label: "erreur" };
          renderActivity(v);
        }).finally(() => { validation.disabled = false; });
      };
    }
    st.appendChild(validation);
  st.appendChild(ensureZoomCtl());
  if (s.subagent) {
    const chip = el("span", "task-chip sub-chip live");
    const halo = el("span", "subagent-halo");
    halo.setAttribute("role", "status");
    halo.setAttribute("aria-label", "Sous-agent en cours");
    chip.appendChild(halo);
    chip.appendChild(document.createTextNode("sous-agent " + String(s.subagent).slice(0, 40)));
    chip.title = "Sous-agent en cours : " + s.subagent;
    chip.onclick = () => openCC("agents");
    st.appendChild(chip);
  }
  if (s.skills && s.skills.length) {
    const chip = el("span", "plan-chip skills-chip", "skills " + s.skills.length);
    chip.title = "Skills chargées automatiquement pour ce tour : " + s.skills.join(", ");
    chip.onclick = () => openCC("skills");
    st.appendChild(chip);
  }
  if (s.outcome === "error" || s.outcome === "cancelled") {
    const paused = el("span", s.outcome === "error" ? "line-warn" : "task-chip", s.outcome === "error" ? "En pause" : "Arrêté");
    paused.title = s.lastError || "Tour annulé ; la progression est conservée"; st.appendChild(paused);
    const resume = el("button", "statusbtn autopilot-resume", s.outcome === "error" ? "reprendre" : "relancer");
    resume.type = "button";
    resume.title = s.lastError || "Reprendre le dernier plan Auto Copilot avec le contexte conservé";
    resume.onclick = () => {
      resume.disabled = true;
      resume.textContent = "reprise...";
      post("/msg", { sid: v.sid, text: "continue" })
        .catch((err) => {
          resume.disabled = false;
          resume.textContent = s.outcome === "error" ? "reprendre" : "relancer";
          showToast(String(err && err.message ? err.message : err), "error");
        });
    };
    st.appendChild(resume);
  }
  if ($("topmodelname") && s.model) {
    const raw = s.model.split("/").pop().split(":").shift();
    $("topmodelname").textContent = raw.length > 15 ? raw.slice(0, 14) + "…" : raw;
  }
  $("ws").textContent = shortPath(s.workspace || "");
  renderCrumb();
}

function renderPlan(v, p) {
  v.planCache = p;
  const box = document.createElement("details");
  box.className = "plan";
  box.open = true;
  const total = p.steps.length;
  const done = p.steps.filter((x) => x.done).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const summary = document.createElement("summary");
  summary.className = "hdr";
  summary.appendChild(document.createTextNode(done + " tâches sur " + total + " terminées"));
  summary.appendChild(el("span", "plan-toggle", "plier"));
  box.appendChild(summary);
  const bar = el("div", "planbar");
  const fill = el("span", "");
  fill.style.width = pct + "%";
  bar.appendChild(fill);
  box.appendChild(bar);
  p.steps.forEach((s, i) => {
    const state = s.done ? "done" : i === p.current ? "cur" : "todo";
    const extra = s.done ? "pdone" : i === p.current ? "pcur" : "ptodo";
    const mark = s.done ? "☑ " : i === p.current ? "◉ " : "☐ ";
    box.appendChild(el("div", state + " " + extra, mark + s.text));
  });
  v.planEl = box;
  if (v === active && planTop) {
    planTop.innerHTML = "";
    planTop.appendChild(box);
    planTop.hidden = false;
  }
}

// ---- event handling -------------------------------------------------------
// The chip follows every tool that touches files. The TREE and the REVIEW
// reload when such a tool FINISHES — a "tool" event fires at its start, too
// early to show what the call actually changed (that was the panel that
// never moved). Long commands get a slow heartbeat from setBusy instead.
const CHIP_TOOLS = ["read_file", "write_file", "edit_file", "list_files", "search", "move_path", "delete_path", "create_folder", "run_command", "git"];
const DISK_TOOLS = ["write_file", "edit_file", "move_path", "delete_path", "create_folder", "format", "run_command", "task", "git", "debug"];
let agentRefreshTimer = null;
let busyRefreshTimer = null;
function scheduleWorkspaceRefresh(v) {
  if (agentRefreshTimer) clearTimeout(agentRefreshTimer);
  agentRefreshTimer = setTimeout(() => {
    agentRefreshTimer = null;
    try {
      const rv = v.tabs.find((x) => x.kind === "review");
      if (rv && rv.reload) rv.reload();
      const ff = v.tabs.find((x) => x.kind === "files");
      if (ff && ff.refreshFiles) ff.refreshFiles();
      fetchReviewBadge();
    } catch (e) {}
  }, 1200);
}
function notifyAgentFileActivity(v, m, completed) {
  if (!v || !m) return;
  const targetFile = m.path || m.file || (() => {
    if (!m.summary || !/(?:\.[a-zA-Z0-9]+|\/|\\)/.test(m.summary)) return "";
    return /([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)/.exec(m.summary)?.[1] || "";
  })();
  const operationId = m.executionId;
  if (targetFile && operationId && CHIP_TOOLS.includes(m.name)) {
    const key = targetFile.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!completed) {
      let operations = v.agentFileOps.get(key);
      if (!operations) {
        operations = new Map();
        v.agentFileOps.set(key, operations);
      }
      operations.set(operationId, m.name);
    } else {
      const operations = v.agentFileOps.get(key);
      operations?.delete(operationId);
      if (operations && !operations.size) v.agentFileOps.delete(key);
    }
  }
  try {
    if (CHIP_TOOLS.indexOf(m.name) >= 0) {
      const ft = v.tabs && v.tabs.find((x) => x.kind === "files");
      if (ft && ft.agentLine) {
        const activeCount = [...v.agentFileOps.values()].reduce((count, operations) => count + operations.size, 0);
        ft.agentLine.textContent = completed
          ? (activeCount ? "🤖 " + activeCount + " opération(s) fichier en cours" : "✓ " + m.name + " terminé")
          : "🤖 " + m.name + (targetFile ? " · " + targetFile : m.summary ? " " + m.summary : "");
        ft.agentLine.hidden = false;
      }
    }
    if (DISK_TOOLS.indexOf(m.name) >= 0) scheduleWorkspaceRefresh(v);
  } catch (e) {}

  if (!targetFile) return;
  v.lastTouchedFile = targetFile;

  // Rafraîchir l'arborescence et afficher le fichier manipulé en live
  const filesTab = v.tabs && v.tabs.find((t) => t.kind === "files");
  if (filesTab) {
    if (filesTab.renderNestedTree) {
      try { filesTab.renderNestedTree(); } catch (e) {}
    }
    if (filesTab.refreshFiles) {
      try { filesTab.refreshFiles(); } catch (e) {}
    }
    // read_file deliberately does NOT switch tabs: the agent reading a file
    // must never steal the buffer the user is typing into.
    if (m.name === "write_file" || m.name === "edit_file") {
      if (filesTab.loadFile) {
        void filesTab.loadFile(targetFile).catch(() => {});
      }
    }
    if (completed && (m.name === "write_file" || m.name === "edit_file") && filesTab.reloadAgentFile) {
      void filesTab.reloadAgentFile(targetFile).catch(() => {});
    }
  }

  // Rafraîchir le panneau de revue de diffs en direct
  const revTab = v.tabs && v.tabs.find((t) => t.kind === "review");
  if (revTab && revTab.reload) {
    try { revTab.reload(); } catch (e) {}
  }
}

// ---- centre d'activite unifie & timeline ----
function recordActivity(v, type, name, desc, targetFile, isMcp) {
  if (!v) return null;
  if (!v.activities) v.activities = [];
  const item = {
    id: "act_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    type: type || "tool",
    name: name || "",
    desc: desc || "",
    file: targetFile || "",
    isMcp: !!isMcp,
    startTime: Date.now(),
    durationMs: 0,
    status: "cur",
  };
  v.activities.unshift(item);
  if (v.activities.length > 40) v.activities.pop();
  v.currentActivity = item;
  renderActivity(v);
  return item;
}

function completeActivity(v, itemOrType, ok, errMsg) {
  if (!v || !v.activities) return;
  let item = null;
  if (typeof itemOrType === "object" && itemOrType) item = itemOrType;
  else if (typeof itemOrType === "string") item = v.activities.find((a) => a.type === itemOrType && a.status === "cur");
  else item = v.currentActivity;

  if (item) {
    item.durationMs = Math.max(10, Date.now() - item.startTime);
    item.status = ok ? "ok" : "err";
    if (errMsg) item.desc = (item.desc ? item.desc + " — " : "") + errMsg;
  }
  if (v.currentActivity === item) v.currentActivity = null;
  renderActivity(v);
}

function renderActivity(v) {
  if (!actBar) return;
  if (!v || v !== active) {
    actBar.hidden = true;
    return;
  }
  actBar.hidden = false;
  if (!v.activities) v.activities = [];

  const cur = v.currentActivity;
  const isBusy = !!v.busyLabel || cur?.status === "cur";

  if (actPulse) {
    actPulse.className = "act-pulse " + (cur?.status === "err" ? "error" : isBusy ? "live" : "idle");
  }

  if (actAgent) {
    const sub = v.activeSubagent || (cur?.type === "sub" ? cur.desc : null);
    if (sub) {
      actAgent.className = "act-agent badge sub-agent-live";
      actAgent.textContent = "⇄ " + sub;
      actAgent.hidden = false;
      actAgent.title = "Sous-agent actif : " + sub;
      actAgent.onclick = () => openCC("agents");
    } else {
      actAgent.className = "act-agent badge";
      actAgent.hidden = true;
    }
  }

  if (actSkill) {
    const sk = (v.state && v.state.skills && v.state.skills.length) ? v.state.skills : v.activeSkills;
    if (sk && sk.length) {
      actSkill.textContent = "⚡ " + (sk.length === 1 ? sk[0] : sk.length + " skills");
      actSkill.hidden = false;
      actSkill.title = "Skills chargées : " + sk.join(", ");
      actSkill.onclick = () => openCC("skills");
    } else {
      actSkill.hidden = true;
    }
  }

  if (actTool) {
    actTool.title = "Outil en cours — cliquer pour ouvrir l'onglet Outils";
    actTool.onclick = () => openCC("tools");
    if (cur && cur.type === "tool" && !cur.isMcp) {
      actTool.textContent = "🛠 " + cur.name.replace(/_/g, " ");
      actTool.hidden = false;
    } else {
      actTool.hidden = true;
    }
  }

  if (actMcp) {
    actMcp.title = "Serveur MCP en cours — cliquer pour ouvrir l'onglet MCP";
    actMcp.onclick = () => openCC("mcp");
    if (cur && (cur.isMcp || cur.type === "mcp")) {
      actMcp.textContent = "🔌 " + cur.name.replace(/^mcp_/, "");
      actMcp.hidden = false;
    } else {
      actMcp.hidden = true;
    }
  }

  if (actFile) {
    const f = cur?.file || v.lastTouchedFile;
    actFile.title = f ? "Fichier : " + f + " — cliquer pour ouvrir l'éditeur" : "Fichier en cours — cliquer pour ouvrir l'éditeur";
    actFile.onclick = () => togglePanelKind("files");
    if (f) {
      const shortF = f.split(/[\\/]/).slice(-2).join("/");
      actFile.textContent = "📝 " + shortF;
      actFile.hidden = false;
      actFile.title = "Fichier : " + f + " — cliquer pour ouvrir l'éditeur";
    } else {
      actFile.hidden = true;
    }
  }

  if (actCheck) {
    actCheck.title = "Validation continue — cliquer pour ouvrir Problems";
    actCheck.onclick = () => togglePanelKind("problems");
    if (v.validationActive) {
      actCheck.textContent = "⧖ validation...";
      actCheck.className = "act-check badge";
      actCheck.hidden = false;
    } else if (v.lastCheckResult) {
      actCheck.textContent = v.lastCheckResult.ok ? "✓ validé" : "✕ échec";
      actCheck.className = "act-check badge " + (v.lastCheckResult.ok ? "ok" : "err");
      actCheck.hidden = false;
    } else {
      actCheck.hidden = true;
    }
  }

  if (actStatus) {
    actStatus.textContent = cur ? (cur.desc || cur.name) : (v.busyLabel || "Prêt");
  }
  if (actTime) {
    if (cur && cur.status === "cur") {
      const sec = ((Date.now() - cur.startTime) / 1000).toFixed(1);
      actTime.textContent = sec + "s";
      actTime.hidden = false;
    } else if (v.activities.length && v.activities[0].durationMs) {
      const ms = v.activities[0].durationMs;
      actTime.textContent = ms > 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms";
      actTime.hidden = false;
    } else {
      actTime.hidden = true;
    }
  }

  if (actCount) actCount.textContent = "(" + v.activities.length + ")";
  if (actList) {
    actList.innerHTML = "";
    v.activities.slice(0, 15).forEach((a) => {
      const item = el("div", "act-item " + a.status);
      const icon = el("span", "icon", a.type === "sub" ? "⇄" : a.isMcp ? "🔌" : a.type === "check" ? "✓" : "🛠");
      const desc = el("span", "desc", (a.name ? a.name + " : " : "") + (a.desc || a.file || ""));
      const dur = a.durationMs ? (a.durationMs > 1000 ? (a.durationMs / 1000).toFixed(1) + "s" : a.durationMs + "ms") : "…";
      const meta = el("span", "meta", dur);
      item.appendChild(icon); item.appendChild(desc); item.appendChild(meta);
      actList.appendChild(item);
    });
  }
}

function startToolActivity(v, m) {
  if (!m || !v) return;
  const isMcp = String(m.name || "").startsWith("mcp_") || String(m.name || "").includes("__");
  let targetFile = "";
  if (m.path) targetFile = m.path;
  else if (m.file) targetFile = m.file;
  else if (m.summary && /(?:\.[a-zA-Z0-9]+|\/|\\)/.test(m.summary)) {
    const matched = /([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)/.exec(m.summary);
    if (matched) targetFile = matched[1];
  }
  if (targetFile) v.lastTouchedFile = targetFile;
  const act = recordActivity(v, isMcp ? "mcp" : "tool", m.name, m.summary || "", targetFile, isMcp);
  if (m.executionId) v.toolActivities.set(m.executionId, act);
  else v.currentToolAct = act;
  return act;
}

function finishToolActivity(v, m, activity, toolMeta) {
  if (!v) return;
  const item = activity || (m.executionId ? v.toolActivities.get(m.executionId) : null) || v.currentToolAct || "tool";
  const output = m.body || m.line || "";
  const exitMatch = (toolMeta?.name === "run_command" || toolMeta?.name === "verification") && output.match(/\[exit code (-?\d+) in ([^\]]+)\]/i);
  const failed = !!m.err || !!(exitMatch && Number.parseInt(exitMatch[1], 10) !== 0);
  completeActivity(v, item, !failed, failed ? (output || "erreur") : "");
  if (m.executionId) v.toolActivities.delete(m.executionId);
  if (v.currentToolAct === item) v.currentToolAct = null;
}

function cancelPendingToolCards(v) {
  if (!v) return;
  const cards = new Set(v.toolCards.values());
  if (v.curTool) cards.add(v.curTool);
  let cancelledFileOps = false;
  for (const card of cards) {
    if (card._toolOutcome?.textContent !== "En cours") continue;
    card.className = (card.className || "tool") + " cancelled";
    card._toolOutcome.textContent = "Annulé";
    card._toolOutcome.className = "tool-outcome cancelled";
    card.appendChild(el("pre", "result cancelled", "Opération interrompue; aucun résultat final n’a été reçu."));
    const activity = card._toolActivity;
    if (activity) {
      activity.durationMs = Math.max(10, Date.now() - activity.startTime);
      activity.status = "cancelled";
      activity.desc = (activity.desc ? activity.desc + " — " : "") + "annulé";
      if (v.currentActivity === activity) v.currentActivity = null;
    }
    if (card._toolMeta) {
      if (CHIP_TOOLS.includes(card._toolMeta.name)) cancelledFileOps = true;
      notifyAgentFileActivity(v, card._toolMeta, true);
    }
  }
  v.toolCards.clear();
  v.toolActivities.clear();
  v.curTool = null;
  v.currentToolAct = null;
  v.agentFileOps.clear();
  clearOffload(v);
  if (cancelledFileOps) {
    const filesTab = v.tabs?.find((tab) => tab.kind === "files");
    if (filesTab?.agentLine) {
      filesTab.agentLine.textContent = "⏸ opérations fichier annulées";
      filesTab.agentLine.hidden = false;
    }
    scheduleWorkspaceRefresh(v);
  }
  if (v.curSub?._summary) v.curSub._summary.appendChild(document.createTextNode(" · annulé"));
  v.curSub = null;
  v.activeSubagent = null;
  renderActivity(v);
}


// ---- offload card ----------------------------------------------------------
// Countdown against the server's REAL shell deadline. Every button acts on
// the live process: move it to a background task, push the deadline out, or
// cancel it — nothing here is cosmetic, the run either keeps going or it dies.
const OFFLOAD_LEAD_MS = 30000;
function clearOffload(v) {
  const o = v && v.offload;
  if (!o) return;
  clearTimeout(o.arm); clearInterval(o.tick);
  if (o.card) { try { o.card.remove(); } catch (e) {} }
  v.offload = null;
}
function armOffload(v, host, summary) {
  clearOffload(v);
  const o = { arm: 0, tick: 0, card: null, host: host, command: String(summary || ""), deadline: 0 };
  v.offload = o;
  fetch("/shell/live?k=" + k)
    .then((r) => (r && r.ok ? r.json() : null))
    .then((j) => {
      if (v.offload !== o || !j || !Array.isArray(j.items)) return;
      const items = j.items.filter((i) => i && i.deadline);
      if (!items.length) return;
      const key = o.command.trim().toLowerCase();
      let hit = key ? items.find((i) => String(i.command || "").toLowerCase().indexOf(key) >= 0) : null;
      if (!hit) hit = items.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
      o.command = hit.command;
      o.deadline = hit.deadline;
      const wait = Math.max(0, o.deadline - Date.now() - OFFLOAD_LEAD_MS);
      if (wait === 0) showOffloadCard(v, o);
      else o.arm = setTimeout(() => { if (v.offload === o) showOffloadCard(v, o); }, wait);
    })
    .catch(() => {});
}
function showOffloadCard(v, o) {
  if (v.offload !== o || !o.host || o.card) return;
  const card = el("div", "offload-card");
  const title = el("div", "offload-title", "Outil en cours depuis longtemps — déport imminent");
  const count = el("div", "offload-count", "");
  const row = el("div", "offload-actions");
  const refresh = () => {
    const left = o.deadline - Date.now();
    count.textContent = left > 0
      ? "Déport dans " + Math.ceil(left / 1000) + "s — la commande est tuée à zéro"
      : "le timeout du shell se déclenche maintenant…";
  };
  const send = (action, ms) => post("/shell", { action: action, command: o.command, ms: ms || 0 });
  const button = (label, primary, fn) => {
    const b = el("button", "offload-btn" + (primary ? " primary" : ""), label);
    b.onclick = () => { try { fn(); } catch (e) {} };
    return b;
  };
  const rearmShow = (deadline) => {
    const wait = Math.max(0, deadline - Date.now() - OFFLOAD_LEAD_MS);
    o.arm = setTimeout(() => { if (v.offload === o) showOffloadCard(v, o); }, wait);
  };
  row.appendChild(button("Déplacer en arrière-plan maintenant", true, () => {
    send("detach").then((r) => {
    if (r && r.ok && r.taskId) count.textContent = "Déplacé en tâche d'arrière-plan n° " + r.taskId + " — l'agent continue de travailler.";
    else count.textContent = "Il s'est terminé avant d'être déplacé.";
    });
  }));
  row.appendChild(button("Ne pas déporter automatiquement", false, () => clearOffload(v)));
  row.appendChild(button("Reporter le déport", false, () => {
    send("extend", 60000).then((r) => {
      if (!r || !r.deadline) { clearOffload(v); return; }
      o.deadline = r.deadline;
      if (o.card) { clearInterval(o.tick); try { o.card.remove(); } catch (e) {} o.card = null; }
      rearmShow(r.deadline);
    });
  }));
  row.appendChild(button("Prolonger le délai", false, () => {
    send("extend", 120000).then((r) => {
      if (r && r.deadline) { o.deadline = r.deadline; refresh(); }
      else clearOffload(v);
    });
  }));
  row.appendChild(button("Annuler", false, () => {
    send("cancel").then(() => clearOffload(v));
  }));
  card.appendChild(title); card.appendChild(count); card.appendChild(row);
  o.host.appendChild(card);
  try { o.host.open = true; } catch (e) {}
  o.card = card;
  refresh();
  o.tick = setInterval(refresh, 1000);
}
function handle(m) {
  if (m.t === "hub") { onHub(m); return; }
  if (m.t === "closed") { dropView(m.sid); return; }
  if (m.t === "shared") { onShared(m); return; }
  if (!m.sid) return;
  const v = getView(m.sid);
  switch (m.t) {
    case "state":
      // The server omits "autopilot" when no phase is active; a merge would keep
      // the stale chip, so drop the local one first (replay may still carry it).
      if (m.s && !("autopilot" in m.s)) delete v.state.autopilot;
      v.state = Object.assign(v.state, m.s);
      if (m.s && "busy" in m.s) setBusy(v, m.s.busy);
      renderState(v);
      if (v === active) renderTaskRail();
      break;
    case "autopilot":
      v.state.autopilot = {
        phase: m.phase,
        label: m.label || "",
        ...(m.details ? { details: m.details } : {}),
      };
      renderState(v);
      break;
    case "turn_error":
      v.state.outcome = "error";
      v.state.lastError = m.message || "Le tour Auto Copilot a échoué.";
      appendOutputLog("Hub Tasks", outStamp() + " [erreur] " + v.state.lastError);
      setBusy(v, null);
      showToast(v.state.lastError, "error");
      renderState(v);
      break;
    case "user": endThought(v); v.curText = null; v.curTool = null; v.planEl = null; v.curSub = null; add(v, userBubble(m, v)); break;
    case "response_reset":
      if (v.curText) v.curText.remove();
      if (v.curThought) v.curThought.remove();
      v.curText = null; v.curThought = null; v.thoughtBuf = ""; break;
    case "turn_cancelled":
      cancelPendingToolCards(v);
      break;
    case "token":
      endThought(v);
      if (!v.curText) {
        // La meta (heure+copier) est SOEUR du texte : le re-rendu streaming
        // (innerHTML) ne l'efface pas.
        const w = subAdd(v, el("div", "msgwrap"));
        v.curText = el("div", "md");
        v.curText._raw = "";
        const responseNode = v.curText;
        w.appendChild(responseNode);
        w.appendChild(msgMeta(() => responseNode._raw || "", v, nextMessageMark(v, "assistant")));
      }
      v.curText._raw += m.s; scheduleMd(v, v.curText); break;
    case "thinking":
      if (!v.curThought) { v.curThought = startThought(v); if (v.curSub) v.curSub.appendChild(v.curThought); }
      v.curThought._body.appendData(m.s);
      // Only the one-line preview is truncated; the full text stays available.
      v.thoughtBuf = (v.thoughtBuf + m.s).slice(-2000);
      var tt = v.thoughtBuf.replace(/\s+/g, " ").trim();
      v.curThought._preview.textContent = "✦ " + (tt.length > 160 ? "…" + tt.slice(-160) : tt);
      if (v === active) stick(); break;
    case "tool": {
      endThought(v); v.curText = null;
      if (v.curSub && typeof m.executionId === "string" && m.executionId.startsWith("child-")) {
        v.curSub._actionCount = (v.curSub._actionCount || 0) + 1;
        if (v.curSub._progress) v.curSub._progress.textContent = v.curSub._actionCount + " action" + (v.curSub._actionCount === 1 ? "" : "s");
      }
      const d = el("details", "tool");
      const summary = el("summary"); summary.appendChild(el("span", "name", m.name.replace(/_/g, " "))); summary.appendChild(el("span", "tool-args", m.summary || ""));
      if (m.category) summary.appendChild(el("span", "tool-category", m.category));
      const outcome = el("span", "tool-outcome pending", "En cours");
      summary.appendChild(outcome);
      d.appendChild(summary); d._summary = summary; v.curTool = d;
      d._toolMeta = m;
      d._toolOutcome = outcome;
      if (m.executionId) v.toolCards.set(m.executionId, d);
      if (m.name === "run_command" && typeof m.command === "string") {
        const command = el("pre", "tool-command", m.command);
        d.appendChild(command);
      }
      v.lastTool = m;
      if (typeof m.diff === "string" && m.diff) {
        const pre = document.createElement("pre");
        pre.className = "diff";
        for (const line of m.diff.split("\n")) {
          const span = document.createElement("span");
          span.className = line.startsWith("+ ") ? "add" : line.startsWith("- ") ? "del" : "same";
          span.textContent = line + "\n";
          pre.appendChild(span);
        }
        d.appendChild(pre);
      }
      subAdd(v, d);
      notifyAgentFileActivity(v, m);
      d._toolActivity = startToolActivity(v, m);
      if (m.name === "run_command") armOffload(v, d, m.summary || "");
      else clearOffload(v);
      break;
    }
    case "result": {
      clearOffload(v);
      endThought(v); v.curText = null;
      const rawText = m.body || m.line || "";
      const toolCard = m.executionId ? v.toolCards.get(m.executionId) : v.curTool;
      const toolMeta = m.executionId ? toolCard?._toolMeta : v.lastTool;
      const isCmd = toolMeta?.name === "run_command";
      const body = el("pre", "result" + (m.err ? " err" : ""));
      if (isCmd) {
        body.appendChild(ansiToFrag(rawText));
      } else {
        body.textContent = rawText;
      }
      if (toolCard) {
        const exitMatch = (isCmd || toolMeta?.name === "verification") && rawText.match(/\[exit code (-?\d+) in ([^\]]+)\]/i);
        const failed = !!m.err || !!(exitMatch && Number.parseInt(exitMatch[1], 10) !== 0);
        toolCard.classList.add(failed ? "failed" : "finished");
        if (toolCard._toolOutcome) {
          toolCard._toolOutcome.textContent = failed ? "Échec" : "Terminé";
          toolCard._toolOutcome.className = "tool-outcome " + (failed ? "failed" : "finished");
        }
        if (isCmd) {
          if (exitMatch) {
            const codeNum = Number.parseInt(exitMatch[1], 10);
            const dur = exitMatch[2];
            const badge = el("span", "cmd-badge " + (codeNum === 0 ? "ok" : "err"), (codeNum === 0 ? "✓ 0" : "✕ " + codeNum) + " (" + dur + ")");
            toolCard._summary?.appendChild(badge);
          }
          const actions = el("div", "cmd-actions");
          const cmdText = toolMeta.command || toolMeta.summary || "";
          const btnCopy = el("button", "cmd-action-btn", "📋 Copier");
          btnCopy.type = "button";
          btnCopy.title = "Copier la commande";
          btnCopy.onclick = (e) => {
            e.stopPropagation();
            if (navigator.clipboard) {
              navigator.clipboard.writeText(cmdText);
              btnCopy.textContent = "✓ Copié";
              setTimeout(() => { btnCopy.textContent = "📋 Copier"; }, 1500);
            }
          };
          const btnRerun = el("button", "cmd-action-btn primary", "↺ Relancer");
          btnRerun.type = "button";
          btnRerun.title = "Relancer la commande dans le terminal";
          btnRerun.onclick = (e) => {
            e.stopPropagation();
            openTerminalTab(v);
            setTimeout(() => {
              const activeTerm = [...v.terms.values()].pop();
              if (activeTerm) {
                activeTerm.inp.value = cmdText;
                activeTerm.inp.focus();
              }
            }, 100);
          };
          actions.appendChild(btnCopy);
          actions.appendChild(btnRerun);
          body.appendChild(actions);
        }
        toolCard.appendChild(body);
        if (m.err && !isCmd && toolMeta?.name !== "verification") toolCard.open = true;
        if (m.executionId) v.toolCards.delete(m.executionId);
        if (v.curTool === toolCard) v.curTool = null;
      }
      else add(v, body);
      if (m.sid === active?.sid && ccOpenNow() && toolMeta?.name === "work") loadCC();
      notifyAgentFileActivity(v, toolMeta, true);
      finishToolActivity(v, m, toolCard?._toolActivity, toolMeta);
      break;
    }
      case "plan": endThought(v); v.curText = null; renderPlan(v, m); v.planCache = m; { const pt = v.tabs.find((t) => t.kind === "plan"); if (pt && pt.renderSteps) { try { pt.renderSteps(m); } catch (e) {} } } break;
      case "editop": {
        const ft = v.tabs.find((x) => x.kind === "files");
        if (!ft || !ft.collab || !ft.collab.doc || ft.collab.path !== m.file) break;
        let changed = false;
        for (const op of m.ops || []) { try { if (applyOp(ft.collab.doc, op)) changed = true; } catch (e) {} }
        if (!changed) break;
        const pos = ft.editor.selectionStart, end = ft.editor.selectionEnd;
        ft.editor.value = docText(ft.collab.doc);
        ft.collab.shadow = ft.editor.value;
        try { ft.editor.setSelectionRange(Math.min(pos, ft.editor.value.length), Math.min(end, ft.editor.value.length)); } catch (e) {}
        try { ft.refreshEditor(); } catch (e) {}
        break;
      }
      case "cursor": {
        const ft = v.tabs.find((x) => x.kind === "files");
        if (ft && ft.onRemoteCursor) ft.onRemoteCursor(m);
        break;
      }
      case "editrebase": {
        const ft = v.tabs.find((x) => x.kind === "files");
        if (!ft || !ft.collab || ft.collab.path !== m.file) break;
        const cur = ft.tabStore.active();
        if (cur && cur.path === m.file && cur.dirty) { ft.collab = null; break; }
        ft.tabStore.close(m.file, true);
        ft.collab = null;
        if (ft.filePath === m.file) void ft.loadFile(m.file);
        break;
      }
    case "sub": endThought(v); v.curText = null;
      if (m.phase === "start") {
        v.activeSubagent = m.label || "";
        recordActivity(v, "sub", "sous-agent", m.label || "", "", false);
        const d = el("details", "subagent"); d.open = true;
        const summary = el("summary", "subagent-summary");
        const halo = el("span", "subagent-halo");
        halo.setAttribute("role", "status");
        halo.setAttribute("aria-label", "Sous-agent en cours");
        const title = el("span", "subagent-title", m.label || "");
        const progress = el("span", "subagent-progress", "0 action");
        summary.appendChild(halo);
        summary.appendChild(title);
        summary.appendChild(progress);
        d.appendChild(summary);
        d._summary = summary;
        d._halo = halo;
        d._progress = progress;
        d._actionCount = 0;
        d._startedAt = Date.now();
        v.curSub = d; add(v, d);
      } else {
        const details = m.details || {};
        const outcome = details.outcome || (m.err ? "error" : "completed");
        const failed = outcome === "error" || outcome === "failed";
        const cancelled = outcome === "cancelled";
        completeActivity(v, "sub", !failed && !cancelled, failed ? "erreur" : cancelled ? "annulé" : "");
        v.activeSubagent = null;
        if (v.curSub) {
          const d = v.curSub;
          d.className = "subagent " + (failed ? "failed" : cancelled ? "cancelled" : "finished");
          d._halo.className = "subagent-halo " + (failed ? "failed" : cancelled ? "cancelled" : "finished");
          d._halo.textContent = failed ? "!" : cancelled ? "Ⅱ" : "✓";
          d._halo.setAttribute("aria-label", failed ? "Sous-agent en erreur" : cancelled ? "Sous-agent annulé" : "Sous-agent terminé");
          const calls = Number.isFinite(details.toolCalls) ? Math.max(0, details.toolCalls) : d._actionCount;
          const elapsed = Math.max(0, Math.round((Date.now() - d._startedAt) / 1000));
          d._progress.textContent = calls + " action" + (calls === 1 ? "" : "s") + " · " + elapsed + "s";
          const meta = el("div", "subagent-meta", "État : " + outcome + " · vérification : " + (details.verification || "non exécutée"));
          d.appendChild(meta);
          if (Array.isArray(details.filesTouched) && details.filesTouched.length) {
            d.appendChild(el("div", "subagent-files", "Fichiers : " + details.filesTouched.join(", ")));
          }
          if (typeof details.report === "string" && details.report.trim()) {
            const report = el("pre", "subagent-report");
            report.textContent = details.report;
            d.appendChild(report);
          }
          d.open = true;
          v.curSub = null;
        } else add(v, el("div", failed ? "line-error" : "line-status", (failed ? "!" : cancelled ? "Ⅱ" : "✓") + " sous-agent : " + (m.label || "")));
      }
      renderActivity(v);
      break;
    case "line": endThought(v); v.curText = null; subAdd(v, el("div", "line-" + m.kind, m.s));
      if (m.kind === "error") ping("error", m.s);
      break;
    case "turnend":
      endThought(v); v.curText = null; v.curSub = null; add(v, el("div", "turnend", "■ " + m.label));
      appendOutputLog("Hub Tasks", outStamp() + " Tour terminé : " + (m.label || ""));
      scheduleProblemsScan(v, 2000);
      ping("turnend", m.label);
      if (v !== active) { v.unread = true; renderSidebar(); }
      renderActivity(v);
      break;
    case "busy": setBusy(v, m.label); renderActivity(v); break;
    case "skills":
      v.state.skills = m.names || [];
      v.activeSkills = m.names || [];
      if (ccOpenNow()) renderCC();
      if (v === active) { renderState(v); renderActivity(v); }
      break;
    case "confirm": {
      endThought(v); v.curText = null;
      const box = el("div", "ask");
      box.appendChild(el("div", "", "Exécuter ?")); box.appendChild(el("div", "cmd", m.command));
      if (m.reason) box.appendChild(el("div", "hint", m.reason));
      ["yes", "no", "always"].forEach((a) => {
        const b = el("button", "", a === "always" ? "Toujours autoriser ce programme" : a === "yes" ? "oui" : "non");
        b.onclick = () => { post("/confirm", { sid: v.sid, id: m.id, answer: a }); box.remove(); };
        box.appendChild(b);
      });
      ping("confirm", m.command);
      v.asks.set(m.id, box);
      add(v, box); break;
    }
    case "answered": {
      // The server settled this prompt (answered here, elsewhere, or cancelled).
      const box = v.asks.get(m.id);
      if (box) { box.remove(); v.asks.delete(m.id); }
      break;
    }
    case "select": {
      endThought(v); v.curText = null;
      const box = el("div", "ask");
      box.appendChild(el("div", "cmd", m.title));
      m.options.forEach((o, i) => {
        const b = el("button", "opt" + (o.current ? " current" : ""), (o.current ? "● " : "") + o.label);
        if (o.hint) b.appendChild(el("span", "hint", o.hint));
        b.onclick = () => { post("/select", { sid: v.sid, id: m.id, index: i }); box.remove(); };
        box.appendChild(el("div")).appendChild(b);
      });
      const cancel = el("button", "", "cancel");
      cancel.onclick = () => { post("/select", { sid: v.sid, id: m.id, index: null }); box.remove(); };
      box.appendChild(cancel);
      v.asks.set(m.id, box);
      add(v, box); break;
    }
    case "prompt": {
      endThought(v); v.curText = null;
      const box = el("div", "ask");
      box.appendChild(el("div", "cmd", m.title));
      const field = el("input", "askinput"); field.type = "text"; field.placeholder = m.placeholder || ""; field.spellcheck = false; field.autocomplete = "off";
      const send = (value) => { post("/prompt", { sid: v.sid, id: m.id, value: value }); box.remove(); };
      field.onkeydown = (e) => {
        if (e.key === "Enter") { e.preventDefault(); send(field.value.trim() || null); }
        // Escape closes this box only; the page-level handler would cancel the whole turn.
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); send(null); }
      };
      box.appendChild(el("div")).appendChild(field);
      const ok = el("button", "", "ok"); ok.onclick = () => send(field.value.trim() || null); box.appendChild(ok);
      const cancel = el("button", "", "cancel"); cancel.onclick = () => send(null); box.appendChild(cancel);
      v.asks.set(m.id, box);
      add(v, box);
      if (v === active) field.focus();
      break;
    }
    case "termopen": ensureTermTab(v, m.tid, m.cwd); break;
    case "term": termWrite(v, m.tid, m.s); break;
    case "termdone": termDone(v, m.tid, m.code, m.cwd); break;
    case "termclosed": removeTermTab(v, m.tid); break;
  }
}

// ---- hub snapshot + sidebar ------------------------------------------------
function onHub(m) {
  hub = m;
  sessInfo.clear();
  for (const w of m.workspaces) for (const s of w.sessions) sessInfo.set(s.id, Object.assign({ workspace: w.path, wsname: w.name }, s));
  for (const v of views.values()) reconcileTerms(v);
  $("ver").textContent = "v" + m.version;
  if (typeof hubStartedAt === "undefined" || hubStartedAt === null) hubStartedAt = m.startedAt || 0;
  else if (m.startedAt && m.startedAt !== hubStartedAt) {
    persistDraft();
    location.reload();
    return;
  }
  if (m.startedAt) {
    const when = new Date(m.startedAt);
    let hh = "?", mm = "?";
    try {
      hh = String(when.getHours()).padStart(2, "0");
      mm = String(when.getMinutes()).padStart(2, "0");
    } catch (e) {}
    $("ver").textContent += " · hub " + hh + ":" + mm;
    $("ver").title = "Hub démarré " + when.toLocaleString() + " — si cette date précède votre dernier npm run build, arrêtez l'ancien hub (Ctrl+C dans son terminal) et relancez-le, puis rechargez cette page";
  }
  if (pendingSelect && sessInfo.has(pendingSelect)) { const id = pendingSelect; pendingSelect = null; show(id); }
  else if (!active) {
    const h = location.hash.slice(1);
    if (h && sessInfo.has(h)) select(h);
    else {
      const live = [...sessInfo.values()].filter((s) => s.live).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      show(live ? live.id : null);
    }
  } else if (!sessInfo.has(active.sid) && !pendingSelect) show(null);
  renderSidebar(); renderCrumb(); renderTitle(); renderWelcome();
}
function select(id) {
  post("/sessions/resume", { id }).catch(() => {});
  show(id);
}
function show(sid) {
  if (active) {
    active.draft = input.value; active.scrollTop = logwrap.scrollTop;
    active.logEl.hidden = true;
  }
  active = sid ? getView(sid) : null;
  $("welcome").hidden = !!active;
  $("bottom").hidden = !active;
  busyEl.hidden = !active;
  if (planTop) {
    planTop.innerHTML = "";
    if (active && active.planCache) {
      renderPlan(active, active.planCache);
    } else {
      planTop.hidden = true;
    }
  }
  if (active) {
    active.logEl.hidden = false; active.unread = false;
    input.value = active.draft || ""; autoGrow(); menuIdx = 0; renderMenu();
    renderState(active);
    renderActivity(active);
    logwrap.scrollTop = active.followBottom ? logwrap.scrollHeight : active.scrollTop || 0;
    active.scrollTop = logwrap.scrollTop;
    renderBusy();
    void refreshSessionOverview(active);
    void refreshGitStatus(active);
    if (location.hash !== "#" + sid) history.replaceState(null, "", "#" + sid);
    // On a narrow window the sidebar floats over the chat: tuck it away once
    // a session is picked.
    if (narrow()) setSide(true);
    input.focus({ preventScroll: true });
  } else {
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    $("status").textContent = "";
  }
  renderPanel(); renderSidebar(); renderCrumb(); renderTitle(); renderWelcome(); renderAttachments(); renderActivity(active); fetchReviewBadge();
  if (active) scheduleProblemsScan(active, 600);
  stick();
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return value.toFixed(unit > 1 ? 1 : 0) + " " + units[unit];
}
function setSystemMetric(name, value, percent) {
  const metric = document.querySelector('.sysmetric[data-metric="' + name + '"]');
  if (!metric) return;
  metric.querySelector(".sysvalue").textContent = value;
  const validPercent = Number.isFinite(percent);
  metric.querySelector(".systrack i").style.width = validPercent ? Math.max(0, Math.min(100, percent)) + "%" : "0%";
  metric.dataset.health = !validPercent ? "unknown" : percent < 60 ? "good" : percent < 85 ? "warn" : "high";
  metric.title = Number.isFinite(percent) ? value + " · " + Math.round(percent) + "%" : value;
}
let overviewBusy = false;
async function refreshSessionOverview(v) {
  if (!v || active !== v || document.hidden || overviewBusy) return;
  overviewBusy = true;
  try {
    const response = await fetch("/session/overview?k=" + k + "&sid=" + encodeURIComponent(v.sid));
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    if (active !== v) return;
    const system = data.system || {};
    const memory = system.memory || {};
    const gpu = system.gpu;
    const storage = system.storage;
    setSystemMetric("cpu", Number.isFinite(system.cpuPercent) ? system.cpuPercent + "%" : "—", system.cpuPercent);
    setSystemMetric("memory", Number.isFinite(memory.percent) ? memory.percent + "% · " + formatBytes(memory.usedBytes) : "—", memory.percent);
    setSystemMetric("gpu", gpu ? gpu.utilizationPercent + "%" : "N/D", gpu && gpu.utilizationPercent);
    setSystemMetric("vram", gpu ? formatBytes(gpu.memoryUsedBytes) + " / " + formatBytes(gpu.memoryTotalBytes) : "N/D", gpu ? gpu.memoryUsedBytes * 100 / gpu.memoryTotalBytes : null);
    setSystemMetric("storage", storage ? storage.percent + "%" : "—", storage && storage.percent);
    const changes = data.changes;
    const changeValue = changes
      ? changes.files + " · +" + changes.added + " −" + changes.removed
      : "Git N/D";
    $("sessionstat-changes-value").textContent = changeValue;
    $("sessionstat-changes").title = changes
      ? "Ouvrir la revue : " + changes.files + " fichiers, +" + changes.added + " lignes, −" + changes.removed + " lignes"
      : "Statut Git indisponible";
    $("sessionstat-background-value").textContent = String(data.backgroundTasks ?? "—");
    $("sessionstat-artifacts-value").textContent = data.artifacts == null ? "N/D" : data.artifacts >= 500 ? "500+" : String(data.artifacts);
  } catch {
    if (active === v) {
      for (const metric of document.querySelectorAll(".sysmetric .sysvalue")) metric.textContent = "—";
      for (const stat of document.querySelectorAll(".sessionstat-value")) stat.textContent = "—";
    }
  } finally {
    overviewBusy = false;
  }
}
setInterval(() => { if (active && !document.hidden) void refreshSessionOverview(active); }, 2000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && active) void refreshSessionOverview(active); });
$("sessionstat-changes").onclick = () => { if (active) openReviewTab(active); };
$("sessionstat-background").onclick = () => { if (active) openCC("overview"); };
$("sessionstat-artifacts").onclick = () => { if (active) openCC("c3"); };
function newSession(path) {
  post("/sessions/new", { workspace: path }).then((r) => { if (r.id) { pendingSelect = r.id; show(r.id); } else if (r.error) alert(r.error); });
}
function renderSidebar() {
  const list = $("wslist");
  list.innerHTML = "";
  renderTaskRail();
  if (!hub.workspaces.length) return;
  for (const w of hub.workspaces) {
    const box = el("div", "ws");
    const hdr = el("div", "wshdr"); hdr.title = w.path;
    hdr.appendChild(el("span", "wsname", w.name)); hdr.appendChild(el("span", "grow"));
    const plus = el("button", "iconbtn", "+");     plus.title = "Nouvelle session dans " + w.name;
    plus.onclick = (e) => { e.stopPropagation(); newSession(w.path); };
    const rm = el("button", "iconbtn", "×");     rm.title = "Retirer " + w.name + " de la liste";
    rm.onclick = (e) => { e.stopPropagation(); removeWorkspace(w); };
    hdr.appendChild(plus); hdr.appendChild(rm);
    if (!w.sessions.length) { hdr.style.cursor = "pointer"; hdr.onclick = () => newSession(w.path); }
    box.appendChild(hdr);
    const sl = el("div", "sessions");
    for (const s of w.sessions) {
      const v = views.get(s.id);
      const row = el("div", "sess " + (s.live ? s.status : "stored") + (active && active.sid === s.id ? " active" : "") + (v && v.unread ? " unread" : ""));
      row.appendChild(el("span", "dot"));
      row.appendChild(el("span", "stitle" + (s.title ? "" : " untitled"), s.title || "nouvelle session"));
      if (s.plan) row.appendChild(el("span", "stime", String(s.plan)));
      row.appendChild(el("span", "stime", rel(s.updatedAt)));
      if (s.live) {
        const sh = el("button", "iconbtn", "⍾");
        sh.title = "Copier un lien de suivi en direct (lecture seule)";
        sh.onclick = (e) => { e.stopPropagation(); shareSession(s.id); };
        row.appendChild(sh);
      }
      const x = el("button", "iconbtn", "×");
      x.title = s.live ? "Fermer la session (conservée dans la liste)" : "Supprimer la session";
      x.onclick = (e) => {
        e.stopPropagation();
        if (s.live) post("/sessions/close", { id: s.id });
        else if (confirm("Supprimer définitivement cette session ?")) post("/sessions/delete", { id: s.id });
      };
      row.appendChild(x);
      row.title = (s.title || "nouvelle session") + (s.model ? " · " + s.model : "") + (s.live ? " · " + s.status : " · enregistrée — cliquez pour reprendre") + (s.viewers && s.viewers.length ? " · 👁 " + s.viewers.join(", ") : "") + (s.editing && s.editing.length ? " · ✎ " + s.editing.map((e) => e.name + ": " + e.path + ":" + e.line).join(", ") : "");
      row.onclick = () => select(s.id);
      row.ondblclick = () => { const t = prompt("Renommer la session", s.title || ""); if (t !== null && t.trim()) post("/sessions/rename", { id: s.id, title: t }); };
      sl.appendChild(row);
    }
    box.appendChild(sl);
    list.appendChild(box);
  }
}

/** Sidebar rail: the active session's plan steps, with a live done counter.
 * Reads state.plan.steps (what Session.state() actually sends) and hides
 * itself when there is no plan yet. */
function renderTaskRail() {
  const rail = $("taskrail");
  const list = $("taskrail-list");
  if (!rail || !list) return;
  const plan = active && active.state ? active.state.plan : null;
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  if (!steps.length) {
    rail.hidden = true;
    return;
  }
  rail.hidden = false;
  list.innerHTML = "";
  const done = steps.filter((s) => s.done).length;
  const head = $("taskrail-head");
  if (head) head.textContent = done + "/" + steps.length + " · tâches";
  steps.forEach((step, i) => {
    const current = plan.current === i;
    const item = el("div", "taskrail-item" + (step.done ? " done" : "") + (current ? " current" : ""));
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "taskrail-checkbox";
    cb.checked = !!step.done;
    cb.title = step.done ? "marquer comme non terminée" : "marquer comme terminée";
    cb.onchange = () => {
      const want = cb.checked;
      step.done = want; // optimistic — the server answer re-syncs below
      renderTaskRail();
      if (!active) return;
      const sid = active.sid, state = active.state;
      post("/plan/done", { sid, step: i + 1, done: want }).then((r) => {
        if (r && r.error) { step.done = !want; renderTaskRail(); showToast(r.error, "error"); return; }
        if (r && r.plan && state && state.plan) {
          state.plan.steps = r.plan.steps;
          state.plan.current = r.plan.current;
          renderTaskRail();
          renderState(active);
        }
      }).catch(() => { step.done = !want; renderTaskRail(); });
    };
    const text = el("span", "taskrail-text", step.text);
    item.title = step.note ? step.text + " — " + step.note : step.text;
    item.appendChild(cb);
    item.appendChild(text);
    if (current) item.appendChild(el("span", "taskrail-now", "›"));
    list.appendChild(item);
  });
}

function removeWorkspace(w) {
  if (w.sessions.some((s) => s.live)) { alert("Fermez d'abord les sessions ouvertes dans " + w.name + "."); return; }
  const n = w.sessions.length;
  if (!confirm("Retirer " + w.name + " de la liste ?" + (n ? " Ses " + n + " session" + (n > 1 ? "s" : "") + " enregistrée" + (n > 1 ? "s" : "") + " seront supprimées." : ""))) return;
  post("/workspaces/remove", { path: w.path }).then((r) => { if (r.error) alert(r.error); });
}
function renderCrumb() {
  const c = $("crumb");
  c.innerHTML = "";
  if (!active) { c.appendChild(el("span", "ws", "smolcoder")); c.title = ""; return; }
  const info = sessInfo.get(active.sid);
  c.appendChild(el("span", "ws", info ? info.wsname : ""));
  c.appendChild(el("span", "sep", "›"));
  c.appendChild(el("span", "title", active.state.title || (info && info.title) || "nouvelle session"));
  c.title = info ? info.workspace : "";
  if (info && info.plan) {
    const chip = el("button", "planchip", "☑ " + info.plan);
    chip.type = "button"; chip.title = "Ouvrir la liste des tâches";
    chip.onclick = () => togglePanelKind("plan");
    c.appendChild(chip);
  }
}
function renderTitle() {
  let busy = false, waiting = false;
  for (const s of sessInfo.values()) { if (s.status === "busy" || s.status === "starting") busy = true; if (s.status === "waiting") waiting = true; }
  const info = active && sessInfo.get(active.sid);
  document.title = (waiting ? "⚠ " : busy ? "● " : "") + (info ? (info.title || info.wsname) + " · " : "") + "smol";
}
function renderWelcome() {
  const w = $("welcome");
  w.hidden = !!active;
  if (active) return;
  const r = $("recent");
  r.innerHTML = "";
  const ws = hub.workspaces.slice(0, 8);
  if (!ws.length) return;
  r.appendChild(el("div", "recent-label", "Recent"));
  for (const x of ws) {
    const b = el("button", "wsbtn");
    b.appendChild(el("span", "", x.name)); b.appendChild(el("span", "dim", "  " + x.display));
    b.onclick = () => newSession(x.path);
    r.appendChild(b);
  }
}
setInterval(() => { renderSidebar(); }, 30000);

// ---- folder picker --------------------------------------------------------
let fsState = { path: "", parent: null };
function openDialog(start) {
  $("modal").hidden = false;
  browse(start || (active && active.state.workspace) || "");
  setTimeout(() => $("fspath").focus(), 0);
}
function closeDialog() { $("modal").hidden = true; }
function browse(p) {
  fetch("/fs?k=" + k + "&path=" + encodeURIComponent(p || "")).then((r) => r.json()).then(renderFs).catch(() => {});
}
function renderFs(d) {
  const list = $("fslist");
  list.innerHTML = "";
  const roots = $("fsroots");
  roots.innerHTML = "";
  const chip = (label, p) => { const c = el("span", "chip", label); c.onclick = () => browse(p); roots.appendChild(c); };
  chip("~ home", d.home);
  for (const r of d.roots || []) chip(r, r);
  if (d.error) { $("fspath").value = d.path || ""; list.appendChild(el("div", "sidehint", d.error)); $("fsopen").disabled = true; return; }
  $("fsopen").disabled = false;
  fsState = d;
  $("fspath").value = d.path;
  $("fsopen").textContent = "Ouvrir " + (d.path.split(/[\\/]/).filter(Boolean).pop() || d.path) + (d.project ? " ✦" : "");
  if (d.parent) { const up = el("div", "fsitem up", "↑ .."); up.onclick = () => browse(d.parent); list.appendChild(up); }
  for (const dir of d.dirs) {
    const it = el("div", "fsitem");
    it.appendChild(el("span", "", dir.name + "/"));
    if (dir.project) it.appendChild(el("span", "proj", "✦ project"));
    it.onclick = () => browse(dir.path);
    it.ondblclick = () => openFolder(dir.path);
    list.appendChild(it);
  }
  if (!d.dirs.length) list.appendChild(el("div", "sidehint", "aucun sous-dossier"));
}
function openFolder(p) {
  post("/workspaces/add", { path: p, start: $("fsstart").checked }).then((r) => {
    if (r.error) { alert(r.error); return; }
    closeDialog();
    if (r.id) { pendingSelect = r.id; show(r.id); }
  });
}
$("openfolder").onclick = () => openDialog();
$("welcomeopen").onclick = () => openDialog();
$("fsclose").onclick = closeDialog;
$("modal").onclick = (e) => { if (e.target === $("modal")) closeDialog(); };
$("fsgo").onclick = () => browse($("fspath").value);
$("fspath").onkeydown = (e) => { if (e.key === "Enter") browse($("fspath").value); };
$("fsopen").onclick = () => openFolder(fsState.path);

// ---- right panel: browser + terminal tabs ---------------------------------
let panelWidth = Math.max(300, Number(ls.get("smol.panel.w")) || 520);
function panelKey(v) { return "smol.panel." + v.sid; }
function savePanel(v) {
  ls.set(panelKey(v), JSON.stringify({ open: v.panelOpen, active: v.activeTab, tabs: v.tabs.filter((t) => t.kind === "browser").map((t) => ({ kind: "browser", url: t.url })) }));
}
function loadPanelState(v) {
  try {
    const st = JSON.parse(ls.get(panelKey(v)) || "null");
    if (!st) return;
    for (const t of st.tabs || []) {
      if (t.kind !== "browser") continue;
      const tab = { kind: "browser", url: t.url || "", id: uid() };
      buildBrowserTab(v, tab); v.tabs.push(tab);
    }
    v.panelOpen = false;
    v.activeTab = st.active || (v.tabs[0] && v.tabs[0].id) || null;
  } catch (e) {}
}
function updateReviewBadge(count) {
  const badge = $("review-badge");
  if (!badge) return;
  const n = Number(count) || 0;
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.hidden = n <= 0;
}
function fetchReviewBadge() {
  if (!active) return;
  fetch("/code/diff?k=" + k + "&sid=" + encodeURIComponent(active.sid))
    .then((r) => r.json())
    .then((d) => {
      const cnt = (d.files || []).length;
      updateReviewBadge(cnt);
    })
    .catch(() => {});
}
function curTab(v) { return v.tabs.find((t) => t.id === v.activeTab) || v.tabs[0] || null; }
// ---- VS Code Pro Dock State & Tabs ----------------------------------------
let workspaceDiagnostics = [];
let outputChannels = {
  "Continuous Validation": [],
  "TypeScript": [],
  "Biome": [],
  "Hub Tasks": [],
  "Console": [],
  "Logs": []
};
let activeOutputChannel = "Continuous Validation";
let debugLogs = [
  { type: "info", text: "Smolcoder Debug Console [Version 0.7.1]" },
  { type: "info", text: "Tapez une expression JavaScript pour l'évaluer ou inspecter l'environnement." }
];
let debugHistory = [];
let debugHistIdx = 0;
let termSidebarMode = false;
let hubPort = Number(location.port) || (location.protocol === "https:" ? 443 : 80);
let detectedPorts = [
  { port: hubPort, protocol: "HTTP", service: "Smolcoder Web Hub", status: "En écoute", openUrl: location.origin },
  { port: 11434, protocol: "HTTP", service: "Ollama LLM Engine", status: "Inactif", openUrl: "http://127.0.0.1:11434" },
  { port: 1234, protocol: "HTTP", service: "LM Studio API", status: "Inactif", openUrl: "http://127.0.0.1:1234" }
];

let workspaceScanError = null;
let workspaceScanMessage = null;
let workspaceScanned = false;
let problemsHideWarnings = false;
function outStamp() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
}

function scanWorkspaceProblems(v) {
  if (!v) return;
  workspaceScanError = null;
  fetch("/workspace/diagnostics?k=" + k + "&sid=" + encodeURIComponent(v.sid) + "&scope=all")
    .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
    .then(({ ok, d }) => {
      if (!ok || (d && d.error)) throw new Error((d && d.error) || "analyse impossible");
      workspaceDiagnostics = [];
      workspaceScanned = true;
      workspaceScanMessage = (d && d.message) || null;
      let errCnt = 0, warnCnt = 0;
      const list = d && Array.isArray(d.diagnostics) ? d.diagnostics : [];
      for (const e of list) {
        const sev = e.severity === "warning" ? "warning" : e.severity === "info" ? "info" : "error";
        if (sev === "error") errCnt++;
        else if (sev === "warning") warnCnt++;
        workspaceDiagnostics.push({
          path: e.path || e.file || "workspace",
          line: e.line || 1,
          col: e.column || e.col || 1,
          message: e.message || String(e),
          severity: sev
        });
        if (/\bTS\d{3,}\b/.test(e.message || "")) {
          appendOutputLog("TypeScript", outStamp() + " " + (e.path || "?") + ":" + (e.line || 1) + " " + e.message);
        }
      }
      appendOutputLog("Continuous Validation", outStamp() + " Scan workspace (" + (d && typeof d.scanned === "number" ? d.scanned + " fichier(s)" : "ok") + ") : " + errCnt + " erreur(s), " + warnCnt + " avertissement(s)");
      const pt = v.tabs.find((x) => x.kind === "problems");
      if (pt && pt.render) pt.render();
      renderPanel();
    })
    .catch((err) => {
      workspaceScanError = String(err && err.message ? err.message : err);
      appendOutputLog("Continuous Validation", outStamp() + " Scan échoué : " + workspaceScanError);
      const pt = v.tabs.find((x) => x.kind === "problems");
      if (pt && pt.render) pt.render();
    });
}
// Automatic workspace scan (VS Code style): debounced, fired on session show,
// after every agent turn and after every file save.
let problemsScanTimer = null;
function scheduleProblemsScan(v, delay = 1200) {
  if (!v) return;
  if (problemsScanTimer) clearTimeout(problemsScanTimer);
  problemsScanTimer = setTimeout(() => {
    problemsScanTimer = null;
    scanWorkspaceProblems(views.get(v.sid) || v);
  }, delay);
}

function ensureProblemsTab(v) {
  let t = v.tabs.find((x) => x.kind === "problems");
  if (t) return t;
  t = { kind: "problems", id: "p:problems", filter: "" };
  const body = el("div", "tabbody vsc-problems"); body.hidden = true;
  const content = el("div", "problems-content");
  body.appendChild(content);
  v.panelEl.appendChild(body);
  t.el = body; t.content = content;
  t.render = () => renderProblemsView(v, t);
  v.tabs.push(t);
  t.render();
  return t;
}

function renderProblemsView(v, t) {
  const content = t.content;
  content.innerHTML = "";
  const filter = (t.filter || "").toLowerCase().trim();
  const diags = workspaceDiagnostics.filter((d) => {
    if (problemsHideWarnings && d.severity !== "error") return false;
    if (!filter) return true;
    return (d.path && d.path.toLowerCase().includes(filter)) || (d.message && d.message.toLowerCase().includes(filter));
  });
  if (!diags.length) {
    const empty = el("div", "problems-empty",
      workspaceScanError ? "Scan impossible : " + workspaceScanError
        : !workspaceScanned ? "Cliquez sur ↻ Re-scan pour analyser le workspace."
        : workspaceScanMessage ? workspaceScanMessage
        : "Aucun problème détecté dans le workspace.");
    content.appendChild(empty);
    const emptyBar = el("div", "prob-action-bar");
    const refreshEmptyBtn = el("button", "prob-btn ghost", "↻ Re-scan");
    refreshEmptyBtn.title = "Analyser tous les fichiers TypeScript/JavaScript/JSON du workspace";
    refreshEmptyBtn.onclick = () => { scanWorkspaceProblems(v); };
    emptyBar.appendChild(refreshEmptyBtn);
    content.appendChild(emptyBar);
    return;
  }
  const headBar = el("div", "prob-action-bar");
  const sendAllBtn = el("button", "prob-btn primary", "⚡ Tout envoyer à l'agent");
  sendAllBtn.title = "Envoyer TOUS les problèmes détectés à l'agent pour correction automatique (comme Send to Copilot dans VS Code)";
  sendAllBtn.onclick = () => {
    const summary = diags.map((d) => "- " + d.path + ":" + (d.line || 1) + " [" + (d.severity || "error") + "] " + d.message).join("\n");
    post("/msg", { sid: v.sid, text: "Corrige tous ces problèmes détectés dans le workspace, un par un, cause racine d'abord, puis relance une validation :\n" + summary });
    showToast("Tous les problèmes envoyés à l'agent", "info");
  };
  const refreshBtn = el("button", "prob-btn ghost", "↻ Re-scan");
  refreshBtn.title = "Rafraîchir les diagnostics du workspace";
  refreshBtn.onclick = () => { scanWorkspaceProblems(v); };
  const countBadge = el("span", "prob-total-badge", diags.length + " problem" + (diags.length > 1 ? "s" : ""));
  headBar.append(sendAllBtn, refreshBtn, countBadge);
  content.appendChild(headBar);

  const byFile = new Map();
  for (const d of diags) {
    const arr = byFile.get(d.path) || [];
    arr.push(d);
    byFile.set(d.path, arr);
  }
  const tree = el("div", "prob-tree");
  for (const [filePath, items] of byFile) {
    const fGroup = el("div", "prob-file-group");
    const fHeader = el("div", "prob-file-header");
    const chevron = el("span", "prob-chevron", "⌵");
    const fIcon = el("span", "prob-file-icon", "📄");
    const fName = el("span", "prob-file-name", filePath);
    const fBadge = el("span", "prob-file-badge", String(items.length));
    fHeader.append(chevron, fIcon, fName, fBadge);
    const itemsList = el("div", "prob-items-list");
    fHeader.onclick = () => {
      itemsList.hidden = !itemsList.hidden;
      chevron.textContent = itemsList.hidden ? "›" : "⌵";
    };
    for (const item of items) {
      const row = el("div", "prob-item-row " + (item.severity || "error"));
      const sIcon = el("span", "prob-severity-icon", item.severity === "warning" ? "⚠" : item.severity === "info" ? "ℹ" : "⊗");
      const msg = el("span", "prob-message", item.message);
      const loc = el("span", "prob-loc", "[" + (item.line || 1) + ", " + (item.col || 1) + "]");
      loc.title = "Cliquer pour ouvrir dans l'éditeur";
      loc.onclick = (e) => {
        e.stopPropagation();
        openFilesTab(v);
        const fTab = v.tabs.find((x) => x.kind === "files");
        if (fTab && fTab.loadFile) {
          fTab.loadFile(filePath).then(() => {
            if (fTab.goToLine) fTab.goToLine(item.line || 1);
          });
        }
      };
      const fixBtn = el("button", "prob-fix-btn", "⚡ Fix");
      fixBtn.title = "Envoyer ce problème précis à l'agent";
      fixBtn.onclick = (e) => {
        e.stopPropagation();
        post("/msg", { sid: v.sid, text: "Corrige le problème suivant dans " + filePath + " ligne " + (item.line || 1) + " : " + item.message });
        showToast("Problème envoyé à l'agent !", "info");
      };
      row.append(sIcon, msg, loc, fixBtn);
      itemsList.appendChild(row);
    }
    fGroup.append(fHeader, itemsList);
    tree.appendChild(fGroup);
  }
  content.appendChild(tree);
}

function ensureOutputTab(v) {
  let t = v.tabs.find((x) => x.kind === "output");
  if (t) return t;
  t = { kind: "output", id: "p:output" };
  const body = el("div", "tabbody vsc-output"); body.hidden = true;
  const bar = el("div", "vsc-sub-bar");
  const sel = document.createElement("select");
  sel.className = "vsc-channel-select";
  for (const ch of Object.keys(outputChannels)) {
    const opt = document.createElement("option"); opt.value = ch; opt.textContent = ch; sel.appendChild(opt);
  }
  sel.value = activeOutputChannel;
  sel.onchange = () => { activeOutputChannel = sel.value; t.render(); };
  const clearBtn = el("button", "iconbtn", "🧹"); clearBtn.title = "Effacer la sortie";
  clearBtn.onclick = () => { outputChannels[activeOutputChannel] = []; t.render(); };
  const copyBtn = el("button", "iconbtn", "📋"); copyBtn.title = "Copier la sortie";
  copyBtn.onclick = () => {
    navigator.clipboard.writeText((outputChannels[activeOutputChannel] || []).join("\n"));
    showToast("Sortie copiée dans le presse-papiers", "info");
  };
  const logsBtn = el("button", "iconbtn", "📥"); logsBtn.title = "Charger les journaux smolcoder (200 dernières lignes)";
  logsBtn.onclick = () => {
    logsBtn.disabled = true;
    fetch("/logs?k=" + encodeURIComponent(k))
      .then((r) => r.json())
      .then((d) => {
        const lines = (d && d.logs) || [];
        outputChannels["Logs"] = lines;
        activeOutputChannel = "Logs";
        // Sync any channel selector present in the DOM (tab sub-bar).
        document.querySelectorAll(".vsc-channel-select").forEach((s) => { s.value = "Logs"; });
        t.render();
        showToast(lines.length ? lines.length + " ligne(s) de journal chargée(s)" : "Aucun journal disponible", lines.length ? "info" : "warn");
      })
      .catch(() => showToast("Lecture des journaux impossible", "error"))
      .finally(() => { logsBtn.disabled = false; });
  };
  bar.append(sel, el("span", "grow"), logsBtn, clearBtn, copyBtn);
  const logPre = el("pre", "vsc-output-log");
  body.append(bar, logPre);
  v.panelEl.appendChild(body);
  t.el = body; t.logPre = logPre;
  t.render = () => {
    const lines = outputChannels[activeOutputChannel] || [];
    logPre.textContent = lines.join("\n") || "Sortie vide.";
    logPre.scrollTop = logPre.scrollHeight;
  };
  v.tabs.push(t);
  t.render();
  return t;
}

function appendOutputLog(channel, text) {
  if (!outputChannels[channel]) outputChannels[channel] = [];
  outputChannels[channel].push(text);
  if (outputChannels[channel].length > 1000) outputChannels[channel].shift();
  if (active) {
    const t = active.tabs.find((x) => x.kind === "output");
    if (t && t.render && activeOutputChannel === channel) t.render();
  }
}
// Mirror browser console errors/warnings into the Output "Console" channel
// (keeps the original console intact).
(function hookConsoleToOutput() {
  const fmt = (a) => a.map((x) => {
    try { return typeof x === "string" ? x : JSON.stringify(x); }
    catch { return String(x); }
  }).join(" ");
  const origErr = console.error;
  const origWarn = console.warn;
  console.error = function (...a) { try { appendOutputLog("Console", outStamp() + " [erreur] " + fmt(a)); } catch {} return origErr.apply(console, a); };
  console.warn = function (...a) { try { appendOutputLog("Console", outStamp() + " [avertissement] " + fmt(a)); } catch {} return origWarn.apply(console, a); };
})();

function ensureDebugConsoleTab(v) {
  let t = v.tabs.find((x) => x.kind === "debug");
  if (t) return t;
  t = { kind: "debug", id: "p:debug" };
  const body = el("div", "tabbody vsc-debug"); body.hidden = true;
  const logBox = el("div", "vsc-debug-logs");
  const promptRow = el("div", "vsc-debug-inputrow");
  const promptSign = el("span", "vsc-debug-prompt", "❯ ");
  const inp = document.createElement("input");
  inp.className = "vsc-debug-input";
  inp.placeholder = "Évaluer une expression JavaScript (ex: location.href, hub.version)...";
  inp.spellcheck = false;
  inp.onkeydown = (e) => {
    if (e.key === "Enter") {
      const code = inp.value.trim();
      if (!code) return;
      inp.value = "";
      debugHistory.push(code);
      debugHistIdx = debugHistory.length;
      debugLogs.push({ type: "input", text: "❯ " + code });
      try {
        const res = eval(code);
        debugLogs.push({ type: "result", text: typeof res === "object" ? JSON.stringify(res, null, 2) : String(res) });
      } catch (err) {
        debugLogs.push({ type: "error", text: String(err && err.message ? err.message : err) });
      }
      t.render();
    } else if (e.key === "ArrowUp") {
      if (debugHistIdx > 0) { debugHistIdx--; inp.value = debugHistory[debugHistIdx] || ""; }
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      if (debugHistIdx < debugHistory.length - 1) { debugHistIdx++; inp.value = debugHistory[debugHistIdx] || ""; }
      else { debugHistIdx = debugHistory.length; inp.value = ""; }
      e.preventDefault();
    }
  };
  promptRow.append(promptSign, inp);
  body.append(logBox, promptRow);
  v.panelEl.appendChild(body);
  t.el = body; t.logBox = logBox; t.inp = inp;
  t.render = () => {
    logBox.innerHTML = "";
    for (const l of debugLogs) {
      const row = el("div", "vsc-debug-row " + l.type, l.text);
      logBox.appendChild(row);
    }
    logBox.scrollTop = logBox.scrollHeight;
  };
  v.tabs.push(t);
  t.render();
  return t;
}

function ensurePortsTab(v) {
  let t = v.tabs.find((x) => x.kind === "ports");
  if (t) return t;
  t = { kind: "ports", id: "p:ports" };
  const body = el("div", "tabbody vsc-ports"); body.hidden = true;
  const bar = el("div", "vsc-sub-bar");
  const title = el("span", "hint", "Ports et services locaux du workspace");
  const refreshBtn = el("button", "iconbtn", "↻"); refreshBtn.title = "Rafraîchir les ports";
  refreshBtn.onclick = () => { t.scan(); };
  bar.append(title, el("span", "grow"), refreshBtn);
  const table = el("table", "vsc-ports-table");
  const thead = el("thead");
  thead.innerHTML = "<tr><th>Port</th><th>Protocole</th><th>Service</th><th>Statut</th><th>Action</th></tr>";
  const tbody = el("tbody");
  table.append(thead, tbody);
  body.append(bar, table);
  v.panelEl.appendChild(body);
  t.el = body; t.table = table; t.tbody = tbody;
  t.render = () => {
    tbody.innerHTML = "";
    for (const p of detectedPorts) {
      const tr = el("tr");
      tr.appendChild(el("td", "port-num", String(p.port)));
      tr.appendChild(el("td", "", p.protocol));
      tr.appendChild(el("td", "port-service", p.service));
      const tdSt = el("td");
      const badge = el("span", "port-status-badge " + (p.status.includes("écoute") || p.status.includes("Prêt") ? "ok" : "warn"), p.status);
      tdSt.appendChild(badge);
      tr.appendChild(tdSt);
      const tdAct = el("td");
      const openBtn = el("button", "port-open-btn", "Ouvrir ↗");
      openBtn.onclick = () => window.open(p.openUrl, "_blank");
      tdAct.appendChild(openBtn);
      tr.appendChild(tdAct);
      tbody.appendChild(tr);
    }
  };
  t.scan = () => {
    const probe = (port, okStatus) => {
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), 1200) : null;
      fetch("http://127.0.0.1:" + port + "/", { mode: "no-cors", cache: "no-store", signal: ctl ? ctl.signal : undefined })
        .then(() => { const row = detectedPorts.find((x) => x.port === port); if (row) row.status = okStatus; })
        .catch(() => { const row = detectedPorts.find((x) => x.port === port); if (row) row.status = "Inactif"; })
        .finally(() => { if (timer) clearTimeout(timer); t.render(); });
    };
    probe(11434, "En écoute");
    probe(1234, "Prêt");
    t.render();
  };
  v.tabs.push(t);
  t.render();
  t.scan();
  return t;
}

function ensureProDockTabs(v) {
  if (!v) return;
  ensureProblemsTab(v);
  ensureOutputTab(v);
  ensureDebugConsoleTab(v);
  ensurePortsTab(v);
}

function curTab(v) { return v.tabs.find((t) => t.id === v.activeTab) || v.tabs[0] || null; }

function renderPanel() {
  const v = active;
  const open = !!(v && v.panelOpen && v.tabs.length);
  panelEl.hidden = !open;
  const cur = open ? curTab(v) : null;
  const dockOrder = ["problems", "output", "debug", "term", "ports"];
  const isDock = cur && dockOrder.includes(cur.kind);
  if (v && v.panelOpen && isDock) ensureProDockTabs(v);
  if (filesBtn) filesBtn.classList.toggle("on", !!(cur && cur.kind === "files"));
  $("btnbrowser").classList.toggle("on", !!(cur && cur.kind === "browser"));
  $("btnterm").classList.toggle("on", !!(cur && cur.kind === "term"));
  const bp = $("btnproblems");
  if (bp) bp.classList.toggle("on", !!(cur && cur.kind === "problems"));
  for (const o of views.values()) o.panelEl.hidden = o !== v || !open;
  if (!open) return;
  panelEl.style.width = Math.min(panelWidth, Math.max(300, window.innerWidth * 0.6)) + "px";
  tabsEl.innerHTML = "";

  const dockLabels = {
    problems: "Problems",
    output: "Output",
    debug: "Debug Console",
    term: "Terminal",
    ports: "Ports"
  };

  const tabsLeft = el("div", "vsc-dock-tabs");
  if (isDock) {
    // Mode Dock/Terminal : afficher UNIQUEMENT les onglets du terminal
    for (const kind of dockOrder) {
      const t = v.tabs.find((x) => x.kind === kind);
      if (!t) continue;
      const isAct = cur && cur.kind === kind;
      const b = el("button", "vsc-tab" + (isAct ? " on" : ""));
      b.type = "button";
      let lbl = dockLabels[kind] || kind;
      if (kind === "problems" && workspaceDiagnostics.length > 0) {
        lbl += " " + workspaceDiagnostics.length;
      }
      b.textContent = lbl;
      b.onclick = () => {
        v.activeTab = t.id;
        savePanel(v);
        renderPanel();
        if (t.kind === "term" && t.inp) t.inp.focus();
      };
      tabsLeft.appendChild(b);
    }
  } else {
    // Mode Éditeur/Fichiers : les onglets du terminal restent MASQUÉS
    for (const t of v.tabs) {
      if (dockOrder.includes(t.kind)) continue;
      const isAct = t === cur;
      const b = el("div", "ptab" + (isAct ? " on" : ""));
      b.appendChild(el("span", "ico", t.kind === "browser" ? "◎" : t.kind === "files" ? "▤" : t.kind === "review" ? "Δ" : "☑"));
      b.appendChild(el("span", "lbl", t.kind === "browser" ? (t.url ? t.url.replace(/^https?:\/\//, "") : "nouvel onglet") : t.kind === "files" ? "fichiers du projet" : t.kind === "review" ? "révision" : "tâches"));
      const x = el("span", "x", "×");
      x.title = "Fermer l'onglet";
      x.onclick = (e) => { e.stopPropagation(); closeTab(v, t); };
      b.appendChild(x);
      b.onclick = () => { v.activeTab = t.id; savePanel(v); renderPanel(); };
      tabsLeft.appendChild(b);
    }
  }
  tabsEl.appendChild(tabsLeft);
  const legacyWrap = el("div", "vsc-legacy-actions");
    const nb = el("button", "iconbtn", "+◎"); nb.title = "Nouvel onglet navigateur"; nb.onclick = () => openBrowserTab(v);
    const nf = el("button", "iconbtn", "+▤"); nf.title = "Fichiers du projet"; nf.onclick = () => openFilesTab(v);
    const ns = el("button", "iconbtn", "+⊞"); ns.title = "Fractionné : second panneau de fichiers"; ns.onclick = () => openFilesTab(v, false, true);
    const nr = el("button", "iconbtn", "+Δ"); nr.title = "Réviser les changements non committés"; nr.onclick = () => openReviewTab(v);
    const np = el("button", "iconbtn", "+☑"); np.title = "Liste des tâches"; np.onclick = () => openPlanTab(v);
    const nt = el("button", "iconbtn", "+>_"); nt.title = "Nouveau terminal"; nt.onclick = () => openTerminalTab(v);
    const cl = el("button", "iconbtn", "»"); cl.title = "Masquer le panneau"; cl.onclick = () => { v.panelOpen = false; savePanel(v); renderPanel(); };
  legacyWrap.append(nb, nf, ns, nr, np, nt, cl);
  tabsEl.appendChild(legacyWrap);
  tabsEl.appendChild(el("span", "grow"));

  // 2. Toolbar droite dynamique identique à VS Code
  const toolRight = el("div", "vsc-dock-tools");
  if (cur && cur.kind === "term") {
    const termsList = v.tabs.filter((x) => x.kind === "term");
    if (!termSidebarMode) {
      // Mode Dropdown (Capture 1 de l'utilisateur) : [>_] pwsh - DELL v
      const termDropdown = el("div", "vsc-term-dropdown");
      const termIcon = el("span", "vsc-term-ico", ">_");
      const termTitle = el("span", "vsc-term-title", "pwsh - DELL" + (termsList.length > 1 ? " (" + (termsList.indexOf(cur) + 1) + ")" : ""));
      const termChevron = el("span", "vsc-term-chevron", " ⌵");
      termDropdown.append(termIcon, termTitle, termChevron);
      termDropdown.title = "Terminaux actifs — cliquer pour basculer";
      termDropdown.onclick = (e) => {
        e.stopPropagation();
        const items = termsList.map((tm, idx) => ({
          label: (idx + 1) + ": pwsh - DELL" + (tm === cur ? " (actif)" : ""),
          on: tm === cur,
          run: () => { v.activeTab = tm.id; savePanel(v); renderPanel(); if (tm.inp) tm.inp.focus(); }
        }));
        items.push(null);
        items.push({
          label: "+ Nouveau terminal (PowerShell)",
          run: () => openTerminalTab(v)
        });
        items.push({
          label: "Afficher la barre latérale des terminaux",
          run: () => { termSidebarMode = true; renderPanel(); }
        });
        statusMenu(termDropdown, ["Terminaux", ...items]);
      };
      toolRight.appendChild(termDropdown);

      // Bouton + v (Nouveau terminal)
      const newTermBtn = el("button", "vsc-tool-btn", "+ ⌵");
      newTermBtn.title = "Nouveau terminal (PowerShell)";
      newTermBtn.onclick = (e) => {
        e.stopPropagation();
        openTerminalTab(v);
      };
      toolRight.appendChild(newTermBtn);

      // Bouton @
      const atBtn = el("button", "vsc-tool-btn", "@");
      atBtn.title = "Environnement local : DELL";
      atBtn.onclick = () => showToast("Environnement d'exécution : Machine locale DELL", "info");
      toolRight.appendChild(atBtn);

      // Bouton Split [|]
      const splitBtn = el("button", "vsc-tool-btn", "◫");
      splitBtn.title = "Diviser le terminal";
      splitBtn.onclick = () => openTerminalTab(v);
      toolRight.appendChild(splitBtn);

      // Bouton Poubelle 🗑
      const killBtn = el("button", "vsc-tool-btn", "🗑");
      killBtn.title = "Fermer / Tuer le terminal actif";
      killBtn.onclick = () => closeTab(v, cur);
      toolRight.appendChild(killBtn);

      // Bouton ...
      const moreBtn = el("button", "vsc-tool-btn", "…");
      moreBtn.title = "Options du terminal";
      moreBtn.onclick = (e) => {
        e.stopPropagation();
        statusMenu(moreBtn, [
          "Terminal Pro",
          {
            label: "Afficher la barre latérale des onglets",
            run: () => { termSidebarMode = true; renderPanel(); }
          },
          {
            label: "Effacer l'affichage (Ctrl+L)",
            run: () => { if (cur.out) cur.out.innerHTML = ""; cur.cur = null; cur.lines = 0; }
          },
          {
            label: "Interrompre la commande (Ctrl+C)",
            run: () => post("/term/interrupt", { sid: v.sid, tid: cur.tid })
          },
          {
            label: "Redémarrer ce terminal",
            run: () => { closeTab(v, cur); openTerminalTab(v); }
          }
        ]);
      };
      toolRight.appendChild(moreBtn);
    } else {
      // Mode Sidebar active (Capture 2 de l'utilisateur) : + ⌵, ..., 🗑
      const newTermBtn = el("button", "vsc-tool-btn", "+ ⌵");
      newTermBtn.title = "Nouveau terminal";
      newTermBtn.onclick = () => openTerminalTab(v);
      toolRight.appendChild(newTermBtn);

      const killBtn = el("button", "vsc-tool-btn", "🗑");
      killBtn.title = "Fermer le terminal";
      killBtn.onclick = () => closeTab(v, cur);
      toolRight.appendChild(killBtn);

      const moreBtn = el("button", "vsc-tool-btn", "…");
      moreBtn.title = "Options du terminal";
      moreBtn.onclick = (e) => {
        e.stopPropagation();
        statusMenu(moreBtn, [
          "Terminal Pro",
          {
            label: "Masquer la barre latérale (mode dropdown)",
            run: () => { termSidebarMode = false; renderPanel(); }
          },
          {
            label: "Effacer l'affichage (Ctrl+L)",
            run: () => { if (cur.out) cur.out.innerHTML = ""; cur.cur = null; cur.lines = 0; }
          }
        ]);
      };
      toolRight.appendChild(moreBtn);
    }
  } else if (cur && cur.kind === "problems") {
    // Filtre Filter (e.g. text, **/*.ts, !**/nod...
    const filterBox = el("div", "vsc-filter-box");
    const filterIn = document.createElement("input");
    filterIn.className = "vsc-filter-in";
    filterIn.placeholder = "Filtrer (ex. texte, **/*.ts, !**/nod...";
    filterIn.value = cur.filter || "";
    filterIn.oninput = () => {
      cur.filter = filterIn.value;
      if (cur.render) cur.render();
    };
    const filterIco = el("span", "vsc-filter-ico", "⑂");
    filterIco.title = "Filtre actif";
    filterBox.append(filterIn, filterIco);
    toolRight.appendChild(filterBox);

    const treeToggle = el("button", "vsc-tool-btn", "⊞");
    treeToggle.title = "Tout développer / réduire";
    treeToggle.onclick = () => {
      const lists = cur.el.querySelectorAll(".prob-items-list");
      const anyVisible = [...lists].some((l) => !l.hidden);
      lists.forEach((l) => { l.hidden = anyVisible; });
    };
    toolRight.appendChild(treeToggle);

    const menuBtn = el("button", "vsc-tool-btn", "≡");
    menuBtn.title = "Options d'affichage";
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      statusMenu(menuBtn, [
        { label: "Relancer le scan du workspace", run: () => scanWorkspaceProblems(v) },
        {
          label: problemsHideWarnings ? "Afficher les avertissements" : "Masquer les avertissements",
          on: problemsHideWarnings,
          run: () => { problemsHideWarnings = !problemsHideWarnings; if (cur.render) cur.render(); }
        },
        {
          label: "Copier la liste des problèmes",
          run: () => {
            const txt = workspaceDiagnostics.map((d) => d.path + ":" + d.line + " [" + d.severity + "] " + d.message).join("\n");
            navigator.clipboard.writeText(txt || "Aucun problème.").then(() => showToast("Problèmes copiés", "info")).catch(() => {});
          }
        }
      ]);
    };
    toolRight.appendChild(menuBtn);
  } else if (cur && cur.kind === "debug") {
    const clr = el("button", "vsc-tool-btn", "🧹"); clr.title = "Effacer la console";
    clr.onclick = () => { debugLogs = []; cur.render(); };
    toolRight.appendChild(clr);
  } else if (cur && cur.kind === "ports") {
    const ref = el("button", "vsc-tool-btn", "↻"); ref.title = "Rafraîchir les ports";
    ref.onclick = () => { cur.scan(); };
    toolRight.appendChild(ref);
  }

  // Séparateur vertical |
  const sep = el("span", "vsc-sep", "|");
  toolRight.appendChild(sep);

  // Bouton Maximiser ⛶
  const maxBtn = el("button", "vsc-tool-btn", panelEl.classList.contains("maximized") ? "🗗" : "⛶");
  maxBtn.title = panelEl.classList.contains("maximized") ? "Restaurer la taille du dock" : "Maximiser le dock";
  maxBtn.onclick = () => {
    panelEl.classList.toggle("maximized");
    maxBtn.textContent = panelEl.classList.contains("maximized") ? "🗗" : "⛶";
  };
  toolRight.appendChild(maxBtn);

  // Bouton Fermer ✕
  const closeBtn = el("button", "vsc-tool-btn", "✕");
  closeBtn.title = "Fermer le dock";
  closeBtn.onclick = () => { v.panelOpen = false; savePanel(v); renderPanel(); };
  toolRight.appendChild(closeBtn);

  tabsEl.appendChild(toolRight);

  for (const t of v.tabs) if (t.el) t.el.hidden = t !== cur;

  // Sidebar latérale des terminaux (Capture 2 de l'utilisateur) uniquement si termSidebarMode actif
  const termTabs = v.tabs.filter((t) => t.kind === "term");
  if (cur && cur.kind === "term") {
    let sideTabs = cur.el.querySelector(".vsc-term-sidebar-pane");
    if (termSidebarMode && termTabs.length > 0) {
      if (!sideTabs) {
        sideTabs = el("div", "vsc-term-sidebar-pane");
        cur.el.appendChild(sideTabs);
      }
      sideTabs.innerHTML = "";
      const sideHead = el("div", "vsc-term-side-head");
      sideHead.style.display = "flex";
      sideHead.style.alignItems = "center";
      sideHead.style.justifyContent = "space-between";
      sideHead.style.padding = "4px 8px";
      sideHead.style.borderBottom = "1px solid var(--line)";
      const sideTitle = el("span", "vsc-term-side-t", "TERMINAUX");
      sideTitle.style.fontSize = "11px";
      sideTitle.style.color = "var(--dim)";
      const addSideBtn = el("button", "iconbtn", "+");
      addSideBtn.title = "Nouveau terminal PowerShell";
      addSideBtn.onclick = (e) => { e.stopPropagation(); openTerminalTab(v); };
      sideHead.append(sideTitle, addSideBtn);
      sideTabs.appendChild(sideHead);

      for (const tm of termTabs) {
        const it = el("div", "vsc-term-side-item" + (tm === cur ? " active" : ""));
        const ic = el("span", "vsc-term-side-ico", ">_");
        const lb = el("span", "vsc-term-side-lbl", "pwsh  DELL");
        const kBtn = el("button", "vsc-term-side-del", "🗑");
        kBtn.title = "Fermer / Tuer ce terminal";
        kBtn.onclick = (e) => { e.stopPropagation(); closeTab(v, tm); };
        it.append(ic, lb, kBtn);
        it.onclick = () => {
          v.activeTab = tm.id;
          savePanel(v);
          renderPanel();
          if (tm.inp) tm.inp.focus();
        };
        sideTabs.appendChild(it);
      }
    } else if (sideTabs) {
      sideTabs.remove();
    }
  }

  const fileTabs = v.tabs.filter((t) => t.kind === "files" && t.el);
  if (open && cur && cur.kind === "files" && fileTabs.length > 1) {
    v.panelEl.classList.add("split2");
    for (const t of fileTabs) t.el.hidden = false;
  } else {
    v.panelEl.classList.remove("split2");
  }
}

function closeTab(v, t) {
  const i = v.tabs.indexOf(t);
  if (t.kind === "term") { post("/term/close", { sid: v.sid, tid: t.tid }); removeTermTab(v, t.tid); return; }
  if (t.agentPollTimer) clearInterval(t.agentPollTimer);
  if (t.winKeydown) window.removeEventListener("keydown", t.winKeydown);
  if (t.winMouseup) window.removeEventListener("mouseup", t.winMouseup);
  if (i >= 0) v.tabs.splice(i, 1);
  if (t.el) t.el.remove();
  if (v.activeTab === t.id) v.activeTab = (v.tabs[i] || v.tabs[i - 1] || {}).id || null;
  savePanel(v); renderPanel();
}

function togglePanelKind(kind) {
  const v = active;
  if (!v) { showToast("Ouvrez d’abord une session dans la barre latérale.", "warn"); return; }
  const dockKinds = ["problems", "output", "debug", "term", "ports"];
  if (dockKinds.includes(kind)) ensureProDockTabs(v);
  const cur = curTab(v);
  if (v.panelOpen && cur && cur.kind === kind) { v.panelOpen = false; savePanel(v); renderPanel(); return; }
  const existing = v.tabs.filter((t) => t.kind === kind).pop();
  if (existing) {
    v.activeTab = existing.id; v.panelOpen = true; savePanel(v); renderPanel();
    if (kind === "term" && existing.inp) existing.inp.focus();
    if (kind === "problems") scanWorkspaceProblems(v);
  } else if (kind === "problems") {
    const pt = ensureProblemsTab(v);
    v.activeTab = pt.id; v.panelOpen = true; savePanel(v); renderPanel();
    scanWorkspaceProblems(v);
  } else if (kind === "output") {
    const ot = ensureOutputTab(v);
    v.activeTab = ot.id; v.panelOpen = true; savePanel(v); renderPanel();
  } else if (kind === "debug") {
    const dt = ensureDebugConsoleTab(v);
    v.activeTab = dt.id; v.panelOpen = true; savePanel(v); renderPanel();
    if (dt.inp) dt.inp.focus();
  } else if (kind === "ports") {
    const pot = ensurePortsTab(v);
    v.activeTab = pot.id; v.panelOpen = true; savePanel(v); renderPanel();
  } else if (kind === "browser") openBrowserTab(v);
  else if (kind === "files") openFilesTab(v);
  else if (kind === "review") openReviewTab(v);
  else if (kind === "plan") openPlanTab(v);
  else openTerminalTab(v);
}

$("btnfiles").onclick = () => togglePanelKind("files");
$("btnbrowser").onclick = () => togglePanelKind("browser");
$("btnterm").onclick = () => togglePanelKind("term");
{
  const bp = $("btnproblems");
  if (bp) bp.onclick = () => togglePanelKind("problems");
}
{ const br = $("btnreview"); if (br) br.onclick = () => togglePanelKind("review"); }

// browser tabs
function fillUrls(t, urls) {
  if (!t.dl) return;
  const cur = [...t.dl.options].map((o) => o.value).join("|");
  if (cur === urls.join("|")) return;
  t.dl.innerHTML = "";
  for (const u of urls) { const o = document.createElement("option"); o.value = u; t.dl.appendChild(o); }
  t.urlsEl.innerHTML = "";
  if (urls.length && !t.url) {
    t.urlsEl.appendChild(el("div", "hint", "serveurs de dev démarrés par l'agent :"));
    for (const u of urls) { const b = el("button", "ghost", u); b.onclick = () => t.nav(u); t.urlsEl.appendChild(b); }
  }
}
function openBrowserTab(v, url) {
  const t = { kind: "browser", url: "", id: uid() };
  buildBrowserTab(v, t);
  v.tabs.push(t); v.activeTab = t.id; v.panelOpen = true;
  const start = url || (v.state.urls && v.state.urls[0]) || "";
  if (start) t.nav(start); else { savePanel(v); renderPanel(); t.urlIn.focus(); }
}
function buildBrowserTab(v, t) {
  const body = el("div", "tabbody browser"); body.hidden = true;
  const bar = el("div", "bar");
  const reload = el("button", "iconbtn", "↻"); reload.title = "Recharger";
  const urlIn = document.createElement("input"); urlIn.placeholder = "http://localhost:5173"; urlIn.spellcheck = false;
  const dlId = "dl_" + t.id; const dl = document.createElement("datalist"); dl.id = dlId; urlIn.setAttribute("list", dlId);
  const go = el("button", "iconbtn", "→"); go.title = "Aller";
  const ext = el("a", "iconbtn", "↗"); ext.title = "Ouvrir dans un nouvel onglet navigateur"; ext.target = "_blank"; ext.rel = "noopener";
  bar.appendChild(reload); bar.appendChild(urlIn); bar.appendChild(dl); bar.appendChild(go); bar.appendChild(ext);
  const previewStatus = el("span", "preview-status", "Aperçu inactif");
  bar.appendChild(previewStatus);
  const empty = el("div", "empty");
  empty.appendChild(el("div", "", "Saisissez une URL pour l'aperçu ici."));
  const urlsEl = el("div", "urls"); empty.appendChild(urlsEl);
  const frame = document.createElement("iframe"); frame.hidden = true;
  // Games need pointer lock; confirmation dialogs must reach the user.
  // Keep navigation to the harness origin blocked below.
  frame.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock allow-modals");
  frame.referrerPolicy = "no-referrer";
  frame.title = "Aperçu de l'application";
  body.appendChild(bar); body.appendChild(empty); body.appendChild(frame);
  v.panelEl.appendChild(body);
  t.el = body; t.frame = frame; t.urlIn = urlIn; t.dl = dl; t.urlsEl = urlsEl; t.previewStatus = previewStatus;
  let loadTimer = null;
  const setPreviewStatus = (kind, text) => {
    previewStatus.className = "preview-status " + kind;
    previewStatus.textContent = text;
  };
  frame.addEventListener("load", () => {
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
    setPreviewStatus("ok", "Preview chargée");
  });
  frame.addEventListener("error", () => {
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
    setPreviewStatus("error", "Preview inaccessible");
  });
  t.nav = (u) => {
    u = (u || "").trim();
    if (!u) return;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "http://" + u;
    let parsed;
    try { parsed = new URL(u); } catch { urlIn.setCustomValidity("Saisissez une URL http ou https valide"); urlIn.reportValidity(); return; }
    const localWorkspacePreview = parsed.origin === location.origin && parsed.pathname === "/workspace/preview";
    if (!["http:", "https:"].includes(parsed.protocol) || (!localWorkspacePreview && parsed.origin === location.origin) || (!localWorkspacePreview && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) && parsed.port === location.port)) {
      urlIn.setCustomValidity("Prévisualisez une application séparée ou un fichier HTML local du workspace"); urlIn.reportValidity(); return;
    }
    urlIn.setCustomValidity(""); u = parsed.href;
    t.url = u; urlIn.value = u; ext.href = u;
    setPreviewStatus("loading", "Chargement de la preview…");
    frame.src = u; frame.hidden = false; empty.hidden = true;
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
      loadTimer = null;
      setPreviewStatus("blocked", "Preview bloquée ou hors ligne");
    }, 9000);
    savePanel(v); renderPanel();
  };
  go.onclick = () => t.nav(urlIn.value);
  urlIn.onkeydown = (e) => { if (e.key === "Enter") t.nav(urlIn.value); };
  reload.onclick = () => {
    if (!t.url) return;
    setPreviewStatus("loading", "Rechargement…");
    frame.src = t.url;
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
      loadTimer = null;
      setPreviewStatus("blocked", "Preview bloquée ou hors ligne");
    }, 9000);
  };
  fillUrls(t, v.state.urls || []);
  if (t.url) t.nav(t.url);
}

// workspace files/editor tab
function openFilesTab(v, focusSearch, forceNew) {
  const existing = forceNew ? null : v.tabs.find((x) => x.kind === "files");
  if (existing) {
    v.activeTab = existing.id; v.panelOpen = true; savePanel(v); renderPanel();
    if (focusSearch && existing.findInput) existing.findInput.focus(); else if (existing.pathInput) existing.pathInput.focus();
    return;
  }
  const t = { kind: "files", id: uid(), rel: "." };
  buildFilesTab(v, t);
  v.tabs.push(t); v.activeTab = t.id; v.panelOpen = true;
  savePanel(v); renderPanel();
  t.loadDir(".");
  if (focusSearch && t.findInput) t.findInput.focus();
}
function buildFilesTab(v, t) {
  const body = el("div", "tabbody files"); body.hidden = true;
  const bar = el("div", "bar");
  const up = el("button", "iconbtn", "↑"); up.title = "Dossier parent";
  const pathInput = document.createElement("input");
  pathInput.placeholder = "Chemin du dossier du projet"; pathInput.spellcheck = false;
  const refresh = el("button", "iconbtn", "↻"); refresh.title = "Rafraîchir les fichiers";
  const save = el("button", "iconbtn", "save"); save.title = "Enregistrer le fichier";
  const diagnosticsButton = el("button", "iconbtn", "✓ problèmes"); diagnosticsButton.title = "Analyser le fichier ouvert avec le serveur de langage";
  const previewButton = el("button", "iconbtn", "▣"); previewButton.title = "Aperçu local HTML";
  const findInput = document.createElement("input");
  findInput.placeholder = "Rechercher dans le projet…"; findInput.setAttribute("aria-label", "Rechercher dans les fichiers du projet");
  const findButton = el("button", "iconbtn", "⌕"); findButton.title = "Rechercher dans l'espace de travail";
  bar.appendChild(up); bar.appendChild(pathInput); bar.appendChild(findInput); bar.appendChild(findButton); bar.appendChild(refresh); bar.appendChild(diagnosticsButton); bar.appendChild(previewButton); bar.appendChild(save);
  const newFile = el("button", "iconbtn", "+F"); newFile.title = "Nouveau fichier dans ce dossier";
  const newFolder = el("button", "iconbtn", "+D"); newFolder.title = "Nouveau dossier ici";
  const renameBtn = el("button", "iconbtn", "✎"); renameBtn.title = "Renommer le fichier ouvert";
  const deleteBtn = el("button", "iconbtn", "🗑"); deleteBtn.title = "Supprimer le fichier ouvert";
  bar.appendChild(newFile); bar.appendChild(newFolder); bar.appendChild(renameBtn); bar.appendChild(deleteBtn);
  const inlineBtn = el("button", "iconbtn", "✨");     inlineBtn.title = "Modifier la sélection avec l'IA (Ctrl+K)";
  bar.appendChild(inlineBtn);
  // A single "+" that opens a real menu: add the open file to what the agent
  // knows about it, or ask for a comment on it. Both used to be unreachable.
  const addBtn = el("button", "iconbtn", "+"); addBtn.type = "button";
  addBtn.title = "Ajouter un contexte ou un commentaire";
  addBtn.setAttribute("aria-haspopup", "menu");
  addBtn.onclick = () => {
    const rel = t.filePath || "";
    statusMenu(addBtn, [
      "Contexte du fichier",
      { note: rel ? rel : "Aucun fichier ouvert — ouvrez un fichier d'abord." },
      {
        label: "Ajouter comme contexte", hint: "explique ce fichier a l agent", on: false,
        run: () => {
          if (!rel) { showError("Ouvrez d'abord un fichier."); return; }
          post("/msg", { sid: active.sid, text: "Voici un fichier de mon projet : " + rel + ". Lis-le et garde-le en contexte pour la suite." });
        }
      },
      {
        label: "Commenter ce fichier", hint: "revue par l agent", on: false,
        run: () => {
          if (!rel) { showError("Ouvrez d'abord un fichier."); return; }
          post("/msg", { sid: active.sid, text: "Commente le fichier " + rel + " : ce qu il fait, les points fragiles et les ameliorations possibles." });
        }
      },
      null,
      { label: "Revue complete du projet", hint: "tous les fichiers", on: false, run: () => post("/msg", { sid: active.sid, text: "Fais une revue complete du projet : architecture, fichiers cles, et ce qui meritereait d etre ameliore." }) }
    ]);
  };
  bar.appendChild(addBtn);
  // Σ — code-symbol search (route /code/symbols, l'index du workspace).
  const symbolsBtn = el("button", "iconbtn", "Σ"); symbolsBtn.type = "button";
  symbolsBtn.title = "Rechercher un symbole (fonction, classe…) via l'index du code";
  const symbolsBar = el("div", "fileinlinebar"); symbolsBar.hidden = true;
  const symRow = el("div", "fileinline-row");
  const symInput = document.createElement("input");
  symInput.placeholder = "Symbole à trouver : ex. formatFile, scanWorkspaceProblems…";
  symInput.setAttribute("aria-label", "Rechercher un symbole du code");
  const symGo = el("button", "iconbtn", "Chercher"); symGo.type = "button";
  const symClose = el("button", "iconbtn", "×"); symClose.type = "button"; symClose.title = "Fermer (Échap)";
  symRow.append(symInput, symGo, symClose);
  const symHint = el("div", "filemeta", "Tapez un nom de symbole (fonction, classe, méthode…).");
  const symResults = el("div", "filesymresults");
  symbolsBar.append(symRow, symHint, symResults);
  let symSeq = 0;
  const gotoLine = async (file, line) => {
    if (file !== t.filePath && !(await t.loadFile(file))) return;
    const offset = editorTools.offsetForPosition(editor.value, Math.max(1, line));
    editor.focus(); editor.setSelectionRange(offset, offset); updatePosition();
    symbolsBar.hidden = true;
  };
  const runSymbols = () => {
    const q = symInput.value.trim();
    if (!q) { symHint.textContent = "Tapez un nom de symbole (fonction, classe, méthode…)."; return; }
    const seq = ++symSeq;
    symHint.textContent = "Recherche dans l'index du code…";
    symResults.replaceChildren();
    fetch("/code/symbols?k=" + encodeURIComponent(k) + "&sid=" + encodeURIComponent(v.sid) + "&q=" + encodeURIComponent(q))
      .then((r) => r.json())
      .then((d) => {
        if (seq !== symSeq) return;
        if (d && d.error) { symHint.textContent = String(d.error); return; }
        const out = String((d && d.result) || "");
        const lines = out.split("\n").filter((x) => x.trim());
        if (!lines.length || out.startsWith("Error:") || out.startsWith("No symbol")) {
          symHint.textContent = out || "Aucun symbole trouvé.";
          return;
        }
        symHint.textContent = lines.length + " résultat(s) — cliquez pour ouvrir à la ligne.";
        for (const ln of lines) {
          const mm = /^(.+?) \((.+?)\) — (.+?):(\d+)/.exec(ln);
          const b = document.createElement("button");
          b.type = "button"; b.className = "completeitem";
          if (mm) {
            b.appendChild(el("span", "", mm[1]));
            b.appendChild(el("span", "kind", mm[2] + " — " + mm[3] + ":" + mm[4]));
            const file = mm[3], line = Number(mm[4]) || 1;
            b.onclick = () => { gotoLine(file, line); };
          } else {
            b.appendChild(el("span", "", ln));
          }
          symResults.appendChild(b);
        }
      })
      .catch((e) => { if (seq === symSeq) symHint.textContent = "Index indisponible : " + String((e && e.message) || e); });
  };
  symGo.onclick = runSymbols;
  symInput.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); runSymbols(); }
    else if (e.key === "Escape") symbolsBar.hidden = true;
  };
  symClose.onclick = () => { symbolsBar.hidden = true; };
  symbolsBtn.onclick = () => {
    symbolsBar.hidden = !symbolsBar.hidden;
    if (!symbolsBar.hidden) { symInput.focus(); if (!symResults.children.length) symHint.textContent = "Tapez un nom de symbole (fonction, classe, méthode…)."; }
  };
  bar.appendChild(symbolsBtn);
  const inlineBar = el("div", "fileinlinebar"); inlineBar.hidden = true;
  const inlineRowTop = el("div", "fileinline-row");
  const inlineInput = document.createElement("input");
  inlineInput.placeholder = "Instruction : ex. refactoriser, typer, ajouter gestion d'erreurs…";
  inlineInput.setAttribute("aria-label", "AI edit instruction");
  const inlineGo = el("button", "iconbtn", "Générer"); inlineGo.type = "button";
  const inlineCancel = el("button", "iconbtn", "×"); inlineCancel.type = "button"; inlineCancel.title = "Fermer (Échap)";
  inlineRowTop.append(inlineInput, inlineGo, inlineCancel);
  const inlineChips = el("div", "fileinlinechips");
  const inlinePresets = [
    { label: "⚡ Refactoriser", text: "Refactorise ce code pour le rendre plus propre, lisible et robuste." },
    { label: "🐛 Corriger bugs", text: "Trouve et corrige les éventuels bugs, états nuls et erreurs de syntaxe." },
    { label: "📝 Typage & Docs", text: "Ajoute le typage TypeScript précis et documente clairement ce bloc." },
    { label: "🧪 Ajouter tests", text: "Génère les tests unitaires pour couvrir cette logique." },
    { label: "🚀 Optimiser", text: "Optimise la performance et la consommation mémoire de ce bloc." },
  ];
  for (const preset of inlinePresets) {
    const chip = el("button", "fileinlinechip", preset.label);
    chip.type = "button";
    chip.onclick = () => {
      inlineInput.value = preset.text;
      runInline();
    };
    inlineChips.appendChild(chip);
  }
  inlineBar.append(inlineRowTop, inlineChips);
  const inlinePreview = el("div", "fileinlinepreview"); inlinePreview.hidden = true;
  const inlineDiff = el("pre", "reviewpatch");
  const inlineRow = el("div", "reviewactions");
  const inlineStatus = el("span", "filemeta", "");
  inlineStatus.style.flex = "1";
  const inlineAccept = el("button", "iconbtn", "Accepter (Entrée)"); inlineAccept.type = "button";
  const inlineReject = el("button", "iconbtn", "Refuser (Échap)"); inlineReject.type = "button";
  inlineRow.append(inlineStatus, inlineAccept, inlineReject);
  inlinePreview.append(inlineDiff, inlineRow);
  // NOTE: inserted into body below, next to the other appends — the
  // results element does not exist yet at this point (TDZ).
  let inlineRange = null;
  // Bumped every time the bar closes or the file changes; a poll carrying an
  // older generation is stale and must not write into the editor anymore.
  let inlineGen = 0;
  const openInlineBar = () => {
    if (!t.filePath) { showError("Ouvrez d’abord un fichier."); return; }
    if (editor.selectionStart === editor.selectionEnd) {
      const pos = editor.selectionStart;
      const startOfLine = editor.value.lastIndexOf("\n", pos - 1) + 1;
      let endOfLine = editor.value.indexOf("\n", pos);
      if (endOfLine === -1) endOfLine = editor.value.length;
      editor.setSelectionRange(startOfLine, endOfLine);
    }
    inlineBar.hidden = false;
    inlinePreview.hidden = true;
    inlineInput.value = "";
    inlineInput.focus();
  };
  const closeInlineBar = () => { inlineBar.hidden = true; inlinePreview.hidden = true; inlineRange = null; inlineGen++; editor.focus(); };
  const paintInlineDiff = (text) => {
    inlineDiff.replaceChildren();
    let adds = 0, dels = 0;
    for (const ln of String(text || "").split("\n")) {
      const s = document.createElement("span");
      if (ln.startsWith("+ ")) { adds++; s.className = "add"; }
      else if (ln.startsWith("- ")) { dels++; s.className = "del"; }
      else if (ln.startsWith("@@")) { s.className = "hunk"; }
      else { s.className = "same"; }
      s.textContent = ln + "\n";
      inlineDiff.appendChild(s);
    }
    return { adds, dels };
  };
  const pollInline = (op, left = 120, gen = inlineGen) => {
    if (left <= 0) { inlineStatus.textContent = "Délai dépassé — réessayez."; inlineRange = null; return; }
    fetch("/code/inline/result?k=" + k + "&id=" + encodeURIComponent(op))
      .then((r) => r.json()).then((d) => {
        if (gen !== inlineGen || !inlineRange) return;
        if (d.status === "done") {
          inlineRange.newText = d.newText;
          const stats = paintInlineDiff(d.diff || "");
          inlineStatus.textContent = "+" + stats.adds + " / -" + stats.dels + " lignes · [Entrée] Accepter · [Échap] Refuser";
          inlineAccept.focus();
        } else if (d.status === "error") {
          inlineStatus.textContent = d.error || "Échec de génération.";
          inlineRange = null;
        } else {
          setTimeout(() => pollInline(op, left - 1, gen), 1500);
        }
      }).catch((e) => { inlineStatus.textContent = String((e && e.message) || e); inlineRange = null; });
  };
  const runInline = () => {
    const instruction = inlineInput.value.trim();
    if (!instruction) { inlineStatus.textContent = "Décrivez la modification."; return; }
    if (editor.selectionStart === editor.selectionEnd) {
      const pos = editor.selectionStart;
      const startOfLine = editor.value.lastIndexOf("\n", pos - 1) + 1;
      let endOfLine = editor.value.indexOf("\n", pos);
      if (endOfLine === -1) endOfLine = editor.value.length;
      editor.setSelectionRange(startOfLine, endOfLine);
    }
    const selStart = editor.selectionStart, selEnd = editor.selectionEnd;
    const before = editor.value.slice(0, selStart).split("\n").length;
    const selection = editor.value.slice(selStart, selEnd);
    const after = before + selection.split("\n").length - 1;
    inlineRange = { start: selStart, end: selEnd, newText: null };
    inlineStatus.textContent = "Génération IA en cours…";
    inlinePreview.hidden = false;
    inlineDiff.replaceChildren();
    post("/code/inline/start", { sid: v.sid, path: t.filePath, selection, start: before, end: after, instruction })
      .then((r) => {
        if (!r || r.error || !r.op) { inlineStatus.textContent = (r && r.error) || "L'édition inline n'a pas pu démarrer."; inlineRange = null; return; }
        pollInline(r.op);
      }).catch((e) => { inlineStatus.textContent = String((e && e.message) || e); inlineRange = null; });
  };
  inlineBtn.onclick = openInlineBar;
  inlineCancel.onclick = closeInlineBar;
  inlineGo.onclick = runInline;
  inlineInput.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); runInline(); } if (e.key === "Escape") closeInlineBar(); };
  inlineAccept.onclick = () => {
    if (!inlineRange || typeof inlineRange.newText !== "string") return;
    editor.focus();
    editor.setRangeText(inlineRange.newText, inlineRange.start, inlineRange.end, "end");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    closeInlineBar();
  };
  inlineReject.onclick = closeInlineBar;
  t.winKeydown = (e) => {
    if (!inlinePreview.hidden && inlineRange && typeof inlineRange.newText === "string") {
      if (e.key === "Enter" || (e.ctrlKey && e.key.toLowerCase() === "y") || e.key === "Tab") {
        e.preventDefault();
        inlineAccept.click();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeInlineBar();
      }
    }
  };
  window.addEventListener("keydown", t.winKeydown);
  const fileOp = (endpoint, body, after) => {
    fetch("/workspace/file/" + endpoint + "?k=" + k + "&sid=" + encodeURIComponent(v.sid), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
    }).then((r) => r.json()).then((d) => {
      if (d.error) throw new Error(d.error);
      after(d);
    }).catch((e) => showError(e.message));
  };
  const inDir = (name) => (t.rel && t.rel !== "." ? t.rel + "/" : "") + name;
  newFile.onclick = () => {
    const name = prompt("New file in " + (t.rel || ".") + " :", "");
    if (!name || !name.trim()) return;
    fileOp("new", { path: inDir(name.trim()) }, (d) => { t.loadDir(t.rel || "."); void t.loadFile(d.path); });
  };
  newFolder.onclick = () => {
    const name = prompt("New folder in " + (t.rel || ".") + " :", "");
    if (!name || !name.trim()) return;
    fileOp("new", { path: inDir(name.trim()), dir: true }, () => t.loadDir(t.rel || "."));
  };
  renameBtn.onclick = () => {
    if (!t.filePath) { showError("Ouvrez d’abord un fichier."); return; }
    const tab = t.tabStore.active();
    if (tab && tab.path === t.filePath && tab.dirty) { showError("Enregistrez les modifications avant de renommer."); return; }
    const to = prompt("Renommer en :", t.filePath);
    if (!to || !to.trim() || to.trim() === t.filePath) return;
    const from = t.filePath;
    fileOp("rename", { path: from, to: to.trim() }, (d) => {
      const r = t.tabStore.close(from, true);
      displayTab(r ? r.active : null);
      t.loadDir(t.rel || ".");
      void t.loadFile(d.path);
    });
  };
  deleteBtn.onclick = () => {
    if (!t.filePath) { showError("Ouvrez d’abord un fichier."); return; }
    const p = t.filePath;
    const td = t.tabStore.list().find((x) => x.path === p);
    const ask = td && td.dirty ? "Supprimer " + p + " ET ses modifications non enregistrées ?" : "Supprimer " + p + " ?";
    if (!confirm(ask)) return;
    fileOp("delete", { path: p }, () => {
      const r = t.tabStore.close(p, true);
      displayTab(r ? r.active : null);
      // An image has no tab entry: without this the preview of the deleted
      // file stayed on screen.
      if (!imagePreview.hidden && t.filePath === p) { t.filePath = ""; imagePreview.hidden = true; imageEl.removeAttribute("src"); renderTabs(); }
      t.loadDir(t.rel || ".");
    });
  };
  const results = el("div", "filesearch-results"); results.hidden = true;
  const split = el("div", "filesplit");
  const tree = el("div", "filetree");
  const editorWrap = el("div", "fileeditor-wrap");
  const monacoHost = el("div", "filemonaco-host");
  editorWrap.appendChild(monacoHost);
  t.monacoHost = monacoHost;
  const imagePreview = el("div", "image-preview"); imagePreview.hidden = true;
  const imageEl = document.createElement("img"); imageEl.alt = "Aperçu de l'image du projet"; imageEl.loading = "lazy";
  imagePreview.appendChild(imageEl);
  const tabsBar = el("div", "filetabs");
  const code = document.createElement("pre"); code.className = "filecode"; code.setAttribute("aria-hidden", "true");
  const editor = document.createElement("textarea");
  t.editor = editor;
  editor.className = "fileeditor"; editor.spellcheck = false; editor.placeholder = "Sélectionnez un fichier…";
  let monacoEditorInstance = null;
  const ensureWebMonacoEditor = () => {
    if (monacoEditorInstance || !window.monaco || !webMonacoReady) return monacoEditorInstance;
    try {
      monacoEditorInstance = window.monaco.editor.create(monacoHost, {
        value: "",
        language: "plaintext",
        theme: "vs-dark",
        automaticLayout: true,
        fontSize: 13,
        fontFamily: 'Consolas, "Courier New", monospace',
        minimap: { enabled: true },
        folding: true,
        lineNumbers: "on",
        roundedSelection: false,
        scrollBeyondLastLine: false,
        readOnly: false,
        cursorBlinking: "smooth",
        tabSize: 2,
        wordWrap: "off",
        multiCursorModifier: "alt",
      });
      t.monacoEditor = monacoEditorInstance;

      monacoEditorInstance.onDidChangeCursorPosition((e) => {
        const line = e.position.lineNumber;
        const col = e.position.column;
        const sPos = $("sPosition");
        if (sPos) sPos.textContent = "Ln " + line + ", Col " + col;
        const model = monacoEditorInstance.getModel();
        const sel = monacoEditorInstance.getSelection();
        if (model && sel && typeof origSetSelectionRange === "function") {
          origSetSelectionRange(model.getOffsetAt(sel.getStartPosition()), model.getOffsetAt(sel.getEndPosition()));
        }
        if (typeof broadcastCursor === "function") broadcastCursor(line, col);
      });

      monacoEditorInstance.addCommand(window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.KeyZ, () => {
        if (t.collab && t.collab.doc && t.collab.path === t.filePath && canUndo(t.collab.doc)) {
          const ops = localUndo(t.collab.doc);
          if (ops.length) {
            editor.value = docText(t.collab.doc);
            t.collab.shadow = editor.value;
            post("/edit/op", { sid: v.sid, path: t.collab.path, ops }).catch(() => {});
            try { t.refreshEditor(); } catch (err) {}
          }
          return;
        }
        monacoEditorInstance.trigger("keyboard", "undo", null);
      });

      monacoEditorInstance.addCommand(window.monaco.KeyMod.CtrlCmd | window.monaco.KeyMod.Shift | window.monaco.KeyCode.KeyZ, () => {
        if (t.collab && t.collab.doc && t.collab.path === t.filePath && canRedo(t.collab.doc)) {
          const ops = localRedo(t.collab.doc);
          if (ops.length) {
            editor.value = docText(t.collab.doc);
            t.collab.shadow = editor.value;
            post("/edit/op", { sid: v.sid, path: t.collab.path, ops }).catch(() => {});
            try { t.refreshEditor(); } catch (err) {}
          }
          return;
        }
        monacoEditorInstance.trigger("keyboard", "redo", null);
      });

      monacoEditorInstance.addCommand(window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.KeyY, () => {
        if (t.collab && t.collab.doc && t.collab.path === t.filePath && canRedo(t.collab.doc)) {
          const ops = localRedo(t.collab.doc);
          if (ops.length) {
            editor.value = docText(t.collab.doc);
            t.collab.shadow = editor.value;
            post("/edit/op", { sid: v.sid, path: t.collab.path, ops }).catch(() => {});
            try { t.refreshEditor(); } catch (err) {}
          }
          return;
        }
        monacoEditorInstance.trigger("keyboard", "redo", null);
      });

      monacoEditorInstance.addCommand(window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.KeyS, () => {
        if (!save.disabled) save.click();
      });

      monacoEditorInstance.addCommand(window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.KeyK, () => {
        openInlineBar();
      });

      window.addEventListener("resize", () => {
        if (monacoEditorInstance) monacoEditorInstance.layout();
      });

      if (!window.__monacoProvidersRegistered) {
        window.__monacoProvidersRegistered = true;
        const supportedLangs = [
          "typescript", "javascript", "python", "rust", "go",
          "json", "html", "css", "markdown", "shell", "c", "cpp", "java", "sql", "yaml", "ini", "plaintext"
        ];
        for (const langId of supportedLangs) {
          window.monaco.languages.registerCompletionItemProvider(langId, {
            triggerCharacters: [".", "(", "{", ":", "/", "@", " "],
            provideCompletionItems: async function (model, position) {
              if (!t.filePath) return { suggestions: [] };
              const word = model.getWordUntilPosition(position);
              const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
              };
              try {
                const res = await fetch("/code/lsp?k=" + k + "&sid=" + encodeURIComponent(v.sid) + "&action=completion&path=" + encodeURIComponent(t.filePath) + "&line=" + position.lineNumber + "&col=" + position.column);
                const d = await res.json();
                const suggestions = [];
                for (const ln of String((d && d.result) || "").split("\n")) {
                  if (!ln.startsWith("- ")) continue;
                  const body = ln.slice(2);
                  const mm = /^(.+?)(?: \(([^)]*)\))?(?: — (.*))?$/.exec(body);
                  const label = (mm ? mm[1] : body).trim();
                  const kStr = String((mm && mm[2]) || "").toLowerCase();
                  let kind = window.monaco.languages.CompletionItemKind.Property;
                  if (kStr.includes("func") || kStr.includes("method")) kind = window.monaco.languages.CompletionItemKind.Function;
                  else if (kStr.includes("var") || kStr.includes("const")) kind = window.monaco.languages.CompletionItemKind.Variable;
                  else if (kStr.includes("class")) kind = window.monaco.languages.CompletionItemKind.Class;
                  else if (kStr.includes("interface")) kind = window.monaco.languages.CompletionItemKind.Interface;
                  else if (kStr.includes("keyword")) kind = window.monaco.languages.CompletionItemKind.Keyword;
                  suggestions.push({
                    label: label,
                    kind: kind,
                    detail: (mm && mm[3]) || (mm && mm[2]) || "",
                    insertText: label,
                    range: range,
                  });
                  if (suggestions.length >= 20) break;
                }
                return { suggestions: suggestions };
              } catch {
                return { suggestions: [] };
              }
            },
          });

          window.monaco.languages.registerHoverProvider(langId, {
            provideHover: async function (model, position) {
              if (!t.filePath) return null;
              const word = model.getWordAtPosition(position);
              if (!word) return null;
              try {
                const res = await fetch("/code/lsp?k=" + k + "&sid=" + encodeURIComponent(v.sid) + "&action=hover&path=" + encodeURIComponent(t.filePath) + "&line=" + position.lineNumber + "&col=" + position.column);
                const d = await res.json();
                const text = String((d && d.result) || "");
                if (!text || text.startsWith("Error")) return null;
                return {
                  range: new window.monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
                  contents: [{ value: text }],
                };
              } catch {
                return null;
              }
            },
          });

          window.monaco.languages.registerInlineCompletionsProvider(langId, {
            provideInlineCompletions: async function (model, position) {
              if (!t.filePath) return { items: [] };
              const lineContent = model.getLineContent(position.lineNumber);
              const suffix = lineContent.slice(position.column - 1);
              if (suffix.trim().length > 0) return { items: [] };
              const word = model.getWordUntilPosition(position);
              if (!word || word.word.length < 2) return { items: [] };
              try {
                const res = await fetch("/code/lsp?k=" + k + "&sid=" + encodeURIComponent(v.sid) + "&action=completion&path=" + encodeURIComponent(t.filePath) + "&line=" + position.lineNumber + "&col=" + position.column);
                const d = await res.json();
                const lines = String((d && d.result) || "").split("\n");
                let topLabel = "";
                for (const ln of lines) {
                  if (ln.startsWith("- ")) {
                    const body = ln.slice(2);
                    const mm = /^(.+?)(?: \(([^)]*)\))?(?: — (.*))?$/.exec(body);
                    topLabel = (mm ? mm[1] : body).trim();
                    if (topLabel) break;
                  }
                }
                if (!topLabel) return { items: [] };
                return {
                  items: [
                    {
                      insertText: topLabel,
                      range: new window.monaco.Range(
                        position.lineNumber,
                        word.startColumn,
                        position.lineNumber,
                        position.column
                      ),
                    },
                  ],
                };
              } catch {
                return { items: [] };
              }
            },
            freeInlineCompletions: function () {},
          });
        }
      }
    } catch (e) {
      console.warn("Échec création éditeur Monaco web:", e);
    }
    return monacoEditorInstance;
  };
  const origSetSelectionRange = editor.setSelectionRange.bind(editor);
  editor.setSelectionRange = (start, end) => {
    origSetSelectionRange(start, end);
    if (t.monacoEditor && window.monaco) {
      const model = t.monacoEditor.getModel();
      if (model) {
        const pStart = model.getPositionAt(start);
        const pEnd = model.getPositionAt(end);
        const range = new window.monaco.Range(pStart.lineNumber, pStart.column, pEnd.lineNumber, pEnd.column);
        t.monacoEditor.setSelection(range);
        t.monacoEditor.revealRangeInCenter(range);
      }
    }
  };
  const origSetRangeText = editor.setRangeText.bind(editor);
  editor.setRangeText = (replacement, start, end, mode = "end") => {
    origSetRangeText(replacement, start, end, mode);
    if (t.monacoEditor && window.monaco) {
      const model = t.monacoEditor.getModel();
      if (model) {
        const pStart = model.getPositionAt(start);
        const pEnd = model.getPositionAt(end);
        const range = new window.monaco.Range(pStart.lineNumber, pStart.column, pEnd.lineNumber, pEnd.column);
        t.monacoEditor.executeEdits("smol-web", [{ range, text: replacement, forceMoveMarkers: true }]);
      }
    }
  };
  window.addEventListener("web-monaco-ready", () => {
    const cur = t.tabStore.active();
    if (cur) displayTab(cur);
  });
  const gutter = document.createElement("div"); gutter.className = "filegutter";
  t.agentDiffBases = new Map();
  const minimap = document.createElement("div"); minimap.className = "fileminimap"; minimap.title = "Minimap — cliquer pour naviguer";
  minimap.setAttribute("role", "scrollbar"); minimap.setAttribute("aria-label", "Minimap du fichier");
  const mmBars = document.createElement("div"); mmBars.className = "minimap-bars";
  const mmBox = document.createElement("div"); mmBox.className = "minimap-box";
  minimap.appendChild(mmBars); minimap.appendChild(mmBox);
  editor.addEventListener("scroll", () => { gutter.scrollTop = editor.scrollTop; });
  // ---- pliage du code editeur ---------------------------------------------
  // folds relie une ligne ouvrante (start) a la fin de sa region (end). Le
  // textarea garde toujours le texte complet : tant qu'une region est pliee il
  // passe en visibility:hidden + readOnly pendant que le <pre> affiche la vue
  // pliee (.ed-row + placeholder .ed-ph). Jamais d'ecriture dans editor.value.
  const folds = new Map();
  let canWriteMode = true;
  let scrollLock = 0;
  const parseFoldData = (v) => {
    const parts = String(v || "").split(":");
    return [Number(parts[0]), Number(parts[1])];
  };
  // Les folds qui ne tiennent plus dans le texte (edition, changement d'onglet)
  // sont purges avant chaque rendu : pas de region fantome ni de decalage.
  const syncFolds = () => {
    const count = editor.value.split("\n").length;
    for (const s of Array.from(folds.keys())) {
      const e = folds.get(s);
      if (!(s >= 0 && s < count && e >= s && e < count)) folds.delete(s);
    }
    return folds;
  };
  const applyFoldVisibility = () => {
    const folded = syncFolds().size > 0;
    editor.style.visibility = folded ? "hidden" : "";
    editor.readOnly = folded || !canWriteMode;
    code.classList.toggle("folded", folded);
  };
  /** Line numbers + fold chevrons, kept in step with the editor's line count
   * and scroll. Called from paint() and displayTab(), so it tracks every edit. */
  const updateGutter = () => {
    const flags = lineChangeFlags(editor.dataset.diffBase || editor.dataset.original || "", editor.value);
    const lines = editor.value.split("\n");
    const active = syncFolds();
    const foldable = new Map();
    foldableRanges(lines).forEach((r) => { if (!active.has(r.start)) foldable.set(r.start, r.end); });
    const parts = [];
    for (let i = 0; i < lines.length; i++) {
      const f = flags[i] || { added: false, removed: false };
      const cls = "gutter-line" + (f.added ? " added" : "") + (f.removed ? " removed" : "");
      const num = String(i + 1);
      if (active.has(i)) {
        const e = active.get(i);
        parts.push('<div class="' + cls + ' foldable"><button type="button" class="gutter-fold" data-fold="' + i + ":" + e + '" title="Déplier" aria-label="Déplier les lignes ' + num + ' à ' + (e + 1) + '">▸</button><span aria-hidden="true">' + num + "</span></div>");
        parts.push('<div class="gutter-line gutter-folded" aria-hidden="true"><span>⋯</span></div>');
        i = e;
        continue;
      }
      if (foldable.has(i)) {
        parts.push('<div class="' + cls + ' foldable"><button type="button" class="gutter-fold" data-fold="' + i + ":" + foldable.get(i) + '" title="Replier" aria-label="Replier les lignes ' + num + ' à ' + (foldable.get(i) + 1) + '">▾</button><span aria-hidden="true">' + num + "</span></div>");
        continue;
      }
      parts.push('<div class="' + cls + '"><span aria-hidden="true">' + num + "</span></div>");
    }
    gutter.innerHTML = parts.join("");
    gutter.scrollTop = editor.scrollTop;
  };
  const meta = el("div", "filemeta", "workspace files");
  const diagnosticsPanel = el("div", "filediagnostics"); diagnosticsPanel.setAttribute("role", "region"); diagnosticsPanel.setAttribute("aria-label", "Problèmes du fichier");
  const fileFindBar = el("div", "filefindbar"); fileFindBar.hidden = true; fileFindBar.setAttribute("role", "search");
  const currentFindInput = document.createElement("input"); currentFindInput.placeholder = "Rechercher dans le fichier"; currentFindInput.setAttribute("aria-label", "Rechercher dans le fichier");
  const currentFindPrev = el("button", "iconbtn", "↑"); currentFindPrev.type = "button"; currentFindPrev.title = "Occurrence précédente (Maj+F3)";
  const currentFindNext = el("button", "iconbtn", "↓"); currentFindNext.type = "button"; currentFindNext.title = "Occurrence suivante (F3)";
  const currentFindCount = el("span", "filefind-count"); currentFindCount.setAttribute("aria-live", "polite");
  const currentReplaceInput = document.createElement("input"); currentReplaceInput.placeholder = "Remplacer par"; currentReplaceInput.setAttribute("aria-label", "Remplacer par"); currentReplaceInput.hidden = true;
  const currentReplaceOne = el("button", "iconbtn", "Remplacer"); currentReplaceOne.type = "button"; currentReplaceOne.hidden = true;
  const currentReplaceAll = el("button", "iconbtn", "Tout remplacer"); currentReplaceAll.type = "button"; currentReplaceAll.hidden = true;
  const currentFindClose = el("button", "iconbtn", "×"); currentFindClose.type = "button"; currentFindClose.title = "Fermer la recherche";
  fileFindBar.append(currentFindInput, currentFindPrev, currentFindNext, currentFindCount, currentReplaceInput, currentReplaceOne, currentReplaceAll, currentFindClose);
  editorWrap.appendChild(tabsBar); editorWrap.appendChild(imagePreview); editorWrap.appendChild(gutter); editorWrap.appendChild(code); editorWrap.appendChild(editor); editorWrap.appendChild(minimap);
  t.editorWrap = editorWrap;
  const lineAskButton = el("button", "fileline-plus", "+");
  lineAskButton.type = "button";
  lineAskButton.title = "Demander une action à l’agent sur cette ligne";
  lineAskButton.setAttribute("aria-label", "Demander à l’agent une action sur la ligne");
  lineAskButton.hidden = true;
  const lineAskPopup = el("form", "fileline-popup");
  lineAskPopup.hidden = true;
  lineAskPopup.setAttribute("aria-label", "Instruction à l’agent pour la ligne sélectionnée");
  const lineAskInput = document.createElement("textarea");
  lineAskInput.rows = 3;
  lineAskInput.maxLength = 2000;
  lineAskInput.placeholder = "Corriger, expliquer, commenter, modifier…";
  lineAskInput.setAttribute("aria-label", "Instruction pour l’agent");
  const lineAskActions = el("div", "fileline-actions");
  const lineAskSend = el("button", "cc-act primary", "Envoyer à l’agent");
  lineAskSend.type = "submit";
  const lineAskCancel = el("button", "cc-act", "Annuler");
  lineAskCancel.type = "button";
  lineAskActions.append(lineAskCancel, lineAskSend);
  lineAskPopup.append(lineAskInput, lineAskActions);
  editorWrap.append(lineAskButton, lineAskPopup);
  let lineAskNumber = 0;
  const hideLineAsk = () => { lineAskPopup.hidden = true; lineAskButton.hidden = true; };
  const positionLineAsk = (line, y) => {
    lineAskNumber = line;
    lineAskButton.style.top = y + "px";
    lineAskPopup.style.top = Math.max(36, Math.min(y, (editorWrap.clientHeight || 200) - 140)) + "px";
    lineAskButton.title = "Demander à l’agent une action sur la ligne " + line;
    lineAskButton.hidden = false;
  };
  editor.addEventListener("pointermove", (event) => {
    if (!lineAskPopup.hidden) return;
    const rect = editor.getBoundingClientRect();
    const style = getComputedStyle(editor);
    const lineHeight = parseFloat(style.lineHeight) || 18.75;
    const paddingTop = parseFloat(style.paddingTop) || 10;
    const line = Math.max(1, Math.min(editor.value.split("\n").length,
      Math.floor((event.clientY - rect.top + editor.scrollTop - paddingTop) / lineHeight) + 1));
    positionLineAsk(line, 45 + (line - 1) * lineHeight - editor.scrollTop);
  });
  editorWrap.addEventListener("pointerleave", () => {
    if (lineAskPopup.hidden) lineAskButton.hidden = true;
  });
  lineAskButton.onclick = () => {
    if (!t.filePath) { showError("Ouvrez d’abord un fichier."); return; }
    lineAskPopup.hidden = false;
    lineAskInput.value = "";
    lineAskInput.focus();
  };
  lineAskCancel.onclick = hideLineAsk;
  const sendLineAsk = () => {
    const instruction = lineAskInput.value.trim();
    if (!instruction) { lineAskInput.focus(); return; }
    if (!t.filePath || lineAskNumber < 1) { showError("Aucune ligne de code sélectionnée."); return; }
    const lines = editor.value.split("\n");
    const first = Math.max(1, lineAskNumber - 2);
    const last = Math.min(lines.length, lineAskNumber + 2);
    const excerpt = lines.slice(first - 1, last).map((line, index) => (first + index) + ": " + line).join("\n");
    const text = "Dans le fichier " + t.filePath + ", traite la ligne " + lineAskNumber + " selon cette demande : " + instruction +
      "\n\nContexte du code (lignes " + first + " à " + last + ") :\n" + excerpt +
      "\n\nOuvre le fichier complet si le contexte manque. Applique les modifications demandées et vérifie-les; pour une demande d’explication ou de commentaire, réponds sans modifier le code.";
    lineAskSend.disabled = true;
    post("/msg", { sid: v.sid, text })
      .then((result) => {
        if (result && result.error) throw new Error(result.error);
        hideLineAsk();
        showToast("Demande envoyée à l’agent avec le fichier et la ligne.", "info");
      })
      .catch((error) => showError(error.message || String(error)))
      .finally(() => { lineAskSend.disabled = false; });
  };
  lineAskPopup.onsubmit = (event) => { event.preventDefault(); sendLineAsk(); };
  lineAskInput.onkeydown = (event) => {
    if (event.key === "Escape") { event.preventDefault(); hideLineAsk(); }
    else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      sendLineAsk();
    }
  };
  const completePop = el("div", "completepop"); completePop.hidden = true;
  completePop.setAttribute("role", "listbox");
  editorWrap.appendChild(completePop);
  let completeItems = [], completePrefix = "", completeAnchor = 0;
  const hideComplete = () => { completePop.hidden = true; completePop.replaceChildren(); completeItems = []; };
  const acceptComplete = (i) => {
    const it = completeItems[i || 0];
    hideComplete();
    if (!it) return;
    editor.focus();
    editor.setRangeText(it.label, completeAnchor, editor.selectionStart, "end");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const triggerComplete = () => {
    hideComplete();
    if (!t.filePath) return;
    const pos = editor.selectionStart;
    const ls = editor.value.lastIndexOf("\n", pos - 1) + 1;
    const m = /[\w$]+$/.exec(editor.value.slice(ls, pos));
    if (!m) return;
    completePrefix = m[0];
    completeAnchor = pos - completePrefix.length;
    const at = editorTools.cursorPosition(editor.value, pos);
    fetch("/code/lsp?k=" + k + "&sid=" + encodeURIComponent(v.sid) + "&action=completion&path=" + encodeURIComponent(t.filePath) + "&line=" + at.line + "&col=" + at.column)
      .then((r) => r.json()).then((d) => {
        const items = [];
        for (const ln of String((d && d.result) || "").split("\n")) {
          if (!ln.startsWith("- ")) continue;
          const body = ln.slice(2);
          const mm = /^(.+?)(?: \(([^)]*)\))?(?: — (.*))?$/.exec(body);
          items.push({ label: (mm ? mm[1] : body).trim(), kind: (mm && mm[2]) || "", detail: (mm && mm[3]) || "" });
          if (items.length >= 8) break;
        }
        if (!items.length) return;
        completeItems = items;
        items.forEach((it, i) => {
          const b = el("button", "completeitem" + (i === 0 ? " sel" : ""));
          b.type = "button";
          b.appendChild(el("span", "", it.label));
          if (it.kind || it.detail) b.appendChild(el("span", "kind", (it.kind ? it.kind + " " : "") + (it.detail || "")));
          b.onclick = () => acceptComplete(i);
          completePop.appendChild(b);
        });
        completePop.hidden = false;
      }).catch(() => {});
  };
  const treeGrip = el("div", "ftreegrip");
  treeGrip.title = "Glisser pour redimensionner";
  treeGrip.setAttribute("aria-hidden", "true");
  {
    const savedTreeW = Number(ls.get("smol.ftree.w"));
    if (savedTreeW) tree.style.setProperty("--ftree-w", Math.max(150, Math.round(savedTreeW)) + "px");
    treeGrip.onmousedown = (e) => {
      e.preventDefault();
      document.body.classList.add("dragging");
      const rect = split.getBoundingClientRect();
      const move = (ev) => {
        const w = Math.max(150, Math.min(rect.width - 150, ev.clientX - rect.left));
        tree.style.setProperty("--ftree-w", Math.round(w) + "px");
      };
      const up = () => {
        document.body.classList.remove("dragging");
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        const w = parseFloat(tree.style.getPropertyValue("--ftree-w"));
        if (w) ls.set("smol.ftree.w", String(Math.round(w)));
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    };
  }
  split.appendChild(tree); split.appendChild(treeGrip); split.appendChild(editorWrap);
  body.appendChild(bar); body.appendChild(results); body.appendChild(fileFindBar); body.appendChild(split); body.appendChild(diagnosticsPanel); body.appendChild(meta);
  body.insertBefore(inlinePreview, results);
  body.insertBefore(inlineBar, inlinePreview);
  body.insertBefore(symbolsBar, fileFindBar);
  v.panelEl.appendChild(body);
  t.el = body; t.pathInput = pathInput; t.findInput = findInput; t.tree = tree; t.editor = editor; t.code = code; t.tabsBar = tabsBar; t.tabStore = makeEditorTabStore(); t.saveBtn = save; t.meta = meta;
  t.filePath = ""; t.mtimeMs = 0; t.rel = "."; t.decompressed = false;
  t.diags = [];
  const SQE = ["\u0001", "\u0002"], SQW = ["\u0003", "\u0004"];
  const markDiags = (source) => {
    const diags = (t.diags || []).filter((d) => d && d.path === t.filePath);
    if (!diags.length) return source;
    const lines = source.split("\n");
    for (const d of diags) {
      const li = (d.line || 1) - 1;
      if (li < 0 || li >= lines.length) continue;
      const line = lines[li];
      const col = Math.max(0, Math.min(((d.col || 1) - 1), line.length));
      let end = col;
      while (end < line.length && /[\w$]/.test(line[end])) end++;
      if (end <= col) end = Math.min(line.length, col + 1);
      if (end <= col) continue;
      const m = d.severity === "warning" ? SQW : SQE;
      lines[li] = line.slice(0, col) + m[0] + line.slice(col, end) + m[1] + line.slice(end);
    }
    return lines.join("\n");
  };
  let diagnosticRequest = 0;
  const paint = () => {
    const marked = markDiags(editor.value);
    const markedLines = marked.split("\n");
    let html = highlightHtml(marked, t.filePath.split(".").pop()) || " ";
    html = html.split(SQE[0]).join('<span class="sq-err">').split(SQE[1]).join("</span>");
    html = html.split(SQW[0]).join('<span class="sq-warn">').split(SQW[1]).join("</span>");
    // Vue pliee : une ligne .ed-row par ligne visible, placeholder .ed-ph a la
    // place des ranges repliees. Les spans referment/rouvrent les tokens
    // multilignes (splitHighlightedByLine), donc la colorisation reste juste.
    const active = syncFolds();
    const rows = splitHighlightedByLine(html);
    const count = rows.length;
    const out = [];
    let i = 0;
    while (i < count) {
      const e = active.has(i) ? active.get(i) : -1;
      if (e >= i && e < count) {
        out.push('<span class="ed-row">' + indentGuides(markedLines[i] || "", 0) + rows[i] + "</span>");
        out.push('<span class="ed-ph" data-unfold="' + i + ":" + e + '" role="button" tabindex="0">⋯ ' + (e - i) + " lignes repliées ▸</span>");
        i = e + 1;
        continue;
      }
      out.push('<span class="ed-row">' + indentGuides(markedLines[i] || "", 0) + rows[i] + "</span>");
      i++;
    }
    code.innerHTML = out.join("") || " ";
    applyFoldVisibility();
    code.scrollTop = editor.scrollTop; code.scrollLeft = editor.scrollLeft;
    updateGutter();
    paintMinimap();
  };

  /** Minimap: a read-only, scaled-down copy of the document. It never touches
   * editor.value, so the dirty flag, the CRDT sync, saving and the agent
   * reload all keep working unchanged. Click or drag to scroll. */
  const paintMinimap = () => {
    const lines = editor.value.split("\n");
    const rows = Math.min(lines.length, 4000);
    const out = [];
    for (let i = 0; i < rows; i++) {
      const raw = lines[i] || "";
      const indent = raw.length - raw.replace(/^\s+/, "").length;
      const len = Math.min(Math.max(raw.trim().length - indent, 0), 60);
      out.push("<i style=\"width:" + (len * 1.6) + "px;margin-left:" + Math.min(indent, 12) * 1.6 + "px\"></i>");
    }
    // On ecrit dans mmBars, jamais dans minimap : sinon innerHTML effacerait
    // le cadre de viewport (mmBox) et il disparaitrait au premier rendu.
    mmBars.innerHTML = out.join("");
    paintMinimapViewport();
  };
  const paintMinimapViewport = () => {
    const mm = minimap.getBoundingClientRect ? minimap.getBoundingClientRect() : null;
    if (!mm || !mm.height) return;
    const ed = editor.getBoundingClientRect ? editor.getBoundingClientRect() : null;
    if (!ed || !ed.height) return;
    const scrollRange = Math.max(1, editor.scrollHeight - ed.height);
    const frac = Math.min(1, Math.max(0, editor.scrollTop / scrollRange));
    const boxH = Math.max(18, (ed.height / Math.max(1, editor.scrollHeight)) * mm.height);
    mmBox.style.height = boxH + "px";
    mmBox.style.transform = "translateY(" + frac * (mm.height - boxH) + "px)";
  };
  const scrollFromMinimap = (clientY) => {
    const mm = minimap.getBoundingClientRect ? minimap.getBoundingClientRect() : null;
    if (!mm || !mm.height) return;
    const ed = editor.getBoundingClientRect ? editor.getBoundingClientRect() : null;
    if (!ed) return;
    const frac = Math.min(1, Math.max(0, (clientY - mm.top) / mm.height));
    const scrollRange = Math.max(0, editor.scrollHeight - ed.height);
    editor.scrollTop = frac * scrollRange;
    code.scrollTop = editor.scrollTop;
    gutter.scrollTop = editor.scrollTop;
    paintMinimapViewport();
  };
  let mmDragging = false;
  minimap.addEventListener("mousedown", (e) => {
    mmDragging = true;
    scrollFromMinimap(e.clientY);
    e.preventDefault();
  });
  minimap.addEventListener("mousemove", (e) => { if (mmDragging) scrollFromMinimap(e.clientY); });
  t.winMouseup = () => { mmDragging = false; };
  window.addEventListener("mouseup", t.winMouseup);
  editor.addEventListener("scroll", paintMinimapViewport);

  const showError = (message) => {
    meta.textContent = String(message || "");
    meta.classList.toggle("error", !!message);
  };
  function getFileItemHtml(name, isDir) {
    var safeName = String(name || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (isDir) {
      var folderSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;margin-right:6px;"><path d="M1.5 3A1.5 1.5 0 0 1 3 1.5h3.1a1.5 1.5 0 0 1 1.06.44L8.5 3.25H13A1.5 1.5 0 0 1 14.5 4.75v8a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12.75V3z" fill="#E8B839"/><path d="M1.5 5.5h13v7.25a1.25 1.25 0 0 1-1.25 1.25H2.75A1.25 1.25 0 0 1 1.5 12.75V5.5z" fill="#F4CF65"/></svg>';
      return folderSvg + '<span class="fileitem-name" style="color:#fde047;font-weight:500;">' + safeName + '</span>';
    }
    var lower = String(name || "").toLowerCase();
    var ext = lower.indexOf(".") !== -1 ? lower.split(".").pop() : "";
    var iconSvg = '';
    var nameColor = '#e2e8f0';

    if (lower.indexOf(".env") === 0 || lower.indexOf(".git") === 0 || lower === "dockerfile" || ext === "yml" || ext === "yaml" || ext === "toml") {
      if (lower.indexOf(".git") === 0) {
        iconSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;margin-right:6px;"><rect width="16" height="16" rx="2" fill="#2b1b1a"/><path d="M13.2 7.1L8.9 2.8a1 1 0 0 0-1.4 0L6.1 4.2l1.8 1.8a1.2 1.2 0 0 1 1.5 1.5l1.7 1.7a1.2 1.2 0 1 1-.7.7l-1.6-1.6v3.2a1.2 1.2 0 1 1-1 0v-4.5a1.2 1.2 0 0 1-.6-1.5L5.4 3.5 2.8 6.1a1 1 0 0 0 0 1.4l4.3 4.3a1 1 0 0 0 1.4 0l4.7-4.7z" fill="#F05032"/></svg>';
        nameColor = '#f87171';
      } else {
        iconSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;margin-right:6px;"><rect width="16" height="16" rx="2" fill="#23272e"/><circle cx="8" cy="8" r="2.5" stroke="#94A3B8" stroke-width="1.2"/><path d="M8 2.5v1.2M8 12.3v1.2M2.5 8h1.2M12.3 8h1.2M4.1 4.1l.9.9M11 11l.9.9M4.1 11.9l.9-.9M11 5l.9-.9" stroke="#94A3B8" stroke-width="1.2" stroke-linecap="round"/></svg>';
        nameColor = '#cbd5e1';
      }
    } else {
      switch (ext) {
        case "js":
        case "mjs":
        case "cjs":
          iconSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;margin-right:6px;"><rect width="16" height="16" rx="2" fill="#F7DF1E"/><text x="3.5" y="12.5" font-size="9" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-weight="900" fill="#000000">JS</text></svg>';
          nameColor = "#fef08a";
          break;
        case "ts":
        case "mts":
        case "cts":
          iconSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;margin-right:6px;"><rect width="16" height="16" rx="2" fill="#3178C6"/><text x="3" y="12.5" font-size="9" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-weight="900" fill="#FFFFFF">TS</text></svg>';
          nameColor = "#bae6fd";
          break;
        case "jsx":
        case "tsx":
          iconSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;margin-right:6px;"><circle cx="8" cy="8" r="1.6" fill="#61DAFB"/><ellipse cx="8" cy="8" rx="6.5" ry="2.5" stroke="#61DAFB" stroke-width="1.1" transform="rotate(30 8 8)"/><ellipse cx="8" cy="8" rx="6.5" ry="2.5" stroke="#61DAFB" stroke-width="1.1" transform="rotate(90 8 8)"/><ellipse cx="8" cy="8" rx="6.5" ry="2.5" stroke="#61DAFB" stroke-width="1.1" transform="rotate(150 8 8)"/></svg>';
          nameColor = "#a5f3fc";
          break;
        case "py":
        case "pyw":
          iconSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;margin-right:6px;"><path d="M7.9 1.5c-3.1 0-2.9 1.3-2.9 1.3v1.4h3v.4H3.8s-1.8.2-1.8 2.7 1.6 2.6 1.6 2.6h.9V8.6s-.1-1.6 1.6-1.6h2.7s1.5 0 1.5-1.5V3s.2-1.5-2.2-1.5zm-1.6.9c.3 0 .5.2.5.5s-.2.5-.5.5-.5-.2-.5-.5.2-.5.5-.5z" fill="#3776AB"/><path d="M8.1 14.5c3.1 0 2.9-1.3 2.9-1.3v-1.4h-3v-.4h4.2s1.8-.2 1.8-2.7-1.6-2.6-1.6-2.6h-.9v1.3s.1 1.6-1.6 1.6H7.2s-1.5 0-1.5 1.5V13s-.2 1.5 2.4 1.5zm1.6-.9c-.3 0-.5-.2-.5-.5s.2-.5.5-.5.5.2.5.5-.2.5-.5.5z" fill="#FFD43B"/></svg>';
          nameColor = "#bfdbfe";
          break;
        case "html":
        case "htm":
          iconSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;margin-right:6px;"><path d="M2.5 1.5l1.1 12.3 4.4 1.2 4.4-1.2 1.1-12.3H2.5z" fill="#E34F26"/><path d="M8 2.5v11.3l3.4-.9.9-9.5L8 2.5z" fill="#EF652A"/><path d="M5.3 4.7h5.4l-.2 1.7H5.5l.2 1.8h4.8l-.4 4-2.1.6-2.1-.6-.1-1.5H4.2l.3 2.6 3.5 1 3.5-1 .8-8.6H5.1l.2 1z" fill="#FFFFFF"/></svg>';
          nameColor = "#fed7aa";
          break;
        case "css":
        case "scss":
        case "less":
          iconSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;margin-right:6px;"><path d="M2.5 1.5l1.1 12.3 4.4 1.2 4.4-1.2 1.1-12.3H2.5z" fill="#1572B6"/><path d="M8 2.5v11.3l3.4-.9.9-9.5L8 2.5z" fill="#33A9DC"/><path d="M5.3 4.7h5.4l-.2 1.7H5.5l.2 1.8h4.8l-.4 4-2.1.6-2.1-.6-.1-1.5H4.2l.3 2.6 3.5 1 3.5-1 .8-8.6H5.1l.2 1z" fill="#FFFFFF"/></svg>';
          nameColor = "#e9d5ff";
          break;
        case "json":
          iconSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;margin-right:6px;"><rect width="16" height="16" rx="2" fill="#20252b"/><text x="2" y="12" font-size="11" font-family="Consolas,monospace" font-weight="900" fill="#CBCB41">{ }</text></svg>';
          nameColor = "#d9f99d";
          break;
        case "md":
        case "markdown":
          iconSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;margin-right:6px;"><rect width="16" height="12" x="0" y="2" rx="1.5" fill="#388E3C" stroke="#2E7D32" stroke-width="0.5"/><path d="M2.5 9V5.5l2 2.2 2-2.2V9M10 5.5v3.5m0 0l-1.5-1.5m1.5 1.5l1.5-1.5" stroke="#FFFFFF" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          nameColor = "#cbd5e1";
          break;
        case "sh":
        case "bash":
        case "bat":
        case "cmd":
        case "ps1":
          iconSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;margin-right:6px;"><rect width="16" height="16" rx="2" fill="#18251e"/><path d="M3.5 4.5l3.5 3.5-3.5 3.5M8.5 11.5h4" stroke="#4ADE80" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          nameColor = "#bbf7d0";
          break;
        case "png":
        case "jpg":
        case "jpeg":
        case "gif":
        case "svg":
        case "ico":
        case "webp":
          iconSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;margin-right:6px;"><rect width="16" height="16" rx="2" fill="#2b1a20"/><rect x="2.5" y="2.5" width="11" height="11" rx="1" stroke="#F43F5E" stroke-width="1"/><circle cx="5.5" cy="5.5" r="1.2" fill="#F43F5E"/><path d="M3.5 12l3-3.5 2.5 2.5 2-2 1.5 3H3.5z" fill="#F43F5E"/></svg>';
          nameColor = "#fecdd3";
          break;
        default:
          iconSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;margin-right:6px;"><path d="M3.5 1.5h6l3.5 3.5v9.5H3.5V1.5z" fill="#2d333b" stroke="#768390" stroke-width="0.8"/><path d="M9.5 1.5v3.5h3.5" fill="#373e47"/><path d="M5.5 7h5M5.5 9.5h5M5.5 12h3" stroke="#768390" stroke-width="0.8" stroke-linecap="round"/></svg>';
          nameColor = "#d4d4d4";
          break;
      }
    }
    return iconSvg + '<span class="fileitem-name" style="color:' + nameColor + ';">' + safeName + '</span>';
  }
  // Nested tree: folders expand in place (▸/▾), files open as editor tabs.
  // Children load once and stay cached; refresh re-fetches open folders.
  t.treeCache = new Map();
  t.expanded = new Set(["."]);
  const treeKey = (p) => (p && p !== "." ? p : ".");
  const statusBadge = (status) => {
    const badge = el("span", "fileitem-badge status-" + String(status).toLowerCase(), status);
    const label = ({ M: "Modifié", A: "Ajouté", D: "Supprimé", R: "Renommé", U: "Non suivi" })[status] || "Changement Git";
    badge.title = label;
    badge.setAttribute("aria-label", label);
    return badge;
  };
  const agentActivityBadge = (rel) => {
    const key = String(rel || "").replace(/\\/g, "/").replace(/^\.\//, "");
    const operations = v.agentFileOps.get(key);
    if (!operations?.size) return null;
    const names = [...new Set(operations.values())];
    const label = "Agent en cours : " + names.join(", ");
    const badge = el("span", "fileitem-agent-badge", "IA");
    badge.title = label;
    badge.setAttribute("aria-label", label);
    return badge;
  };
  const ensureKids = (rel, force) => {
    const key = treeKey(rel);
    if (!force && t.treeCache.has(key)) return Promise.resolve();
    // Stale-while-revalidate: a folder that already has children keeps them on
    // screen while the new listing arrives. Blanking the cache first is what
    // made the whole panel flash to "Loading…" and back on every refresh.
    if (!t.treeCache.has(key)) { t.treeCache.set(key, null); renderNestedTree(); }
    return fetch("/workspace/tree?k=" + k + "&sid=" + encodeURIComponent(v.sid) + "&path=" + encodeURIComponent(rel))
      .then((r) => r.json()).then((d) => {
        if (d.error) throw new Error(d.error);
        t.treeCache.set(treeKey(d.path || rel), d.entries || []);
      }).catch((e) => { t.treeCache.set(key, { error: String(e.message || e) }); })
      .finally(() => renderNestedTree());
  };
  const renderNestedTree = () => {
    // Build the markup off-screen first and swap it in only when it really
    // changed. Wiping the live tree on every probe made folders and files blink
    // out and back even when the listing was byte-for-byte identical.
    const buf = document.createElement("div");
    const paint = (container, rel, depth) => {
      const kids = t.treeCache.get(treeKey(rel));
      if (kids === undefined || kids === null) {
        const w = el("div", "filediagnostic-note", "Loading…");
        w.style.paddingLeft = (depth * 14 + 6) + "px";
        container.appendChild(w);
        return;
      }
      if (kids.error) {
        container.appendChild(el("div", "filediagnostic-note error", kids.error));
        return;
      }
      for (const item of kids) {
        const row = el("div", "treerow");
        row.style.paddingLeft = (depth * 14) + "px";
        if (depth > 0) {
          row.style.backgroundImage = "repeating-linear-gradient(to right, transparent 0 7px, rgba(255,255,255,.16) 7px 8px, transparent 8px 14px)";
          row.style.backgroundSize = (depth * 14) + "px 100%";
          row.style.backgroundRepeat = "no-repeat";
        }
        if (item.dir) {
          const open = t.expanded.has(item.path);
          const tg = el("button", "treetoggle", open ? "▾" : "▸");
          tg.type = "button"; tg.title = open ? "collapse" : "expand";
          tg.onclick = (e) => { e.stopPropagation(); toggleFolder(item.path); };
          const b = el("button", "fileitem folder");
          b.title = item.path;
          b.innerHTML = getFileItemHtml(item.name, true);
          b.onclick = () => toggleFolder(item.path);
          row.appendChild(tg);
          row.appendChild(b);
          const agentBadge = agentActivityBadge(item.path);
          if (agentBadge) row.appendChild(agentBadge);
          if (item.status) row.appendChild(statusBadge(item.status));
          container.appendChild(row);
          if (open) {
            const sub = el("div", "treesub");
            container.appendChild(sub);
            paint(sub, item.path, depth + 1);
          }
        } else {
          row.appendChild(el("span", "treespacer"));
          const b = el("button", "fileitem");
          b.title = item.path;
          b.innerHTML = getFileItemHtml(item.name, false);
          b.onclick = () => t.loadFile(item.path);
          row.appendChild(b);
          const agentBadge = agentActivityBadge(item.path);
          if (agentBadge) row.appendChild(agentBadge);
          if (item.status) row.appendChild(statusBadge(item.status));
          container.appendChild(row);
        }
      }
    };
    paint(buf, ".", 0);
    if (buf.innerHTML === tree.innerHTML) return;
    // Keep the reading position: rebuilding the markup reset scrollTop to 0 on
    // every repaint, which made the panel jump to the top each time it flashed.
    const keepScroll = tree.scrollTop;
    tree.replaceChildren(...buf.childNodes);
    tree.scrollTop = keepScroll;
  };
  const toggleFolder = (rel) => {
    if (t.expanded.has(rel)) {
      t.expanded.delete(rel);
      const drop = [];
      t.expanded.forEach((p) => { if (p !== rel && p.startsWith(rel + "/")) drop.push(p); });
      drop.forEach((p) => t.expanded.delete(p));
    } else {
      t.expanded.add(rel);
      t.rel = rel;
      pathInput.value = rel;
    }
    if (t.expanded.has(rel)) void ensureKids(rel).catch((e) => showError(e.message));
    renderNestedTree();
  };
  t.loadDir = (rel) => {
    rel = rel || ".";
    const parts = rel === "." ? [] : String(rel).split("/");
    let acc = "";
    const chain = ["."];
    for (const p of parts) { acc = acc ? acc + "/" + p : p; chain.push(acc); }
    chain.forEach((c) => t.expanded.add(c));
    t.rel = rel;
    pathInput.value = rel;
    renderNestedTree();
    // Fetch the missing levels in parallel: the sequential chain repainted once
    // per level, so the tree visibly rebuilt itself several times in a row.
    Promise.all(chain.filter((c) => !t.treeCache.has(treeKey(c))).map((c) => ensureKids(c)))
      .catch((e) => showError(e.message));
  };
  const renderTabs = () => {
    tabsBar.replaceChildren();
    for (const tab of t.tabStore.list()) {
      const item = el("div", "filetab" + (tab.path === t.filePath ? " active" : ""));
      const label = el("button", "filetab-label", (tab.dirty ? "● " : "") + tab.path.split("/").pop());
      label.type = "button"; label.title = tab.path; label.setAttribute("aria-selected", String(tab.path === t.filePath));
      label.onclick = () => t.loadFile(tab.path);
      const close = el("button", "filetab-close", "×"); close.type = "button"; close.title = "Fermer " + tab.path;
      close.setAttribute("aria-label", "Fermer " + tab.path);
      close.onclick = (event) => { event.stopPropagation(); closeFile(tab.path); };
      item.append(label, close); tabsBar.appendChild(item);
    }
  };
  const displayTab = (tab) => {
    const nextPath = tab ? tab.path : "";
    // displayTab always reloads editor.value, so ANY inline range is stale —
    // including same-path ones (agent reload). Kill the bar and in-flight
    // results unconditionally so Enter can never splice into the wrong buffer.
    inlineRange = null; inlineBar.hidden = true; inlinePreview.hidden = true; inlineGen++;
    t.filePath = nextPath; t.mtimeMs = tab ? tab.mtimeMs : 0;
    imagePreview.hidden = true;
    // Un .gz affiché par le hub l'est forcément décompressé : lecture seule.
    // Idem pour le listing d'une .zip et ses membres (« archive › fichier »).
    t.decompressed = /\.(?:gz|gzip|zip)$/i.test(nextPath) || nextPath.includes(" › ");
    imageEl.removeAttribute("src");
    t.diags = [];
    editor.value = tab ? tab.content : "";
    editor.dataset.original = tab ? tab.savedContent : "";
    if (tab && !t.agentDiffBases.has(tab.path)) t.agentDiffBases.set(tab.path, tab.savedContent);
    editor.dataset.diffBase = tab ? (t.agentDiffBases.get(tab.path) ?? tab.savedContent) : "";
    editor.dataset.dirty = tab && tab.dirty ? "1" : "0";
    save.disabled = v.state.mode === "ro" || !tab || t.decompressed;
    const med = ensureWebMonacoEditor();
    if (med && window.monaco && tab) {
      monacoHost.style.display = "block";
      editor.hidden = true; code.hidden = true; gutter.hidden = true; minimap.hidden = true;
      const uri = window.monaco.Uri.file(tab.path);
      let model = window.monaco.editor.getModel(uri);
      if (!model) {
        model = window.monaco.editor.createModel(tab.content || "", monacoLanguageFor(tab.path), uri);
        model.onDidChangeContent(() => {
          const val = model.getValue();
          editor.value = val;
          const activeTab = t.tabStore.active();
          if (activeTab && activeTab.path === tab.path) {
            t.tabStore.update(tab.path, val);
            activeTab.dirty = (val !== activeTab.savedContent);
            editor.dataset.dirty = activeTab.dirty ? "1" : "0";
            save.disabled = v.state.mode === "ro" || t.decompressed || !activeTab.dirty;
            renderTabs();
          }
          try { syncCollab(); } catch (e) {}
        });
      } else if (model.getValue() !== (tab.content || "") && !tab.dirty) {
        model.setValue(tab.content || "");
      }
      med.setModel(model);
      med.updateOptions({ readOnly: v.state.mode === "ro" || t.decompressed });
    } else {
      if (monacoHost) monacoHost.style.display = "none";
      editor.hidden = false; code.hidden = false; gutter.hidden = false; minimap.hidden = false;
      folds.clear();
      applyFoldVisibility();
      paint();
      updateGutter();
    }
    const ext = tab && tab.path ? (tab.path.split(".").pop() || "").toLowerCase() : "";
    const langNames = {
      ts: "TypeScript", js: "JavaScript", tsx: "TypeScript JSX", jsx: "JavaScript JSX",
      py: "Python", json: "JSON", html: "HTML", css: "CSS", scss: "SCSS",
      md: "Markdown", sh: "Shell", bash: "Bash", ps1: "PowerShell",
      rs: "Rust", go: "Go", c: "C", cpp: "C++", java: "Java", sql: "SQL"
    };
    const lang = langNames[ext] || (ext ? ext.toUpperCase() : "Plain Text");
    const sbLang = $("sb-lang-text");
    if (sbLang) sbLang.textContent = lang;
    const isCrlf = tab && tab.content && tab.content.includes("\r\n");
    const sbEol = $("sb-eol");
    if (sbEol) sbEol.textContent = isCrlf ? "CRLF" : "LF";
    updatePosition();
    meta.classList.remove("error");
    if (t.decompressed) {
      const kind = /\.(?:gz|gzip)$/i.test(nextPath)
        ? ".gz décompressé (lecture seule)"
        : nextPath.includes(" › ")
          ? "membre d'archive .zip (lecture seule)"
          : "listing de l'archive .zip (double-clic pour ouvrir)";
      meta.textContent = nextPath + " · " + kind;
    }
    const shownPath = tab ? tab.path : (t.rel || ".");
    pathInput.value = shownPath.includes(" › ") ? shownPath.slice(0, shownPath.indexOf(" › ")) : shownPath;
    renderTabs();
    void analyzeFile(t.filePath);
    openCollab(tab && !tab.dirty ? tab.path : "");
  };
  // Live collaboration: the open clean file joins a shared CRDT doc; local
  // edits stream as ops, remote ops patch the textarea. Saves and agent
  // writes re-bootstrap everyone from disk (authoritative file wins).
  t.refreshEditor = () => { paint(); renderTabs(); updatePosition(); };
  t.collab = null;
  const openCollab = (rel) => {
    t.collab = null;
    if (!rel) return;
    // Un .gz affiché décompressé est lecture seule : pas de doc partagée,
    // et cela évite un appel /edit/open que le hub refuse (400).
    if (t.decompressed) return;
    const cur = t.tabStore.active();
    if (!cur || cur.path !== rel || cur.dirty) return;
    post("/edit/open", { sid: v.sid, path: rel }).then((r) => {
      if (!r || r.error || typeof r.text !== "string") return;
      if (t.filePath !== rel) return;
      const still = t.tabStore.active();
      if (!still || still.path !== rel || still.dirty) return;
      const doc = docFromText(r.text);
      doc.site = "w" + v.sid + t.id;
      doc.counter = 0;
      t.collab = { path: rel, doc, shadow: r.text, version: r.version || 0 };
    }).catch(() => {});
  };
  const syncCollab = () => {
    const c = t.collab;
    if (!c || !c.doc || c.path !== t.filePath) return;
    let d;
    try { d = diffForSync(c.shadow, editor.value); } catch (e) { return; }
    if (!d.del && !d.ins) return;
    const ops = [];
    try {
      if (d.del) ops.push(...localDelete(c.doc, d.at, d.del));
      if (d.ins) ops.push(...localInsert(c.doc, d.at, d.ins));
    } catch (e) { return; }
    c.shadow = editor.value;
    if (!ops.length) return;
    post("/edit/op", { sid: v.sid, path: c.path, ops }).catch(() => {});
  };
  editor.addEventListener("input", () => { try { syncCollab(); } catch (e) {} });
  const agentBar = el("div", "fileinlinebar"); agentBar.hidden = true;
  const agentText = el("span", "filemeta", "");
  agentText.style.flex = "1";
  const agentReload = el("button", "iconbtn", "Recharger"); agentReload.type = "button";
  const agentKeep = el("button", "iconbtn", "Garder"); agentKeep.type = "button"; agentKeep.title = "Garder ma version (la prochaine sauvegarde l'écrase)";
  const agentX = el("button", "iconbtn", "×"); agentX.type = "button";
  agentBar.append(agentText, agentReload, agentKeep, agentX);
  body.insertBefore(agentBar, split);
  const hideAgentBar = () => { agentBar.hidden = true; };
  agentX.onclick = hideAgentBar;
  agentReload.onclick = () => {
    hideAgentBar();
    if (!t.filePath) return;
    t.tabStore.close(t.filePath, true);
    t.collab = null;
    void t.loadFile(t.filePath);
  };
  agentKeep.onclick = () => {
    if (!t.filePath) { hideAgentBar(); return; }
    fetch("/workspace/file?k=" + k + "&sid=" + encodeURIComponent(v.sid) + "&path=" + encodeURIComponent(t.filePath) + "&meta=1")
      .then((r) => r.json()).then((d) => {
        if (d && !d.error && Number.isFinite(d.mtimeMs)) t.mtimeMs = d.mtimeMs;
        hideAgentBar();
      }).catch(() => hideAgentBar());
  };
  let metaCheckAt = 0;
  let checkingDisk = false;
  let reloadingDisk = false;
  const checkAgentChange = () => {
    if (!t.filePath || !t.mtimeMs || checkingDisk || reloadingDisk) return;
    const now = Date.now();
    if (now - metaCheckAt < 5000) return;
    metaCheckAt = now;
    checkingDisk = true;
    fetch("/workspace/file?k=" + k + "&sid=" + encodeURIComponent(v.sid) + "&path=" + encodeURIComponent(t.filePath) + "&meta=1")
      .then((r) => r.json()).then((d) => {
        if (!d || d.error || !Number.isFinite(d.mtimeMs)) return;
        if (Math.abs(d.mtimeMs - t.mtimeMs) > 1 && t.filePath) {
          const changedPath = t.filePath;
          const tab = t.tabStore.active();
          if (tab && !tab.dirty) {
            t.agentDiffBases.set(changedPath, tab.savedContent);
            reloadingDisk = true;
            agentBar.hidden = true;
            t.tabStore.close(changedPath, true);
            t.collab = null;
            void t.loadFile(changedPath).finally(() => { reloadingDisk = false; });
          } else {
            agentText.textContent = "L’agent a modifié ce fichier. Le buffer local contient des changements : recharge après les avoir sauvegardés ou copiés.";
            agentBar.hidden = false;
          }
        }
      }).catch(() => {}).finally(() => { checkingDisk = false; });
  };
  t.agentPollTimer = setInterval(() => {
    if (active === v && v.panelOpen && curTab(v) && curTab(v).id === t.id) checkAgentChange();
  }, 2000);
  editor.addEventListener("focus", () => {
    if (v.activeTab !== t.id) { v.activeTab = t.id; savePanel(v); renderPanel(); }
    try { checkAgentChange(); } catch (e) {}
  });
  let lastCursorKey = "";
  let lastCursorAt = 0;
  const broadcastCursor = (line, col) => {
    if (!t.filePath) return;
    const c = col || 1;
    const key = t.filePath + ":" + line + ":" + c;
    const now = Date.now();
    if (key === lastCursorKey && now - lastCursorAt < 2000) return;
    lastCursorKey = key;
    lastCursorAt = now;
    fetch("/cursor?k=" + k, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sid: v.sid, path: t.filePath, line, col: c, name: ls.get("smol-viewer") || "owner" }),
    }).catch(() => {});
  };
  t.remoteCursors = new Map();
  t.monacoCursorDecs = [];
  t.onRemoteCursor = (msg) => {
    if (!msg || !msg.name || msg.name === (ls.get("smol-viewer") || "owner")) return;
    if (msg.path !== t.filePath) {
      t.remoteCursors.delete(msg.name);
    } else if (msg.line > 0) {
      t.remoteCursors.set(msg.name, { line: msg.line, col: msg.col || 1, at: Date.now() });
    } else {
      t.remoteCursors.delete(msg.name);
    }
    if (t.monacoEditor && window.monaco) {
      const decs = [];
      const now = Date.now();
      t.remoteCursors.forEach((cur, cname) => {
        if (now - cur.at > 35000) return;
        const colorIdx = Math.abs(cname.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0)) % 5;
        decs.push({
          range: new window.monaco.Range(cur.line, cur.col, cur.line, cur.col + 1),
          options: {
            className: "remote-cursor remote-cursor-" + colorIdx,
            hoverMessage: { value: "**" + cname + "** (collaborateur)" },
            after: {
              content: " " + cname,
              inlineClassName: "remote-cursor-flag remote-cursor-" + colorIdx,
            },
          },
        });
      });
      t.monacoCursorDecs = t.monacoEditor.deltaDecorations(t.monacoCursorDecs || [], decs);
    }
  };
  const updatePosition = () => {
    const position = editorTools.cursorPosition(editor.value, editor.selectionStart);
    const tab = t.filePath && t.tabStore.active();
    meta.textContent = (t.filePath ? t.filePath + " · " : "") + "Ln " + position.line + ", Col " + position.column + (tab && tab.dirty ? " · modifié" : "");
    const sbPos = $("sb-pos-text");
    if (sbPos) sbPos.textContent = "Ln " + position.line + ", Col " + position.column;
    broadcastCursor(position.line, position.column);
  };
  // Which extensions a pro language server can own. Asked of the hub rather
  // than hardcoded: the catalogue has 37 languages, and a regex here silently
  // excluded every one except py/rs/go.
  let serverExts = null;
  let missingLangs = null;
  const proLangFor = async () => {
    if (serverExts) return serverExts;
    serverExts = [];
    missingLangs = [];
    try {
      const r = await fetch("/code/availability?k=" + k + "&sid=" + encodeURIComponent(v.sid));
      const d = await r.json();
      const exts = [];
      const missing = [];
      for (const s of d.servers || []) {
        exts.push(...(s.exts || []));
        if (!s.ok) missing.push({ lang: s.lang, hint: s.hint, exts: s.exts || [] });
      }
      serverExts = exts;
      missingLangs = missing;
    } catch {
      serverExts = [".py", ".rs", ".go"];
    }
    return serverExts;
  };
  /** When a file's language has no server installed, offer the install in the
   * diagnostics panel rather than leaving a silent "unsupported language".
   * Once per language, then never again for that session. */
  const offerLspInstall = (filePath) => {
    if (!missingLangs) return;
    const ext = (String(filePath).match(/\.[A-Za-z0-9]+$/) || [""])[0].toLowerCase();
    if (!ext) return;
    const hit = missingLangs.find((m) => m && (m.exts || []).some((e) => ext === String(e).toLowerCase()));
    if (!hit) return;
    const key = "smol.lspask." + hit.lang;
    if (ls.get(key)) return;
    ls.set(key, "1");
    const row = el("div", "filediagnostic-note lspinstall");
    row.appendChild(el("span", "", "Aucun serveur de langage installé pour ." + ext + " — "));
    const b = el("button", "iconbtn", "Installer " + hit.lang);
    b.type = "button";
    b.title = hit.hint || "Installer le serveur de langage";
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = "Installation…";
      const r = await post("/code/lsp/install", { sid: v.sid, lang: hit.lang });
      if (r && r.error) {
        b.disabled = false;
        b.textContent = "Réessayer";
        row.appendChild(el("span", "note", " " + String(r.error).slice(0, 160)));
        return;
      }
      row.remove();
      showError((r && r.detail) || "Serveur installé.");
      // The catalogue is cached for the page: re-read it so the next file of
      // this language is analysed instead of refused.
      serverExts = null;
      missingLangs = null;
    };
    row.appendChild(b);
    diagnosticsPanel.appendChild(row);
  };
  const analyzeFile = async (filePath = t.filePath) => {
    if (!filePath) {
      diagnosticRequest++;
      diagnosticsPanel.replaceChildren(el("div", "filediagnostic-note", "Ouvrez un fichier de code pour lancer l’analyse."));
      diagnosticsPanel.scrollIntoView?.({ block: "nearest" });
      return;
    }
    // TypeScript/JavaScript go through the workspace diagnostics; every other
    // language goes through the pro language server for that extension.
    const exts = await proLangFor();
    const proLang = exts.some((e) => filePath.toLowerCase().endsWith(e));
    if (!proLang && !/\.(?:[cm]?js|jsx|tsx?)$/i.test(filePath)) {
      diagnosticRequest++;
      diagnosticsPanel.replaceChildren();
      return;
    }
    // A language with no server installed is the common case on a fresh
    // machine: say so and offer the install instead of failing silently.
    if (proLang) {
      const ext = (filePath.match(/\.[A-Za-z0-9]+$/) || [""])[0].toLowerCase();
      const missing = (missingLangs || []).find((m) => m && (m.exts || []).some((e) => ext === String(e).toLowerCase()));
      if (missing) {
        diagnosticRequest++;
        diagnosticsPanel.replaceChildren();
        offerLspInstall(filePath);
        return;
      }
    }
    const active = t.tabStore.active();
    if (active && active.path === filePath && active.dirty) {
      diagnosticRequest++;
      diagnosticsPanel.replaceChildren(el("div", "filediagnostic-note", "Enregistrez les modifications pour analyser la version actuelle."));
      return;
    }
    const request = ++diagnosticRequest;
    diagnosticsPanel.replaceChildren(el("div", "filediagnostic-note", "Analyse du fichier…"));
    try {
      const url = proLang
        ? "/code/diag-structured?k=" + k + "&sid=" + encodeURIComponent(v.sid) + "&path=" + encodeURIComponent(filePath)
        : "/workspace/diagnostics?k=" + k + "&sid=" + encodeURIComponent(v.sid) + "&path=" + encodeURIComponent(filePath);
      const response = await fetch(url);
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || "L’analyse a échoué.");
      if (request !== diagnosticRequest || filePath !== t.filePath) return;
      diagnosticsPanel.replaceChildren();
      t.diags = result.diagnostics || [];
      paint();
      if (t.monacoEditor && window.monaco) {
        const model = t.monacoEditor.getModel();
        if (model) {
          const markers = (t.diags || []).map((d) => ({
            severity: d.severity === "error" ? window.monaco.MarkerSeverity.Error : window.monaco.MarkerSeverity.Warning,
            message: d.message,
            startLineNumber: Number(d.line) || 1,
            startColumn: Number(d.col) || 1,
            endLineNumber: Number(d.endLine || d.line) || 1,
            endColumn: Number(d.endCol || (Number(d.col) + 5)) || 5,
          }));
          window.monaco.editor.setModelMarkers(model, "lsp", markers);
        }
      }
      let errCnt = 0, warnCnt = 0;
      for (const d of (result.diagnostics || [])) {
        if (d.severity === "error") errCnt++;
        else warnCnt++;
      }
      const errEl = $("sb-err-cnt");
      const warnEl = $("sb-warn-cnt");
      if (errEl) errEl.textContent = String(errCnt);
      if (warnEl) warnEl.textContent = String(warnCnt);
      if (result.message) diagnosticsPanel.appendChild(el("div", "filediagnostic-note", result.message));
      if (result.text && !(result.diagnostics || []).length && !result.message) {
        diagnosticsPanel.appendChild(el("div", "filediagnostic-note", result.text));
      }
      for (const diagnostic of result.diagnostics || []) {
        const row = el("div", "filediagnostic " + diagnostic.severity);
        const go = el("button", "filediagnostic-go", diagnostic.severity.toUpperCase() + "  " + diagnostic.path + ":" + diagnostic.line + "  " + diagnostic.message);
        go.type = "button";
        go.onclick = async () => {
          if (diagnostic.path !== t.filePath && !await t.loadFile(diagnostic.path)) return;
          const offset = editorTools.offsetForPosition(editor.value, diagnostic.line);
          editor.focus(); editor.setSelectionRange(offset, offset); updatePosition();
          if (t.monacoEditor && window.monaco) {
            const line = Number(diagnostic.line) || 1;
            const col = Number(diagnostic.col) || 1;
            t.monacoEditor.focus();
            t.monacoEditor.setPosition({ lineNumber: line, column: col });
            t.monacoEditor.revealPositionInCenter({ lineNumber: line, column: col });
          }
        };
        const fix = el("button", "iconbtn", "🤖");
        fix.type = "button"; fix.title = "Corriger avec l’IA";
        fix.onclick = async () => {
          if (diagnostic.path !== t.filePath && !await t.loadFile(diagnostic.path)) return;
          const lines = editor.value.split("\n");
          const li = Math.max(0, Math.min((diagnostic.line || 1) - 1, lines.length - 1));
          const start = lines.slice(0, li).join("\n").length + (li > 0 ? 1 : 0);
          editor.focus(); editor.setSelectionRange(start, start + (lines[li] || "").length); updatePosition();
          openInlineBar();
        };
        row.appendChild(go); row.appendChild(fix);
        diagnosticsPanel.appendChild(row);
      }
      if (!(result.diagnostics || []).length && !result.message && !result.text) {
        diagnosticsPanel.appendChild(el("div", "filediagnostic-note ok", "Aucun problème détecté."));
      }
      diagnosticsPanel.scrollIntoView?.({ block: "nearest" });
    } catch (error) {
      if (request !== diagnosticRequest || filePath !== t.filePath) return;
      diagnosticsPanel.replaceChildren(el("div", "filediagnostic-note error", String(error.message || error)));
    }
  };
  const updateCurrentFindCount = () => {
    const query = currentFindInput.value;
    const result = editorTools.findMatches(editor.value, query, { limit: 1000 });
    currentFindCount.textContent = !query ? "" : result.matches.length + (result.truncated ? "+" : "") + " occurrence(s)";
  };
  const openCurrentFind = (replaceMode = false) => {
    if (!t.filePath) return;
    fileFindBar.hidden = false;
    currentReplaceInput.hidden = !replaceMode; currentReplaceOne.hidden = !replaceMode; currentReplaceAll.hidden = !replaceMode;
    if (editor.selectionStart !== editor.selectionEnd) currentFindInput.value = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    updateCurrentFindCount(); currentFindInput.focus(); currentFindInput.select();
  };
  const closeCurrentFind = () => { fileFindBar.hidden = true; editor.focus(); };
  const moveCurrentFind = (backwards = false) => {
    const match = editorTools.findNextMatch(editor.value, currentFindInput.value, backwards ? editor.selectionStart : editor.selectionEnd, backwards);
    if (!match) { currentFindCount.textContent = currentFindInput.value ? "Aucun résultat" : ""; return; }
    editor.focus(); editor.setSelectionRange(match.start, match.end); updatePosition();
  };
  const replaceCurrentOne = () => {
    const query = currentFindInput.value;
    if (!query) { currentFindCount.textContent = "Saisissez un texte à rechercher."; return; }
    const match = editorTools.findNextMatch(editor.value, query, editor.selectionStart);
    if (!match) { updateCurrentFindCount(); return; }
    editor.setRangeText(currentReplaceInput.value, match.start, match.end, "end");
    editor.dispatchEvent(new Event("input", { bubbles: true })); moveCurrentFind(false);
  };
  const replaceCurrentAll = () => {
    const result = editorTools.replaceAllLiteral(editor.value, currentFindInput.value, currentReplaceInput.value);
    if (result.error) { currentFindCount.textContent = result.error; return; }
    if (!result.count) { currentFindCount.textContent = "Aucun résultat"; return; }
    editor.value = result.text; editor.setSelectionRange(0, 0); editor.dispatchEvent(new Event("input", { bubbles: true }));
    currentFindCount.textContent = result.count + " remplacement(s)";
  };
  t.openCurrentFind = openCurrentFind; t.closeCurrentFind = closeCurrentFind;
  t.moveCurrentFind = moveCurrentFind; t.currentFindOpen = () => !fileFindBar.hidden;
  currentFindInput.oninput = updateCurrentFindCount;
  currentFindInput.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); moveCurrentFind(event.shiftKey); } };
  currentFindPrev.onclick = () => moveCurrentFind(true); currentFindNext.onclick = () => moveCurrentFind(false);
  currentReplaceOne.onclick = replaceCurrentOne; currentReplaceAll.onclick = replaceCurrentAll; currentFindClose.onclick = closeCurrentFind;
  diagnosticsButton.onclick = () => analyzeFile();
  t.goToLine = () => {
    if (!t.filePath) { showError("Ouvrez d’abord un fichier."); return; }
    const current = editorTools.cursorPosition(editor.value, editor.selectionStart).line;
    const line = Number(prompt("Aller à la ligne :", String(current)));
    if (!Number.isFinite(line) || line < 1) return;
    const offset = editorTools.offsetForPosition(editor.value, line);
    editor.focus(); editor.setSelectionRange(offset, offset); updatePosition();
  };
  const closeFile = (filePath) => {
    if (t.filePath) t.tabStore.update(t.filePath, editor.value);
    const tab = t.tabStore.list().find((item) => item.path === filePath);
    if (!tab || (tab.dirty && !confirm("Fermer " + filePath + " sans enregistrer ses modifications ?"))) return;
    const result = t.tabStore.close(filePath, tab.dirty);
    if (result.closed) displayTab(result.active);
  };
  t.loadFile = async (rel) => {
    if (t.filePath) t.tabStore.update(t.filePath, editor.value);
    const existing = t.tabStore.activate(rel);
    if (existing) { displayTab(existing); return true; }
    if (/\.(?:png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(String(rel))) {
      t.filePath = rel;
      t.decompressed = false;
      // No mtime for an image preview: the disk poll compares mtimeMs, and a
      // stale value from the previous text file looped a reload every 5 s.
      t.mtimeMs = 0;
      // This branch bypasses displayTab: reset inline state here too, or the
      // bar stays over the image and "Accepter" writes into a dead buffer.
      inlineRange = null; inlineBar.hidden = true; inlinePreview.hidden = true; inlineGen++;
      imageEl.src = "/workspace/asset?k=" + encodeURIComponent(k) + "&sid=" + encodeURIComponent(v.sid) + "&path=" + encodeURIComponent(rel);
      imagePreview.hidden = false;
      if (monacoHost) monacoHost.style.display = "none";
      editor.hidden = true; code.hidden = true; gutter.hidden = true; minimap.hidden = true;
      save.disabled = true; diagnosticsPanel.replaceChildren(el("div", "filediagnostic-note", "Aperçu image — fichier en lecture seule."));
      meta.textContent = rel + " · aperçu image";
      pathInput.value = rel;
      renderTabs();
      return true;
    }
    try {
      const response = await fetch("/workspace/file?k=" + k + "&sid=" + encodeURIComponent(v.sid) + "&path=" + encodeURIComponent(rel));
      const d = await response.json();
      if (!response.ok || d.error) throw new Error(d.error || "Impossible d’ouvrir ce fichier.");
      const tab = t.tabStore.open(d.path, d.content || "", d.mtimeMs || 0);
      displayTab(tab);
      return true;
    } catch (e) { showError(e.message); return false;     }
  };
  t.reloadAgentFile = async (rel) => {
    const existing = t.tabStore.list().find((tab) => tab.path === rel);
    if (!existing) return t.loadFile(rel);
    if (existing.dirty) {
      if (t.filePath === rel) {
        agentText.textContent = "L’agent a modifié ce fichier. Le buffer local contient des changements : recharge après les avoir sauvegardés ou copiés.";
        agentBar.hidden = false;
      }
      return false;
    }
    const response = await fetch("/workspace/file?k=" + k + "&sid=" + encodeURIComponent(v.sid) + "&path=" + encodeURIComponent(rel));
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || "Impossible de recharger le fichier modifié.");
    const refreshed = t.tabStore.reload(rel, data.content || "", data.mtimeMs || 0);
    if (!refreshed) return false;
    t.agentDiffBases.set(rel, existing.savedContent);
    if (t.filePath === rel) displayTab(refreshed);
    else renderTabs();
    return true;
  };
  t.refreshMode = (canWrite) => {
    canWriteMode = canWrite;
    // The image preview has no buffer: re-enabling save here would push the
    // previous text buffer over the picture file.
    save.disabled = !canWrite || !t.filePath || !imagePreview.hidden || t.decompressed;
    applyFoldVisibility();
  };
  previewButton.onclick = () => {
    if (!t.filePath || !/\.(?:html?|HTML?)$/.test(t.filePath)) {
      showError("Ouvrez un fichier HTML pour lancer son aperçu local.");
      return;
    }
    const url = location.origin + "/workspace/preview?k=" + encodeURIComponent(k) + "&sid=" + encodeURIComponent(v.sid) + "&path=" + encodeURIComponent(t.filePath);
    openBrowserTab(v, url);
  };
  pathInput.onkeydown = (e) => { if (e.key === "Enter") t.loadDir(pathInput.value.trim() || "."); };
  const search = async () => {
    const query = findInput.value.trim();
    if (!query) { results.hidden = true; results.replaceChildren(); return; }
    results.hidden = false; results.textContent = "Recherche…";
    try {
      const url = "/workspace/search?k=" + k + "&sid=" + encodeURIComponent(v.sid) + "&q=" + encodeURIComponent(query);
      const response = await fetch(url);
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || "Échec de la recherche");
      results.replaceChildren();
      for (const match of data.matches || []) {
        const button = el("button", "filesearch-result");
        button.type = "button";
        button.textContent = match.path + ":" + match.line + ":" + match.column + "  " + match.text;
        button.title = match.path + ", ligne " + match.line;
        button.onclick = async () => {
          if (!await t.loadFile(match.path)) return;
          const start = editor.value.split("\n").slice(0, Math.max(0, match.line - 1)).join("\n").length + (match.line > 1 ? 1 : 0) + match.column - 1;
          editor.focus(); editor.setSelectionRange(start, start + query.length);
        };
        results.appendChild(button);
      }
      if (!data.matches?.length) results.textContent = "Aucun résultat.";
      if (data.truncated) results.appendChild(el("div", "filesearch-note", "Résultats limités ; précisez votre recherche."));
    } catch (error) { results.textContent = String(error.message || error); }
  };
  findButton.onclick = search;
  findInput.onkeydown = (e) => { if (e.key === "Enter") search(); };
  up.onclick = () => {
    const p = t.rel && t.rel !== "." ? t.rel.split("/").slice(0, -1).join("/") || "." : ".";
    t.loadDir(p);
  };
  refresh.onclick = () => {
    const wanted = [];
    t.treeCache.forEach((_, kk) => { if (kk === "." || t.expanded.has(kk)) wanted.push(kk); });
    if (!wanted.includes(".")) wanted.unshift(".");
    // Reload in place with the force flag instead of emptying the cache: the
    // previous tree stays on screen until each new listing lands, instead of
    // the panel going blank and repopulating level by level.
    Promise.all(wanted.map((c) => ensureKids(c, true))).catch((e) => showError(e.message));
  };
  t.renderNestedTree = renderNestedTree;
  t.refreshFiles = () => { try { refresh.onclick(); } catch (e) {} };
  const agentLine = el("div", "filemeta", "");
  agentLine.hidden = true;
  body.insertBefore(agentLine, split);
  t.agentLine = agentLine;
  editor.oninput = () => {
    const tab = t.filePath && t.tabStore.update(t.filePath, editor.value);
    editor.dataset.dirty = tab && tab.dirty ? "1" : "0"; paint(); renderTabs();
    updatePosition(); updateCurrentFindCount();
  };
  // Scroll double sens : en mode plie le <pre> prend la souris, le textarea
  // (caches) reste la source de verite du scroll. scrollLock evite la boucle
  // d'echo entre les deux gestionnaires.
  editor.onscroll = () => {
    if (scrollLock) return;
    scrollLock = 1;
    code.scrollTop = editor.scrollTop; code.scrollLeft = editor.scrollLeft;
    scrollLock = 0;
  };
  code.addEventListener("scroll", () => {
    if (scrollLock) return;
    scrollLock = 1;
    editor.scrollTop = code.scrollTop; editor.scrollLeft = code.scrollLeft; gutter.scrollTop = code.scrollTop;
    scrollLock = 0;
  });
  // Plier/deplier : chevron du gutter (clic) et placeholder .ed-ph (clic ou
  // Entree/Espace). Le focus est rendu au chevron car paint() reconstruit le
  // gutter — sans cela le clavier perdrait sa place.
  editorWrap.addEventListener("click", (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    const btn = target.closest(".gutter-fold");
    const ph = target.closest(".ed-ph");
    if (!btn && !ph) return;
    event.preventDefault();
    const data = btn ? btn.getAttribute("data-fold") : ph.getAttribute("data-unfold");
    const parsed = parseFoldData(data);
    if (ph) folds.delete(parsed[0]);
    else if (folds.has(parsed[0])) folds.delete(parsed[0]);
    else folds.set(parsed[0], parsed[1]);
    paint();
    const back = editorWrap.querySelector((btn ? ".gutter-fold" : ".ed-ph") + '[data-' + (btn ? "fold" : "unfold") + '="' + data + '"]');
    if (back && back.focus) back.focus();
  });
  editorWrap.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    const ph = target.closest(".ed-ph");
    if (!ph) return;
    event.preventDefault();
    const data = ph.getAttribute("data-unfold");
    folds.delete(parseFoldData(data)[0]);
    paint();
    const back = editorWrap.querySelector('.gutter-fold[data-fold="' + data + '"]');
    if (back && back.focus) back.focus();
  });
  editor.onkeyup = editor.onclick = editor.onselect = updatePosition;
  editor.onkeydown = (e) => {
    if (editor.readOnly) return;
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
      if (t.collab && t.collab.doc && t.collab.path === t.filePath && canRedo(t.collab.doc)) {
        e.preventDefault();
        const ops = localRedo(t.collab.doc);
        if (ops.length) {
          editor.value = docText(t.collab.doc);
          t.collab.shadow = editor.value;
          post("/edit/op", { sid: v.sid, path: t.collab.path, ops }).catch(() => {});
          try { t.refreshEditor(); } catch (err) {}
        }
        return;
      }
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
      if (t.collab && t.collab.doc && t.collab.path === t.filePath && canUndo(t.collab.doc)) {
        e.preventDefault();
        const ops = localUndo(t.collab.doc);
        if (ops.length) {
          editor.value = docText(t.collab.doc);
          t.collab.shadow = editor.value;
          post("/edit/op", { sid: v.sid, path: t.collab.path, ops }).catch(() => {});
          try { t.refreshEditor(); } catch (err) {}
        }
        return;
      }
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); openInlineBar(); return; }
    if (e.key === "Escape" && !inlineBar.hidden) { closeInlineBar(); return; }
    if (!completePop.hidden) {
      if (e.key === "Escape") { e.preventDefault(); hideComplete(); return; }
      if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); acceptComplete(0); return; }
    }
    if (e.key === "Tab" && !e.shiftKey && editor.selectionStart === editor.selectionEnd) {
      const pos = editor.selectionStart;
      const ls = editor.value.lastIndexOf("\n", pos - 1) + 1;
      if (/[\w$]+$/.test(editor.value.slice(ls, pos))) { e.preventDefault(); triggerComplete(); return; }
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const edit = editorTools.changeIndent(editor.value, editor.selectionStart, editor.selectionEnd, e.shiftKey ? -1 : 1);
      editor.value = edit.text; editor.setSelectionRange(edit.start, edit.end); editor.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const edit = editorTools.insertNewlineWithIndent(editor.value, editor.selectionStart, editor.selectionEnd);
      editor.value = edit.text; editor.setSelectionRange(edit.start, edit.end); editor.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };
  save.onclick = () => {
    if (!t.filePath) return;
    if (!imagePreview.hidden) return;
    if (t.decompressed) {
      showError(/\.(?:gz|gzip)$/i.test(t.filePath)
        ? "Ce fichier .gz est affiché décompressé en lecture seule : enregistrer écraserait l'archive."
        : "Ce contenu d'archive .zip est affiché en lecture seule : enregistrer écraserait l'archive.");
      return;
    }
    const filePath = t.filePath, content = editor.value, expectedMtimeMs = t.mtimeMs;
    t.tabStore.update(filePath, content);
    save.disabled = true;
    fetch("/workspace/file?k=" + k + "&sid=" + encodeURIComponent(v.sid), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: filePath, content, expectedMtimeMs }),
    }).then((r) => r.json()).then((d) => {
      if (d.error) throw new Error(d.error);
      const tab = t.tabStore.saved(filePath, d.mtimeMs, content);
      if (t.filePath === filePath && tab) {
        t.mtimeMs = tab.mtimeMs; editor.dataset.original = content; editor.dataset.diffBase = content; t.agentDiffBases.set(filePath, content); editor.dataset.dirty = tab.dirty ? "1" : "0";
        paint();
        meta.textContent = d.path + (tab.dirty ? " · enregistré ; nouvelles modifications non enregistrées" : " · enregistré");
        meta.classList.remove("error");
      }
      renderTabs();
      t.loadDir(t.rel || ".");
      if (!tab || !tab.dirty) void analyzeFile(filePath);
      scheduleProblemsScan(v, 900);
      if (t.filePath === filePath && (!tab || !tab.dirty)) openCollab(filePath);
    }).catch((e) => showError(e.message)).finally(() => t.refreshMode(v.state.mode !== "ro"));
  };
  // Listing .zip : double-clic sur une ligne (« nom… taille ») = ouvrir le
  // membre en lecture seule via « archive.zip › chemin ».
  editor.ondblclick = () => {
    if (!t.decompressed || !/\.zip$/i.test(t.filePath) || t.filePath.includes(" › ")) return;
    const pos = editor.selectionStart;
    const from = editor.value.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
    let to = editor.value.indexOf("\n", pos);
    if (to < 0) to = editor.value.length;
    const m = /^(.+?)\s{2,}(\d[\d.,]* [KMG]?o|\?)\s*$/.exec(editor.value.slice(from, to));
    if (!m) return;
    const name = m[1].replace(/\s+$/, "");
    if (!name || /^Archive/.test(name)) return;
    void t.loadFile(t.filePath + " › " + name);
  };
  t.refreshMode(v.state.mode !== "ro");
}

// review tab: uncommitted changes, hunk by hunk, with stage/revert actions
function renderSbsHunk(block, h) {
  const grid = el("div", "sbsgrid");
  const head = el("div", "sbshunk", h.header || "");
  grid.appendChild(head);
  const line = (text, cls) => {
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = (text === "" ? " " : text) + "\n";
    return s;
  };
  const L = h.lines || [];
  let i = 0;
  while (i < L.length) {
    if (L[i].startsWith("-")) {
      const dels = [];
      while (i < L.length && L[i].startsWith("-")) dels.push(L[i++]);
      const adds = [];
      while (i < L.length && L[i].startsWith("+")) adds.push(L[i++]);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        const row = el("div", "sbsrow");
        const ld = el("pre", "reviewpatch");
        ld.appendChild(line(dels[k] || "", "del"));
        const ra = el("pre", "reviewpatch");
        ra.appendChild(line(adds[k] || "", "add"));
        row.appendChild(ld);
        row.appendChild(ra);
        grid.appendChild(row);
      }
    } else {
      const full = el("div", "sbssame");
      full.textContent = L[i++] + "\n";
      grid.appendChild(full);
    }
  }
  block.appendChild(grid);
}
function openReviewTab(v) {
  if (!v) return;
  const existing = v.tabs.filter((t) => t.kind === "review").pop();
  if (existing) { v.activeTab = existing.id; v.panelOpen = true; savePanel(v); renderPanel(); return; }
  const t = { kind: "review", id: "r:" + Math.random().toString(36).slice(2) };
  buildReviewTab(v, t);
  v.tabs.push(t); v.activeTab = t.id; v.panelOpen = true; savePanel(v); renderPanel();
}
function buildReviewTab(v, t) {
  const body = el("div", "tabbody review"); body.hidden = true;
  const bar = el("div", "bar");
  const refresh = el("button", "iconbtn", "↻"); refresh.title = "Actualiser la révision";
  const staged = document.createElement("select");
  staged.className = "reviewmode";
  staged.setAttribute("aria-label", "Vue de révision");
  staged.title = "afficher les changements stagés à la place des non stagés";
  const unstagedOpt = document.createElement("option"); unstagedOpt.value = "unstaged"; unstagedOpt.textContent = "Arbre de travail";
  const stagedOpt = document.createElement("option"); stagedOpt.value = "staged"; stagedOpt.textContent = "Stagé";
  staged.appendChild(unstagedOpt); staged.appendChild(stagedOpt);
  bar.appendChild(refresh); bar.appendChild(staged);
  const sbsBtn = el("button", "iconbtn", "⇄"); sbsBtn.type = "button"; sbsBtn.title = "Vue côte à côte";
  bar.appendChild(sbsBtn);
  let sbsMode = t.sbs ?? null; // null = auto, true = side-by-side, false = unified
  const updateSbsBtn = () => {
    if (sbsMode === null) { sbsBtn.textContent = "⇄"; sbsBtn.title = "Vue côte à côte (auto)"; }
    else if (sbsMode) { sbsBtn.textContent = "≡"; sbsBtn.title = "Vue unifiée"; }
    else { sbsBtn.textContent = "⇄"; sbsBtn.title = "Vue côte à côte"; }
  };
  const computeSbs = () => {
    if (sbsMode !== null) return sbsMode;
    // auto: side-by-side if review panes width >= 1100px
    const panes = document.querySelector(".reviewpanes");
    return panes && panes.offsetWidth >= 1100;
  };
  const applySbs = () => {
    const on = computeSbs();
    const panes = document.querySelector(".reviewpanes");
    if (panes) {
      panes.style.flexDirection = on ? "row" : "column";
      panes.classList.toggle("sbsgrid", on);
    }
    // Also toggle on body for test visibility
    document.body.classList.toggle("sbsgrid", on);
  };
  sbsBtn.onclick = () => {
    if (sbsMode === null) sbsMode = true;
    else if (sbsMode) sbsMode = false;
    else sbsMode = null;
    t.sbs = sbsMode;
    savePanel(v);
    updateSbsBtn();
    applySbs();
  };
  updateSbsBtn();
  const reviewFilter = document.createElement("input");
  reviewFilter.placeholder = "Filtrer…";
  reviewFilter.setAttribute("aria-label", "Filtrer les blocs");
  reviewFilter.title = "Filtrer les fichiers et les blocs par texte";
  const navUp = el("button", "iconbtn", "↑"); navUp.type = "button"; navUp.title = "Changement précédent";
  const navDown = el("button", "iconbtn", "↓"); navDown.type = "button"; navDown.title = "Changement suivant";
  bar.appendChild(reviewFilter); bar.appendChild(navUp); bar.appendChild(navDown);
  const applyReviewFilter = () => {
    const q = reviewFilter.value.trim().toLowerCase();
    for (const row of list.querySelectorAll("[data-reviewfile]")) {
      row.hidden = !(!q || (row.textContent || "").toLowerCase().includes(q));
    }
    for (const h of diffBody.querySelectorAll(".reviewhunk")) {
      h.hidden = !!q && !(h.textContent || "").toLowerCase().includes(q);
    }
  };
  reviewFilter.oninput = applyReviewFilter;
  const jumpHunk = (dir) => {
    const hunks = [...diffBody.querySelectorAll(".reviewhunk")].filter((h) => !h.hidden);
    if (!hunks.length) return;
    const y = window.scrollY || 0;
    const tops = hunks.map((h) => h.getBoundingClientRect ? h.getBoundingClientRect().top + y : 0);
    let pick = dir > 0 ? 0 : hunks.length - 1;
    for (let i = 0; i < tops.length; i++) {
      if (dir > 0 && tops[i] > y + 80) { pick = i; break; }
      if (dir < 0 && tops[i] < y - 80) pick = i;
    }
    if (hunks[pick] && hunks[pick].scrollIntoView) hunks[pick].scrollIntoView();
  };
  navUp.onclick = () => jumpHunk(-1);
  navDown.onclick = () => jumpHunk(1);
  const commitRow = el("div", "bar");
  const commitInput = document.createElement("input");
  commitInput.placeholder = "Message de commit…";
  commitInput.setAttribute("aria-label", "Message de commit");
  const commitBtn = el("button", "iconbtn", "Committer"); commitBtn.type = "button"; commitBtn.title = "Committer les changements stagés";
  commitRow.appendChild(commitInput); commitRow.appendChild(commitBtn);
  const list = el("div", "reviewlist");
  const totals = el("div", "reviewtotals", "");
  const listCol = el("div", "reviewfiles");
  listCol.appendChild(list); listCol.appendChild(totals);
  const diffPath = el("span", "reviewpath", "aucun changement");
  const fileActions = el("span", "reviewfileacts");
  const diffTop = el("div", "reviewdifftop");
  diffTop.appendChild(diffPath); diffTop.appendChild(fileActions);
  const diffBody = el("div", "reviewdiffbody");
  const diffCol = el("div", "reviewdiff");
  diffCol.appendChild(diffTop); diffCol.appendChild(diffBody);
  const navBadge = el("span", "badge-n", "–");
  const navPrev = el("button", "iconbtn", "↑"); navPrev.type = "button"; navPrev.title = "Fichier précédent";
  const navNext = el("button", "iconbtn", "↓"); navNext.type = "button"; navNext.title = "Fichier suivant";
  const navRail = el("div", "reviewnav");
  navRail.appendChild(navPrev); navRail.appendChild(navBadge); navRail.appendChild(navNext);
  const panes = el("div", "reviewpanes");
  panes.appendChild(listCol); panes.appendChild(navRail); panes.appendChild(diffCol);
  const note = el("div", "filemeta", "changements non committés");
  body.appendChild(bar); body.appendChild(commitRow); body.appendChild(panes); body.appendChild(note);
  v.panelEl.appendChild(body);
  t.el = body;
  let showStaged = false;
  let files = [];
  let selected = null;
  const doCommit = () => {
    const message = commitInput.value.trim();
    if (!message) { note.textContent = "Écrivez d'abord un message de commit."; return; }
    commitBtn.disabled = true;
    post("/code/commit", { sid: v.sid, message }).then((r) => {
      if (!r || r.error || (typeof r.message === "string" && /^Error/.test(r.message))) {
        note.textContent = (r && (r.error || r.message)) || "Le commit a échoué";
        return;
      }
      commitInput.value = "";
      note.textContent = r.message;
      load();
    }).catch((e) => { note.textContent = String((e && e.message) || e); }).finally(() => { commitBtn.disabled = false; });
  };
  commitBtn.onclick = doCommit;
  commitInput.onkeydown = (e) => { if (e.key === "Enter") doCommit(); };
  const statusOf = (f) => {
    if (f && f.status) return String(f.status).slice(0, 1).toUpperCase();
    const hdr = ((((f || {}).hunks) || [])[0] || {}).header || "";
    if (/new file mode/.test(hdr)) return "A";
    if (/deleted file mode/.test(hdr)) return "D";
    if (/rename/.test(hdr)) return "R";
    return "M";
  };
  const renderDiffTop = (list2) => {
    fileActions.replaceChildren();
    const f = (list2 || []).find((x) => x.file === selected);
    if (!f) {
      diffPath.textContent = (list2 || []).length ? "sélectionnez un fichier" : "aucun changement";
      navBadge.textContent = "–";
      navRail.title = "Aucun fichier sélectionné";
      return;
    }
    const pos = (list2 || []).indexOf(f) + 1;
    diffPath.textContent = f.file;
    navBadge.textContent = String(pos);
    navRail.title = "Fichier " + pos + " sur " + (list2 || []).length + " · fichier précédent/suivant";
    if (!showStaged) {
      const sf = el("button", "iconbtn", "Stager le fichier"); sf.type = "button"; sf.title = "Stager le fichier entier";
      const rf = el("button", "iconbtn", "Restaurer"); rf.type = "button"; rf.title = "Restaurer le fichier entier depuis HEAD";
      sf.onclick = () => fileAction("/code/diff/stage", { sid: v.sid, path: f.file }, sf);
      rf.onclick = () => { if (confirm("Restaurer " + f.file + " depuis HEAD ? Les changements non stagés seront perdus.")) fileAction("/code/diff/revert-file", { sid: v.sid, path: f.file }, rf); };
      fileActions.appendChild(sf); fileActions.appendChild(rf);
    } else {
      const uf = el("button", "iconbtn", "Dé-stager"); uf.type = "button"; uf.title = "Retirer le fichier de la zone de staging";
      uf.onclick = () => fileAction("/code/diff/unstage", { sid: v.sid, path: f.file }, uf);
      fileActions.appendChild(uf);
    }
  };
  const stepFile = (dir) => {
    if (!files.length) return;
    let i = files.findIndex((f) => f.file === selected);
    if (i < 0) i = 0;
    i = Math.min(files.length - 1, Math.max(0, i + dir));
    selected = files[i].file;
    load();
  };
  navPrev.onclick = () => stepFile(-1);
  navNext.onclick = () => stepFile(1);
  const fileAction = (endpoint, body, btn) => {
    btn.disabled = true;
    post(endpoint, body).then((r) => {
      if (!r || r.error || (typeof r.message === "string" && /^Error/.test(r.message))) {
        alert((r && (r.error || r.message)) || "Échec de l'action de révision");
        return;
      }
      note.textContent = r.message || "Fait.";
      load();
    }).catch((e) => alert(String((e && e.message) || e))).finally(() => { btn.disabled = false; });
  };
  const actHunk = (file, index, action, btn) => {
    btn.disabled = true;
    post("/code/diff/hunk", { sid: v.sid, path: file, hunk: index, action }).then((r) => {
      if (!r || r.error || (typeof r.message === "string" && /^Error/.test(r.message))) {
        alert((r && (r.error || r.message)) || "Échec de l'action de révision");
        return;
      }
      load();
    }).catch((e) => alert(String((e && e.message) || e))).finally(() => { btn.disabled = false; });
  };
  const load = () => {
    list.replaceChildren(el("div", "filediagnostic-note", "Chargement de la révision…"));
    fetch("/code/diff?k=" + k + "&sid=" + encodeURIComponent(v.sid) + (showStaged ? "&staged=1" : ""))
      .then((r) => r.json()).then((d) => {
        if (d.error) throw new Error(d.error);
        list.replaceChildren();
        diffBody.replaceChildren();
        files = d.files || [];
        updateReviewBadge(files.length);
        if (!files.some((f) => f.file === selected)) selected = files[0] ? files[0].file : null;
        note.textContent = d.note || (files.length + " fichier(s) avec des changements non committés");
        let allAdds = 0, allDels = 0;
        renderDiffTop(files);
        for (const [fi, f] of files.entries()) {
          let adds = 0, dels = 0;
          for (const h of f.hunks || []) {
            for (const ln of h.lines || []) {
              if (ln.startsWith("+")) adds++;
              else if (ln.startsWith("-")) dels++;
            }
          }
          const row = el("div", "reviewfilerow" + (f.file === selected ? " sel" : ""));
          row.setAttribute("data-reviewfile", String(fi));
          const st = statusOf(f);
          const stEl = el("span", "fstat " + st.toLowerCase(), st);
          const fp = el("span", "fpath", f.file);
          const fd = el("span", "fdelta", "");
          fd.appendChild(el("span", "plus", "+" + adds));
          fd.appendChild(el("span", "minus", " −" + dels));
          row.appendChild(stEl); row.appendChild(fp); row.appendChild(fd);
          row.onclick = () => { selected = f.file; load(); };
          allAdds += adds; allDels += dels;
          list.appendChild(row);
          if (f.file !== selected) continue;
          for (const h of f.hunks || []) {
            const block = el("div", "reviewhunk");
            if (computeSbs()) renderSbsHunk(block, h);
            else {
            const pre = el("pre", "reviewpatch");
            const sel = new Set();
            const paint = (text, cls, oldLn, newLn, li, change) => {
              const wrap = el("div", "reviewline");
              if (change && !showStaged) {
                const cb = document.createElement("input");
                cb.type = "checkbox"; cb.className = "reviewpick"; cb.title = "Stager cette ligne";
                cb.onchange = () => { if (cb.checked) sel.add(li); else sel.delete(li); };
                wrap.appendChild(cb);
              }
              const s = document.createElement("span");
              s.className = cls;
              if (oldLn !== null && oldLn !== undefined) {
                const g1 = document.createElement("span"); g1.className = "gutter"; g1.textContent = oldLn;
                const g2 = document.createElement("span"); g2.className = "gutter"; g2.textContent = newLn;
                s.appendChild(g1); s.appendChild(g2);
              }
              s.appendChild(document.createTextNode(text + "\n"));
              wrap.appendChild(s);
              pre.appendChild(wrap);
            };
            paint(h.header, "hunk", null, null, -1, false);
            const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(h.header || "");
            let oldLn = hm ? Number(hm[1]) : 1;
            let newLn = hm ? Number(hm[3]) : 1;
            h.lines.forEach((ln, li) => {
              if (ln.startsWith("+")) { paint(ln, "add", "", String(newLn), li, true); newLn++; }
              else if (ln.startsWith("-")) { paint(ln, "del", String(oldLn), "", li, true); oldLn++; }
              else if (ln.startsWith("\\")) { paint(ln, "same", "", "", li, false); }
              else { paint(ln, "same", String(oldLn), String(newLn), li, false); oldLn++; newLn++; }
            });
            block.appendChild(pre);
            }
            const row = el("div", "reviewactions");
            if (showStaged) {
              // Staged hunks can only come out of the index: staging is a no-op
              // and a revert here would rewrite the working tree behind the
              // user's back.
              const ub = el("button", "iconbtn", "Dé-stager"); ub.title = "Retirer ce bloc de la zone de staging";
              ub.onclick = () => actHunk(f.file, h.index, "unstage", ub);
              row.appendChild(ub);
            } else {
              const sb = el("button", "iconbtn", "Stager"); sb.title = "Stager ce bloc";
              const rb = el("button", "iconbtn", "Restaurer"); rb.title = "Restaurer ce bloc dans l'arbre de travail";
              const sl = el("button", "iconbtn", "Stager ✓"); sl.title = "Stager uniquement les lignes cochées";
              sb.onclick = () => actHunk(f.file, h.index, "stage", sb);
              rb.onclick = () => { if (confirm("Restaurer ce bloc dans " + f.file + " ? La modification sera perdue.")) actHunk(f.file, h.index, "revert", rb); };
              sl.onclick = () => {
                sl.disabled = true;
                post("/code/diff/stage-lines", { sid: v.sid, path: f.file, hunk: h.index, lines: [...sel] }).then((r) => {
                  if (!r || r.error || (typeof r.message === "string" && /^Error/.test(r.message))) {
                    alert((r && (r.error || r.message)) || "Échec du staging des lignes");
                    return;
                  }
                  load();
                }).catch((e) => alert(String((e && e.message) || e))).finally(() => { sl.disabled = false; });
              };
              row.appendChild(sb); row.appendChild(rb); row.appendChild(sl);
            }
            block.appendChild(row);
            diffBody.appendChild(block);
          }
        }
        totals.replaceChildren(el("span", "plus", "+" + allAdds), el("span", "minus", " −" + allDels));
        if (!files.length) {
          list.appendChild(el("div", "filediagnostic-note", "Arbre de travail propre."));
          diffBody.replaceChildren();
        }
        applyReviewFilter();
        applySbs();
      }).catch((e) => { list.replaceChildren(el("div", "filediagnostic-note error", String((e && e.message) || e))); });
  };
  refresh.onclick = load;
  const setReviewMode = () => { showStaged = staged.value === "staged"; load(); };
  staged.onchange = setReviewMode;
  // Keep a click affordance for keyboard-light clients and the legacy smoke
  // harness: clicking the selector cycles the two review scopes.
  staged.onclick = (e) => {
    if (e) return;
    staged.value = staged.value === "staged" ? "unstaged" : "staged";
    setReviewMode();
  };
  t.reload = load;
  load();
}

// plan tab: the agent's task list with clickable checkboxes
function openPlanTab(v) {
  if (!v) return;
  const existing = v.tabs.filter((t) => t.kind === "plan").pop();
  if (existing) { v.activeTab = existing.id; v.panelOpen = true; savePanel(v); renderPanel(); return; }
  const t = { kind: "plan", id: "p:" + Math.random().toString(36).slice(2) };
  buildPlanTab(v, t);
  v.tabs.push(t); v.activeTab = t.id; v.panelOpen = true; savePanel(v); renderPanel();
}
function buildPlanTab(v, t) {
  const body = el("div", "tabbody plan"); body.hidden = true;
  const bar = el("div", "bar");
  const refresh = el("button", "iconbtn", "↻"); refresh.title = "Actualiser la liste des tâches";
  const head = el("span", "filemeta", "liste des tâches");
  head.style.flex = "1";
  bar.appendChild(refresh); bar.appendChild(head);
  const list = el("div", "planlist");
  body.appendChild(bar); body.appendChild(list);
  v.panelEl.appendChild(body);
  t.el = body;
  const renderSteps = (d) => {
    list.replaceChildren();
    const steps = (d && d.steps) || [];
    head.textContent = d && d.exists ? (d.done + " tâches sur " + d.total + " terminées") : "liste des tâches";
    if (!steps.length) {
      list.appendChild(el("div", "filediagnostic-note", "Pas encore de liste de tâches — l'agent en crée une pour le travail en plusieurs étapes."));
      return;
    }
    steps.forEach((s, i) => {
      const b = el("button", "planstep" + (s.done ? " done" : i === d.current ? " current" : ""));
      b.type = "button";
      b.title = s.done ? "terminé" : "marquer l'étape " + (i + 1) + " comme terminée";
      const box = el("span", "box", s.done ? "☑" : i === d.current ? "◉" : "☐");
      const label = el("span", "", (i + 1) + ". " + s.text);
      b.appendChild(box); b.appendChild(label);
      if (!s.done) {
        b.onclick = () => {
          b.disabled = true;
          post("/plan/done", { sid: v.sid, step: i + 1 }).then((r) => {
            if (!r || r.error) { alert((r && r.error) || "Échec de la mise à jour du plan"); return; }
            if (r.plan) renderSteps(r.plan);
            else load();
          }).catch((e) => alert(String((e && e.message) || e))).finally(() => { b.disabled = false; });
        };
      }
      list.appendChild(b);
    });
  };
  const load = () => {
    list.replaceChildren(el("div", "filediagnostic-note", "Chargement de la liste des tâches…"));
    fetch("/plan?k=" + k + "&sid=" + encodeURIComponent(v.sid))
      .then((r) => r.json()).then((d) => {
        if (d.error) throw new Error(d.error);
        renderSteps(d);
      }).catch((e) => { list.replaceChildren(el("div", "filediagnostic-note error", String((e && e.message) || e))); });
  };
  refresh.onclick = load;
  t.renderSteps = renderSteps;
  load();
}

// terminal tabs
function ensureTermTab(v, tid, cwd) {
  let t = v.terms.get(tid);
  if (t) { if (cwd) setPrompt(t, cwd); return t; }
  t = { kind: "term", tid, id: "t:" + tid, cwd: cwd || "", history: [], hi: 0, lines: 0, cur: null, ansi: { classes: [], pending: "" } };
  const body = el("div", "tabbody term"); body.hidden = true;
  const toolbar = el("div", "term-toolbar");
  const toolLeft = el("div", "term-tool-left");
  const termBadge = el("span", "term-badge", "TERMINAL");
  const termCwd = el("span", "term-cwd", shortPath(cwd || "") || "workspace");
  toolLeft.appendChild(termBadge); toolLeft.appendChild(termCwd);
  const toolRight = el("div", "term-tool-right");
  const btnInterrupt = el("button", "term-btn warn", "⏹ Interrompre (Ctrl+C)");
  btnInterrupt.type = "button"; btnInterrupt.title = "Interrompre la commande en cours";
  btnInterrupt.onclick = () => { post("/term/interrupt", { sid: v.sid, tid }); };
  const btnClear = el("button", "term-btn", "🧹 Effacer (Ctrl+L)");
  btnClear.type = "button"; btnClear.title = "Effacer l'affichage du terminal";
  btnClear.onclick = () => { out.innerHTML = ""; t.cur = null; t.lines = 0; };
  toolRight.appendChild(btnInterrupt); toolRight.appendChild(btnClear);
  toolbar.appendChild(toolLeft); toolbar.appendChild(toolRight);
  const out = el("pre", "out");
  const row = el("div", "trow");
  const prompt = el("span", "prompt");
  const inp = document.createElement("input");
  inp.placeholder = "Tapez une commande…"; inp.title = "Entrée pour exécuter · Ctrl+C pour interrompre · Ctrl+L pour effacer"; inp.setAttribute("aria-label", "Commande du terminal"); inp.spellcheck = false; inp.autocomplete = "off";
  inp.onkeydown = (e) => {
    if (e.key === "Enter") {
      const text = inp.value;
      if (!text.trim()) return;
      inp.value = "";
      if (t.history[t.history.length - 1] !== text) t.history.push(text);
      t.hi = t.history.length;
      post("/term/input", { sid: v.sid, tid, text });
    } else if (e.key === "c" && e.ctrlKey && !String(window.getSelection())) { e.preventDefault(); post("/term/interrupt", { sid: v.sid, tid }); }
    else if (e.key === "l" && e.ctrlKey) { e.preventDefault(); out.innerHTML = ""; t.cur = null; t.lines = 0; }
    else if (e.key === "ArrowUp") { if (t.hi > 0) { t.hi--; inp.value = t.history[t.hi]; } e.preventDefault(); }
    else if (e.key === "ArrowDown") { if (t.hi < t.history.length - 1) { t.hi++; inp.value = t.history[t.hi]; } else { t.hi = t.history.length; inp.value = ""; } e.preventDefault(); }
  };
  out.onclick = () => { if (!String(window.getSelection())) inp.focus(); };
  row.appendChild(prompt); row.appendChild(inp);
  body.appendChild(out); body.appendChild(row);
  v.panelEl.appendChild(body);
  t.el = body; t.out = out; t.inp = inp; t.promptEl = prompt;
  setPrompt(t, cwd || "");
  v.terms.set(tid, t); v.tabs.push(t);
  if (!v.activeTab) v.activeTab = t.id;
  if (v === active) renderPanel();
  return t;
}
function setPrompt(t, cwd) {
  t.cwd = cwd;
  const p = cwd ? (cwd.includes(":") || cwd.startsWith("/") ? (navigator.platform.includes("Win") ? "PS " + cwd + "> " : cwd + " ❯ ") : shortPath(cwd) + " ❯ ") : "PS C:\\Users\\DELL> ";
  t.promptEl.innerHTML = '<span class="term-status-dot" title="Terminal actif"></span> ' + esc(p);
  t.promptEl.title = cwd;
}
function termWrite(v, tid, text) {
  const t = v.terms.get(tid) || ensureTermTab(v, tid, "");
  const out = t.out;
  const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 60;
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i++) {
    let seg = parts[i];
    if (i > 0) t.cur = null;
    if (!t.cur) { t.cur = el("div", "l"); out.appendChild(t.cur); t.lines++; }
    const cr = seg.lastIndexOf("\r");
    if (cr >= 0) { t.cur.innerHTML = ""; seg = seg.slice(cr + 1); }
    if (seg) t.cur.appendChild(ansiToFrag(seg, t.ansi));
  }
  while (t.lines > 4000 && out.firstChild) { out.removeChild(out.firstChild); t.lines--; }
  if (nearBottom) out.scrollTop = out.scrollHeight;
}
function termDone(v, tid, code, cwd) {
  const t = v.terms.get(tid);
  if (!t) return;
  if (cwd) setPrompt(t, cwd);
  if (t.cur && t.cur.textContent) termWrite(v, tid, "\n");
  if (code) termWrite(v, tid, "\x1b[2m[exit " + code + "]\x1b[0m\n");
}
function removeTermTab(v, tid) {
  const t = v.terms.get(tid);
  if (!t) return;
  v.terms.delete(tid);
  const i = v.tabs.indexOf(t);
  if (i >= 0) v.tabs.splice(i, 1);
  if (t.el) t.el.remove();
  if (v.activeTab === t.id) v.activeTab = (v.tabs[i] || v.tabs[i - 1] || {}).id || null;
  savePanel(v);
  if (v === active) renderPanel();
}
function reconcileTerms(v) {
  const info = sessInfo.get(v.sid);
  const alive = new Set(info && info.live ? info.terminals.map((x) => x.tid) : []);
  for (const tid of [...v.terms.keys()]) if (!alive.has(tid)) removeTermTab(v, tid);
  if (info && info.live) for (const x of info.terminals) ensureTermTab(v, x.tid, x.cwd);
}
function openTerminalTab(v) {
  post("/term/open", { sid: v.sid }).then((r) => {
    if (!r.tid) { if (r.error) alert(r.error); return; }
    const t = ensureTermTab(v, r.tid, r.cwd);
    v.activeTab = t.id; v.panelOpen = true; savePanel(v); renderPanel();
    t.inp.focus();
  });
}

// resize grip
$("panelgrip").onmousedown = (e) => {
  e.preventDefault();
  document.body.classList.add("dragging");
  const move = (ev) => { panelWidth = Math.min(window.innerWidth * 0.8, Math.max(300, window.innerWidth - ev.clientX)); panelEl.style.width = panelWidth + "px"; };
  const up = () => { document.body.classList.remove("dragging"); document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); ls.set("smol.panel.w", String(Math.round(panelWidth))); };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
};

// Panneau des dossiers : poignée de redimensionnement (persistée).
let sideWidth = Math.min(640, Math.max(176, Number(ls.get("smol.side.w")) || 272));
function applySideWidth() {
  if (sideEl && sideEl.style && typeof sideEl.style.setProperty === "function") {
    sideEl.style.setProperty("--side-w", sideWidth + "px");
  }
}
applySideWidth();
$("sidegrip").onmousedown = (e) => {
  e.preventDefault();
  document.body.classList.add("dragging");
  const move = (ev) => { sideWidth = Math.min(640, Math.max(176, ev.clientX)); applySideWidth(); };
  const up = () => { document.body.classList.remove("dragging"); document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); ls.set("smol.side.w", String(Math.round(sideWidth))); };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
};

// ---- sidebar collapse -----------------------------------------------------
function setSide(collapsed) {
  sideEl.classList.toggle("collapsed", collapsed);
  const tog = $("sidetoggle");
  if (tog) {
    tog.hidden = false;
    tog.classList.toggle("active", !collapsed);
    tog.classList.toggle("on", !collapsed);
    tog.title = collapsed ? "Afficher le panneau latéral (Ctrl+B)" : "Masquer le panneau latéral (Ctrl+B)";
    tog.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }
  ls.set("smol.side", collapsed ? "1" : "0");
}
function toggleSide() {
  setSide(!sideEl.classList.contains("collapsed"));
}
function narrow() { return window.matchMedia("(max-width: 1000px)").matches; }
const sideTogBtn = $("sidetoggle");
if (sideTogBtn) sideTogBtn.onclick = () => toggleSide();
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b" && !e.shiftKey && !e.altKey) {
    const tag = (e.target && e.target.tagName) || "";
    if (tag !== "INPUT" && tag !== "TEXTAREA") {
      e.preventDefault();
      toggleSide();
    }
  }
});
setSide(ls.get("smol.side") === "1" || (narrow() && !!location.hash));

// ---- input + slash menu ---------------------------------------------------
let menuIdx = 0;
// ---- mention @fichier : complétion des fichiers du workspace --------------
let atFiles = [];
let atFilesSid = "";
function mentionInfo() {
  if (!active) return null;
  const pos = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
  const before = input.value.slice(0, pos);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  return { start: m.index + (m[1] ? m[1].length : 0), query: m[2] };
}
function loadAtFiles() {
  if (!active || atFilesSid === active.sid) return;
  const sid = active.sid;
  atFilesSid = sid;
  fetch("/workspace/files?k=" + k + "&sid=" + encodeURIComponent(sid))
    .then((r) => r.json())
    .then((d) => {
      atFiles = Array.isArray(d && d.files) ? d.files : [];
      if (active && active.sid === sid) renderMenu();
    })
    .catch(() => { atFiles = []; });
}
function atItems() {
  const hit = mentionInfo();
  if (!hit || !active) return [];
  if (atFilesSid !== active.sid) { loadAtFiles(); return []; }
  const lower = hit.query.toLowerCase();
  return atFiles
    .filter((p) => p.toLowerCase().indexOf(lower) !== -1)
    .slice(0, 12)
    .map((p) => ({ kind: "file", name: p, desc: "" }));
}
function acceptAtItem(idx) {
  const it = menuItems()[idx];
  const hit = mentionInfo();
  if (!it || it.kind !== "file" || !hit) return;
  const pos = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
  const after = input.value.slice(pos);
  input.value = input.value.slice(0, hit.start) + "@" + it.name + " " + after;
  const caret = hit.start + it.name.length + 2;
  if (typeof input.setSelectionRange === "function") input.setSelectionRange(caret, caret);
  menuIdx = 0;
  renderMenu();
  autoGrow();
  input.focus();
}
function menuItems() {
  const v = input.value;
  if (!active) return [];
  if (!v.startsWith("/") || v.includes(" ") || v.includes("\n")) return atItems();
  return (active.state.commands || [])
    .filter((c) => c.name.startsWith(v.slice(1)))
    .map((c) => ({ kind: "cmd", name: c.name, desc: c.desc }));
}
function renderMenu() {
  const items = menuItems();
  menu.style.display = items.length ? "block" : "none";
  menu.innerHTML = "";
  if (menuIdx >= items.length) menuIdx = 0;
  items.forEach((it, i) => {
    const d = el("div", "item" + (i === menuIdx ? " sel" : ""));
    if (it.kind === "file") {
      d.appendChild(el("span", "nm", "@" + it.name));
      d.appendChild(el("span", "ds", "fichier"));
      d.onclick = () => { acceptAtItem(i); };
    } else {
      d.appendChild(el("span", "nm", "/" + it.name));
      d.appendChild(el("span", "ds", it.desc));
      d.onclick = () => { input.value = "/" + it.name; submit(); };
    }
    menu.appendChild(d);
  });
}
function submit(options = {}) {
  if (!active) { showError("Aucune session ouverte. Choisissez une session dans la barre laterale."); return; }
  let v = input.value;
  const items = menuItems();
  const picked = items[menuIdx];
  if (picked && picked.kind === "cmd") v = "/" + picked.name;
  v = v.trim();
  const pending = pendingOf(active);
  // A stuck upload used to swallow every message with no feedback at all,
  // which reads as "I cannot type to the agent any more". Say it out loud.
  if (pending.some((a) => a.uploading)) { showError("Envoi d'une piece jointe en cours. Attendez, ou retirez-la avec la croix."); return; }
  const files = pending.filter((a) => a.id).map((a) => a.id);
  if (!v && !files.length) return;
  const sentDraft = { text: v, pending };
  input.value = ""; active.draft = ""; active.pending = []; renderMenu(); autoGrow(); renderAttachments();
  scrollToBottom();
  post("/msg", { sid: active.sid, text: v, attachments: files, ...(options.workItemId ? { workItemId: options.workItemId } : {}) })
    .then((r) => {
      if (!r || !r.error) return;
      // A failed send must never eat the user's text: put the draft back
      // (unless they already started typing something new).
      if (!input.value) {
        input.value = sentDraft.text; active.draft = sentDraft.text; active.pending = sentDraft.pending;
        renderMenu(); autoGrow(); renderAttachments();
      }
      alert(r.error);
    });
}
function autoGrow() { input.rows = Math.min(12, Math.max(2, input.value.split("\n").length)); }
input.addEventListener("input", () => { menuIdx = 0; renderMenu(); autoGrow(); });
input.addEventListener("keydown", (e) => {
  const items = menuItems();
  const picked = items[menuIdx];
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (picked && picked.kind === "file") { acceptAtItem(menuIdx); return; }
    submit();
  }
  else if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); if (active) post("/cycle", { sid: active.sid }); }
  else if (e.key === "Tab" && items.length) {
    e.preventDefault();
    if (picked && picked.kind === "file") acceptAtItem(menuIdx);
    else { input.value = "/" + items[menuIdx].name + " "; renderMenu(); }
  }
  else if (e.key === "ArrowUp" && items.length) { e.preventDefault(); menuIdx = (menuIdx - 1 + items.length) % items.length; renderMenu(); }
  else if (e.key === "ArrowDown" && items.length) { e.preventDefault(); menuIdx = (menuIdx + 1) % items.length; renderMenu(); }
  else if (e.key === "Escape") {
    if (input.value) { input.value = ""; renderMenu(); autoGrow(); }
    else if (active) {
      post("/cancel", { sid: active.sid });
      setBusy(active, null);
      actionBtn.textContent = "Envoyer";
      actionBtn.className = "";
      showToast("Arrêt immédiat demandé…", "info");
    }
  }
});
actionBtn.onclick = () => {
  if (!active) return;
  const isBusy = !!active.busyLabel || actionBtn.classList.contains("stop") || (active.state && active.state.status === "busy");
  if (isBusy) {
    post("/cancel", { sid: active.sid });
    setBusy(active, null);
    actionBtn.textContent = "Envoyer";
    actionBtn.className = "";
    showToast("Arrêt immédiat demandé…", "info");
  } else {
    submit();
  }
};

// ---- attachments ----------------------------------------------------------
// Paste a screenshot (ctrl+v or right-click → paste), drop files on the chat,
// or pick them with the paperclip. Each file is uploaded right away and shown
// as a chip; the ids go with the next message.
const attachRow = $("attachrow"), filePick = $("filepick"), mainEl = $("main");
function pendingOf(v) { if (!v.pending) v.pending = []; return v.pending; }
function renderAttachments() {
  attachRow.innerHTML = "";
  const list = active ? pendingOf(active) : [];
  attachRow.hidden = !list.length;
  for (const a of list) {
    const chip = el("span", "attach" + (a.uploading ? " uploading" : "") + (a.warning ? " warn" : ""));
    if (a.kind === "image" && a.url) { const img = el("img", "attach-thumb"); img.src = a.url + "&k=" + k; img.alt = ""; chip.appendChild(img); }
    chip.appendChild(el("span", "attach-name", a.name));
    chip.appendChild(el("span", "dim", a.uploading ? "envoi…" : fmtSize(a.size)));
    if (a.warning) { chip.title = a.warning; chip.appendChild(el("span", "note", "le modèle ne peut pas voir les images")); }
    const x = el("button", "attach-x", "×"); x.type = "button"; x.title = "Retirer"; x.onclick = () => removeAttachment(a);
    chip.appendChild(x);
    attachRow.appendChild(chip);
  }
}
function addFiles(files) {
  if (!active) return;
  for (const f of files) upload(active, f);
  input.focus();
}
async function upload(v, file) {
  const payload = await shrinkImage(file);
  const type = payload.type || "application/octet-stream";
  const name = payload.name || (type.startsWith("image/") ? "pasted-image." + (type.split("/")[1] || "png").replace("jpeg", "jpg") : "pasted.txt");
  const entry = { id: null, name, size: payload.size, kind: type.startsWith("image/") ? "image" : "text", uploading: true };
  pendingOf(v).push(entry); renderAttachments();
  try {
    const r = await fetch("/upload?k=" + k + "&sid=" + v.sid + "&name=" + encodeURIComponent(name), { method: "POST", headers: { "content-type": type }, body: payload });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(d.error || ("échec de l'envoi (" + r.status + ")"));
    Object.assign(entry, d, { uploading: false });
  } catch (err) {
    const list = pendingOf(v); const i = list.indexOf(entry); if (i >= 0) list.splice(i, 1);
    alert(String((err && err.message) || err));
  }
  renderAttachments();
}
// Shrink big screenshots before upload (canvas, no dependency): local vision
// models choke on 4K PNGs. Animated GIFs and small files pass through;
// anything failing falls back to the original file.
async function shrinkImage(file) {
  try {
    if (!file || !file.type || !file.type.startsWith("image/")) return file;
    if (file.type === "image/gif") return file;
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
    const bmp = await createImageBitmap(file);
    try {
      const MAX = 1568;
      if (Math.max(bmp.width, bmp.height) <= MAX && file.size <= 1536 * 1024) return file;
      const scale = MAX / Math.max(bmp.width, bmp.height);
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(bmp.width * scale));
      cv.height = Math.max(1, Math.round(bmp.height * scale));
      const ctx2d = cv.getContext("2d");
      if (!ctx2d) return file;
      ctx2d.drawImage(bmp, 0, 0, cv.width, cv.height);
      const blob = await new Promise((res) => {
        try {
          cv.toBlob(res, file.type === "image/png" ? "image/png" : "image/jpeg", 0.85);
        } catch (e) { res(null); }
      });
      if (!blob || blob.size >= file.size) return file;
      return new File([blob], file.name || "pasted-image", { type: blob.type || file.type });
    } finally {
      try { bmp.close(); } catch (e) {}
    }
  } catch (e) {
    return file;
  }
}
function removeAttachment(a) {
  if (!active) return;
  const list = pendingOf(active); const i = list.indexOf(a); if (i >= 0) list.splice(i, 1);
  if (a.id) post("/upload/remove", { sid: active.sid, id: a.id });
  renderAttachments();
}
$("attachbtn").onclick = () => { if (active) filePick.click(); };
const atBtn = $("atbtn");
if (atBtn) atBtn.onclick = () => {
  const pos = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
  input.value = input.value.slice(0, pos) + "@" + input.value.slice(pos);
  const caret = pos + 1;
  if (typeof input.setSelectionRange === "function") input.setSelectionRange(caret, caret);
  input.focus();
  menuIdx = 0;
  loadAtFiles();
  renderMenu();
  autoGrow();
};
filePick.onchange = () => { addFiles([...filePick.files]); filePick.value = ""; };
input.addEventListener("paste", (e) => {
  const files = e.clipboardData && e.clipboardData.files ? [...e.clipboardData.files] : [];
  if (!files.length) return; // plain text pastes as usual
  e.preventDefault();
  addFiles(files);
});
function hasFiles(e) { return !!(e.dataTransfer && [...e.dataTransfer.types].includes("Files")); }
mainEl.addEventListener("dragover", (e) => { if (!active || !hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; mainEl.classList.add("dragging"); });
mainEl.addEventListener("dragleave", (e) => { if (e.relatedTarget && mainEl.contains(e.relatedTarget)) return; mainEl.classList.remove("dragging"); });
mainEl.addEventListener("drop", (e) => { mainEl.classList.remove("dragging"); if (!active || !hasFiles(e)) return; e.preventDefault(); addFiles([...e.dataTransfer.files]); });

// ---- global keys ----------------------------------------------------------
$("keys").onclick = () => {
  const dialog = document.createElement("dialog"); dialog.className = "dlg";
  const list = el("div", "shortcut-list");
  ["/  Commandes", "Entrée  Envoyer", "Maj+Entrée  Nouvelle ligne", "Ctrl+V  Coller une image ou un fichier", "Maj+Tab  Mode de permission", "Échap  Annuler", "Ctrl+B  Barre latérale", "⚙  Centre de contrôle", "Ctrl+\`  Terminal"].forEach((s) => list.appendChild(el("div", "", s)));
  const close = el("button", "ghost", "Fermer"); close.onclick = () => dialog.close(); list.appendChild(close);
  dialog.appendChild(list); document.body.appendChild(dialog); dialog.onclose = () => dialog.remove(); dialog.showModal();
};
document.addEventListener("keydown", (e) => {
  const fileEditor = active && active.tabs.find((tab) => tab.kind === "files");
  if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "f" && active) { e.preventDefault(); openFilesTab(active, true); }
  else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key.toLowerCase() === "f" || e.key.toLowerCase() === "h") && fileEditor && fileEditor.filePath && fileEditor.openCurrentFind) {
    e.preventDefault(); fileEditor.openCurrentFind(e.key.toLowerCase() === "h");
  }
  else if (e.key === "F3" && fileEditor && fileEditor.currentFindOpen && fileEditor.currentFindOpen()) {
    e.preventDefault(); fileEditor.moveCurrentFind(e.shiftKey);
  }
  else if (e.key === "Escape" && fileEditor && fileEditor.currentFindOpen && fileEditor.currentFindOpen()) {
    e.preventDefault(); fileEditor.closeCurrentFind();
  }
  else if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "g" && active) {
    const files = active.tabs.find((tab) => tab.kind === "files");
    if (files && files.filePath && files.goToLine) { e.preventDefault(); files.goToLine(); }
  }
  else if (e.key === "Escape" && document.activeElement !== input) {
    if (ccOpenNow()) closeCC();
    else if (!$("modal").hidden) closeDialog();
    else if (active && !(document.activeElement && document.activeElement.closest && document.activeElement.closest(".tabbody.term"))) post("/cancel", { sid: active.sid });
  }
  else if (e.ctrlKey && e.key === "\`") { e.preventDefault(); togglePanelKind("term"); }
});

// Indicateur Ln/Col de la barre d'état : le clic ouvre « Aller à la ligne »,
// le même geste que Ctrl+G (aucun fichier ouvert = message discret).
const sbPosBtn = $("sb-pos");
if (sbPosBtn) {
  sbPosBtn.onclick = () => {
    const files = active && active.tabs.find((tab) => tab.kind === "files");
    if (files && files.filePath && files.goToLine) files.goToLine();
    else showToast("Ouvrez d’abord un fichier pour y aller à une ligne", "warn");
  };
}

// ---- centre de contrôle ----------------------------------------------------
// Le statut complet d'une session — modèle, contexte, plan, tâches,
// sous-agents, skills, outils, serveurs MCP, options — dans une seule fenêtre.
// Même rapport que le TUI et l'IDE Electron : GET /status le sert.
const CC_TABS = [
  { id: "overview", label: "Vue d'ensemble" },
  { id: "work", label: "Cowork" },
  { id: "agents", label: "Sous-agents" },
  { id: "skills", label: "Skills" },
  { id: "tools", label: "Outils" },
  { id: "mcp", label: "Serveurs MCP" },
  { id: "c3", label: "C3 / mémoire" },
  { id: "options", label: "Options" },
];
let cc = { tab: "overview", data: null, error: "", loading: false, at: 0, sid: "", requestId: 0, needsRender: false };
function ccOpenNow() { return !$("cc").hidden; }
function ccHasFocus() {
  const panel = $("cc");
  return !!(panel && typeof panel.contains === "function" && panel.contains(document.activeElement));
}
function openCC(tab) {
  if (tab) cc.tab = tab;
  $("cc").hidden = false;
  if (!CC_TABS.some((t) => t.id === cc.tab)) cc.tab = "overview";
  renderCCTabs();
  renderCC();
  loadCC();
}
function closeCC() { $("cc").hidden = true; window.clearTimeout(ccFastTimer); }
// While a server probe is still in flight the light says "demarrage..." and we
// refresh every 4 s instead of waiting for the 20 s tick, so the state settles fast.
let ccFastTimer = 0;
function ccFastPoll(data) {
  const rows = (data && data.mcp) || [];
  let pending = false;
  for (let i = 0; i < rows.length; i++) if (rows[i] && rows[i].retrying === true && !rows[i].ok) pending = true;
  window.clearTimeout(ccFastTimer);
  if (pending) ccFastTimer = window.setTimeout(() => { if (ccOpenNow() && !cc.loading) loadCC(); }, 4000);
}
function updateTopBackendStatus(d) {
  const btn = $("btnmodels");
  if (!btn) return;
  const lm = d && d.localModels;
  if (!lm) return;
  const led = btn.querySelector(".led");
  const online = Boolean(lm.ollamaOnline || lm.lmStudioOnline);
  if (led) {
    led.className = "led " + (online ? "green" : "red");
  }
  const engine = lm.ollamaOnline ? "Ollama" : (lm.lmStudioOnline ? "LM Studio" : "Aucun");
  const vram = lm.totalVramMb ? (lm.totalVramMb >= 1024 ? (lm.totalVramMb / 1024).toFixed(1) + " Go" : lm.totalVramMb + " Mo") : "0 Mo";
  btn.title = online
    ? ("Moteur : " + engine + " (en ligne) · Charge VRAM : " + vram + " · Cliquer pour changer (/models)")
    : "Moteurs locaux (Ollama / LM Studio) hors ligne !";
}

function loadCC() {
  if (!active) { cc.error = "ouvrez une session pour voir son statut"; cc.data = null; cc.loading = false; renderCC(); return; }
  const sid = active.sid;
  if (cc.loading && cc.sid === sid) return;
  cc.sid = sid;
  const requestId = ++cc.requestId;
  cc.loading = true; cc.error = "";
  renderCC();
  fetch("/status?k=" + k + "&sid=" + encodeURIComponent(active.sid))
    .then((r) => r.json())
    .then((d) => {
      if (requestId !== cc.requestId || active?.sid !== sid) return;
      cc.loading = false;
      cc.data = d && !d.error ? d : null;
      cc.error = d && d.error ? d.error : "";
      cc.at = Date.now();
      if (d && !d.error) updateTopBackendStatus(d);
      ccFastPoll(d);
      if (ccHasFocus()) cc.needsRender = true;
      else { cc.needsRender = false; renderCC(); }
    })
    .catch((e) => {
      if (requestId !== cc.requestId || active?.sid !== sid) return;
      cc.loading = false; cc.error = (e && e.message) || "statut indisponible";
      if (ccHasFocus()) cc.needsRender = true;
      else { cc.needsRender = false; renderCC(); }
    });
}
function renderCCTabs() {
  const tabs = $("cctabs");
  tabs.innerHTML = "";
  for (const t of CC_TABS) {
    const b = el("button", "cc-tab" + (cc.tab === t.id ? " on" : ""), t.label);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", cc.tab === t.id ? "true" : "false");
    b.onclick = () => { cc.tab = t.id; renderCCTabs(); renderCC(); };
    tabs.appendChild(b);
  }
}
// Remplit le composeur (jamais d'envoi silencieux : l'utilisateur garde la main).
function ccFill(text) {
  if (!active) {
    showToast("Veuillez d'abord ouvrir un dossier de projet", "info");
    return;
  }
  input.value = text;
  autoGrow();
  renderMenu();
  if (active) active.draft = text;
  input.focus();
}
function ccSend(text, options = {}) {
  if (!active) {
    showToast("Veuillez d'abord ouvrir un dossier de projet", "info");
    return;
  }
  ccFill(text);
  submit(options);
}
function ccKV(pairs) {
  const box = el("div", "cc-kv");
  for (const [label, value] of pairs) {
    const s = el("span");
    s.appendChild(el("b", "", label + " "));
    s.appendChild(document.createTextNode(String(value)));
    box.appendChild(s);
  }
  return box;
}
function ccSection(title, node) {
  const sec = el("div", "cc-sec");
  if (title) sec.appendChild(el("h3", "", title));
  sec.appendChild(node);
  return sec;
}
function ccSkeleton() {
  const box = el("div", "cc-load");
  for (const w of ["", "w60", "w40", "w60"]) box.appendChild(el("div", "skel " + w));
  return box;
}


function ccLights(list) {
  const box = el("div", "cc-lights");
  for (const m of list) {
    // A server the user switched off is not broken, so it must not be painted
    // with the red "hors ligne" light. It gets its own muted state instead.
    const off2 = m.enabled === false;
    // A second probe in flight means "not answered yet", not "broken": amber
    // "demarrage…" beats a red light that turns green seconds later.
    const waiting = m.retrying === true && !m.ok;
    // 401/403 means the server answered but refused the key: it is configured,
    // not dead. Amber "cle manquante" + the exact reason beats a red light.
    const needsKey = !m.ok && /\b(401|403)\b|cl[ée] API/i.test(String(m.error || ""));
    const c = el("span", "cc-light " + (off2 ? "muted" : waiting || needsKey ? "warn" : m.ok ? "ok" : "bad"));
    c.appendChild(el("span", "dot"));
    c.appendChild(el("span", "", m.name));
    c.appendChild(
      el("span", "cc-tag", off2 ? "desactive" : waiting ? "demarrage..." : needsKey ? "cle manquante" : m.ok ? m.tools + " outils" : "hors ligne"),
    );
    if (!off2 && !waiting && !m.ok && m.error) c.title = m.error;
    box.appendChild(c);
  }
  if (!list.length) box.appendChild(el("div", "cc-empty", "Aucun serveur MCP configuré (.smol/mcp.json)."));
  return box;
}
function ccCard(title, text, actionLabel, onClick) {
  const c = el("div", "cc-card");
  c.appendChild(el("h4", "", title));
  c.appendChild(el("p", "", text));
  if (actionLabel) {
    const b = el("button", "cc-act", actionLabel);
    b.type = "button";
    b.onclick = onClick;
    c.appendChild(b);
  }
  return c;
}
function ccGoTab(id) { cc.tab = id; renderCCTabs(); renderCC(); }
function ccWork(d) {
  const wrap = el("div", "cc-anim");
  const state = d.state || {};
  const writable = state.mode !== "ro";
  const form = el("div", "cc-workform");
  const title = document.createElement("input");
  title.type = "text"; title.maxLength = 200; title.placeholder = "Nouvelle tâche cowork…"; title.setAttribute("aria-label", "Titre de la tâche");
  const area = document.createElement("input");
  area.type = "text"; area.maxLength = 60; area.placeholder = "Espace (ex. produit)"; area.value = "work"; area.setAttribute("aria-label", "Espace cowork");
  const priority = document.createElement("select");
  priority.setAttribute("aria-label", "Priorité");
  [["normal", "Normale"], ["low", "Basse"], ["high", "Haute"], ["urgent", "Urgente"]].forEach(([value, label]) => {
    const option = document.createElement("option"); option.value = value; option.textContent = label; priority.appendChild(option);
  });
  const due = document.createElement("input");
  due.type = "date"; due.setAttribute("aria-label", "Échéance");
  const roleSelect = document.createElement("select");
  roleSelect.setAttribute("aria-label", "Rôle assigné");
  [
    ["", "Rôle : auto (expert)"],
    ["architect", "Architecte"],
    ["implementer", "Implémenteur"],
    ["quality_reviewer", "Réviseur Qualité"],
    ["spec_reviewer", "Réviseur Spéc."],
    ["researcher", "Chercheur"],
    ["expert", "Expert Polyvalent"],
  ].forEach(([value, label]) => {
    const option = document.createElement("option"); option.value = value; option.textContent = label; roleSelect.appendChild(option);
  });
  const acceptance = document.createElement("input");
  acceptance.type = "text"; acceptance.maxLength = 1000; acceptance.placeholder = "Critères d'acceptation (ex. tests verts)…"; acceptance.setAttribute("aria-label", "Critères d'acceptation");
  const add = el("button", "cc-act primary", "Ajouter");
  add.type = "button";
  add.disabled = !writable;
  const refresh = () => loadCC();
  const submit = () => {
    if (!title.value.trim()) { title.setCustomValidity("Saisissez un titre."); title.reportValidity(); return; }
    title.setCustomValidity(""); add.disabled = true;
    post("/work/items", {
      sid: active.sid,
      action: "create",
      title: title.value,
      area: area.value || "work",
      priority: priority.value,
      ...(due.value ? { due: due.value } : {}),
      ...(roleSelect.value ? { role: roleSelect.value } : {}),
      ...(acceptance.value.trim() ? { acceptance: acceptance.value.trim() } : {}),
    })
      .then((result) => {
        if (result && result.error) throw new Error(result.error);
        if (cc.data) cc.data.workItems = result.items || [];
        title.value = ""; due.value = ""; acceptance.value = ""; renderCC();
      }).catch((error) => showToast(error.message || "Échec de création", "error"))
      .finally(() => { add.disabled = !writable; });
  };
  add.onclick = submit;
  title.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } };
  form.append(title, area, priority, roleSelect, acceptance, due, add);
  if (!writable) form.title = "Passez en mode édition pour modifier les tâches.";
  wrap.appendChild(ccSection("Ajouter au tableau partagé", form));
  if (d.workItemsError) wrap.appendChild(el("div", "cc-empty", "Tableau cowork indisponible : " + d.workItemsError));

  const items = Array.isArray(d.workItems) ? d.workItems : [];
  const kanbanBoard = el("div", "cc-kanban-board");
  const cols = [
    { id: "todo", label: "À faire", items: items.filter((it) => it.status === "open" && it.executionStatus !== "in_progress" && it.executionStatus !== "running") },
    { id: "inprogress", label: "En cours", items: items.filter((it) => it.status === "in_progress" || it.executionStatus === "in_progress" || it.executionStatus === "running") },
    { id: "done", label: "Terminé / Archivé", items: items.filter((it) => it.status === "completed" || it.status === "archived" || it.executionStatus === "verified") },
  ];

  for (const col of cols) {
    const colEl = el("div", "cc-kanban-col");
    const head = el("div", "cc-kanban-head");
    head.appendChild(el("span", "", col.label));
    head.appendChild(el("span", "cc-kanban-count", String(col.items.length)));
    colEl.appendChild(head);

    const cardsEl = el("div", "cc-kanban-cards");
    for (const item of col.items) {
      const card = el("div", "cc-kanban-card cc-workitem");
      card.appendChild(el("div", "cc-kanban-card-title", item.title));

      const tags = el("div", "cc-kanban-tags");
      tags.appendChild(el("span", "cc-tag", item.area + (item.due ? " · " + item.due : "")));
      const prioClass = item.priority === "urgent" || item.priority === "high" ? "cc-tag warn" : "cc-tag";
      tags.appendChild(el("span", prioClass, item.priority));
      if (item.assignedRole) tags.appendChild(el("span", "cc-tag ok", "rôle : " + item.assignedRole));
      if (item.executionStatus && item.executionStatus !== "idle") {
        tags.appendChild(el("span", "cc-tag " + (item.executionStatus === "verified" ? "ok" : "warn"), item.executionStatus));
      }
      card.appendChild(tags);

      if (item.acceptanceCriteria) card.appendChild(el("span", "hint", "Critères d'acceptation : " + item.acceptanceCriteria));
      if (item.notes) card.appendChild(el("span", "cc-worknotes", item.notes));
      if (item.lastReport) card.appendChild(el("span", "cc-worknotes", "Rapport : " + item.lastReport.slice(0, 140) + (item.lastReport.length > 140 ? "…" : "")));

      const acts = el("div", "cc-kanban-actions");
      if (item.status === "open" || col.id === "inprogress") {
        const delegateBtn = el("button", "cc-act primary", "Exécuter avec l’agent");
        delegateBtn.type = "button";
        delegateBtn.title = "Envoyer cette tâche à l’agent de la session pour qu’il l’exécute et vérifie le résultat";
        delegateBtn.onclick = () => {
          const targetRole = item.assignedRole || "expert";
          const promptText =
            "Exécute maintenant cette tâche Cowork dans le workspace, ne te limite pas à un plan. ID: " + item.id +
            "\nTâche: " + item.title +
            "\nRôle spécialiste: " + targetRole +
            (item.acceptanceCriteria ? "\nCritères d'acceptation: " + item.acceptanceCriteria : "") +
            "\nInspecte le code concerné, réalise le travail, puis lance les vérifications adaptées. Termine avec un rapport factuel via l'outil work; le statut et la complétion sont mis à jour par le runtime d'après le résultat réel du tour et les vérifications. Si une délégation aide, délègue un sous-objectif borné et intègre son résultat toi-même.";
          ccSend(promptText, { workItemId: item.id });
          closeCC();
        };
        acts.appendChild(delegateBtn);

        const doneBtn = el("button", "cc-act ok", "Terminer");
        doneBtn.type = "button";
        doneBtn.disabled = !writable;
        doneBtn.onclick = () => {
          doneBtn.disabled = true;
          post("/work/items", { sid: active.sid, action: "complete", task_id: item.id })
            .then((res) => {
              if (res && res.error) throw new Error(res.error);
              if (cc.data) cc.data.workItems = res.items || [];
              renderCC();
            }).catch((err) => showToast(err.message || "Échec", "error"))
            .finally(() => { doneBtn.disabled = !writable; });
        };
        acts.appendChild(doneBtn);
      } else {
        const reopenBtn = el("button", "cc-act", "Réouvrir");
        reopenBtn.type = "button";
        reopenBtn.disabled = !writable;
        reopenBtn.onclick = () => {
          reopenBtn.disabled = true;
          post("/work/items", { sid: active.sid, action: "update", task_id: item.id, status: "open" })
            .then((res) => {
              if (res && res.error) throw new Error(res.error);
              if (cc.data) cc.data.workItems = res.items || [];
              renderCC();
            }).catch((err) => showToast(err.message || "Échec", "error"))
            .finally(() => { reopenBtn.disabled = !writable; });
        };
        acts.appendChild(reopenBtn);
      }

      if (item.status !== "archived") {
        const archBtn = el("button", "cc-act", "Archiver");
        archBtn.type = "button";
        archBtn.disabled = !writable;
        archBtn.onclick = () => {
          archBtn.disabled = true;
          post("/work/items", { sid: active.sid, action: "archive", task_id: item.id })
            .then((res) => {
              if (res && res.error) throw new Error(res.error);
              if (cc.data) cc.data.workItems = res.items || [];
              renderCC();
            }).catch((err) => showToast(err.message || "Échec", "error"))
            .finally(() => { archBtn.disabled = !writable; });
        };
        acts.appendChild(archBtn);
      }

      card.appendChild(acts);
      cardsEl.appendChild(card);
    }
    if (!col.items.length) {
      cardsEl.appendChild(el("div", "hint", "Aucune tâche dans cette colonne."));
    }
    colEl.appendChild(cardsEl);
    kanbanBoard.appendChild(colEl);
  }

  wrap.appendChild(ccSection("Tableau Kanban Cowork (" + items.length + ")", kanbanBoard));
  const refreshButton = el("button", "cc-act", "Actualiser"); refreshButton.type = "button"; refreshButton.onclick = refresh;
  wrap.appendChild(refreshButton);
  return wrap;
}
function ccOverview(d) {
  const wrap = el("div", "cc-anim");
  const s = d.state || {};
  const ctx = s.context || null;
  wrap.appendChild(
    ccSection(
      "",
      ccKV([
        ["mode", s.modeLabel || s.mode || "—"],
        ["modèle", (s.model || "—") + (s.host ? " @" + s.host : "")],
        ["backend", s.backend || "—"],
        ["raisonnement", s.effort || "auto"],
        ["contexte", (s.ctxPct || 0) + "%" + (ctx ? " (" + ctx.prompt.toLocaleString() + " / " + ctx.window.toLocaleString() + ")" : "")],
        ["plan", s.plan ? s.plan.steps.filter((x) => x.done).length + "/" + s.plan.steps.length : "—"],
        ["tâches", s.tasks || 0],
        ["état", s.outcome || "idle"],
        ["espace", shortPath(d.workspace || "")],
        ["runtime", "smol " + (d.version || "?") + " · node " + (((d.runtime || {}).node) || "?")],
      ])
    )
  );
  const chips = el("div", "cc-lights");
  if (d.subagents && d.subagents.running) {
    const c = el("span", "cc-light ok");
    c.appendChild(el("span", "dot"));
    c.appendChild(el("span", "", "sous-agent : " + d.subagents.running));
    chips.appendChild(c);
  }
  for (const n of d.skillsActive || []) {
    const c = el("span", "cc-light ok");
    c.appendChild(el("span", "dot"));
    c.appendChild(el("span", "", n));
    c.appendChild(el("span", "cc-tag", "skill active"));
    chips.appendChild(c);
  }
  if (s.verification) {
    const c = el("span", "cc-light " + (s.verification.passed ? "ok" : "bad"));
    c.appendChild(el("span", "dot"));
    c.appendChild(el("span", "", s.verification.passed ? "vérification passée" : "réparation auto ×" + s.verification.attempts));
    chips.appendChild(c);
  }
  if (d.localModels && (d.localModels.loaded || []).length) {
    for (const m of d.localModels.loaded) {
      const c = el("span", "cc-light ok");
      c.appendChild(el("span", "dot"));
      c.appendChild(el("span", "", "modèle : " + m.name));
      const vStr = m.vramMb ? (m.vramMb >= 1024 ? (m.vramMb / 1024).toFixed(1) + " Go VRAM" : m.vramMb + " Mo VRAM") : "";
      if (vStr) c.appendChild(el("span", "cc-tag", vStr));
      chips.appendChild(c);
    }
  }
  if (chips.childNodes.length) wrap.appendChild(ccSection("En direct", chips));

  // Monitoring en direct des modèles locaux et VRAM
  const lm = d.localModels;
  if (lm) {
    const loadedList = lm.loaded || [];
    const vramMb = lm.totalVramMb || 0;
    const vramStr = vramMb >= 1024 ? (vramMb / 1024).toFixed(1) + " Go" : vramMb + " Mo";
    const lmSec = el("div", "cc-sec");
    const lmHead = el("h3", "", "⚡ Monitoring Modèles Locaux & VRAM");
    lmSec.appendChild(lmHead);

    const lmGrid = el("div", "cc-grid");
    const vramCard = ccCard(
      "VRAM active allouée",
      loadedList.length ? vramStr + " utilisée par " + loadedList.length + " modèle(s) chargé(s)" : "0 Mo (aucun modèle résident en VRAM)",
      "Gérer (/models)",
      () => { ccSend("/models"); closeCC(); }
    );
    lmGrid.appendChild(vramCard);

    const enginesText = "Ollama: " + (lm.ollamaOnline ? "En ligne (11434)" : "Hors ligne") + " · LM Studio: " + (lm.lmStudioOnline ? "En ligne (1234)" : "Hors ligne");
    const enginesCard = ccCard(
      "Moteurs d'inférence locaux",
      enginesText,
      "Tester la connexion",
      () => loadCC()
    );
    lmGrid.appendChild(enginesCard);

    for (const m of loadedList) {
      const mVram = m.vramMb ? (m.vramMb >= 1024 ? (m.vramMb / 1024).toFixed(1) + " Go VRAM" : m.vramMb + " Mo VRAM") : (m.sizeMb ? m.sizeMb + " Mo" : "Actif");
      const mCard = ccCard(
        "🧠 " + m.name,
        "Fournisseur : " + m.provider + " · Charge VRAM : " + mVram + (m.contextLength ? " · Contexte : " + m.contextLength + " tokens" : ""),
        "Sélectionner",
        () => { ccSend("/model " + m.name); closeCC(); }
      );
      lmGrid.appendChild(mCard);
    }
    lmSec.appendChild(lmGrid);
    wrap.appendChild(lmSec);
  }

  const grid = el("div", "cc-grid");
  const runs = d.subagents && d.subagents.stats ? d.subagents.stats.runs : 0;
  grid.appendChild(ccCard("Sous-agents", runs ? runs + " délégations cumulées dans cet espace." : "Aucune délégation encore : chaque rôle est prêt.", "Voir les rôles", () => ccGoTab("agents")));
  grid.appendChild(ccCard("Cowork", (d.workItems || []).filter((item) => item.status === "open").length + " tâches ouvertes partagées avec l’agent.", "Ouvrir le tableau", () => ccGoTab("work")));
  grid.appendChild(ccCard("Skills", (d.skills || []).length + " skills utilisables (projet + intégrées).", "Parcourir", () => ccGoTab("skills")));
  grid.appendChild(ccCard("Outils", (d.tools || []).length + " outils disponibles dans ce mode.", "Lister", () => ccGoTab("tools")));
  grid.appendChild(ccCard("Serveurs MCP", (d.mcp || []).filter((x) => x.ok).length + "/" + (d.mcp || []).length + " joignables.", "Diagnostiquer", () => ccGoTab("mcp")));
  const c3 = d.c3 || {};
  grid.appendChild(ccCard(
    "C3 / mémoire projet",
    c3.enabled
      ? (c3.workspace ? "Contrôle C3 actif dans cet espace." : "C3 global détecté, sans index workspace.")
      : "C3 non détecté dans cet espace.",
    c3.enabled ? "Inspecter" : null,
    () => { cc.tab = "c3"; renderCCTabs(); renderCC(); }
  ));
  wrap.appendChild(ccSection("Raccourcis", grid));
  return wrap;
}

function ccAgents(d) {
  const wrap = el("div", "cc-anim");
  const info = d.subagents || {};
  const roles = info.roles || [];
  const stats = info.stats || { runs: 0, toolCalls: 0, lastAt: 0 };
  wrap.appendChild(
    ccSection(
      "",
      ccKV([
        ["rôles", roles.length],
        ["délégations", stats.runs],
        ["outils délégués", stats.toolCalls],
        ["en cours", info.running || "—"],
        ["dernière", stats.lastAt ? new Date(stats.lastAt).toLocaleString() : "—"],
      ])
    )
  );
  const grid = el("div", "cc-grid");
  for (const r of roles) {
    const card = el("div", "cc-card cc-role");
    const h = el("h4");
    h.appendChild(document.createTextNode(r.role || r.name));
    h.appendChild(el("span", "cc-tag", r.name + (r.source === "builtin" ? "" : " · " + r.source)));
    card.appendChild(h);
    card.appendChild(el("p", "", r.description || ""));
    if (r.tools && r.tools.length) card.appendChild(el("div", "hint", "outils autorisés : " + r.tools.join(", ")));
    const row = el("div", "row");
    const inp = document.createElement("input");
    inp.placeholder = "tâche à déléguer…";
    inp.spellcheck = false;
    const b = el("button", "cc-act", "Préparer");
    b.type = "button";
    const run = el("button", "cc-act primary", "Lancer");
    run.type = "button";
    b.onclick = () => {
      const task = inp.value.trim();
      if (!task) { inp.setCustomValidity("décrivez la tâche"); inp.reportValidity(); inp.focus(); return; }
      inp.setCustomValidity("");
      post("/agents/draft", { sid: active.sid, role: r.name, task }).then((res) => {
        if (res && res.error) { alert(res.error); return; }
        ccFill(res.text || "");
        closeCC();
      });
    };
    run.onclick = () => {
      const task = inp.value.trim();
      if (!task) { inp.setCustomValidity("décrivez la tâche"); inp.reportValidity(); inp.focus(); return; }
      inp.setCustomValidity("");
      run.disabled = true;
      post("/agents/draft", { sid: active.sid, role: r.name, task }).then((res) => {
        if (res && res.error) { alert(res.error); return; }
        return post("/msg", { sid: active.sid, text: res.text || "" });
      }).then(() => {
        closeCC();
      }).finally(() => { run.disabled = false; });
    };
    inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); b.click(); } };
    row.appendChild(inp);
    row.appendChild(b);
    row.appendChild(run);
    card.appendChild(row);
    grid.appendChild(card);
  }
  wrap.appendChild(ccSection("Rôles disponibles", grid));
  if (!roles.length) wrap.appendChild(el("div", "cc-empty", "Aucun rôle : ajoutez .smol/agents/<nom>.json."));
  return wrap;
}
function ccSkills(d) {
  const wrap = el("div", "cc-anim");
  const list = el("div", "cc-list");
  const active = new Set(d.skillsActive || []);
  for (const s of d.skills || []) {
    const it = el("div", "cc-item" + (active.has(s.name) ? " on" : ""));
    it.appendChild(el("span", "nm", s.name));
    if (s.builtin) it.appendChild(el("span", "cc-tag", "intégrée"));
    else if (s.auto) it.appendChild(el("span", "cc-tag", "auto-réparation"));
    it.appendChild(el("span", "ds", s.description || ""));
    if (!s.builtin && s.updatedAt) it.appendChild(el("span", "cc-tag", new Date(s.updatedAt).toLocaleDateString()));
    const b = el("button", "cc-act", "Lire");
    b.type = "button";
    b.onclick = () => { ccSend("/skill read " + s.name); closeCC(); };
    it.appendChild(b);
    list.appendChild(it);
  }
  if (!(d.skills || []).length) list.appendChild(el("div", "cc-empty", "Aucune skill pour l'instant."));
  wrap.appendChild(ccSection("Skills du projet et intégrées (" + (d.skills || []).length + ")", list));
  return wrap;
}
function ccTools(d) {
  const wrap = el("div", "cc-anim");
  const list = el("div", "cc-list");
  for (const t of d.tools || []) {
    const it = el("div", "cc-item");
    it.appendChild(el("span", "nm", t.name));
    it.appendChild(el("span", "ds", t.description || ""));
    list.appendChild(it);
  }
  if (!(d.tools || []).length) list.appendChild(el("div", "cc-empty", "Aucun outil dans ce mode."));
  wrap.appendChild(ccSection("Outils actifs (" + (d.tools || []).length + ")", list));
  return wrap;
}

function ccMcp(d) {
  const wrap = el("div", "cc-anim");
  const servers = d.mcp || [];
  wrap.appendChild(ccSection("Etat des serveurs", ccLights(servers)));
  if (!servers.length) {
    wrap.appendChild(el("div", "cc-empty", "Aucun serveur MCP configure (.smol/mcp.json)."));
    return wrap;
  }
  // One single list: every server appears once, with a real switch and a real
  // diagnose button. Both act on the server through /mcp/toggle and /mcp/debug,
  // so no command is ever echoed back into the conversation.
  const list = el("div", "cc-list");
  const note = el("div", "cc-note", "");
  for (const m of servers) {
    const it = el("div", "cc-item");
    const disabled = m.enabled === false;
    const waiting = m.retrying === true && !m.ok;
    // Same amber rule as the dashboard lights: a refused key is a missing key,
    // not an unreachable server.
    const needsKey = !waiting && !m.ok && /\b(401|403)\b|cl[ée] API/i.test(String(m.error || ""));
    it.appendChild(el("span", "nm", m.name));
    const detail = disabled
      ? "desactive"
      : waiting
        ? "demarrage..."
        : m.ok
          ? m.tools + (m.tools === 1 ? " outil" : " outils")
          : m.error || "injoignable";
    const ds = el("span", "ds" + (m.ok && !disabled ? " ok" : disabled ? " muted" : waiting || needsKey ? " warn" : " bad"), detail);
    if (waiting) ds.title = "Reponse lente : une seconde tentative de connexion est en cours.";
    else if (needsKey) ds.title = "Serveur actif, mais la cle API est absente ou refusee : renseignez la cle de ce serveur.";
    it.appendChild(ds);
    const row = el("div", "cc-row");
    const sw = el("button", "cc-switch" + (disabled ? "" : " on"));
    sw.type = "button";
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-checked", disabled ? "false" : "true");
    sw.setAttribute("aria-label", (disabled ? "Activer " : "Desactiver ") + m.name);
    sw.title = disabled
      ? "Demarre ce serveur et l'enregistre dans .smol/mcp.json"
      : "Arrete de demarrer ce serveur et l'enregistre dans .smol/mcp.json";
    sw.onclick = () => {
      sw.disabled = true;
      post("/mcp/toggle", { sid: active.sid, name: m.name, verb: disabled ? "on" : "off" })
        .then((r) => {
          showToast(r && r.message ? r.message : "MCP : " + (disabled ? "active" : "desactive"), "info");
          return loadCC();
        })
        .catch(() => showToast("MCP : impossible de joindre le serveur", "err"))
        .finally(() => { sw.disabled = false; });
    };
    row.appendChild(sw);
    const dbg = el("button", "cc-act", "Diagnostiquer");
    dbg.type = "button";
    dbg.title = "Relance ce serveur avec un delai long et affiche le detail de l'echec";
    dbg.onclick = () => {
      dbg.disabled = true;
      const restore = dbg.textContent;
      dbg.textContent = "Diagnostic...";
      post("/mcp/debug", { sid: active.sid, name: m.name, timeoutMs: 30000 })
        .then((r) => {
          note.textContent = (r && r.error ? "Erreur : " + r.error : (r && r.message) || "Aucune reponse du serveur.");
          note.hidden = false;
          return loadCC();
        })
        .catch(() => { note.textContent = "Erreur : impossible de joindre le serveur."; note.hidden = false; })
        .finally(() => { dbg.disabled = false; dbg.textContent = restore; });
    };
    row.appendChild(dbg);
    it.appendChild(row);
    list.appendChild(it);
  }
  wrap.appendChild(ccSection("Serveurs MCP (" + servers.length + ")", list));
  note.hidden = true;
  wrap.appendChild(note);
  return wrap;
}
function ccC3(d) {
  const wrap = el("div", "cc-anim");
  const c = d.c3 || {};
  const bytes = Number(c.indexedBytes || 0);
  const pretty = bytes < 1024 ? bytes + " B" : bytes < 1048576 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / 1048576).toFixed(1) + " MB";
  const grid = el("div", "cc-grid");
  grid.appendChild(ccCard("État", c.enabled ? "C3 détecté" : "C3 non détecté", null));
  grid.appendChild(ccCard("Cache intelligent", String(c.cacheFiles || 0) + " fichiers indexés", null));
  grid.appendChild(ccCard("Index SQLite", pretty, null));
  grid.appendChild(ccCard("Artifacts", c.artifacts ? "Disponibles" : "Absents", null));
  grid.appendChild(ccCard("Mémoire fichier", c.memory ? "Disponible" : "Absente", null));
  wrap.appendChild(ccSection("Contrôle C3", grid));
  wrap.appendChild(el("div", "cc-empty", c.workspace
    ? "Le workspace possède son index C3. Les modifications de session restent synchronisées avec l’IDE."
    : "Aucun index C3 local au workspace. Le contrôle global est visible, mais l’indexation projet doit être activée."));
  return wrap;
}
function ccOptions(d) {
  const wrap = el("div", "cc-anim");
  const s = d.state || {};
  const command = (name) => post("/msg", { sid: active ? active.sid : "", text: "/" + name });
  const grid = el("div", "cc-grid");
  grid.appendChild(ccCard("Mode de permission", "Lecture seule, édition, puis YOLO (aucune confirmation avant d'agir).", "Changer : " + (s.modeLabel || "—"), () => { ccSend("/mode"); closeCC(); }));
  grid.appendChild(ccCard("Modèle", "Actif : " + (s.model || "—") + (s.host ? " @ " + s.host : "") + " — choisir un modèle local ou en découvrir un sur une autre machine.", "Choisir (/models)", () => { ccSend("/models"); closeCC(); }));
  grid.appendChild(ccCard("Raisonnement", "Régler l'effort de réflexion envoyé au modèle.", "Régler (/effort)", () => { ccSend("/effort"); closeCC(); }));
  const ctxPct = Math.max(0, Math.min(100, Math.round(Number(s.ctxPct) || 0)));
  grid.appendChild(ccCard("Contexte", ctxPct + "% utilisé · voir le budget détaillé et compacter la conversation si besoin.", "Ouvrir le menu de la jauge", () => {
    closeCC();
    if (ctxChip) statusMenu(ctxChip, contextMenuItems(s, command));
  }));
  grid.appendChild(ccCard("Notifications", bellOn() ? "Actives : fin de tour, erreurs, approbations." : "Inactives.", bellOn() ? "Désactiver" : "Activer", () => {
    ls.set("smol-notify", bellOn() ? "0" : "1");
    if (active) renderState(active);
    renderCC();
  }));
  grid.appendChild(ccCard("Barre latérale", "Afficher ou masquer la liste des espaces et sessions.", "Basculer", () => toggleSide()));
  grid.appendChild(ccCard("Serveurs MCP", "Liste, nombre d'outils et interrupteur par serveur.", "Ouvrir le panneau MCP", () => { openCC("mcp"); }));
  grid.appendChild(ccCard("Skills", d.skills ? (d.skills.length + " skills utilisables (projet + intégrées).") : "Lister, lire ou enregistrer une skill (/skill save).", "Lister (/skills)", () => { ccSend("/skills"); closeCC(); }));
  grid.appendChild(ccCard("Formateurs", "Vérifier les formateurs installés : prettier, black, ruff, rustfmt, gofmt.", "Vérifier", () => {
    fetch("/format/status?k=" + encodeURIComponent(k))
      .then((r) => r.json())
      .then((d) => {
        const raw = String((d && d.status) || "");
        if (raw.startsWith("(")) { showToast(raw.replace(/[()]/g, ""), "warn", 10000); return; }
        const lines = raw.split("\n").filter(Boolean);
        if (!lines.length) { showToast("Statut des formateurs indisponible", "error"); return; }
        const okN = lines.filter((l) => l.indexOf("✓") === 0).length;
        const missing = lines.filter((l) => l.indexOf("✗") === 0).map((l) => l.replace(/^✗\s*/, "").replace(/\s*\(.*\)$/, ""));
        showToast(okN + "/" + lines.length + " formateur(s) prêt(s)" + (missing.length ? " — manquant : " + missing.join(", ") : " — tous installés"), okN === lines.length ? "success" : "warn", 8000);
      })
      .catch(() => showToast("Statut des formateurs indisponible", "error"));
  }));
  wrap.appendChild(ccSection("Options de session", grid));
  return wrap;
}
function renderCC() {
  const body = $("ccbody");
  if (!body) return;
  body.innerHTML = "";
  const meta = $("ccmeta");
  if (meta) meta.textContent = cc.at ? "actualisé " + rel(cc.at) : "";
  if (cc.loading && !cc.data) { body.appendChild(ccSkeleton()); return; }
  if (cc.error) { body.appendChild(el("div", "cc-empty", cc.error)); return; }
  if (!cc.data) { body.appendChild(el("div", "cc-empty", "Aucune donnée de statut.")); return; }
  const d = cc.data;
  if (cc.tab === "work") body.appendChild(ccWork(d));
  else if (cc.tab === "agents") body.appendChild(ccAgents(d));
  else if (cc.tab === "skills") body.appendChild(ccSkills(d));
  else if (cc.tab === "tools") body.appendChild(ccTools(d));
  else if (cc.tab === "mcp") body.appendChild(ccMcp(d));
  else if (cc.tab === "c3") body.appendChild(ccC3(d));
  else if (cc.tab === "options") body.appendChild(ccOptions(d));
  else body.appendChild(ccOverview(d));
}
$("btnstatus").onclick = () => (ccOpenNow() ? closeCC() : openCC());
const sbProblems = $("sb-problems");
if (sbProblems) sbProblems.onclick = () => togglePanelKind("problems");
const sbSettings = $("sb-settings");
if (sbSettings) sbSettings.onclick = () => (ccOpenNow() ? closeCC() : openCC());
const sbBranch = $("sb-branch");
async function loadGitStatus(v) {
  if (!v) throw new Error("Ouvrez une session de projet pour consulter Git.");
  const response = await fetch("/git/status?k=" + k + "&sid=" + encodeURIComponent(v.sid));
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "Statut Git indisponible.");
  if (data.sync && data.sync.error) throw new Error(data.sync.error);
  return data.sync;
}
async function refreshGitStatus(v) {
  try {
    const sync = await loadGitStatus(v);
    if (active !== v) return sync;
    $("sb-branch-name").textContent = sync.branch || "(detached)";
    sbBranch.title = "Branche locale : " + (sync.branch || "(detached)");
    const syncText = $("sb-sync-text");
    if (sync.upstream && sync.ahead !== null && sync.behind !== null) {
      syncText.textContent = sync.behind + "↓ " + sync.ahead + "↑";
      $("sb-sync").title = sync.behind + " en retard, " + sync.ahead + " en avance sur " + sync.upstream + " (référence locale; aucun fetch/push).";
    } else {
      syncText.textContent = "—";
      $("sb-sync").title = sync.upstream ? "Écart upstream inconnu (référence locale)." : "Aucune référence upstream configurée; aucun fetch/push effectué.";
    }
    return sync;
  } catch (error) {
    if (active === v) {
      $("sb-branch-name").textContent = "Git ?";
      $("sb-sync-text").textContent = "—";
      $("sb-branch").title = error.message || "Statut Git indisponible.";
    }
    return { error: error.message || String(error) };
  }
}
if (sbBranch) sbBranch.onclick = async () => {
  const sync = await refreshGitStatus(active);
  showToast(sync.error || ("Branche locale : " + (sync.branch || "(detached)")), sync.error ? "error" : "info");
};
const sbSync = $("sb-sync");
if (sbSync) sbSync.onclick = async () => {
  const sync = await refreshGitStatus(active);
  const message = sync.error
    || (sync.upstream && sync.ahead !== null && sync.behind !== null
      ? sync.behind + " en retard, " + sync.ahead + " en avance sur " + sync.upstream + ". Comparaison locale uniquement : aucun fetch/push effectué."
      : "Aucune référence upstream configurée. Aucun fetch/push effectué.");
  showToast(message, sync.error ? "error" : "info");
};
const sbIndent = $("sb-indent");
let currentIndent = 2;
if (sbIndent) {
  sbIndent.onclick = () => {
    currentIndent = currentIndent === 2 ? 4 : 2;
    const txt = $("sb-indent-text");
    if (txt) txt.textContent = "Espaces : " + currentIndent;
    showToast("Indentation configurée : " + currentIndent + " espaces", "info");
  };
}
const sbEol = $("sb-eol");
if (sbEol) {
  sbEol.onclick = () => {
    const curTab = active && active.tabs ? active.tabs.find((x) => x.kind === "files") : null;
    const curEditor = curTab ? curTab.editor : null;
    if (!curEditor || !curEditor.value) {
      const nextEol = sbEol.textContent === "LF" ? "CRLF" : "LF";
      sbEol.textContent = nextEol;
      showToast("Format de fin de ligne par défaut : " + nextEol, "info");
      return;
    }
    if (sbEol.textContent === "LF") {
      curEditor.value = curEditor.value.replace(/\r?\n/g, "\r\n");
      sbEol.textContent = "CRLF";
      showToast("Fichier converti en CRLF (Windows)", "info");
    } else {
      curEditor.value = curEditor.value.replace(/\r\n/g, "\n");
      sbEol.textContent = "LF";
      showToast("Fichier converti en LF (Unix/macOS)", "info");
    }
    if (curTab.paint) curTab.paint();
  };
}
const sbEncoding = $("sb-encoding");
if (sbEncoding) {
  sbEncoding.onclick = () => {
    showToast("Encodage : UTF-8 (sans BOM, encodage standard universel)", "info");
  };
}
const sbFormatter = $("sb-formatter");
if (sbFormatter) sbFormatter.onclick = async () => {
  if (!active) { showToast("Ouvrez une session pour formater un fichier.", "warn"); return; }
  const ft = active.tabs.find((tb) => tb.kind === "files");
  if (!ft || !ft.filePath) { showToast("Ouvrez d'abord un fichier dans l'éditeur.", "warn"); return; }
  const rel = ft.filePath;
  const cur = ft.tabStore && ft.tabStore.active ? ft.tabStore.active() : null;
  if (cur && cur.dirty) {
    if (ft.saveBtn) ft.saveBtn.click();
    let savedNow = false;
    for (let i = 0; i < 40; i++) {
      const check = ft.tabStore.active();
      if (!check || !check.dirty) { savedNow = true; break; }
      await new Promise((res) => setTimeout(res, 50));
    }
    if (!savedNow) { showToast("Enregistrez le fichier avant de le formater (Ctrl+S).", "warn"); return; }
  }
  const r = await post("/code/format", { sid: active.sid, path: rel }).catch(() => null);
  if (r && r.ok) {
    sbFormatter.innerHTML = '<span class="vsc-sb-ico">△</span> Formateur ✓';
    sbFormatter.title = rel + " : " + r.message;
    showToast(r.message, "info");
    if (typeof ft.loadFile === "function") { try { await ft.loadFile(rel); } catch (e) {} }
  } else {
    showToast((r && r.message) || "Aucun formateur disponible pour ce type de fichier.", "warn");
  }
};
const sbLangBtn = $("sb-lang");
if (sbLangBtn) {
  sbLangBtn.title = "Langage déduit de l'extension du fichier — cliquer pour le détail";
  sbLangBtn.onclick = () => {
    const lang = ($("sb-lang-text") && $("sb-lang-text").textContent) || "—";
    const ft = active && active.tabs ? active.tabs.find((tb) => tb.kind === "files") : null;
    const name = ft && ft.filePath ? ft.filePath.split(/[\\/]/).pop() : null;
    showToast(name ? "Langage : " + lang + " — déduit de l'extension de « " + name + " » (le mode suit toujours le fichier)." : "Langage : " + lang + " — déduit de l'extension du fichier ouvert.", "info");
  };
}
const sbBell = $("sb-bell");
if (sbBell) {
  const paintBell = () => { const ico = sbBell.querySelector(".vsc-sb-ico"); if (ico) ico.textContent = bellOn() ? "🔔" : "🔕"; sbBell.title = "Notifications desktop : " + (bellOn() ? "actives (fin de tour, erreurs, approbations)" : "inactives"); };
  paintBell();
  sbBell.onclick = () => {
    if (!bellOn()) {
      ls.set("smol-notify", "1");
      try { if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission(); } catch (e) {}
      showToast("Notifications desktop activées : fin de tour, erreurs, approbations.", "info");
    } else {
      ls.set("smol-notify", "0");
      showToast("Notifications desktop désactivées.", "info");
    }
    paintBell();
  };
}
const sbBlame = $("sb-blame");
if (sbBlame) sbBlame.onclick = async () => {
  if (!active) { showToast("Ouvrez une session et un fichier d’abord.", "warn"); return; }
  const files = active.tabs.find((tab) => tab.kind === "files");
  if (!files?.filePath || !files.editor) { showToast("Ouvrez un fichier suivi par Git pour afficher son auteur.", "warn"); return; }
  try {
    const line = editorTools.cursorPosition(files.editor.value, files.editor.selectionStart).line;
    const url = "/git/blame?k=" + k + "&sid=" + encodeURIComponent(active.sid) + "&path=" + encodeURIComponent(files.filePath) + "&line=" + line;
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || "Git blame indisponible.");
    $("sb-blame-text").textContent = data.result.slice(0, 60);
    $("sb-blame").title = data.result;
    showToast(data.result, "info");
  } catch (error) {
    showToast(error.message || String(error), "error");
  }
};
if ($("btnmodels")) $("btnmodels").onclick = () => {
  if (active) {
    post("/msg", { sid: active.sid, text: "/models" });
  } else {
    showToast("Veuillez d'abord ouvrir un dossier de projet", "info");
  }
};
$("ccclose").onclick = closeCC;
$("ccrefresh").onclick = () => loadCC();
$("cc").onclick = (e) => { if (e.target === $("cc")) closeCC(); };
$("cc").addEventListener("focusout", (event) => {
  if (cc.needsRender && !$("cc").contains(event.relatedTarget)) {
    cc.needsRender = false;
    renderCC();
  }
});
// Le hub peut ouvrir le centre directement (lien #status, IDE Electron) et le
// rafraîchit tout seul pendant qu'il est ouvert.
setTimeout(() => { if (location.hash === "#status" && active) openCC(); }, 600);
setInterval(() => { if (ccOpenNow() && !cc.loading && !ccHasFocus()) loadCC(); }, 20000);

// ---- connect (SSE avec retry + bandeau) -----------------------------------
let es = null;
let sseRetry = 0;
let sseTimer = null;
const SSE_DELAYS = [2000, 5000, 15000];
function netBanner() { return document.getElementById("netbanner"); }
function hideNetBanner() { const b = netBanner(); if (b) b.remove(); }
function showNetBanner() {
  if (netBanner()) return;
  const bar = el("div", "");
  bar.id = "netbanner";
  bar.style.position = "fixed";
  bar.style.top = "0";
  bar.style.left = "0";
  bar.style.right = "0";
  bar.style.zIndex = "9999";
  bar.style.display = "flex";
  bar.style.alignItems = "center";
  bar.style.justifyContent = "center";
  bar.style.gap = "10px";
  bar.style.padding = "8px 12px";
  bar.style.background = "#3a1214";
  bar.style.color = "#ffd9d9";
  bar.style.borderBottom = "1px solid #7a2020";
  bar.style.fontSize = "13px";
  bar.appendChild(document.createTextNode("Serveur injoignable — rechargez la page"));
  const btn = el("button", "ghost", "Recharger");
  btn.type = "button";
  btn.onclick = () => { persistDraft(); location.reload(); };
  bar.appendChild(btn);
  const hide = el("button", "iconbtn", "×");
  hide.type = "button";
  hide.title = "masquer";
  hide.onclick = () => hideNetBanner();
  bar.appendChild(hide);
  document.body.appendChild(bar);
}
function sseClearRetry() { sseRetry = 0; if (sseTimer) { clearTimeout(sseTimer); sseTimer = null; } }
function sseFailed() {
  try { if (es) es.close(); } catch (e) {}
  $("status").textContent = "reconnexion…";
  if (sseRetry >= SSE_DELAYS.length) { showNetBanner(); return; }
  const delay = SSE_DELAYS[sseRetry++];
  if (sseTimer) clearTimeout(sseTimer);
  sseTimer = setTimeout(() => { sseTimer = null; connectSSE(); }, delay);
}
// ---- read-only live follow --------------------------------------------------
// Opened with ?share=TOKEN: the same page follows one session live, with the
// composer disabled and presence announced. The hub token is never exposed.
const shareToken = new URLSearchParams(location.search).get("share") || "";
let shareSid = "";
function shareSession(sid) {
  post("/sessions/share", { sid }).then((r) => {
    if (!r || r.error || !r.token) { alert((r && r.error) || "Échec du partage"); return; }
    prompt("Lien de suivi en direct (lecture seule) — copiez-le :", location.origin + location.pathname + "?share=" + r.token);
  }).catch((e) => alert(String((e && e.message) || e)));
}
function pingShare() {
  if (!shareToken) return;
  fetch("/shared/ping?k=" + encodeURIComponent(shareToken) + "&name=" + encodeURIComponent(ls.get("smol-viewer") || "anonymous")).catch(() => {});
}
function onShared(m) {
  shareSid = m.sid;
  let name = ls.get("smol-viewer") || "";
  if (!name) {
    try { name = (prompt("Votre nom (affiché au propriétaire) :", "") || "").trim().slice(0, 40) || "anonymous"; }
    catch (e) { name = "anonymous"; }
    ls.set("smol-viewer", name);
  }
  document.title = "👁 " + (m.title || "session partagée") + " · smol";
  if (!$("sharebanner")) {
    const b = el("div", "sharebanner", "👁 Session partagée en lecture seule — le compositeur est désactivé.");
    document.body.prepend(b);
  }
  input.disabled = true;
  input.placeholder = "Lecture seule — demandez au propriétaire d’agir.";
  const ab = $("actionbtn"); if (ab) ab.disabled = true;
  const st = $("sidetoggle"); if (st) st.hidden = true;
  sideEl.hidden = true;
  pingShare();
  show(m.sid);
}
setInterval(() => { if (shareToken && shareSid) pingShare(); }, 20000);
function connectSSE() {
  try { if (es) es.close(); } catch (e) {}
  es = new EventSource(shareToken ? "/shared?k=" + encodeURIComponent(shareToken) : "/events?k=" + k);
  es.onopen = () => {
    sseClearRetry();
    hideNetBanner();
    // Everything is replayed on (re)connect: start each view from a clean slate.
    for (const v of views.values()) {
      v.logEl.innerHTML = ""; v.curText = null; v.curThought = null; v.asks.clear();
      for (const t of v.terms.values()) { t.out.innerHTML = ""; t.cur = null; t.lines = 0; }
    }
  };
  es.onmessage = (e) => { sseClearRetry(); hideNetBanner(); handle(JSON.parse(e.data)); };
  es.onerror = () => { sseFailed(); };
}

// ---- Palette de Commandes Web Hub (Ctrl+P / Ctrl+Shift+P / Ctrl+Tilde) ----
let webPaletteEl = null;
let webPaletteInput = null;
let webPaletteList = null;
let webPaletteCount = null;
let webPaletteIcon = null;
let webPaletteItems = [];
let webPaletteIdx = 0;

function ensureWebPalette() {
  if (webPaletteEl) return;
  webPaletteEl = el("div", "");
  webPaletteEl.id = "webPaletteOverlay";
  webPaletteEl.hidden = true;
  webPaletteEl.setAttribute("role", "dialog");
  webPaletteEl.setAttribute("aria-modal", "true");

  const box = el("div", "");
  box.id = "webPaletteBox";

  const header = el("div", "");
  header.id = "webPaletteHeader";

  webPaletteIcon = el("span", "", ">");
  webPaletteIcon.id = "webPalettePromptIcon";

  webPaletteInput = document.createElement("input");
  webPaletteInput.id = "webPaletteInput";
  webPaletteInput.type = "text";
  webPaletteInput.placeholder = "Tapez '>' pour des commandes ou le nom d'un onglet / fichier...";
  webPaletteInput.autocomplete = "off";
  webPaletteInput.spellcheck = false;

  webPaletteCount = el("span", "", "0 résultat");
  webPaletteCount.id = "webPaletteCount";

  header.append(webPaletteIcon, webPaletteInput, webPaletteCount);

  webPaletteList = el("div", "");
  webPaletteList.id = "webPaletteList";
  webPaletteList.setAttribute("role", "listbox");

  box.append(header, webPaletteList);
  webPaletteEl.appendChild(box);
  document.body.appendChild(webPaletteEl);

  webPaletteEl.onclick = (e) => {
    if (e.target === webPaletteEl) closeWebPalette();
  };

  webPaletteInput.oninput = filterWebPalette;
  webPaletteInput.onkeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeWebPalette();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (webPaletteItems.length > 0) {
        webPaletteIdx = (webPaletteIdx + 1) % webPaletteItems.length;
        updateWebPaletteSelection();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (webPaletteItems.length > 0) {
        webPaletteIdx = (webPaletteIdx - 1 + webPaletteItems.length) % webPaletteItems.length;
        updateWebPaletteSelection();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (webPaletteItems.length > 0) {
        executeWebPaletteItem(webPaletteItems[webPaletteIdx]);
      }
    }
  };
}

function updateWebPaletteSelection() {
  if (!webPaletteList) return;
  const children = webPaletteList.querySelectorAll(".hub-palette-item");
  children.forEach((elem, i) => {
    elem.classList.toggle("active", i === webPaletteIdx);
    elem.setAttribute("aria-selected", String(i === webPaletteIdx));
  });
  const act = webPaletteList.querySelector(".hub-palette-item.active");
  if (act) act.scrollIntoView({ block: "nearest" });
}

function renderWebPaletteItems() {
  if (!webPaletteList) return;
  webPaletteList.replaceChildren();
  if (!webPaletteItems.length) {
    const empty = el("div", "", "Aucun résultat correspondant.");
    empty.style.padding = "10px 14px";
    empty.style.color = "#858585";
    empty.style.fontSize = "12px";
    webPaletteList.appendChild(empty);
    if (webPaletteCount) webPaletteCount.textContent = "0 résultat";
    return;
  }
  if (webPaletteCount) webPaletteCount.textContent = webPaletteItems.length + " résultat(s)";

  webPaletteItems.forEach((it, idx) => {
    const b = el("button", "hub-palette-item" + (idx === webPaletteIdx ? " active" : ""));
    b.type = "button";
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(idx === webPaletteIdx));

    const iconSpan = el("span", "", it.icon || "📄");
    iconSpan.style.width = "18px";
    iconSpan.style.textAlign = "center";

    const labelSpan = el("span", "palette-label", it.label);
    const detailSpan = el("span", "palette-detail", it.detail || "");

    b.append(iconSpan, labelSpan, detailSpan);
    b.onclick = () => {
      webPaletteIdx = idx;
      executeWebPaletteItem(it);
    };
    b.onmouseenter = () => {
      webPaletteIdx = idx;
      updateWebPaletteSelection();
    };
    webPaletteList.appendChild(b);
  });
  updateWebPaletteSelection();
}

function executeWebPaletteItem(it) {
  closeWebPalette();
  if (!it) return;
  if (it.run) it.run();
}

function filterWebPalette() {
  const q = (webPaletteInput ? webPaletteInput.value : "").trim();
  const isCmd = q.startsWith(">");
  if (webPaletteIcon) webPaletteIcon.textContent = isCmd ? ">" : "📄";

  const v = active;
  const commands = [
    { label: "Basculer le Terminal & Dock Pro", detail: "Ctrl+Tilde", icon: "💻", run: () => togglePanelKind("term") },
    { label: "Fichiers & Explorateur de projet", detail: "Onglet fichiers", icon: "📁", run: () => togglePanelKind("files") },
    { label: "Navigateur Web intégré", detail: "Aperçu local", icon: "🌐", run: () => togglePanelKind("browser") },
    { label: "Ouvrir le Centre de Contrôle", detail: "Skills, rôles, MCP", icon: "⚙", run: () => openCC() },
    { label: "Problèmes & Diagnostics du projet", detail: "LSP en temps réel", icon: "✓", run: () => togglePanelKind("problems") },
    { label: "Révision des changements Git", detail: "Diff non committé", icon: "Δ", run: () => togglePanelKind("review") },
    { label: "Modèles d'IA disponibles (/models)", detail: "Ollama / LM Studio", icon: "🤖", run: () => { if (v) post("/msg", { sid: v.sid, text: "/models" }); } },
    { label: "État et Diagnostic du Hub (/status)", detail: "Ressources & charge", icon: "📊", run: () => { if (v) post("/msg", { sid: v.sid, text: "/status" }); } },
    { label: "Nettoyer la conversation (/clean)", detail: "Purge visuelle", icon: "🧹", run: () => { if (v) post("/msg", { sid: v.sid, text: "/clean" }); } },
    { label: "Interrompre la réponse en cours", detail: "Stop agent", icon: "⏹", run: () => { if (v) post("/stop", { sid: v.sid }); } },
  ];

  if (isCmd) {
    const s = q.slice(1).trim().toLowerCase();
    webPaletteItems = commands.filter((c) => !s || c.label.toLowerCase().includes(s) || (c.detail && c.detail.toLowerCase().includes(s)));
  } else {
    const s = q.toLowerCase();
    const tabItems = (v ? v.tabs : []).map((t) => {
      let lbl = t.kind;
      if (t.kind === "files") lbl = "Fichiers (" + (t.filePath || t.rel || ".") + ")";
      else if (t.kind === "browser") lbl = "Navigateur (" + (t.url || "vide") + ")";
      else if (t.kind === "term") lbl = "Terminal (" + (t.tid || "actif") + ")";
      else if (t.kind === "problems") lbl = "Problèmes LSP";
      return {
        label: lbl,
        detail: "Onglet ouvert",
        icon: t.kind === "term" ? "💻" : t.kind === "browser" ? "🌐" : "📄",
        run: () => { v.activeTab = t.id; v.panelOpen = true; savePanel(v); renderPanel(); }
      };
    });

    const fileMatches = (workspaceDiagnostics || []).map((d) => ({
      label: d.path + ":" + d.line,
      detail: d.message,
      icon: d.severity === "error" ? "❌" : "⚠",
      run: () => { togglePanelKind("problems"); }
    }));

    const combined = tabItems.concat(commands).concat(fileMatches);
    webPaletteItems = combined.filter((c) => !s || c.label.toLowerCase().includes(s) || (c.detail && c.detail.toLowerCase().includes(s)));
  }
  webPaletteIdx = 0;
  renderWebPaletteItems();
}

function openWebPalette(cmdMode) {
  ensureWebPalette();
  webPaletteEl.hidden = false;
  if (webPaletteInput) {
    webPaletteInput.value = cmdMode ? "> " : "";
    webPaletteInput.focus();
    webPaletteInput.select();
  }
  filterWebPalette();
}

function closeWebPalette() {
  if (webPaletteEl) webPaletteEl.hidden = true;
  if (input) input.focus();
}

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.keyCode === 192 || e.key === "~" || e.key === String.fromCharCode(96))) {
    e.preventDefault();
    togglePanelKind("term");
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
    e.preventDefault();
    openWebPalette(e.shiftKey);
  }
});

connectSSE();
`;

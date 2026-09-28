// Compact workspace chrome, with monospace reserved for code and commands.

import { LOGO_ROWS } from "../logo";

// The logo as a CSS string: "\A " is a newline whose trailing space is eaten
// by the escape, so each row starts where it should.
const LOGO_CSS = LOGO_ROWS.map((r) => r.trimEnd()).join("\\A ");

export const STYLES = String.raw`
  :root {
    --bg: #090d12; --fg: #f0f6fc; --dim: #8b949e; --gray: #6e7681;
    --accent: #38bdf8; --accent-hover: #0ea5e9; --accent-glow: rgba(56, 189, 248, 0.22);
    --yellow: #f59e0b; --red: #f43f5e; --green: #10b981;
    --magenta: #a855f7; --box: #131922; --card: #16202c; --sel: #0284c7; --line: #212c3b; --side: #080c10;
    --radius-sm: 6px; --radius-md: 10px; --radius-lg: 14px;
    --transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }
  * { box-sizing: border-box; }
  /* Class rules below set display; the hidden attribute must still win. */
  [hidden] { display: none !important; }
  /* Scrollbars in the page's own colors (native ones are light and chunky). */
  html { color-scheme: dark; scrollbar-color: #212c3b transparent; }
  * { scrollbar-width: thin; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #212c3b; border-radius: 4px; border: 2px solid transparent; background-clip: padding-box; }
  ::-webkit-scrollbar-thumb:hover { background: #38bdf8; background-clip: padding-box; }
  ::-webkit-scrollbar-corner { background: transparent; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--fg); display: flex; overflow: hidden;
    font: 14px/1.6 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    letter-spacing: -0.01em;
  }
  button { font: inherit; }
  a { color: var(--accent); text-decoration: none; transition: var(--transition); }
  a:hover { color: #7dd3fc; text-decoration: underline; }
  .grow { flex: 1; }
  .iconbtn { background: transparent; border: 1px solid transparent; color: var(--dim); cursor: pointer; border-radius: var(--radius-sm); padding: 4px 8px; line-height: 1.2; display: inline-flex; align-items: center; gap: 6px; transition: var(--transition); }
  .iconbtn:hover { color: var(--fg); border-color: var(--line); background: rgba(255, 255, 255, 0.05); }
  .iconbtn.on { color: var(--accent); border-color: rgba(56, 189, 248, 0.4); background: rgba(56, 189, 248, 0.1); box-shadow: 0 0 12px var(--accent-glow); }
  .iconbtn svg { display: block; }
  .primary { background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%); color: #ffffff; border: 1px solid rgba(255, 255, 255, 0.15); padding: 7px 16px; border-radius: var(--radius-sm); cursor: pointer; font-weight: 600; box-shadow: 0 4px 14px rgba(2, 132, 199, 0.35); transition: var(--transition); }
  .primary:hover { box-shadow: 0 6px 20px rgba(2, 132, 199, 0.55); transform: translateY(-1px); }
  .ghost { background: rgba(255, 255, 255, 0.03); backdrop-filter: blur(8px); color: var(--fg); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 6px 12px; cursor: pointer; font-weight: 500; transition: var(--transition); }
  .ghost:hover { border-color: var(--accent); background: rgba(56, 189, 248, 0.08); color: var(--accent); }
  .hint { color: var(--dim); font-size: 12px; }
  .badge-gpu { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 20px; font-size: 11px; font-weight: 600; color: #34d399; letter-spacing: 0.02em; margin-right: 6px; }
  .badge-dot { width: 6px; height: 6px; border-radius: 50%; background: #10b981; box-shadow: 0 0 8px #10b981; animation: pulse 1.8s infinite; }

  /* ---- left sidebar ---- */
  #side { width: 272px; flex: none; background: var(--side); border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
  #side.collapsed { display: none; }
  .sidehdr { display: flex; align-items: center; gap: 8px; padding: 12px 10px 8px 14px; }
  /* The SMOL block logo, sized so all 39 columns fit beside the collapse button. */
  .brand { color: var(--accent); white-space: pre; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 7px; line-height: 1.15; }
  #openfolder { margin: 2px 10px 10px; text-align: left; }
  #wslist { flex: 1; overflow-y: auto; padding: 0 6px 10px; }
  .sidehint { color: var(--dim); font-size: 12px; padding: 8px 10px; }
  .ws { margin: 2px 0 10px; }
  .wshdr { display: flex; align-items: center; gap: 6px; padding: 4px 4px 4px 8px; border-radius: 4px; color: var(--dim); font-size: 12.5px; }
  .wshdr:hover { background: #141a1d; }
  .wsname { color: var(--fg); font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: none; max-width: 55%; }
  .wspath { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--gray); }
  .wshdr .iconbtn { visibility: hidden; padding: 0 5px; }
  .wshdr:hover .iconbtn { visibility: visible; }
  .sess { display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 12px; border-radius: 4px; cursor: pointer; color: var(--dim); font-size: 13px; }
  .sess:hover { background: #141a1d; color: var(--fg); }
  .sess.active { background: #17232a; color: #eef3f5; }
  .sess .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--gray); flex: none; }
  .sess.busy .dot, .sess.starting .dot { background: var(--accent); animation: pulse 1s infinite; }
  .sess.waiting .dot { background: var(--yellow); box-shadow: 0 0 6px var(--yellow); }
  .sess.error .dot { background: var(--red); }
  .sess.stored .dot { background: transparent; border: 1px solid var(--gray); }
  .sess.unread .stitle::after { content: " •"; color: var(--accent); }
  .stitle { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stitle.untitled { font-style: italic; }
  .stime { font-size: 11px; color: var(--gray); flex: none; }
  .sess .iconbtn { visibility: hidden; padding: 0 5px; }
  .sess:hover .iconbtn { visibility: visible; }
  .sidefoot { padding: 8px 14px; font-size: 11.5px; color: var(--gray); border-top: 1px solid var(--line); display: flex; gap: 10px; }

  /* ---- main column ---- */
  #main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
  #top { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-bottom: 1px solid var(--line); font-size: 12.5px; color: var(--dim); min-height: 40px; }
  #crumb { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 4px; }
  #crumb .ws { color: var(--fg); font-weight: 700; }
  #crumb .sep { margin: 0 6px; color: var(--gray); }
  #crumb .model { color: var(--gray); margin-left: 10px; }
  #logwrap { flex: 1; overflow-y: auto; overflow-x: hidden; min-height: 0; overflow-anchor: none; }
  #logs, #busywrap { max-width: 920px; margin: 0 auto; padding: 16px 16px 0; }
  #logs { overflow-wrap: anywhere; }
  #wslist, #fslist, .tabbody.term .out { overflow-x: hidden; }
  #busywrap { padding-bottom: 20px; }
  #welcome { max-width: 920px; margin: 0 auto; padding: 48px 16px; }
  #welcome p { color: var(--dim); max-width: 60ch; }
  #welcome .row { display: flex; gap: 10px; align-items: center; margin: 14px 0 22px; }
  #recent { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
  .wsbtn { background: transparent; border: 1px solid transparent; color: var(--fg); padding: 4px 8px; border-radius: 4px; cursor: pointer; text-align: left; }
  .wsbtn:hover { border-color: var(--line); background: #141a1d; }
  .wsbtn .dim { color: var(--gray); font-size: 12px; }
  #logo { color: var(--accent); white-space: pre; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 11px; line-height: 1.15; margin: 8px 0 12px; }
  #logo .coder { color: var(--dim); }

  .user {
    background: linear-gradient(135deg, rgba(2, 132, 199, 0.12) 0%, rgba(37, 99, 235, 0.08) 100%);
    border: 1px solid rgba(56, 189, 248, 0.25);
    border-left: 4px solid var(--accent);
    border-radius: var(--radius-md);
    padding: 12px 16px;
    margin: 18px 0 12px;
    font-weight: 500;
    white-space: pre-wrap;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  }
  .thought { color: var(--gray); margin-top: 6px; }
  .thought summary { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; list-style: none; background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: var(--radius-sm); transition: var(--transition); }
  .thought summary::-webkit-details-marker { display: none; }
  .thought summary::before { content: "›"; flex: none; font-size: 14px; font-weight: 700; color: var(--accent); }
  .thought[open] summary::before { content: "⌄"; }
  .thought summary:hover { color: var(--fg); background: rgba(255, 255, 255, 0.04); }
  .thought-preview { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12.5px; }
  .thought-expand, .thought-collapse { flex: none; color: var(--accent); font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .thought-collapse, .thought[open] .thought-expand { display: none; }
  .thought[open] .thought-collapse { display: inline; }
  .thought-body { color: var(--dim); white-space: pre-wrap; overflow-wrap: anywhere; border-left: 2px solid rgba(56, 189, 248, 0.4); padding: 10px 14px; margin: 6px 0 14px 6px; line-height: 1.7; background: rgba(0, 0, 0, 0.2); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }
  .md { white-space: normal; }
  .md p { margin: 8px 0; }
  .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 16px 0 8px; line-height: 1.3; color: #f0f6fc; font-weight: 700; }
  .md h1 { font-size: 1.35em; color: var(--accent); } .md h2 { font-size: 1.2em; } .md h3 { font-size: 1.08em; }
  .md h4, .md h5, .md h6 { font-size: 1em; }
  .md ul, .md ol { margin: 8px 0; padding-left: 22px; }
  .md li { margin: 3px 0; }
  .md strong { color: #f0f6fc; }
  .md code { background: rgba(245, 158, 11, 0.12); padding: 2px 6px; border-radius: 4px; color: #fcd34d; font-family: 'JetBrains Mono', monospace; font-size: 12.5px; }
  .md pre { background: #070a0e; border: 1px solid var(--line); border-radius: var(--radius-md); padding: 12px 14px; overflow-x: auto; margin: 10px 0; box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
  .md pre code { background: none; padding: 0; color: var(--fg); font-family: 'JetBrains Mono', monospace; }
  .md table { border-collapse: collapse; margin: 10px 0; display: block; overflow-x: auto; max-width: 100%; border-radius: var(--radius-sm); border: 1px solid var(--line); }
  .md th, .md td { border: 1px solid var(--line); padding: 6px 12px; text-align: left; }
  .md th { background: #131922; color: #f0f6fc; font-weight: 600; }
  .md blockquote { border-left: 3px solid var(--accent); margin: 10px 0; padding: 4px 14px; color: var(--dim); background: rgba(56, 189, 248, 0.04); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }
  .md hr { border: 0; border-top: 1px solid var(--line); margin: 16px 0; }
  .tool { color: var(--dim); margin-top: 6px; display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; background: rgba(255, 255, 255, 0.03); border: 1px solid var(--line); border-radius: var(--radius-sm); font-family: 'JetBrains Mono', monospace; font-size: 12px; }
  .tool .name { color: var(--accent); font-weight: 600; }
  .result { color: var(--dim); padding: 8px 14px; margin: 4px 0 10px; background: rgba(0, 0, 0, 0.25); border-left: 2px solid var(--line); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; font-family: 'JetBrains Mono', monospace; font-size: 12px; }
  .result.err { color: var(--red); border-left-color: var(--red); background: rgba(244, 63, 94, 0.06); }
  .plan { background: var(--card); border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: var(--radius-md); padding: 12px 16px; margin: 12px 0; box-shadow: 0 4px 16px rgba(0,0,0,0.2); }
  .plan .hdr { font-weight: 700; color: #f0f6fc; } .plan .hdr small { color: var(--dim); font-weight: 400; }
  .plan .done { color: var(--gray); text-decoration: line-through; }
  .plan .cur { color: var(--accent); font-weight: 700; }
  .plan .todo { color: var(--dim); }
  .turnend { color: var(--gray); margin: 10px 0 6px; font-size: 12px; }
  .line-status { color: var(--gray); white-space: pre-wrap; } .line-warn { color: var(--yellow); white-space: pre-wrap; } .line-error { color: var(--red); white-space: pre-wrap; }
  #busy { color: var(--dim); display: none; }
  #busy.on { display: block; }
  #busy .spin { display: inline-block; color: var(--accent); animation: pulse 1s infinite; font-size: 16px; }
  @keyframes pulse { 50% { opacity: .3; } }
  .ask { background: var(--card); border: 1px solid rgba(245, 158, 11, 0.3); border-left: 4px solid var(--yellow); border-radius: var(--radius-md); padding: 12px 16px; margin: 12px 0; box-shadow: 0 4px 20px rgba(0,0,0,0.25); }
  .ask .cmd { font-weight: 700; color: var(--yellow); }
  .ask button, .ask .opt { margin: 8px 8px 0 0; background: #1a222e; color: var(--fg); border: 1px solid var(--line); padding: 6px 14px; cursor: pointer; font: inherit; border-radius: var(--radius-sm); transition: var(--transition); }
  .ask button:hover, .ask .opt:hover { border-color: var(--accent); background: rgba(56, 189, 248, 0.1); color: var(--accent); }
  .ask .opt.current { border-color: var(--green); color: var(--green); }
  .ask .askinput { margin-top: 8px; width: min(420px, 100%); box-sizing: border-box; background: #0e131a; color: var(--fg); border: 1px solid var(--line); padding: 8px 10px; font: inherit; border-radius: var(--radius-sm); outline: none; }
  .ask .askinput:focus { border-color: var(--accent); }
  .ask .opt .hint { color: var(--dim); font-size: 12px; margin-left: 8px; }
  .ask > .hint { color: var(--dim); font-size: 12px; margin-top: 4px; }

  #bottom { flex: none; padding: 10px 16px 16px; background: transparent; }
  #bottom .inner { max-width: 920px; margin: 0 auto; position: relative; }
  #jumpbottom { position: absolute; bottom: calc(100% + 10px); left: 50%; transform: translateX(-50%); z-index: 4; border-radius: 20px; padding: 7px 16px; white-space: nowrap; box-shadow: 0 6px 24px rgba(0,0,0,0.5); font-size: 12px; background: rgba(19, 25, 34, 0.95); backdrop-filter: blur(10px); border: 1px solid var(--line); }
  #menu { position: absolute; bottom: 100%; left: 0; right: 0; background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-md) var(--radius-md) 0 0; display: none; z-index: 5; box-shadow: 0 -8px 24px rgba(0,0,0,0.4); overflow: hidden; }
  #menu .item { padding: 6px 12px; cursor: pointer; transition: var(--transition); }
  #menu .item .nm { font-weight: 700; color: var(--accent); } #menu .item .ds { color: var(--dim); margin-left: 10px; }
  #menu .item.sel { background: rgba(56, 189, 248, 0.15); color: #ffffff; }
  #menu .item.sel .ds { color: #bae6fd; }
  #inputbox { border: 1px solid var(--line); border-left: 4px solid var(--accent); background: var(--card); border-radius: var(--radius-lg); padding: 10px 14px; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35); backdrop-filter: blur(12px); transition: var(--transition); }
  #inputbox:focus-within { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-glow), 0 8px 32px rgba(2, 132, 199, 0.25); }
  .inputrow { display: flex; align-items: flex-end; gap: 10px; }
  #input { flex: 1; background: transparent; border: 0; outline: 0; color: var(--fg); font: inherit; resize: none; min-height: 44px; max-height: 38vh; overflow-y: auto; }
  #actionbtn { flex: none; background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%); color: #ffffff; border: 0; padding: 6px 16px; cursor: pointer; font: inherit; font-size: 12.5px; font-weight: 600; border-radius: var(--radius-sm); transition: var(--transition); box-shadow: 0 2px 8px rgba(2, 132, 199, 0.3); }
  #actionbtn:hover { box-shadow: 0 4px 14px rgba(2, 132, 199, 0.5); transform: translateY(-1px); }
  #actionbtn.stop { background: var(--red); color: #fff; box-shadow: 0 2px 8px rgba(244, 63, 94, 0.3); }
  #actionbtn.stop:hover { box-shadow: 0 4px 14px rgba(244, 63, 94, 0.5); }
  #status { margin-top: 8px; font-size: 12px; color: var(--dim); display: flex; gap: 10px; align-items: center; }
  #status .mode { font-weight: 700; padding: 2px 6px; border-radius: 4px; }
  #status .mode.edit { color: var(--accent); background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.2); }
  #status .mode.bypass { color: var(--red); background: rgba(244, 63, 94, 0.1); border: 1px solid rgba(244, 63, 94, 0.2); }
  #status .mode.ro { color: var(--magenta); background: rgba(168, 85, 247, 0.1); border: 1px solid rgba(168, 85, 247, 0.2); }
  #status .eff { color: var(--yellow); } #status .plan-chip { color: var(--accent); } #status .plan-chip.done { color: var(--green); }
  #status .files-chip.active { color: var(--yellow); }
  .validation-rail { display: inline-flex; align-items: center; gap: 5px; min-height: 20px; padding: 1px 7px 1px 5px; border-left: 3px solid var(--accent); border-radius: 2px; font-size: 11px; white-space: nowrap; }
  .validation-rail.ok { color: var(--green); border-left-color: var(--green); background: rgba(16,185,129,.08); }
  .validation-rail.bad { color: var(--red); border-left-color: var(--red); background: rgba(244,63,94,.08); }
  .validation-rail.pending { color: var(--yellow); border-left-color: var(--yellow); background: rgba(245,158,11,.08); }
  .validation-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }
  .validation-rail.pending .validation-dot { animation: pulse 1s infinite; }
  #hintrow { font-size: 12px; color: var(--gray); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ---- right panel: browser + terminal tabs ---- */
  #panel { flex: none; width: 520px; min-width: 300px; max-width: 80vw; border-left: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; position: relative; background: var(--side); }
  #panel[hidden] { display: none; }
  #panelgrip { position: absolute; left: -3px; top: 0; bottom: 0; width: 7px; cursor: col-resize; z-index: 6; }
  #panelgrip:hover, body.dragging #panelgrip { background: var(--sel); }
  body.dragging { cursor: col-resize; user-select: none; }
  body.dragging iframe { pointer-events: none; }
  #paneltabs { display: flex; align-items: center; gap: 2px; padding: 5px 6px; border-bottom: 1px solid var(--line); overflow-x: auto; flex: none; min-height: 40px; }
  .ptab { display: flex; align-items: center; gap: 6px; padding: 3px 6px 3px 8px; border-radius: 4px; color: var(--dim); cursor: pointer; font-size: 12px; white-space: nowrap; max-width: 210px; border: 1px solid transparent; }
  .ptab:hover { color: var(--fg); background: #141a1d; }
  .ptab.on { color: #eef3f5; background: #17232a; border-color: var(--line); }
  .ptab .ico { color: var(--accent); font-size: 11px; }
  .ptab .lbl { overflow: hidden; text-overflow: ellipsis; }
  .ptab .x { color: var(--gray); padding: 0 2px; }
  .ptab .x:hover { color: var(--red); }
  #panelviews { flex: 1; min-height: 0; display: flex; }
  .panelview { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
  .panelview[hidden] { display: none; }
  .tabbody { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .tabbody[hidden] { display: none; }
  .tabbody.browser .bar { display: flex; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--line); align-items: center; flex: none; }
  .tabbody.browser .bar input { flex: 1; min-width: 0; background: var(--box); border: 1px solid var(--line); color: var(--fg); font: inherit; font-size: 12.5px; padding: 3px 8px; border-radius: 4px; outline: 0; }
  .tabbody.browser .bar input:focus { border-color: var(--accent); }
  .preview-status { flex: none; color: var(--dim); font-size: 11px; white-space: nowrap; }
  .preview-status.loading { color: var(--accent); }
  .preview-status.ok { color: var(--ok); }
  .preview-status.error, .preview-status.blocked { color: var(--warn); }
  .tabbody.browser iframe { flex: 1; border: 0; background: #fff; width: 100%; min-height: 0; }
  .tabbody.browser iframe[hidden] { display: none; }
  .tabbody.browser .empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--dim); text-align: center; padding: 20px; gap: 8px; font-size: 13px; }
  .tabbody.browser .empty[hidden] { display: none; }
  .tabbody.browser .empty .urls { display: flex; flex-direction: column; gap: 4px; }
  .tabbody.term { background: #0a0c0d; }
  .tabbody.term .out { flex: 1; overflow-y: auto; margin: 0; padding: 10px 12px; white-space: pre-wrap; word-break: break-word; font-size: 12.5px; line-height: 1.4; font-family: inherit; }
  .tabbody.term .out .l { min-height: 1.4em; }
  .tabbody.term .trow { display: flex; gap: 8px; padding: 6px 12px 8px; border-top: 1px solid var(--line); align-items: baseline; flex: none; }
  .tabbody.term .prompt { color: var(--accent); white-space: nowrap; max-width: 45%; overflow: hidden; text-overflow: ellipsis; font-size: 12.5px; }
  .tabbody.term input { flex: 1; min-width: 0; background: transparent; border: 0; outline: 0; color: var(--fg); font: inherit; font-size: 12.5px; }
  .filesplit { flex: 1; min-height: 0; display: flex; }
  .tabbody.files .bar input { min-width: 0; background: var(--box); border: 1px solid var(--line); color: var(--fg); font: inherit; font-size: 12px; padding: 4px 7px; border-radius: 4px; }
  .tabbody.files .bar input:first-of-type { flex: 1; }
  .tabbody.files .bar input[aria-label] { flex: 1.2; }
  .filesearch-results { max-height: 180px; overflow: auto; border-bottom: 1px solid var(--line); padding: 4px 6px; }
  .filesearch-result { display: block; width: 100%; text-align: left; border: 0; background: transparent; color: var(--fg); padding: 4px 6px; cursor: pointer; font: inherit; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .filesearch-result:hover { background: rgba(255,255,255,.08); }
  .filesearch-note { padding: 5px 6px; color: var(--dim); font-size: 11px; }
  .filefindbar { display: flex; flex: none; align-items: center; gap: 5px; flex-wrap: wrap; padding: 6px; border-bottom: 1px solid var(--line); background: #12171a; }
  .filefindbar[hidden] { display: none; }
  .filefindbar input { min-width: 90px; flex: 1; background: var(--box); border: 1px solid var(--line); color: var(--fg); font: inherit; font-size: 12px; padding: 5px 7px; border-radius: 4px; }
  .filefindbar button { min-height: 28px; padding: 4px 8px; }
  .filefind-count { min-width: 92px; color: var(--dim); font-size: 11px; }
  .filetree { width: 38%; min-width: 150px; overflow: auto; border-right: 1px solid var(--line); padding: 6px; }
  .treerow { display: flex; align-items: center; min-width: 0; }
  .treetoggle { border: 0; background: transparent; color: var(--dim); cursor: pointer; font: inherit; font-size: 9px; width: 18px; flex: none; padding: 2px 0; }
  .treetoggle:hover { color: var(--fg); }
  .treespacer { width: 18px; flex: none; }
  .treerow .fileitem { flex: 1; min-width: 0; }
  .treesub { min-width: 0; }
  .fileitem { display: flex; align-items: center; width: 100%; text-align: left; border: 0; background: transparent; color: var(--fg); padding: 4px 7px; border-radius: 3px; cursor: pointer; font: inherit; font-size: 12px; white-space: nowrap; overflow: hidden; }
    .fileitem:hover { background: rgba(255,255,255,.06); }
    .fileitem-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 16px; padding: 0 4px; font-size: 9.5px; font-weight: 700; font-family: Consolas, monospace; border-radius: 3px; margin-right: 6px; flex-shrink: 0; line-height: 1; }
    .fileitem-icon { display: inline-flex; align-items: center; justify-content: center; width: 20px; font-size: 13px; margin-right: 6px; flex-shrink: 0; }
    .fileitem-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; text-align: left; }
    /* old */ .fileitem-old { display: flex; align-items: center; width: 100%; text-align: left; border: 0; background: transparent; color: var(--fg); padding: 4px 7px; border-radius: 3px; cursor: pointer; font: inherit; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fileitem-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; text-align: left; }
  .fileitem:hover { background: rgba(255,255,255,.06); }
  .fileitem.folder { color: var(--accent); }
  .fileitem.parent { color: var(--dim); border-bottom: 1px solid var(--line); margin-bottom: 4px; }
  .fileeditor-wrap { position: relative; flex: 1; min-width: 0; min-height: 0; overflow: hidden; background: #0f1417; }
  .filediagnostics { flex: none; max-height: 130px; overflow: auto; background: #101416; border-top: 1px solid var(--line); }
  .filediagnostic, .filediagnostic-note { display: block; width: 100%; padding: 5px 8px; border: 0; border-bottom: 1px solid var(--line); text-align: left; color: var(--fg); background: transparent; font: inherit; font-size: 11px; }
  .filediagnostic { cursor: pointer; }
  .filediagnostic:hover { background: rgba(255,255,255,.08); }
  .filediagnostic.error { box-shadow: inset 3px 0 var(--red); }
  .filediagnostic.warning { box-shadow: inset 3px 0 #c99a34; }
  .filediagnostic-note { color: var(--dim); }
  .filediagnostic-note.error { color: var(--red); }
  .reviewlist { flex: 1; min-height: 0; overflow: auto; padding: 6px 8px; }
  .reviewfile { display: flex; gap: 6px; align-items: center; font-weight: 700; font-size: 12px; margin: 10px 0 4px; color: var(--fg); }
  .reviewfile .iconbtn { font-size: 11px; padding: 2px 8px; }
  .tabbody.review .bar input, .tabbody.review .bar select { min-width: 0; background: var(--box); border: 1px solid var(--line); color: var(--fg); font: inherit; font-size: 12px; padding: 4px 7px; border-radius: 4px; }
  .tabbody.review .bar input { flex: 1; }
  .gutter { display: inline-block; width: 34px; flex: none; text-align: right; margin-right: 8px; color: var(--dim); opacity: .7; user-select: none; }
  .reviewhunk { border: 1px solid var(--line); border-radius: 6px; margin: 0 0 8px; overflow: hidden; }
  .reviewpatch { margin: 0; padding: 6px 8px; font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; background: #0c1013; max-height: 220px; overflow: auto; }
  .reviewactions { display: flex; gap: 6px; padding: 6px 8px; border-top: 1px solid var(--line); background: #101416; }
  .sharebanner { padding: 8px 14px; background: #1c2b1f; border-bottom: 1px solid #2f5b38; color: #c9f0d4; font-size: 12.5px; }
  pre.diff { margin: 6px 0; padding: 6px 8px; background: #0c1013; border: 1px solid var(--line); border-radius: 6px; font-size: 11.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  pre.diff span, .reviewpatch span { display: block; padding: 0 4px; }
  pre.diff span.add, .reviewpatch span.add { color: #7ee787; background: rgba(63,185,80,.13); }
  pre.diff span.del, .reviewpatch span.del { color: #ffa198; background: rgba(248,81,73,.13); }
  pre.diff span.same, .reviewpatch span.same { color: var(--dim); }
  pre.diff span.hunk, .reviewpatch span.hunk { color: #79c0ff; }
  .planlist { flex: 1; min-height: 0; overflow: auto; padding: 6px 8px; }
  .planstep { display: flex; gap: 8px; align-items: flex-start; width: 100%; text-align: left; border: 0; background: transparent; color: var(--fg); font: inherit; font-size: 12px; padding: 6px 8px; border-bottom: 1px solid var(--line); cursor: pointer; }
  .planstep:hover { background: rgba(255,255,255,.06); }
  .planstep .box { flex: none; width: 15px; }
  .planstep.done { color: var(--dim); text-decoration: line-through; }
  .planstep.current { box-shadow: inset 3px 0 var(--accent); }
  .sq-err { text-decoration: underline wavy #f14c4c 1px; text-decoration-skip-ink: none; }
  .sq-warn { text-decoration: underline wavy #cca700 1px; text-decoration-skip-ink: none; }
  div.filediagnostic { display: flex; gap: 6px; align-items: center; }
  .filediagnostic-go { flex: 1; min-width: 0; border: 0; background: transparent; color: inherit; font: inherit; font-size: 11px; text-align: left; cursor: pointer; padding: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fileinlinebar { display: flex; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  .fileinlinebar[hidden] { display: none; }
  .fileinlinebar input { flex: 1; min-width: 0; background: var(--box); border: 1px solid var(--line); color: var(--fg); font: inherit; font-size: 12px; padding: 4px 7px; border-radius: 4px; }
  .fileinlinepreview { border-bottom: 1px solid var(--line); padding: 6px 8px; }
  .fileinlinepreview[hidden] { display: none; }
  .completepop { display: block; position: absolute; z-index: 6; left: 12px; top: 44px; min-width: 260px; max-width: 70%; max-height: 220px; overflow: auto; background: #202629; border: 1px solid var(--accent); box-shadow: 0 8px 24px #0008; }
  .completepop[hidden] { display: none; }
  .completeitem { display: flex; gap: 8px; width: 100%; text-align: left; background: transparent; border: 0; border-bottom: 1px solid var(--line); color: var(--fg); padding: 5px 10px; cursor: pointer; font: inherit; font-size: 12px; }
  .completeitem:hover, .completeitem.sel { background: #094771; }
  .completeitem .kind { color: var(--dim); }
  .planchip { border: 1px solid var(--line); background: var(--box); color: var(--fg); border-radius: 20px; font: inherit; font-size: 11px; padding: 2px 10px; cursor: pointer; margin-left: 8px; white-space: nowrap; }
  .planchip:hover { border-color: var(--accent); }
  .filetabs { position: absolute; z-index: 2; inset: 0 0 auto; height: 35px; display: flex; overflow-x: auto; background: #171c1f; border-bottom: 1px solid var(--line); }
  .filetab { display: flex; align-items: center; flex: none; max-width: 220px; background: #202629; border-right: 1px solid var(--line); }
  .filetab.active { background: #0f1417; border-top: 1px solid var(--accent); }
  .filetab-label, .filetab-close { border: 0; background: transparent; color: var(--fg); cursor: pointer; font: inherit; font-size: 11px; min-height: 32px; }
  .filetab-label { max-width: 175px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 4px 8px; }
  .filetab-close { color: var(--dim); padding: 4px 7px; }
  .filetab-close:hover { background: rgba(255,255,255,.1); }
  .filecode, .fileeditor { position: absolute; inset: 35px 0 0; height: calc(100% - 35px); margin: 0; padding: 10px 12px; font: 12.5px/1.5 Consolas, monospace; tab-size: 2; white-space: pre-wrap; overflow: auto; word-wrap: break-word; }
  .filecode { pointer-events: none; color: var(--fg); }
  .fileeditor { resize: none; border: 0; outline: 0; background: transparent; color: transparent; caret-color: #fff; }
  .fileeditor:focus { outline: 1px solid var(--accent); outline-offset: -1px; }
  .filemeta { flex: none; min-height: 26px; padding: 6px 9px; border-top: 1px solid var(--line); color: var(--dim); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .filemeta.error { color: var(--red); }
  .tok-key { color: #c586c0; } .tok-str { color: #ce9178; } .tok-num { color: #b5cea8; }
  .tok-com { color: #6a9955; } .tok-lit { color: #569cd6; }
  .tok-k { color: #c586c0; } .tok-s { color: #ce9178; } .tok-n { color: #b5cea8; } .tok-c { color: #6a9955; } .tok-f { color: #dcdcaa; } .tok-o { color: #d4d4d4; } .tok-tag { color: #4ec9b0; } .tok-t { color: #4ec9b0; } .tok-d { color: #e5c07b; }
  .ab { font-weight: 700; } .ad { opacity: .6; }
  .a30 { color: #3b4048; } .a31 { color: var(--red); } .a32 { color: var(--green); } .a33 { color: var(--yellow); }
  .a34 { color: #7aa2f7; } .a35 { color: var(--magenta); } .a36 { color: var(--accent); } .a37 { color: #c0caf5; }
  .a90 { color: var(--gray); } .a91 { color: #ff9e9e; } .a92 { color: #b9f27c; } .a93 { color: #ffd580; }
  .a94 { color: #8db4ff; } .a95 { color: #d0b4ff; } .a96 { color: #74e0f0; } .a97 { color: #eef3f5; }

  /* Narrow windows: the sidebar floats over the chat instead of squeezing it,
     and the panel cannot take more than half the width. */
  @media (max-width: 1000px) {
    #side { position: absolute; left: 0; top: 0; bottom: 0; z-index: 20; box-shadow: 8px 0 30px rgba(0,0,0,.5); }
    #main { padding-left: 0; }
    #sidetoggle { display: inline-flex; }
    #panel { max-width: 55vw; }
  }

  /* ---- folder picker ---- */
  #modal { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 50; }
  #modal[hidden] { display: none; }
  .dlg { width: min(680px, 92vw); max-height: 82vh; background: var(--box); border: 1px solid var(--line); border-radius: 6px; display: flex; flex-direction: column; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
  .dlghdr { display: flex; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line); font-weight: 700; gap: 8px; }
  .pathrow { display: flex; gap: 6px; padding: 10px 14px 6px; }
  .pathrow input { flex: 1; background: var(--bg); border: 1px solid var(--line); color: var(--fg); font: inherit; font-size: 13px; padding: 4px 8px; border-radius: 4px; outline: 0; }
  .pathrow input:focus { border-color: var(--accent); }
  #fsroots { padding: 2px 14px 8px; display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { background: #1a2023; border: 1px solid var(--line); color: var(--dim); border-radius: 12px; padding: 1px 10px; font-size: 12px; cursor: pointer; }
  .chip:hover { color: var(--fg); border-color: var(--accent); }
  #fslist { flex: 1; overflow-y: auto; padding: 0 8px 8px; min-height: 240px; }
  .fsitem { padding: 4px 8px; border-radius: 4px; cursor: pointer; display: flex; gap: 10px; align-items: baseline; }
  .fsitem:hover { background: #1a2023; }
  .fsitem .proj { color: var(--accent); font-size: 11px; }
  .fsitem.up { color: var(--dim); }
  .dlgfoot { display: flex; align-items: center; gap: 14px; padding: 10px 14px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--dim); }
  .dlgfoot label { display: flex; align-items: center; gap: 6px; cursor: pointer; }

  /* The working surface: quieter navigation and a single compact control row. */
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  #side { width: 248px; }
  .sidehdr { padding: 22px 18px 18px; }

  #openfolder { margin: 0 14px 20px; padding: 8px 10px; background: transparent; }
  .wshdr { padding: 8px; }
  .wsname { max-width: 78%; font-weight: 600; }
  .sess { padding: 8px 8px 8px 12px; border-radius: 6px; }
  .sess.active { background: #20292d; }
  .stitle.untitled { font-style: normal; }
  .stime { display: none; }
  .sess:hover .stime { display: inline; }
  .sidefoot { align-items: center; padding: 12px 18px; }
  #top { min-height: 60px; padding: 12px 20px; }
  #crumb .ws { font-weight: 500; color: var(--dim); }
  #crumb .title { color: var(--fg); font-weight: 600; }
  #logs, #busywrap { max-width: 860px; padding-left: 32px; padding-right: 32px; }
  #welcome { max-width: 660px; padding-top: clamp(48px, 16vh, 180px); }
  #welcome h1 { font-size: clamp(26px, 3vw, 38px); letter-spacing: -1.2px; font-weight: 500; margin: 16px 0 24px; }
  .primary { padding: 9px 18px; border-radius: 7px; }
  .recent-label { font-size: 12px; margin-top: 30px; margin-bottom: 6px; color: var(--gray); }
  .wsbtn { width: 100%; padding: 9px 0; }
  .wsbtn .dim { float: right; }
  /* A fresh session opens on the logo until the first message arrives. */
  .log:empty::before { content: "${LOGO_CSS}"; display: block; margin-top: 14vh; color: var(--accent); white-space: pre; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 11px; line-height: 1.15; }
  .log:empty::after { content: "What are we building?"; display: block; margin-top: 18px; color: var(--dim); font-size: 26px; letter-spacing: -.7px; }
  .user { border: 1px solid var(--line); border-radius: 10px; background: #1b2125; padding: 14px 18px; margin: 24px 0; font-weight: 400; }
  .md { line-height: 1.8; }
  .md p { margin: 12px 0; }
  .md code, .md pre, .tool, .tabbody.term, .plan { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12.5px; }
  .tool { margin: 3px 0; border-radius: 5px; }
  .tool summary { cursor: pointer; display: flex; align-items: baseline; gap: 10px; padding: 4px 0; list-style: none; }
  .tool summary::before { content: "›"; color: var(--gray); }
  .tool[open] summary::before { content: "⌄"; }
  .tool .name { color: var(--dim); font-weight: 400; white-space: nowrap; }
  .tool .tool-args { white-space: nowrap; text-overflow: ellipsis; overflow: hidden; color: var(--gray); }
  .tool.finished .name { color: #b9c6c7; }
  .tool.failed .name, .tool.failed summary::before { color: var(--red); }
  .result { margin: 4px 0 12px 16px; border: 1px solid var(--line); border-radius: 6px; background: #0e1214; padding: 12px; max-height: 280px; overflow: auto; white-space: pre-wrap; }
  .plan { border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; background: transparent; line-height: 1.9; }
  .thought, .turnend { font-size: 12px; }
  .turnend { margin-top: 20px; margin-bottom: 20px; }
  #bottom { padding: 16px 32px 24px; }
  #bottom .inner { max-width: 796px; }
  #inputbox { border: 1px solid #354149; border-radius: 12px; padding: 14px 16px 10px; background: #1b2125; box-shadow: 0 8px 30px #0002; }
  #inputbox:focus-within { border-color: #55737b; }
  #input { min-height: 50px; line-height: 1.6; }
  #input::placeholder { color: var(--gray); }
  #actionbtn { border-radius: 6px; padding: 5px 12px; color: var(--fg); }
  #status { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 11px; margin-top: 12px; }
  .statusbtn { background: transparent; color: var(--dim); border: 0; border-radius: 4px; cursor: pointer; padding: 3px 4px; font: inherit; }
  .statusbtn:hover { background: #293138; color: var(--fg); }
  .modelpick { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #status .mode { font-weight: 500; }
  #status .eff { color: var(--dim); }
  .context-chip { display: flex; align-items: center; gap: 6px; }
  .context-chip.pressure { color: var(--yellow); }
  meter { width: 35px; height: 8px; appearance: none; border: none; background: #364047; border-radius: 9px; overflow: hidden; }
  meter::-webkit-meter-bar { background: #364047; border: none; }
  meter::-webkit-meter-optimum-value { background: #7dabad; }
  meter::-moz-meter-bar { background: #7dabad; }
  .task-chip, .plan-chip { white-space: nowrap; }
  #busywrap { padding-top: 8px; }
  #busy { font-size: 12px; }
  #panel { background: #101416; }
  .shortcut-list { line-height: 2; padding: 16px 24px; }

  /* Attachments: chips in the composer; thumbnails and file links in a sent message. */
  #attachrow { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .attach { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 4px 6px 4px 8px; background: #141a1d; font-size: 12px; color: var(--fg); }
  .attach.uploading { opacity: .7; }
  .attach.warn { border-color: var(--yellow); }
  .attach-thumb { width: 28px; height: 28px; object-fit: cover; border-radius: 4px; }
  .attach-name { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attach .note { color: var(--yellow); }
  .attach-x { background: transparent; border: 0; color: var(--dim); cursor: pointer; font: inherit; font-size: 15px; padding: 0 2px; line-height: 1; }
  .attach-x:hover { color: var(--red); }
  #attachbtn { flex: none; padding: 5px 7px; }
  #main.dragging #inputbox { border-color: var(--accent); box-shadow: 0 0 0 3px #35bfd433; }
  .user .files { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .user .thumb { display: block; max-width: min(320px, 100%); max-height: 240px; border-radius: 8px; border: 1px solid var(--line); }
  .user .filechip { display: inline-block; border: 1px solid var(--line); border-radius: 8px; padding: 4px 10px; font-size: 12px; color: var(--fg); text-decoration: none; background: #141a1d; }
  .user .filechip:hover { border-color: var(--accent); }
  @media (max-width: 600px) {
    #top { min-height: 48px; padding: 8px 12px; }
    #logs, #busywrap { padding-left: 16px; padding-right: 16px; }
    #bottom { padding: 12px; }
    #welcome { padding: 48px 24px; }
    #panel { position: absolute; inset: 48px 0 0; width: 100% !important; max-width: 100%; z-index: 15; }
    .modelpick { max-width: 150px; }
    .wshdr .iconbtn, .sess .iconbtn { visibility: visible; }
    #input { min-height: 44px; }
    #status { gap: 6px 8px; }
    .md { line-height: 1.7; }
    .md table { font-size: 12.5px; }
  }

  /* Suivi de tâches : liste à cases + progression fine. */
  .plan { scroll-margin-top: 8px; }
  .plan > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px; }
  .plan > summary::-webkit-details-marker { display: none; }
  .plan > summary::before { content: "›"; color: var(--accent); font-size: 16px; font-weight: 700; }
  .plan[open] > summary::before { content: "⌄"; }
  .plan-toggle { margin-left: auto; color: var(--dim); font-size: 10px; text-transform: uppercase; }
  .plan[open] .plan-toggle { color: var(--accent); }
  .planbar { height: 3px; background: var(--line); border-radius: 2px; overflow: hidden; margin: 6px 0 8px; }
  .planbar span { display: block; height: 100%; background: var(--accent); border-radius: 2px; }
  .pdone { color: var(--gray); text-decoration: line-through; }
  .pcur { color: var(--accent); font-weight: 600; }
  .ptodo { color: var(--dim); }

  /* ---- Centre de contrôle : statut, sous-agents, skills, outils, MCP, options ---- */
  #cc { position: fixed; inset: 0; background: rgba(0,0,0,.65); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; z-index: 999; }
  .dlg.cc { width: min(960px, 94vw); max-height: 86vh; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); background: rgba(19, 25, 34, 0.95); box-shadow: 0 16px 48px rgba(0,0,0,0.6); }
  .cc-hdr { display: inline-flex; align-items: center; gap: 8px; }
  .cc-tabs { display: flex; gap: 4px; padding: 6px 10px 0; border-bottom: 1px solid var(--line); overflow-x: auto; }
  .cc-tab { background: transparent; border: 1px solid transparent; border-bottom: 0; color: var(--dim); border-radius: 6px 6px 0 0; padding: 6px 12px; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
  .cc-tab:hover { color: var(--fg); background: #161c1f; }
  .cc-tab.on { color: var(--accent); background: #13202a; border-color: var(--line); }
  .cc-tab .n { color: var(--gray); font-size: 11px; }
  .cc-body { padding: 14px 16px 18px; overflow-y: auto; }
  .cc-sec { margin: 0 0 16px; }
  .cc-sec > h3 { margin: 0 0 8px; font-size: 12.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--gray); font-weight: 600; }
  .cc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); gap: 10px; }
  .cc-card { background: #12171a; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .cc-card h4 { margin: 0 0 4px; font-size: 13px; color: var(--fg); display: flex; align-items: center; gap: 6px; }
  .cc-card p { margin: 0; color: var(--dim); font-size: 12px; line-height: 1.55; }
  .cc-kv { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12.5px; color: var(--dim); }
  .cc-kv b { color: var(--fg); font-weight: 600; }
  .cc-lights { display: flex; flex-wrap: wrap; gap: 8px; }
  .cc-light { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border: 1px solid var(--line); border-radius: 999px; font-size: 12px; background: #141a1d; }
  .cc-light .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--gray); }
  .cc-light.ok .dot { background: var(--green); box-shadow: 0 0 6px rgba(16,185,129,.8); animation: breathe 2.4s ease-in-out infinite; }
  .cc-light.bad .dot { background: var(--red); box-shadow: 0 0 6px rgba(244,63,94,.8); }
  .cc-light.bad { color: #ffd9d9; }
  .cc-role { display: flex; flex-direction: column; gap: 8px; }
  .cc-role .row { display: flex; gap: 6px; }
  .cc-role input { flex: 1; min-width: 0; background: #0f1417; border: 1px solid var(--line); border-radius: 4px; color: var(--fg); padding: 5px 8px; font: inherit; font-size: 12.5px; }
  .cc-role input:focus { outline: 1px solid var(--accent); }
  .cc-tag { font-size: 11px; color: var(--gray); border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; }
  .cc-act { background: transparent; border: 1px solid var(--line); color: var(--dim); border-radius: 4px; padding: 3px 9px; cursor: pointer; font-size: 12px; }
  .cc-act:hover { color: var(--fg); border-color: var(--accent); }
  .cc-list { display: flex; flex-direction: column; gap: 6px; }
  .cc-item { display: flex; align-items: baseline; gap: 8px; padding: 6px 9px; border: 1px solid var(--line); border-radius: 6px; background: #12171a; }
  .cc-item .nm { color: var(--fg); font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }
  .cc-item .ds { color: var(--gray); font-size: 12px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cc-item.on { border-color: #1f5d68; background: #13202a; }
  .cc-empty { color: var(--gray); font-size: 12.5px; }
  .skel { height: 12px; border-radius: 6px; background: linear-gradient(90deg, #171d20 25%, #202a2f 37%, #171d20 63%); background-size: 400% 100%; animation: shimmer 1.4s ease-in-out infinite; }
  .skel + .skel { margin-top: 8px; }
  .skel.w60 { width: 60%; }
  .skel.w40 { width: 40%; }

  /* ============================================================ */
  /* UPGRADE PRO : ANIMATIONS, SPINNERS, LEDS, GLASS, TOASTS      */
  /* ============================================================ */

  /* Glassmorphism amélioré */
  .glass-panel {
    background: rgba(19, 25, 34, 0.75) !important;
    backdrop-filter: blur(16px) saturate(180%) !important;
    -webkit-backdrop-filter: blur(16px) saturate(180%) !important;
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.36) !important;
  }
  #top {
    background: rgba(13, 18, 24, 0.88);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  }
  #side {
    background: rgba(8, 12, 16, 0.95);
    backdrop-filter: blur(16px);
  }

  /* Micro-animations sur les boutons */
  button, .iconbtn, .primary, .ghost, .wsbtn, .statusbtn, .chip, .cc-tab, .cc-act {
    position: relative;
    transition: transform 0.15s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s ease, background 0.2s ease, border-color 0.2s ease;
  }
  button:hover:not(:disabled), .iconbtn:hover, .primary:hover, .ghost:hover, .wsbtn:hover, .statusbtn:hover, .chip:hover {
    transform: translateY(-1px);
  }
  button:active:not(:disabled), .iconbtn:active, .primary:active, .ghost:active {
    transform: translateY(0.5px);
  }

  /* Barre de progression fluide de connexion et génération */
  .conn-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2.5px;
    z-index: 100;
    background: transparent;
    overflow: hidden;
  }
  .conn-bar.active {
    background: rgba(56, 189, 248, 0.12);
  }
  .conn-bar.active::after {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    width: 40%;
    background: linear-gradient(90deg, transparent, #38bdf8, #a855f7, transparent);
    animation: connSweep 1.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  }
  @keyframes connSweep {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(350%); }
  }

  /* Animations d'entrée fluides pour les messages */
  .msgwrap, .user, .plan, .turnend, .tool {
    animation: messageIn 0.22s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @keyframes messageIn {
    from {
      opacity: 0;
      transform: translateY(6px) scale(0.995);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  /* Indicateurs de statut lumineux (LED) */
  .led {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    flex: none;
    position: relative;
    transition: all 0.3s ease;
  }
  .led::after {
    content: "";
    position: absolute;
    inset: -2px;
    border-radius: 50%;
    background: inherit;
    opacity: 0.4;
    animation: ledPulse 2s ease-in-out infinite;
  }
  .led.green {
    background: #10b981;
    box-shadow: 0 0 8px #10b981, 0 0 16px rgba(16, 185, 129, 0.4);
  }
  .led.blue {
    background: #38bdf8;
    box-shadow: 0 0 8px #38bdf8, 0 0 16px rgba(56, 189, 248, 0.4);
  }
  .led.yellow {
    background: #f59e0b;
    box-shadow: 0 0 8px #f59e0b, 0 0 16px rgba(245, 158, 11, 0.4);
  }
  .led.red {
    background: #f43f5e;
    box-shadow: 0 0 8px #f43f5e, 0 0 16px rgba(244, 63, 94, 0.4);
  }
  .led.purple {
    background: #a855f7;
    box-shadow: 0 0 8px #a855f7, 0 0 16px rgba(168, 85, 247, 0.4);
  }
  @keyframes ledPulse {
    0%, 100% { transform: scale(1); opacity: 0.4; }
    50% { transform: scale(1.6); opacity: 0; }
  }

  /* Spinner Avancé Multi-Orbites Pro */
  .spinner-pro {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .pro-orbits {
    position: relative;
    width: 20px;
    height: 20px;
    flex: none;
  }
  .pro-orbits span {
    position: absolute;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    border-radius: 50%;
  }
  .pro-orbits span:nth-child(1) {
    border-top: 2px solid #38bdf8;
    border-right: 2px solid transparent;
    border-bottom: 2px solid transparent;
    border-left: 2px solid transparent;
    animation: orbitRotate1 1.2s cubic-bezier(0.5, 0, 0.5, 1) infinite;
  }
  .pro-orbits span:nth-child(2) {
    border-top: 2px solid transparent;
    border-right: 2px solid #a855f7;
    border-bottom: 2px solid transparent;
    border-left: 2px solid transparent;
    animation: orbitRotate2 1.2s cubic-bezier(0.5, 0, 0.5, 1) infinite;
    animation-delay: -0.4s;
  }
  .pro-orbits span:nth-child(3) {
    border-top: 2px solid transparent;
    border-right: 2px solid transparent;
    border-bottom: 2px solid #10b981;
    border-left: 2px solid transparent;
    animation: orbitRotate3 1.2s cubic-bezier(0.5, 0, 0.5, 1) infinite;
    animation-delay: -0.8s;
  }
  @keyframes orbitRotate1 { 0% { transform: rotateX(35deg) rotateY(-45deg) rotateZ(0deg); } 100% { transform: rotateX(35deg) rotateY(-45deg) rotateZ(360deg); } }
  @keyframes orbitRotate2 { 0% { transform: rotateX(50deg) rotateY(10deg) rotateZ(0deg); } 100% { transform: rotateX(50deg) rotateY(10deg) rotateZ(360deg); } }
  @keyframes orbitRotate3 { 0% { transform: rotateX(35deg) rotateY(55deg) rotateZ(0deg); } 100% { transform: rotateX(35deg) rotateY(55deg) rotateZ(360deg); } }

  /* Points de chargement ondulants (Loading Wave Dots) */
  .wave-dots {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 14px;
  }
  .wave-dots i {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--accent);
    display: inline-block;
    animation: waveBounce 1.2s infinite ease-in-out both;
  }
  .wave-dots i:nth-child(1) { animation-delay: -0.32s; }
  .wave-dots i:nth-child(2) { animation-delay: -0.16s; }
  .wave-dots i:nth-child(3) { animation-delay: 0s; }
  @keyframes waveBounce {
    0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
    40% { transform: scale(1.3); opacity: 1; box-shadow: 0 0 6px var(--accent); }
  }

  /* Toasts de notification modernes */
  #toasts {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 10px;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    border-radius: 8px;
    background: rgba(19, 25, 34, 0.94);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid var(--line);
    color: var(--fg);
    font-size: 13px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    animation: toastIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
    max-width: 380px;
  }
  .toast.out {
    animation: toastOut 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  .toast.success { border-color: rgba(16, 185, 129, 0.4); }
  .toast.success .t-icon { color: #10b981; }
  .toast.error { border-color: rgba(244, 63, 94, 0.4); }
  .toast.error .t-icon { color: #f43f5e; }
  .toast.info { border-color: rgba(56, 189, 248, 0.4); }
  .toast.info .t-icon { color: #38bdf8; }
  @keyframes toastIn { from { opacity: 0; transform: translateY(16px) scale(0.95); } to { opacity: 1; transform: translateY(0) scale(1); } }
  @keyframes toastOut { from { opacity: 1; transform: translateY(0) scale(1); } to { opacity: 0; transform: translateY(8px) scale(0.95); } }

  /* Top Bar IDE badges */
  .ide-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 11.5px;
    font-weight: 500;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--line);
    color: var(--dim);
    cursor: pointer;
    transition: var(--transition);
  }
  .ide-badge:hover {
    color: var(--fg);
    border-color: var(--accent);
    background: rgba(56, 189, 248, 0.08);
  }
  .ide-badge.active {
    color: var(--accent);
    border-color: rgba(56, 189, 248, 0.4);
    background: rgba(56, 189, 248, 0.12);
  }

  /* ---- Spinners classiques préservés ---- */
  .orb { position: relative; display: inline-block; width: 15px; height: 15px; flex: none; }
  .orb i { position: absolute; inset: 0; border-radius: 50%; border: 1.5px solid transparent; }
  .orb i:nth-child(1) { border-top-color: var(--accent); animation: orbit 1.1s linear infinite; }
  .orb i:nth-child(2) { inset: 3px; border-right-color: var(--yellow); animation: orbit 1.7s linear infinite reverse; }
  .orb i:nth-child(3) { inset: 6px; border-bottom-color: var(--magenta); animation: orbit .9s linear infinite; }
  .orb.sm { width: 13px; height: 13px; }
  #busy .orb { margin-right: 6px; }
  #busy:not(.on) .orb { opacity: 0; }
  .sub-chip.live .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--magenta); animation: breathe 1.6s ease-in-out infinite; }
  .skills-chip { color: var(--green); }

  @keyframes orbit { to { transform: rotate(360deg); } }
  @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
  @keyframes breathe { 0%, 100% { opacity: .45; transform: scale(.85); } 50% { opacity: 1; transform: scale(1.15); } }
  @keyframes rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  .cc-anim, .msgwrap, .line-status, .turnend { animation: rise .18s ease-out both; }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
    .orb i, .skel, .cc-anim, .msgwrap, .line-status, .turnend, .pro-orbits span, .wave-dots i { animation: none !important; }
    .cc-light.ok .dot, .sub-chip.live .dot, .led::after { animation: none !important; }
  }

`;

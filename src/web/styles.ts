// Compact workspace chrome, with monospace reserved for code and commands.

import { LOGO_ROWS } from "../logo";

// The logo as a CSS string: "\A " is a newline whose trailing space is eaten
// by the escape, so each row starts where it should.
const LOGO_CSS = LOGO_ROWS.map((r) => r.trimEnd()).join("\\A ");

export const STYLES = `
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
    /* Every size below is expressed in px, so scaling the root font would do
       nothing. Chromium's zoom rescales the whole tree, which is what a
       readability control has to touch. */
    zoom: var(--zoom, 1);
  }
  /* Text-size control: a track with a live percentage, so the reader can see
     the value instead of guessing with the mouse wheel. */
  .zoomctl { display: flex; align-items: center; gap: 6px; flex: none; }
  .zoomctl .zl { color: var(--dim); font-size: 11px; letter-spacing: .02em; }
  .zoomctl .zbar { position: relative; width: 96px; height: 16px; display: flex; align-items: center; }
  .zoomctl .zbar::before { content: ""; position: absolute; left: 0; right: 0; height: 4px; border-radius: 2px; background: #1b242a; box-shadow: inset 0 1px 2px #0008; }
  .zoomctl .zfill { position: absolute; left: 0; height: 4px; border-radius: 2px; background: linear-gradient(90deg, #24727f, #43c6d6, #93f2ff); box-shadow: 0 0 8px rgba(67, 198, 214, .45); width: calc(var(--zpct, 50) * 1%); }
  .zoomctl input[type="range"] { position: relative; z-index: 2; width: 100%; height: 16px; margin: 0; background: transparent; -webkit-appearance: none; appearance: none; cursor: pointer; }
  .zoomctl input[type="range"]::-webkit-slider-runnable-track { height: 16px; background: transparent; }
  .zoomctl input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 12px; height: 12px; margin-top: 2px; border-radius: 50%; background: #eafcff; border: 1px solid #2c7f8c; box-shadow: 0 0 8px rgba(147, 242, 255, .55); }
  .zoomctl input[type="range"]::-moz-range-track { height: 16px; background: transparent; }
  .zoomctl input[type="range"]::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: #eafcff; border: 1px solid #2c7f8c; }
  .zoomctl input[type="range"]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .zoomctl .zval { min-width: 38px; text-align: right; color: var(--fg); font-size: 11px; font-variant-numeric: tabular-nums; }
  .zoomctl .zstep { width: 20px; height: 20px; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: 1px solid var(--line); border-radius: 4px; color: var(--dim); cursor: pointer; line-height: 1; }
  .zoomctl .zstep:hover { color: var(--fg); border-color: var(--accent); background: rgba(56, 189, 248, .1); }
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
  #side { position: relative; width: var(--side-w, 272px); flex: none; background: var(--side); border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
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
  /* ---- Centre d'activite unifie & timeline ---- */
  .activity-bar { flex: none; border-bottom: 1px solid var(--line); background: rgba(11, 15, 20, 0.95); backdrop-filter: blur(10px); font-size: 12px; transition: background 0.2s ease; }
  .activity-summary { display: flex; align-items: center; gap: 8px; padding: 6px 14px; min-height: 34px; overflow-x: auto; scrollbar-width: none; }
  .activity-summary::-webkit-scrollbar { display: none; }
  .act-pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--gray); flex: none; transition: all 0.2s ease; }
  .act-pulse.live { background: var(--accent); box-shadow: 0 0 8px var(--accent); animation: pulse 1.2s infinite; }
  .act-pulse.check { background: var(--yellow); box-shadow: 0 0 8px var(--yellow); animation: pulse 0.8s infinite; }
  .act-pulse.error { background: var(--red); box-shadow: 0 0 8px var(--red); }
  .activity-summary .badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 4px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08); font-size: 11.5px; color: var(--fg); white-space: nowrap; }
  .activity-summary .act-agent { color: #a5d6ff; border-color: rgba(56, 139, 253, 0.35); background: rgba(56, 139, 253, 0.1); }
  .activity-summary .act-skill { color: #d2a8ff; border-color: rgba(187, 128, 247, 0.35); background: rgba(187, 128, 247, 0.1); }
  .activity-summary .act-tool { color: #7ee787; border-color: rgba(63, 185, 80, 0.35); background: rgba(63, 185, 80, 0.1); }
  .activity-summary .act-mcp { color: #f0883e; border-color: rgba(240, 136, 62, 0.35); background: rgba(240, 136, 62, 0.1); }
  .activity-summary .act-file { color: #79c0ff; border-color: rgba(88, 166, 255, 0.25); background: rgba(88, 166, 255, 0.08); font-family: ui-monospace, monospace; }
  .activity-summary .act-check { color: #e3b341; border-color: rgba(210, 153, 34, 0.35); background: rgba(210, 153, 34, 0.1); }
  .act-status { color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px; }
  .act-time { font-size: 11px; color: var(--gray); font-family: ui-monospace, monospace; white-space: nowrap; }
  .act-toggle { background: transparent; border: 1px solid var(--line); color: var(--dim); padding: 3px 8px; border-radius: 4px; font-size: 11.5px; cursor: pointer; transition: all 0.15s ease; white-space: nowrap; }
  .act-toggle:hover { color: var(--fg); border-color: var(--gray); background: rgba(255,255,255,0.04); }
  .activity-timeline { max-height: 190px; overflow-y: auto; padding: 6px 14px 10px; border-top: 1px solid rgba(255,255,255,0.05); background: rgba(7, 10, 13, 0.7); }
  .act-list { display: flex; flex-direction: column; gap: 4px; max-width: 920px; margin: 0 auto; }
  .act-item { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 4px; font-size: 11.5px; background: rgba(255,255,255,0.02); border-left: 2px solid var(--gray); }
  .act-item.ok { border-left-color: #3fb950; }
  .act-item.err { border-left-color: #f85149; background: rgba(248, 81, 73, 0.06); }
  .act-item.cur { border-left-color: var(--accent); background: rgba(56, 139, 253, 0.08); }
  .act-item .icon { font-size: 11px; width: 14px; text-align: center; flex: none; }
  .act-item .desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); }
  .act-item .meta { font-size: 10.5px; color: var(--gray); font-family: ui-monospace, monospace; flex: none; }

  #plantop { flex: none; max-height: 34vh; overflow: auto; padding: 8px 16px 0; border-bottom: 1px solid var(--line); background: rgba(8,12,15,.92); }
  #plantop[hidden] { display: none; }
  #plantop .plan { max-width: 920px; margin: 0 auto 8px; }
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
    background: transparent;
    border: 0;
    border-left: 2px solid rgba(56, 189, 248, 0.65);
    border-radius: 0;
    padding: 3px 0 3px 12px;
    margin: 18px 0 12px;
    font-weight: 400;
    white-space: pre-wrap;
    box-shadow: none;
  }
  .msgmeta { display: flex; align-items: center; gap: 8px; margin-top: 7px; color: var(--gray); font-size: 11px; }
  .msgcopy {
    appearance: none;
    border: 0;
    background: transparent;
    color: var(--gray);
    padding: 1px 3px;
    min-width: 20px;
    height: 20px;
    border-radius: 3px;
    cursor: pointer;
    font: inherit;
    line-height: 1;
  }
  .msgcopy:hover { color: var(--accent); background: rgba(255,255,255,.06); }
  .msgcopy:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
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
  .md pre code { background: none; padding: 0; color: #9cdcfe; font-family: 'JetBrains Mono', Consolas, monospace; }
  .md table { border-collapse: collapse; margin: 10px 0; display: block; overflow-x: auto; max-width: 100%; border-radius: var(--radius-sm); border: 1px solid var(--line); }
  .md th, .md td { border: 1px solid var(--line); padding: 6px 12px; text-align: left; }
  .md th { background: #131922; color: #f0f6fc; font-weight: 600; }
  .md blockquote { border-left: 3px solid var(--accent); margin: 10px 0; padding: 4px 14px; color: var(--dim); background: rgba(56, 189, 248, 0.04); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }
  .md hr { border: 0; border-top: 1px solid var(--line); margin: 16px 0; }
  .tool { color: var(--dim); margin-top: 6px; display: flex; align-items: center; gap: 6px; padding: 3px 8px; background: rgba(255, 255, 255, 0.025); border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: var(--radius-sm); font-family: 'JetBrains Mono', monospace; font-size: 11px; max-width: 100%; }
  .tool .name { color: var(--accent); font-weight: 600; }
  .result { color: var(--dim); padding: 8px 14px; margin: 4px 0 10px; background: rgba(0, 0, 0, 0.25); border-left: 2px solid var(--line); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; font-family: 'JetBrains Mono', monospace; font-size: 12px; }
  .result.err { color: var(--red); border-left-color: var(--red); background: rgba(244, 63, 94, 0.06); }
  .tool.failed { border-left-color: var(--red); }
  .tool.finished { border-left-color: var(--green); }
  .tool summary { cursor: pointer; }
  .tool .tool-args { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool-command { margin: 4px 0; padding: 7px 9px; max-height: 110px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dim); background: rgba(0,0,0,.22); border-radius: 4px; font: 11px/1.45 Consolas, monospace; }

  /* ---- offload card: real countdown on a long-running command ---- */
  .offload-card { margin: 8px 0 4px; padding: 10px 14px; background: rgba(245, 158, 11, 0.07); border: 1px solid rgba(245, 158, 11, 0.4); border-radius: var(--radius-sm); max-width: 620px; font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.5; }
  .offload-title { font-weight: 700; color: var(--yellow); }
  .offload-count { color: var(--dim); margin: 4px 0 10px; min-height: 18px; }
  .offload-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .offload-btn { font: inherit; font-size: 12px; font-weight: 600; padding: 6px 12px; border-radius: var(--radius-sm); border: 1px solid var(--line); background: rgba(255, 255, 255, 0.04); color: var(--fg); cursor: pointer; transition: var(--transition); }
  .offload-btn:hover { border-color: var(--accent); background: rgba(56, 189, 248, 0.1); }
  .offload-btn.primary { background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%); border-color: rgba(255, 255, 255, 0.15); color: #fff; box-shadow: 0 4px 14px rgba(2, 132, 199, 0.35); }
  .offload-btn.primary:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(2, 132, 199, 0.55); }
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
  .validation-rail { display: inline-flex; align-items: center; gap: 5px; min-height: 20px; padding: 1px 7px 1px 5px; border: 0; border-left: 3px solid var(--accent); border-radius: 2px; font: inherit; font-size: 11px; white-space: nowrap; cursor: pointer; transition: background .15s, border-color .15s, color .15s; }
  .validation-rail.ok, .validation-rail.pass { color: var(--green); border-left-color: var(--green); background: rgba(16,185,129,.08); }
  .validation-rail.bad, .validation-rail.fail { color: var(--red); border-left-color: var(--red); background: rgba(244,63,94,.08); }
  .validation-rail.pending { color: var(--yellow); border-left-color: var(--yellow); background: rgba(245,158,11,.08); }
  .validation-rail.idle { color: var(--dim); border-left-color: #3a4a50; background: rgba(255,255,255,.03); }
  .validation-rail.none { color: var(--dim); border-left-color: #3a4a50; background: transparent; }
  .validation-rail:hover:not(:disabled) { filter: brightness(1.25); }
  .validation-rail:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .validation-rail:disabled { cursor: progress; opacity: .75; }
  .validation-label { pointer-events: none; }
  .validation-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; flex: none; }
  .validation-rail.pending .validation-dot { animation: pulse 1s infinite; }
  #hintrow { font-size: 12px; color: var(--gray); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ---- right panel: browser + terminal tabs ---- */
  #panel { flex: none; width: 520px; min-width: 300px; max-width: 80vw; border-left: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; position: relative; background: var(--side); }
  #panel[hidden] { display: none; }
  #panelgrip { position: absolute; left: -3px; top: 0; bottom: 0; width: 7px; cursor: col-resize; z-index: 6; }
  #panelgrip:hover, body.dragging #panelgrip { background: var(--sel); }
  #sidegrip { position: absolute; right: -3px; top: 0; bottom: 0; width: 7px; cursor: col-resize; z-index: 6; }
  #sidegrip:hover, body.dragging #sidegrip { background: var(--sel); }
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
  .term-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; background: #111618; border-bottom: 1px solid var(--line); font-size: 11px; flex: none; }
  .term-tool-left { display: flex; align-items: center; gap: 8px; }
  .term-badge { font-weight: 700; color: var(--accent); background: rgba(0, 200, 220, 0.12); padding: 2px 6px; border-radius: 3px; font-size: 10px; letter-spacing: 0.5px; border: 1px solid rgba(0, 200, 220, 0.25); }
  .term-cwd { color: var(--dim); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; }
  .term-tool-right { display: flex; align-items: center; gap: 6px; }
  .term-btn { background: #1a2226; color: var(--fg); border: 1px solid var(--line); border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer; transition: background 0.15s, border-color 0.15s; }
  .term-btn:hover { background: #222d33; border-color: var(--accent); }
  .term-btn.warn { color: var(--warn); }
  .term-btn.warn:hover { background: rgba(255, 170, 0, 0.15); border-color: var(--warn); }
  .cmd-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 600; padding: 1px 6px; border-radius: 4px; margin-left: 8px; font-family: monospace; }
  .cmd-badge.ok { background: rgba(30, 200, 100, 0.15); color: #3cd070; border: 1px solid rgba(30, 200, 100, 0.3); }
  .cmd-badge.err { background: rgba(240, 70, 70, 0.15); color: #f06060; border: 1px solid rgba(240, 70, 70, 0.3); }
  .cmd-actions { display: flex; align-items: center; gap: 6px; margin-top: 8px; padding-top: 6px; border-top: 1px solid rgba(255, 255, 255, 0.08); }
  .cmd-action-btn { background: #182228; border: 1px solid var(--line); color: var(--dim); border-radius: 4px; padding: 3px 8px; font-size: 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; transition: background 0.15s, color 0.15s; }
  .cmd-action-btn:hover { background: #222f36; color: var(--fg); border-color: var(--accent); }
  .cmd-action-btn.primary { color: var(--accent); border-color: rgba(0, 200, 220, 0.3); }
  .cmd-action-btn.primary:hover { background: rgba(0, 200, 220, 0.12); }
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
  .filetree { width: var(--ftree-w, 38%); min-width: 150px; overflow: auto; border-right: 1px solid var(--line); padding: 6px; }
  .ftreegrip { flex: 0 0 7px; cursor: col-resize; margin-left: -3px; position: relative; z-index: 6; }
  .ftreegrip:hover, body.dragging .ftreegrip { background: var(--sel); }
  .treerow { display: flex; align-items: center; min-width: 0; }
  .treetoggle { border: 0; background: transparent; color: var(--dim); cursor: pointer; font: inherit; font-size: 9px; width: 18px; flex: none; padding: 2px 0; }
  .treetoggle:hover { color: var(--fg); }
  .treespacer { width: 18px; flex: none; }
  .treerow .fileitem { flex: 1; min-width: 0; }
  .treesub { min-width: 0; }
  .fileitem { display: flex; align-items: center; width: 100%; text-align: left; border: 0; background: transparent; color: var(--fg); padding: 4px 7px; border-radius: 3px; cursor: pointer; font: inherit; font-size: 12px; white-space: nowrap; overflow: hidden; }
    .fileitem:hover { background: rgba(255,255,255,.06); }
    .fileitem-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 20px; padding: 0 5px; font-size: 12px; font-weight: 800; font-family: Consolas, monospace; border-radius: 4px; margin-right: 7px; flex-shrink: 0; line-height: 1; }
    .fileitem-badge.status-m { color: #e3b341; background: rgba(227,179,65,.14); }
    .fileitem-badge.status-a, .fileitem-badge.status-u { color: #3fb950; background: rgba(63,185,80,.15); }
    .fileitem-badge.status-d { color: #f85149; background: rgba(248,81,73,.15); }
    .fileitem-badge.status-r { color: #d2a8ff; background: rgba(210,168,255,.15); }
    .fileitem-icon { display: inline-flex; align-items: center; justify-content: center; width: 20px; font-size: 13px; margin-right: 6px; flex-shrink: 0; }
    .fileitem-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; text-align: left; }
    /* old */ .fileitem-old { display: flex; align-items: center; width: 100%; text-align: left; border: 0; background: transparent; color: var(--fg); padding: 4px 7px; border-radius: 3px; cursor: pointer; font: inherit; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fileitem-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; text-align: left; }
  .fileitem:hover { background: rgba(255,255,255,.06); }
  .fileitem.folder { color: var(--accent); }
  .fileitem.parent { color: var(--dim); border-bottom: 1px solid var(--line); margin-bottom: 4px; }
  .fileeditor-wrap { position: relative; flex: 1; min-width: 0; min-height: 0; overflow: hidden; background: #0f1417; }
  .filegutter { position: absolute; top: 35px; left: 0; bottom: 0; width: 48px; padding: 10px 8px 10px 0; font: 12.5px/1.5 Consolas, monospace; text-align: right; color: var(--dim); opacity: 1; user-select: none; pointer-events: none; background: #0d1114; border-right: 1px solid var(--line); overflow: hidden; }
  .filegutter .gutter-line { position: relative; height: 1.5em; padding-right: 2px; box-sizing: border-box; }
  .filegutter .gutter-line.added::before, .filegutter .gutter-line.removed::after { content: ""; position: absolute; top: 2px; bottom: 2px; width: 3px; left: 0; border-radius: 2px; }
  .filegutter .gutter-line.added::before { background: #3fb950; }
  .filegutter .gutter-line.removed::after { left: 4px; background: #f85149; }
  .filediagnostics { flex: none; max-height: 130px; overflow: auto; background: #101416; border-top: 1px solid var(--line); }
  .filediagnostic, .filediagnostic-note { display: block; width: 100%; padding: 5px 8px; border: 0; border-bottom: 1px solid var(--line); text-align: left; color: var(--fg); background: transparent; font: inherit; font-size: 11px; }
  .filediagnostic { cursor: pointer; }
  .filediagnostic:hover { background: rgba(255,255,255,.08); }
  .filediagnostic.error { box-shadow: inset 3px 0 var(--red); }
  .filediagnostic.warning { box-shadow: inset 3px 0 #c99a34; }
  .filediagnostic-note { color: var(--dim); }
  .filediagnostic-note.ok { color: var(--green); }
  .lspinstall { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .lspinstall .iconbtn { font-size: 11px; padding: 2px 8px; border: 1px solid var(--accent); border-radius: 4px; background: rgba(56,189,248,.12); color: var(--accent); cursor: pointer; }
  .filediagnostic-note.error { color: var(--red); }
  .reviewpanes { flex: 1; min-height: 0; display: flex; align-items: stretch; }
  .reviewfiles { display: flex; flex-direction: column; width: min(360px, 46%); min-width: 190px; border-right: 1px solid var(--line); background: rgba(0,0,0,.14); }
  .reviewlist { flex: 1; min-height: 0; overflow: auto; padding: 6px; }
  .reviewtotals { flex: none; display: flex; justify-content: space-between; gap: 8px; padding: 6px 8px; border-top: 1px solid var(--line); color: var(--dim); font-size: 11px; }
  .reviewtotals .plus { color: var(--green); }
  .reviewtotals .minus { color: var(--red); }
  .reviewfilerow { display: flex; gap: 6px; align-items: center; width: 100%; text-align: left; border: 0; background: transparent; color: var(--fg); font: inherit; font-size: 12px; padding: 5px 7px; border-radius: 5px; cursor: pointer; }
  .reviewfilerow:hover { background: rgba(255,255,255,.06); }
  .reviewfilerow.sel { background: rgba(56,189,248,.13); box-shadow: inset 2px 0 var(--accent); }
  .reviewfilerow .fstat { flex: none; width: 15px; font-weight: 700; text-align: center; font-size: 11px; }
  .reviewfilerow .fstat.a { color: var(--green); }
  .reviewfilerow .fstat.m { color: var(--yellow); }
  .reviewfilerow .fstat.d { color: var(--red); }
  .reviewfilerow .fstat.r { color: var(--magenta); }
  .reviewfilerow .fpath { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .reviewfilerow .fdelta { flex: none; font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; white-space: nowrap; }
  .reviewfilerow .fdelta .plus { color: var(--green); }
  .reviewfilerow .fdelta .minus { color: var(--red); }
  .reviewnav { flex: none; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 0; border-left: 1px solid var(--line); border-right: 1px solid var(--line); }
  .reviewnav .badge-n { min-width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border-radius: 10px; background: var(--accent); color: #06121b; font: 700 11px/1 ui-monospace, Consolas, monospace; }
  .reviewdiff { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .reviewdifftop { flex: none; display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--line); font-size: 11.5px; color: var(--dim); }
  .reviewdifftop .reviewpath { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Consolas, monospace; color: var(--fg); }
  .reviewdiffbody { flex: 1; min-height: 0; overflow: auto; padding: 8px 10px; }
  .tabbody.review .bar input { min-width: 0; background: var(--box); border: 1px solid var(--line); color: var(--fg); font: inherit; font-size: 12px; padding: 4px 7px; border-radius: 4px; }
  .tabbody.review .bar input { flex: 1; }
  .tabbody.review .reviewmode { min-width: 132px; background: var(--box); border: 1px solid var(--line); color: var(--fg); font: inherit; font-size: 11px; padding: 4px 7px; border-radius: 4px; }
  .tabbody.review .reviewmode:focus { outline: 1px solid var(--accent); outline-offset: 1px; }
  .gutter { display: inline-block; width: 34px; flex: none; text-align: right; margin-right: 8px; color: var(--dim); opacity: .7; user-select: none; }
  .sbsgrid { border: 1px solid var(--line); border-radius: 6px; margin: 0 0 8px; overflow: hidden; }
  .sbshunk { padding: 4px 8px; color: #79c0ff; font-size: 11px; background: #0c1013; border-bottom: 1px solid var(--line); }
  .sbsrow { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .sbsrow .reviewpatch { margin: 0; border: 0; border-radius: 0; max-height: none; min-width: 0; overflow: hidden; }
  /* Colour rails: red marks the removed code, green the added one, so a line
     reads at a glance without having to hunt for the +/- glyph. */
  .sbsrow .reviewpatch:first-child { border-right: 1px solid var(--line); border-left: 3px solid rgba(248, 81, 73, .75); background: rgba(248, 81, 73, .05); }
  .sbsrow .reviewpatch:last-child { border-left: 3px solid rgba(63, 185, 80, .75); background: rgba(63, 185, 80, .05); }
  .sbssame { padding: 0 8px; color: var(--dim); font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  .reviewhunk { border: 1px solid var(--line); border-radius: 6px; margin: 0 0 8px; overflow: hidden; }
  .reviewpatch { margin: 0; padding: 6px 8px; font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; background: #0c1013; max-height: 220px; overflow: auto; }
  .reviewactions { display: flex; gap: 6px; padding: 6px 8px; border-top: 1px solid var(--line); background: #101416; }
  .sharebanner { padding: 8px 14px; background: #1c2b1f; border-bottom: 1px solid #2f5b38; color: #c9f0d4; font-size: 12.5px; }
  pre.diff { margin: 6px 0; padding: 6px 8px; background: #0c1013; border: 1px solid var(--line); border-radius: 6px; font-size: 11.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  pre.diff > span, .reviewpatch > span { display: block; padding: 0 4px; }
  pre.diff span.add, .reviewpatch span.add { color: #7ee787; background: rgba(63,185,80,.13); }
  pre.diff span.del, .reviewpatch span.del { color: #ffa198; background: rgba(248,81,73,.13); }
  pre.diff span.same, .reviewpatch span.same { color: var(--dim); }
  pre.diff span.hunk, .reviewpatch span.hunk { color: #79c0ff; }
  .reviewline { display: flex; gap: 6px; align-items: flex-start; }
  .reviewline > span:last-child { flex: 1; min-width: 0; }
  .reviewline .gutter { display: inline-block; }
  .reviewpick { margin-top: 3px; flex: none; }
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
  .fileinlinebar { display: flex; flex-direction: column; gap: 6px; padding: 7px 10px; border-bottom: 1px solid var(--accent); background: #151a1e; }
  .fileinlinebar[hidden] { display: none; }
  .fileinline-row { display: flex; gap: 6px; width: 100%; align-items: center; }
  .fileinlinebar input { flex: 1; min-width: 0; background: var(--box); border: 1px solid var(--line); color: var(--fg); font: inherit; font-size: 12.5px; padding: 5px 8px; border-radius: 4px; outline: none; }
  .fileinlinebar input:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .fileinlinechips { display: flex; gap: 6px; overflow-x: auto; padding: 2px 0; }
  .fileinlinechip { border: 1px solid var(--line); background: var(--box); color: var(--fg); border-radius: 12px; font: inherit; font-size: 11px; padding: 2px 8px; cursor: pointer; white-space: nowrap; transition: background 0.15s, border-color 0.15s; }
  .fileinlinechip:hover { border-color: var(--accent); background: rgba(56,189,248,0.15); color: #fff; }
  .fileinlinepreview { border-bottom: 1px solid var(--line); padding: 7px 10px; background: #0e1215; }
  .fileinlinepreview[hidden] { display: none; }
  .completepop { display: block; position: absolute; z-index: 6; left: 12px; top: 44px; min-width: 260px; max-width: 70%; max-height: 220px; overflow: auto; background: #202629; border: 1px solid var(--accent); box-shadow: 0 8px 24px #0008; }
  .completepop[hidden] { display: none; }
  .completeitem { display: flex; gap: 8px; width: 100%; text-align: left; background: transparent; border: 0; border-bottom: 1px solid var(--line); color: var(--fg); padding: 5px 10px; cursor: pointer; font: inherit; font-size: 12px; }
  .completeitem:hover, .completeitem.sel { background: #094771; }
  .completeitem .kind { color: var(--dim); }
  .planchip { border: 1px solid var(--line); background: var(--box); color: var(--fg); border-radius: 20px; font: inherit; font-size: 11px; padding: 2px 10px; cursor: pointer; margin-left: 8px; white-space: nowrap; }
  .planchip:hover { border-color: var(--accent); }
  .taskrail { padding: 8px 10px; border-top: 1px solid var(--line); background: rgba(0,0,0,.08); }
  .taskrail-header { font-size: 11px; font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px; }
  .taskrail-item { display: flex; gap: 6px; align-items: flex-start; padding: 4px 0; font-size: 12px; color: var(--fg); border-bottom: 1px solid var(--line); }
  .taskrail-item:last-child { border-bottom: none; }
  .taskrail-checkbox { flex: none; width: 16px; height: 16px; margin-top: 2px; accent-color: var(--accent); cursor: pointer; }
  .taskrail-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .taskrail-item.done .taskrail-text { text-decoration: line-through; color: var(--dim); }
  .taskrail-item.current { box-shadow: inset 3px 0 var(--accent); background: rgba(56,189,248,.07); }
  .taskrail-now { flex: none; color: var(--accent); font-weight: 700; }
  #panel.split2 { display: flex; }
  #panel.split2 > .tabbody.files { flex: 1; min-width: 0; }
  .filetabs { position: absolute; z-index: 2; inset: 0 0 auto; height: 35px; display: flex; overflow-x: auto; background: #171c1f; border-bottom: 1px solid var(--line); }
  .filetab { display: flex; align-items: center; flex: none; max-width: 220px; background: #202629; border-right: 1px solid var(--line); }
  .filetab.active { background: #0f1417; border-top: 1px solid var(--accent); }
  .filetab-label, .filetab-close { border: 0; background: transparent; color: var(--fg); cursor: pointer; font: inherit; font-size: 11px; min-height: 32px; }
  .filetab-label { max-width: 175px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 4px 8px; }
  .filetab-close { color: var(--dim); padding: 4px 7px; }
  .filetab-close:hover { background: rgba(255,255,255,.1); }
  .filecode, .fileeditor { position: absolute; inset: 35px 78px 0 48px; height: calc(100% - 35px); margin: 0; padding: 10px 12px; font: 12.5px/1.5 Consolas, monospace; tab-size: 2; white-space: pre-wrap; overflow: auto; word-wrap: break-word; }
  .fileminimap { position: absolute; top: 35px; right: 0; bottom: 0; width: 30px; padding: 10px 4px; overflow: hidden; background: #0d1114; border-left: 1px solid var(--line); cursor: pointer; }
  .fileminimap i { display: block; height: 2px; margin-bottom: 1px; background: var(--gray); opacity: .45; border-radius: 1px; }
  .fileminimap i:nth-child(3n) { opacity: .7; }
  .minimap-bars { position: absolute; inset: 10px 4px; }
  .minimap-box { position: absolute; left: 0; right: 0; top: 0; background: rgba(56,189,248,.14); border-top: 1px solid rgba(56,189,248,.5); border-bottom: 1px solid rgba(56,189,248,.5); pointer-events: none; }
  .filecode { pointer-events: none; color: #9cdcfe; }
  .fileeditor { resize: none; border: 0; outline: 0; background: transparent; color: transparent; caret-color: #fff; }
  .fileeditor:focus { outline: 1px solid var(--accent); outline-offset: -1px; }
  .filemeta { flex: none; min-height: 26px; padding: 6px 9px; border-top: 1px solid var(--line); color: var(--dim); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .filemeta.error { color: var(--red); }
  .tok-key { color: #c586c0; font-weight: 600; } .tok-str { color: #ce9178; } .tok-num { color: #b5cea8; }
  .tok-com { color: #6a9955; font-style: italic; } .tok-lit { color: #569cd6; font-weight: 600; }
  .tok-k { color: #569cd6; font-weight: 600; }
  .tok-control { color: #c586c0; font-weight: 600; }
  .tok-bool { color: #569cd6; font-weight: 600; }
  .tok-s { color: #ce9178; }
  .tok-regex { color: #d16969; }
  .tok-f { color: #dcdcaa; font-weight: 500; }
  .tok-prop { color: #9cdcfe; }
  .tok-v { color: #9cdcfe; }
  .tok-const { color: #4fc1ff; font-weight: 600; }
  .tok-t { color: #4ec9b0; font-weight: 600; }
  .tok-n { color: #b5cea8; }
  .tok-c { color: #6a9955; font-style: italic; }
  .tok-d { color: #dcdcaa; }
  .tok-tag { color: #569cd6; font-weight: 600; }
  .tok-o { color: #80c7ff; }
  .tok-b1 { color: #ffd700; font-weight: 600; }
  .tok-b2 { color: #da70d6; font-weight: 600; }
  .tok-b3 { color: #179fff; font-weight: 600; }
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
  #side { width: var(--side-w, 248px); }
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
  .user { border: 0; border-left: 2px solid rgba(56, 189, 248, 0.65); border-radius: 0; background: transparent; padding: 3px 0 3px 12px; margin: 24px 0; font-weight: 400; box-shadow: none; }
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
  /* Dropdown menus for the status bar (context, agent mode). Same visual
     language as the completion popup, but anchored to the button that opened
     it and closed on outside click or Escape. */
  .statusmenu { position: fixed; z-index: 60; min-width: 190px; max-width: 320px; max-height: 60vh; overflow: auto; background: #202629; border: 1px solid var(--accent); border-radius: 6px; box-shadow: 0 10px 30px #000a; padding: 4px; }
  .statusmenu-head { color: var(--dim); font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; padding: 5px 8px 3px; }
  .statusmenu-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: transparent; border: 0; border-radius: 4px; color: var(--fg); padding: 6px 8px; cursor: pointer; font: inherit; font-size: 12px; }
  .statusmenu-item:hover, .statusmenu-item:focus-visible { background: #094771; outline: none; }
  .statusmenu-item .mi-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .statusmenu-item .mi-hint { color: var(--dim); font-size: 10.5px; flex: none; }
  .statusmenu-item .mi-tick { color: var(--accent); flex: none; }
  .statusmenu-item.on .mi-label { font-weight: 600; }
  .statusmenu-sep { height: 1px; background: var(--line); margin: 4px 2px; }
  .statusmenu-note { color: var(--dim); font-size: 11px; line-height: 1.45; padding: 6px 8px; white-space: pre-wrap; }
  /* Context meter — rebuilt as a tweened gauge so the fill actually animates. */
  .context-chip { display: flex; align-items: center; gap: 7px; padding: 3px 8px 3px 6px; }
  .context-chip.pressure { color: var(--yellow); }
  .ctx-track {
    position: relative; display: block; width: 88px; height: 11px; flex: none;
    border-radius: 6px; overflow: hidden;
    background: linear-gradient(180deg, #0a0f12, #141d22);
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.07), inset 0 1px 3px rgba(0,0,0,.65);
  }
  .ctx-track::after {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background: repeating-linear-gradient(90deg, transparent 0 calc(25% - 1px), rgba(0,0,0,.5) calc(25% - 1px) 25%);
  }
  .ctx-fill {
    position: absolute; top: 0; bottom: 0; left: 0;
    width: calc(var(--pct, 0) * 1%);
    border-radius: 6px; overflow: hidden;
    background: linear-gradient(90deg, #24727f 0%, #43c6d6 55%, #93f2ff 100%);
    box-shadow: 0 0 8px rgba(67,198,214,.5), 0 0 2px rgba(147,242,255,.9);
    transition: width .62s cubic-bezier(.22,1,.36,1), background .4s ease, box-shadow .4s ease;
  }
  .ctx-fill::before {
    content: ""; position: absolute; inset: 0;
    background: linear-gradient(100deg, transparent 18%, rgba(255,255,255,.5) 50%, transparent 82%);
    transform: translateX(-130%);
    animation: ctxSweep 2.6s cubic-bezier(.4,0,.2,1) infinite;
  }
  .ctx-fill::after {
    content: ""; position: absolute; top: 0; right: 0; bottom: 0; width: 2px;
    background: #ddfcff; border-radius: 2px; box-shadow: 0 0 7px #bff6ff;
  }
  @keyframes ctxSweep { 0% { transform: translateX(-130%); } 62%, 100% { transform: translateX(130%); } }
  .ctx-num {
    font: 600 11px/1 Consolas, ui-monospace, monospace; font-variant-numeric: tabular-nums;
    min-width: 36px; text-align: right; letter-spacing: .2px; color: #93f2ff;
    transition: color .4s ease;
  }
  .ctx-num.bump { animation: ctxBump .5s cubic-bezier(.22,1,.36,1); }
  @keyframes ctxBump { 0% { transform: scale(1); } 40% { transform: scale(1.24); } 100% { transform: scale(1); } }
  .context-chip[data-zone="warm"] .ctx-fill {
    background: linear-gradient(90deg, #7f621c 0%, #dfa53c 55%, #ffd57d 100%);
    box-shadow: 0 0 9px rgba(223,165,60,.55), 0 0 2px rgba(255,213,125,.9);
  }
  .context-chip[data-zone="warm"] .ctx-num { color: #ffd57d; }
  .context-chip[data-zone="hot"] .ctx-fill {
    background: linear-gradient(90deg, #8c2424 0%, #e04b4b 55%, #ff9d8d 100%);
    box-shadow: 0 0 11px rgba(224,75,75,.7), 0 0 3px rgba(255,157,141,.95);
  }
  .context-chip[data-zone="hot"] .ctx-num { color: #ff9d8d; }
  .context-chip[data-zone="hot"] .ctx-track { animation: ctxPulse 1.6s ease-in-out infinite; }
  @keyframes ctxPulse {
    0%, 100% { box-shadow: inset 0 0 0 1px rgba(255,120,110,.25), inset 0 1px 3px rgba(0,0,0,.65); }
    50% { box-shadow: inset 0 0 0 1px rgba(255,155,145,.9), inset 0 1px 3px rgba(0,0,0,.65), 0 0 11px rgba(224,75,75,.5); }
  }
  @media (prefers-reduced-motion: reduce) {
    .ctx-fill, .context-chip[data-zone="hot"] .ctx-track { transition: none; animation: none !important; }
    .ctx-fill::before { animation: none; opacity: 0; }
  }
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
  .cc-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 10px 0; border-bottom: 1px solid var(--line); }
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
  .cc-light.warn .dot { background: var(--yellow); box-shadow: 0 0 6px rgba(234,179,8,.7); animation: breathe 1.2s ease-in-out infinite; }
  .cc-light.warn { color: #f5e7c0; border-color: rgba(234,179,8,.45); }
  .cc-item .ds.warn { color: var(--yellow); }
  .cc-role { display: flex; flex-direction: column; gap: 8px; }
  .cc-role .row { display: flex; gap: 6px; }
  .cc-role input { flex: 1; min-width: 0; background: #0f1417; border: 1px solid var(--line); border-radius: 4px; color: var(--fg); padding: 5px 8px; font: inherit; font-size: 12.5px; }
  .cc-role input:focus { outline: 1px solid var(--accent); }
  .cc-tag { font-size: 11px; color: var(--gray); border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; }
  .cc-act { background: transparent; border: 1px solid var(--line); color: var(--dim); border-radius: 4px; padding: 3px 9px; cursor: pointer; font-size: 12px; }
  .cc-act:hover { color: var(--fg); border-color: var(--accent); }
  .cc-list { display: flex; flex-direction: column; gap: 6px; }
  .cc-workform { display: grid; grid-template-columns: minmax(180px, 2fr) minmax(110px, 1fr) auto auto auto; gap: 6px; }
  .cc-workform input, .cc-workform select { min-width: 0; padding: 6px 8px; border: 1px solid var(--line); border-radius: 5px; background: #0f1417; color: var(--fg); font: inherit; font-size: 12px; }
  .cc-workitem { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: #12171a; }
  .cc-workdetails { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 10px; flex: 1; min-width: 180px; }
  .cc-workdetails strong { color: var(--fg); font-size: 12.5px; }
  .cc-worknotes { flex-basis: 100%; color: var(--gray); font-size: 11.5px; overflow-wrap: anywhere; }
  @media (max-width: 700px) { .cc-workform { grid-template-columns: 1fr 1fr; } .cc-workform input:first-child { grid-column: 1 / -1; } }
  .cc-item { display: flex; align-items: baseline; gap: 8px; padding: 6px 9px; border: 1px solid var(--line); border-radius: 6px; background: #12171a; }
  .cc-item .nm { color: var(--fg); font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }
  .cc-item .ds { color: var(--gray); font-size: 12px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cc-item .ds.ok { color: var(--green); }
  .cc-item .ds.bad { color: var(--yellow); }
  .cc-item .ds.muted { color: #5d6b70; font-style: italic; }
  .cc-row { display: flex; align-items: center; gap: 6px; flex: none; margin-left: auto; }
  .cc-note { color: var(--dim); font-size: 12px; line-height: 1.5; padding: 7px 9px; border-left: 2px solid var(--accent); background: #101a1e; border-radius: 0 5px 5px 0; white-space: pre-wrap; word-break: break-word; }
  .cc-note[hidden] { display: none; }
  .cc-switch { flex: none; position: relative; width: 36px; height: 19px; padding: 0; border-radius: 10px; border: 1px solid #2b3a40; background: #1a2226; cursor: pointer; transition: background .18s ease, border-color .18s ease; }
  .cc-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: #67787e; transition: transform .18s cubic-bezier(.3,1.4,.5,1), background .18s ease; }
  .cc-switch:hover { border-color: #3d5a63; }
  .cc-switch.on { background: #173a41; border-color: #2c7f8c; }
  .cc-switch.on::after { transform: translateX(17px); background: #7fe6f2; }
  .cc-switch:disabled { opacity: .55; cursor: progress; }
  .cc-switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
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

  /* ---- VS Code Pro Dock Styles ---- */
  #paneltabs {
    display: flex;
    align-items: center;
    background: #181818;
    border-bottom: 1px solid #2b2b2b;
    height: 35px;
    padding: 0 4px;
    user-select: none;
    overflow-x: auto;
  }
  .vsc-dock-tabs {
    display: flex;
    align-items: center;
    height: 100%;
    gap: 2px;
  }
  .vsc-tab {
    background: transparent;
    border: none;
    color: #969696;
    font-size: 11.5px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-weight: 500;
    padding: 0 12px;
    height: 100%;
    display: flex;
    align-items: center;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: color 0.12s ease, border-color 0.12s ease;
  }
  .vsc-tab:hover {
    color: #cccccc;
  }
  .vsc-tab.on {
    color: #ffffff;
    border-bottom-color: #007acc;
    background: #1f1f1f;
  }
  .vsc-dock-tools {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
    padding-right: 4px;
  }
  .vsc-tool-btn {
    background: transparent;
    border: none;
    color: #cccccc;
    font-size: 12px;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 3px;
    cursor: pointer;
    transition: background 0.12s ease;
  }
  .vsc-tool-btn:hover {
    background: #2a2d2e;
    color: #ffffff;
  }
  .vsc-sep {
    color: #3c3c3c;
    font-size: 12px;
    padding: 0 3px;
  }
  .vsc-term-dropdown {
    display: flex;
    align-items: center;
    background: #252526;
    border: 1px solid #3c3c3c;
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 11.5px;
    color: #cccccc;
    gap: 4px;
  }
  .vsc-term-ico {
    font-family: monospace;
    font-size: 11px;
    color: #888888;
  }
  .vsc-term-select {
    background: transparent;
    border: none;
    color: #cccccc;
    font-size: 11.5px;
    outline: none;
    cursor: pointer;
  }
  .vsc-filter-box {
    display: flex;
    align-items: center;
    background: #252526;
    border: 1px solid #3c3c3c;
    border-radius: 3px;
    padding: 2px 8px;
    gap: 4px;
  }
  .vsc-filter-in {
    background: transparent;
    border: none;
    color: #cccccc;
    font-size: 11.5px;
    width: 190px;
    outline: none;
  }
  .vsc-filter-in::placeholder {
    color: #666666;
    font-style: italic;
  }
  .vsc-filter-ico {
    color: #888888;
    font-size: 11px;
    cursor: pointer;
  }
  .vsc-channel-select {
    background: #252526;
    border: 1px solid #3c3c3c;
    color: #cccccc;
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 11.5px;
    outline: none;
  }

  /* ---- Problems View ---- */
  .vsc-problems {
    background: #181818;
    height: 100%;
    overflow-y: auto;
    color: #cccccc;
  }
  .problems-content {
    padding: 12px 16px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .problems-empty {
    color: #cccccc;
    font-size: 13px;
    padding: 14px 4px;
    line-height: 1.5;
  }
  .prob-action-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid #282828;
  }
  .prob-btn {
    border: none;
    border-radius: 3px;
    padding: 4px 10px;
    font-size: 11.5px;
    cursor: pointer;
    font-weight: 500;
  }
  .prob-btn.primary {
    background: #007acc;
    color: #ffffff;
  }
  .prob-btn.primary:hover {
    background: #0098ff;
  }
  .prob-btn.ghost {
    background: transparent;
    border: 1px solid #3c3c3c;
    color: #cccccc;
  }
  .prob-btn.ghost:hover {
    background: #252526;
  }
  .prob-total-badge {
    color: #888888;
    font-size: 11px;
    margin-left: auto;
  }
  .prob-tree {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .prob-file-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .prob-file-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    color: #cccccc;
    cursor: pointer;
    padding: 3px 6px;
    border-radius: 3px;
  }
  .prob-file-header:hover {
    background: #222222;
  }
  .prob-file-badge {
    background: #333333;
    color: #aaaaaa;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 10px;
  }
  .prob-items-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-left: 18px;
  }
  .prob-item-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 6px;
    font-size: 12px;
    border-radius: 3px;
  }
  .prob-item-row:hover {
    background: #222222;
  }
  .prob-item-row.error .prob-severity-icon { color: #f48771; }
  .prob-item-row.warning .prob-severity-icon { color: #cca700; }
  .prob-item-row.info .prob-severity-icon { color: #75beff; }
  .prob-message {
    flex: 1;
    color: #d4d4d4;
  }
  .prob-loc {
    color: #007acc;
    font-size: 11px;
    cursor: pointer;
    text-decoration: underline;
  }
  .prob-fix-btn {
    background: rgba(0, 122, 204, 0.2);
    border: 1px solid rgba(0, 122, 204, 0.4);
    color: #75beff;
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 10.5px;
    cursor: pointer;
  }
  .prob-fix-btn:hover {
    background: #007acc;
    color: #ffffff;
  }

  /* ---- Terminal Pro & Sidebar VS Code ---- */
  .vsc-legacy-actions {
    display: none !important;
  }
  .term-status-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #4ec9b0;
    margin-right: 6px;
    vertical-align: middle;
  }
  .tabbody.term {
    position: relative;
    display: flex;
    flex-direction: row;
    height: 100%;
    overflow: hidden;
    background: #181818;
  }
  .tabbody.term > pre.out {
    flex: 1;
    margin: 0;
    padding: 10px 14px;
    font-family: "Fira Code", Consolas, monospace;
    font-size: 12.5px;
    line-height: 1.45;
    color: #cccccc;
    overflow-y: auto;
  }
  .tabbody.term > .trow {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    padding: 6px 14px;
    background: #181818;
    border-top: 1px solid #252526;
  }
  .vsc-term-sidebar-pane {
    width: 140px;
    height: 100%;
    background: #181818;
    border-left: 1px solid #2b2b2b;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    overflow-y: auto;
    z-index: 5;
  }
  .vsc-term-side-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    font-size: 11.5px;
    color: #888888;
    cursor: pointer;
    border-left: 2px solid transparent;
    user-select: none;
    transition: background 0.1s ease, color 0.1s ease;
  }
  .vsc-term-side-item:hover {
    background: #222222;
    color: #cccccc;
  }
  .vsc-term-side-item.active {
    background: #1f1f1f;
    color: #ffffff;
    border-left-color: #007acc;
    font-weight: 500;
  }
  .vsc-term-side-ico {
    font-family: monospace;
    font-size: 11px;
    color: #888888;
  }
  .vsc-term-side-item.active .vsc-term-side-ico {
    color: #007acc;
  }
  .vsc-term-side-lbl {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .vsc-term-side-del {
    background: transparent;
    border: none;
    color: #666666;
    font-size: 11px;
    cursor: pointer;
    opacity: 0;
    padding: 0 2px;
  }
  .vsc-term-side-item:hover .vsc-term-side-del {
    opacity: 1;
    color: #aaaaaa;
  }
  .vsc-term-side-del:hover {
    color: #f48771;
  }

  /* ---- Output & Debug & Ports ---- */
  .vsc-output, .vsc-debug, .vsc-ports {
    background: #181818;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .vsc-sub-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: #1e1e1e;
    border-bottom: 1px solid #2b2b2b;
  }
  .vsc-output-log {
    flex: 1;
    margin: 0;
    padding: 10px 14px;
    color: #d4d4d4;
    font-family: "Fira Code", Consolas, monospace;
    font-size: 12px;
    line-height: 1.45;
    overflow: auto;
    white-space: pre-wrap;
  }
  .vsc-debug-logs {
    flex: 1;
    padding: 10px 14px;
    overflow-y: auto;
    font-family: "Fira Code", Consolas, monospace;
    font-size: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .vsc-debug-row.input { color: #569cd6; }
  .vsc-debug-row.result { color: #b5cea8; }
  .vsc-debug-row.error { color: #f48771; }
  .vsc-debug-row.info { color: #888888; font-style: italic; }
  .vsc-debug-inputrow {
    display: flex;
    align-items: center;
    padding: 6px 12px;
    border-top: 1px solid #2b2b2b;
    background: #1a1a1a;
  }
  .vsc-debug-prompt {
    color: #007acc;
    font-weight: bold;
    margin-right: 6px;
    font-family: monospace;
  }
  .vsc-debug-input {
    flex: 1;
    background: transparent;
    border: none;
    color: #d4d4d4;
    outline: none;
    font-family: "Fira Code", Consolas, monospace;
    font-size: 12px;
  }
  .vsc-ports-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .vsc-ports-table th {
    text-align: left;
    padding: 8px 14px;
    border-bottom: 1px solid #2b2b2b;
    color: #888888;
    font-weight: 500;
  }
  .vsc-ports-table td {
    padding: 8px 14px;
    border-bottom: 1px solid #222222;
    color: #cccccc;
  }
  .port-num { font-weight: bold; color: #569cd6; }
  .port-service { font-weight: 500; }
  .port-status-badge {
    padding: 2px 6px;
    border-radius: 10px;
    font-size: 10.5px;
  }
  .port-status-badge.ok { background: rgba(78, 201, 176, 0.15); color: #4ec9b0; }
  .port-status-badge.warn { background: rgba(204, 167, 0, 0.15); color: #cca700; }
  .port-open-btn {
    background: #007acc;
    border: none;
    color: #ffffff;
    padding: 3px 8px;
    border-radius: 3px;
    font-size: 11px;
    cursor: pointer;
  }
  .port-open-btn:hover { background: #0098ff; }

  #panel.maximized {
    width: 100% !important;
    max-width: 100% !important;
    z-index: 100;
  }

  /* ---- Barre d'état inférieure officielle VS Code (Status Bar) ---- */
  .vsc-statusbar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 22px;
    background: #007acc;
    color: #ffffff;
    font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
    font-size: 11px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px;
    z-index: 1000;
    user-select: none;
    line-height: 22px;
  }
  .vsc-sb-left, .vsc-sb-right {
    display: flex;
    align-items: center;
    height: 100%;
    gap: 2px;
  }
  .vsc-sb-item {
    background: transparent;
    border: none;
    color: #ffffff;
    height: 22px;
    padding: 0 6px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    border-radius: 2px;
    outline: none;
    white-space: nowrap;
    transition: background 0.1s ease;
  }
  .vsc-sb-item:hover {
    background: rgba(255, 255, 255, 0.2);
  }
  .vsc-sb-item:active {
    background: rgba(255, 255, 255, 0.3);
  }
  .vsc-sb-ico {
    display: inline-flex;
    align-items: center;
    font-size: 11px;
  }
  .vsc-sb-ico.vsc-err {
    color: #ffd7d7;
  }
  .vsc-sb-ico.vsc-warn {
    color: #fff3c4;
  }
  /* Padding bas sur le conteneur principal pour ne pas chevaucher la statusbar */
  body {
    padding-bottom: 22px;
  }

`;

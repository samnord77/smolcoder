# smolcoder — TODO

## Done

- [x] **AGENTS.md memory files** — injected after the system prompt, size-capped (~2k tokens),
      survives compaction. Pirate-tested on Ollama and LM Studio.
- [x] **Plan tool** — harness-held checklist (set/done/add/show), TUI + web rendering,
      compaction re-injection, quit-halfway nudge. Proven in real runs on both backends.
- [x] **Web UI** (`--web`) — TUI twin over SSE, localhost + URL token.
- [x] **Web UI v2: workspace hub** — `smol --web` from anywhere; a collapsible sidebar of workspaces
      and their sessions (status dots, new/close/delete/rename, folder picker), many sessions running side
      by side, transcripts saved under `~/.smolcoder/sessions/` and resumable after a restart, a second
      `smol --web` joins the running hub. Right panel with browser tabs (dev-server URLs suggested) and
      streaming terminal tabs (persistent shell, no PTY).
- [x] **Model-written session titles** in the web sidebar — one call with thinking off after the first
      turn replaces the verbatim first message; manual renames are never overwritten.
- [x] **Markdown rendering in the web page.**
- [x] **Reasoning effort that means what it says on LM Studio** — reads the model's supported
      levels and default from `/api/v1/models`, sends `none` for off, snaps other levels to what the
      model has. (Previously "high" fell back to the model default — `xhigh` on qwen3.x — and "off"
      did nothing on models without the `/no_think` switch.)
- [x] **Speed readout** — every turn ends with tool count, tokens generated, tok/s; headless runs
      print a `[stats]` JSON line for scripted backend comparisons.
- [x] **Post-write syntax check hook** — JS/JSON/HTML-inline-script/Python parse errors come back on
      the write_file/edit_file result with a line number.
- [x] **Compaction v2** — structured hand-over notes written with thinking off, old reasoning traces
      not replayed, stale reads of overwritten files evicted immediately.
- [x] **Ollama keep_alive** — the model stays resident 30 min between calls (`SMOLCODER_KEEP_ALIVE`).
- [x] **Unit tests** — `npm test` (node:test, no deps).
- [x] **Real tier-2 compaction on a live model** — `bench/run.sh mc-compact <model> off --ctx 12000`:
      tier-1 eviction then a hand-over-notes compaction (7.5k → 2.1k tokens) on LM Studio, five
      compactions on Ollama; both finished the build with the plan intact. Headless logs show the tier.
- [x] **Cut-off tool calls are coached** — an oversized write_file that overflows the output cap
      now gets "not executed, write it in parts" instead of a generic "continue".
- [x] **Visible YOLO mode** — `bypass` shows as `YOLO bypass` with a red banner at startup (CLI + web flag).
- [x] **Desktop app mode** — `smol --web --app` opens the hub in its own Chrome/Edge window (own profile), plain browser tab otherwise; Kaggle GPU recipe in `docs/kaggle.md` (remote address flow, no key yet).
- [x] **IDE-grade web extras** — desktop notifications (bell, approvals/turn-end/errors, silent while watching), sub-agent start/done lines on CLI + TUI + web, color diffs on edits.
- [x] **Pro TUI extras** — `/mcp` lights (●/○ + tools, both UIs), `/skills` list, terminal bell on approval/finish/error; multi-project stays web-side (one dossier par terminal, comme des onglets).
- [x] **Visible web dashboard extras** — YOLO label + warning, live verification chip (`vérifié ✓` / `réparation auto N`), color diffs on every `edit_file`, sub-agent progress lines; context meter + plan + tasks already live.
- [x] **VRAM-calibrated startup** — `scripts/vram-check.cjs` reports GPU headroom + Ollama loaded context and recommends `smol --ctx` (floor 4096, cap 32768, same ceiling as the agent).
- [x] **Bounded sub-agents** — `delegate` tool (edit/bypass only, 12 actions max, no nesting, same-or-lower mode) with per-workspace stats in `.smol/delegate-stats.json`.
- [x] **Skills + auto-evolution** — `skill` list/read/save in `.smol/skills/`, matching skills auto-load into each turn, hard repairs auto-save a capped `auto-*` lesson, built-in `impeccable-design` adapted from pbakaus/impeccable (Apache-2.0).
- [x] **Web reading without subscription** — `fetch_url` tool (built-in fetch, public pages only, loopback/private refused, capped output); external browser pilots (browser-use, stagehand, Playwright) documented in `docs/plugins.md` but not vendored (Python/API-key/browser weight vs zero-config promise).
- [x] **Same MCPs as your other assistants** — zero-dependency JSON-RPC client (`src/mcp.ts`), `.smol/mcp.json` config, `mcp` tool with per-server approval, servers die with the session.
- [x] **6 MCP servers installed and proven here (2026-09-24)** — files, memory, fetch, thinking, everything, browser (Playwright, 25 tools, real page read) + git (12 tools); preset in `docs/mcp.json`, project wired in `.smol/mcp.json`; Windows `.cmd` wrappers fixed; servers start in the workspace.
- [x] **All 13 user MCPs wired and proven (2026-09-24)** — `~/.smolcoder/mcp.json` merged under project config (workspace wins): memory (file), sqlite, windows (26 tools), excel, word (50 tools), powerbi (22), n8n, firecrawl (key via environment, never in file), websearch, context7, chrome-devtools (30), scrapling, youtube-transcripts; 19 servers, ~200 tools total.
- [x] **Remote MCP over HTTP (2026-09-24)** — Streamable HTTP transport (JSON + SSE + session ids, `${VAR}` secrets): deepwiki (3 tools, real answer) and zapier (portal, key via env) proven live; laya wired but crashes on start here; c3 alive via `c3_status`.
- [x] **Real LSP code intelligence** — `symbols` tool (hover/def/refs/diag) over typescript-language-server, zero new deps; 2 server quirks fixed (forward-slash URIs, diagnostics need didChange + declared caps).
- [x] **ADHD-style + long memory** — built-in `direct-style` skill (adapted from i-have-adhd, MIT) and `MEMORY.md` loaded into every session like AGENTS.md.
- [x] **Every MCP CLI kept** — `docs/mcp-cli.md` lists all server commands incl. laya; zapier/deepwiki noted remote-only (needs HTTP transport, next step).
- [x] **Durable Cowork work list** — project-scoped personal/work tasks shared by CLI, web and desktop agents; validates dates and limits, supports priorities, notes, status filters, update/complete/archive, and refuses mutations in read-only mode.
- [x] **Enforced specialist sub-agents** — role tool allowlists are applied to the child schemas and checked again at execution; built-in research, project, Office and personal roles; interactive child MCP/command approvals are relayed to the user.
- [x] **Restart-safe work plans** — bounded, atomic project-local plans persist for the CLI and per Web conversation; unfinished work is reintroduced to the model on a fresh CLI turn, while concurrent browser conversations keep isolated plans.
- [x] **File time machine (`/rewind`)** — every turn opens a persisted checkpoint under
      `~/.smolcoder/file-history/<session>/`; `/rewind` lists the last turns, `/rewind <n>` puts every
      file touched since turn n back to its state at the turn's start (created files removed, moves
      reverted, empty folders cleaned); 2 MB per-file cap, content-addressed blobs, atomic index,
      best effort — never blocks a write.
- [x] **Auto-pilot mode (`auto`)** — fourth permission mode between edit and bypass (`--mode auto`,
      `/mode auto`, shift+tab cycle, web menu). Outside the workspace, commands recognized as plainly
      read-only (`src/approvals.ts`: listings, reads, git log/diff/status, tool `--version`) run without
      asking and log what they did; chained, destructive or state-changing commands still ask y/n, and
      MCP approvals are unchanged. Never more permissive than a human who reads the command.
- [x] **Scheduled prompts (`/routine`)** — project-scoped routines in `.smol/routines.json`
      (`src/routines.ts`), cadences in English and French (`every 30m`, `hourly`, `every day at 09:00`,
      `weekdays at 08:30`, `every monday at 10:00`, `chaque lundi à 10:00`…). A 30 s `unref`'d tick per
      session claims each due occurrence exactly once under a cross-window lock and runs it through the
      normal turn path (so routines respect the mode, the file time machine and the journal); overdue
      routines are caught up on the next tick. `/routine add <cadence> | <text>`, `list`, `run`, `on`,
      `off`, `remove`; TUI + web (menu « Routines planifiées »).
- [x] **Cold language-server handshakes (`symbols` panels)** — the first `initialize` gets its own
      90 s budget (`INIT_TIMEOUT_MS` in `src/lsp-pro.ts`; a cold `pylsp` needs ~40 s on a cold
      machine), missing candidates are skipped with `findCommand` and never mask the installed
      server's real failure, and the diagnostics wait ends on the first publication _newer_ than the
      `didChange` — empty or not — so a clean file answers immediately while a cold
      `gopls`/`rust-analyzer` still lands. Verified live: Python (`undefined name 'nam'`, ~22 s cold)
      and Go (`cannot use "hello" … as int`, ~8 s cold) panels.
- [x] **Agent-driven browser (`browser` tool)** — a real local Chrome/Edge driven over the
      Chrome DevTools Protocol with zero dependencies (`src/browser.ts`: native WebSocket,
      `--remote-debugging-port=0` + `DevToolsActivePort`, one browser per session, ten idle
      minutes, temp profile removed on close). One `browser` tool (`src/tools/browser.ts`):
      `open`, `read`, `click`, `type` (optional form submit), `press`, `shot`
      (`.smol/screenshots/browser-*.png`), `back`, `close`. Read-only mode keeps open/read/shot/
      back/close and refuses click/type/press — in the schema and again at execution. Local
      addresses are welcome (dev servers), http/https only; no approval prompt (same posture as
      `fetch_url`). Verified live: a local page opened in ~1 s, read/click/type/back drove the
      DOM, and the screenshot landed as PNG.
- [x] **Agent live view (Navigateur panel)** — every step the agent's browser takes lands in the
      in-app **Navigateur** panel as it happens: each action (open/click/type/submit/press/back)
      captures a jpeg right after it runs (`onLive` in `src/browser.ts`), the session writes the
      newest frame to `.smol/screenshots/live.jpg` and pushes a `BrowserView` to the UI, the
      channel broadcasts it (kept out of the transcript replay, retained as `lastBrowser` so a
      reconnecting page restores it), and the web panel opens one "🤖 agent" tab with a live
      badge, the page title/url and refresh/open-externally buttons, served by the bounded
      `/workspace/asset` image route. The TUI prints one discreet line per step. A sandboxed
      iframe cannot show third-party sites (X-Frame-Options) nor be driven from outside, so the
      panel shows what the agent sees instead.
- [x] **Conversation rewind (`/rewind` chat side)** — `/rewind <n>` now restores the conversation
      as well as the files: every turn records its transcript mark when it opens (`transcriptCount()`
      in `src/agent.ts`, kept in a bounded per-session map), and `rewindTranscript(mark)` truncates
      the model's context back to the start of turn n — the system message always stays and the
      context anchors recalibrate on the next request. `/rewind <n> files` or `/rewind <n> chat`
      (or `conversation`) restores only one side; a turn recorded before this session warns honestly
      instead of pretending. Verified: 58/58 targeted tests (mark capture, both/files/chat, missing
      mark, unknown scope word).
- [x] **Autonomous mission (`/autopilot`)** — `/autopilot <goal>` runs like a Cowork background task:
      the first turn asks the model to write a concrete plan (`plan` tool), then the session loops
      on its own, turn after turn, feeding the remaining plan steps back (`[Pilote automatique —
      tour n/6] ... Étapes restantes`) until every step is verified done — or it stops honestly:
      turn limit (6), 45-minute budget, two consecutive error turns, a cancelled turn, or no plan
      after the first turn. `/autopilot stop` interrupts between turns, `/autopilot` alone shows the
      help/state, read-only mode refuses to start one. Verified: 7/7 tests (`test/autopilot.test.js`).
- [x] **Pro documents (`document` tool)** — the model writes real `.xlsx`, `.docx`, `.pptx` and `.pdf`
      files with zero dependencies: `src/office.ts` builds the OOXML parts (zip via `zlib.deflateRawSync`,
      reproducible headers) and a minimal PDF (Helvetica, wrapped lines, exact xref); `src/tools/office.ts`
      exposes structured JSON (`sheets` / `blocks` / `slides` / `lines`, bounded) and returns a French summary.
      Opens directly in Excel, Word, PowerPoint and any PDF reader. Verified: 7/7 tests with a real zip reader
      (`test/office.test.js`); hidden in read-only mode.
- [x] **Code review copilot (`/review`) + GitHub (`github` tool)** — `/review` now turns the copilot into a
      reviewer: it inspects the uncommitted diff (or a base branch you name) and reports issues file by file
      with severity (🔴/🟠/🟡), `file:line` references, concrete fixes, positives and a verdict — `/review diff`
      and `/review staged` keep the raw hunk view. The new `github` tool drives the signed-in `gh` CLI:
      `status`, `pr_list`, `pr_view`, `pr_checks`, `issue_list`, `issue_view` in every mode; `pr_create`
      (title/body/base/draft) in editing modes only; a missing `gh` is reported honestly. Verified: 6/6 tests
      (`test/github.test.js`) + 2/2 review request tests (`test/review.test.js`).

## Outstanding

- [ ] **Human pass on the terminal TUI** — puppet-tested and the web twin is visually verified, but
      no human has driven the real terminal UI in a while (logo, slash menu, shift+tab, pickers,
      approval prompt, esc-cancel mid-stream).
- [x] **Per-backend effort memory** — Ollama and LM Studio retain independent reasoning settings; explicit default is preserved, old configs remain valid, and switching backends loads its saved setting.
- [x] **Multi-language verification discovery** — auto-runs conventional, fixed test commands for Node scripts, Python pytest projects, Go, Rust, .NET and Maven/Gradle; wrappers are preferred where present and configuration text is never treated as a command.
- [x] **IDE problem panel (Web + Electron)** — TypeScript/JavaScript diagnostics appear when a file is opened and after saving; selecting a problem opens the reported file and moves to its line. Requests stay within the selected workspace and unsupported languages explain the current LSP limit.
- [x] **npm publish** — package `smolcoder`, command `smol`; repo at github.com/leonvanzyl/smolcoder. Released as v0.7.1.

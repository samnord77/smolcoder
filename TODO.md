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

## Outstanding

- [ ] **Human pass on the terminal TUI** — puppet-tested and the web twin is visually verified, but
  no human has driven the real terminal UI in a while (logo, slash menu, shift+tab, pickers,
  approval prompt, esc-cancel mid-stream).
- [x] **Per-backend effort memory** — Ollama and LM Studio retain independent reasoning settings; explicit default is preserved, old configs remain valid, and switching backends loads its saved setting.
- [x] **Multi-language verification discovery** — auto-runs conventional, fixed test commands for Node scripts, Python pytest projects, Go, Rust, .NET and Maven/Gradle; wrappers are preferred where present and configuration text is never treated as a command.
- [x] **IDE problem panel (Web + Electron)** — TypeScript/JavaScript diagnostics appear when a file is opened and after saving; selecting a problem opens the reported file and moves to its line. Requests stay within the selected workspace and unsupported languages explain the current LSP limit.
- [x] **npm publish** — package `smolcoder`, command `smol`; repo at github.com/leonvanzyl/smolcoder. Released as v0.7.1.

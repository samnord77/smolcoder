// Agent-loop behaviour with a scripted fake provider: what the model is told
// when its output overflows the cap (the classic local-model "write the whole
// file in one call" failure), and the per-turn stats.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Agent } = require("../dist/agent");
const { ContextManager } = require("../dist/context");
const { EventBus } = require("../dist/events");
const { Plan } = require("../dist/plan");
const { TaskManager } = require("../dist/tools/tasks");

function fakeUi() {
  const lines = [];
  let resets = 0;
  return {
    lines,
    get resets() {
      return resets;
    },
    resetResponse() {
      resets++;
    },
    token() {},
    thinking() {},
    toolCall() {},
    toolResult() {},
    println() {},
    status(s) {
      lines.push(s);
    },
    warn(s) {
      lines.push(s);
    },
    error(s) {
      lines.push(s);
    },
    startSpinner() {},
    stopSpinner() {},
    async confirmCommand() {
      return "yes";
    },
    turnEnd(label) {
      lines.push(`END ${label}`);
    },
    planUpdated() {},
  };
}

function scriptedProvider(replies) {
  const seen = [];
  const toolsets = [];
  let i = 0;
  return {
    seen,
    toolsets,
    label: "fake",
    modelId: "fake",
    contextWindow: 8000,
    maxOutputTokens: 2000,
    setEffort() {},
    effortLabel() {
      return null;
    },
    async chat(messages, tools) {
      seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
      toolsets.push((tools ?? []).map((t) => t.name));
      const r = replies[Math.min(i++, replies.length - 1)];
      return { content: "", toolCalls: [], generatedTokens: 100, genTokPerSec: 50, promptTokens: 500, completionTokens: 20, ...r };
    },
  };
}

function makeAgent(provider, ui, mode = "bypass", interactive = false) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tc-agent-"));
  const toolCtx = { workspace: ws, taskManager: new TaskManager(ws), plan: new Plan(), filesTouched: new Set(), commandsRun: [] };
  return new Agent(provider, mode, "sys", toolCtx, new ContextManager(8000, 2000), new EventBus(), ui, interactive, 20);
}

test("alternating unchanged reads stop with a recoverable error before the model-step limit", async () => {
  const replies = Array.from({ length: 12 }, (_, i) => ({
    content: "",
    toolCalls: [{ id: `r${i}`, name: "read_file", args: { path: i % 2 ? "b.txt" : "a.txt" } }],
  }));
  const agent = makeAgent(scriptedProvider(replies), fakeUi());
  fs.writeFileSync(path.join(agent.toolCtx.workspace, "a.txt"), "first module");
  fs.writeFileSync(path.join(agent.toolCtx.workspace, "b.txt"), "second module");
  await assert.rejects(agent.runTurn("implement the next module"), /same unchanged data/);
  assert.equal(agent.outcome, "error");
  assert.equal(agent.lastTurnStats.toolCalls, 9);
  assert.match(agent.messages.at(-1).content, /Do not restart the same reads/);
});

test("rewindTranscript truncates the conversation back to a saved mark", async () => {
  const replies = [{ content: "", toolCalls: [{ id: "r0", name: "read_file", args: { path: "a.txt" } }] }, { content: "Fini." }];
  const agent = makeAgent(scriptedProvider(replies), fakeUi());
  fs.writeFileSync(path.join(agent.toolCtx.workspace, "a.txt"), "module");
  const mark = agent.transcriptCount();
  assert.equal(mark, 1, "a fresh agent only holds the system message");
  await agent.runTurn("lis a.txt");
  assert.ok(agent.transcriptCount() > mark, "the turn added messages");
  const dropped = agent.rewindTranscript(mark);
  assert.equal(agent.transcriptCount(), mark, "the transcript is back to the mark");
  assert.equal(dropped, 4);
  assert.equal(agent.rewindTranscript(0), 0, "the system message always stays");
  assert.equal(agent.transcriptCount(), 1);
});

test("a local-PC folder search requires and accepts observed filename-search results", async () => {
  const provider = scriptedProvider([{ content: "Voici le résultat de la recherche réelle." }]);
  const agent = makeAgent(provider, fakeUi(), "ro");
  fs.mkdirSync(path.join(agent.toolCtx.workspace, "DeepSeek-data"));

  await agent.runTurn("recherche sur mon pc le dossier de DeepSeek dans le workspace");

  assert.equal(agent.outcome, "completed");
  assert.equal(agent.lastTurnWorkspaceEvidence, true);
  assert.ok(provider.toolsets[0].includes("find_local"));
  assert.equal(
    agent.lastTurnStats.toolCalls,
    1,
    "the host executes the deterministic local lookup without relying on the model to call a tool"
  );
  assert.ok(provider.seen[0].some((message) => message.role === "tool" && message.content.includes("DeepSeek-data")));
  const result = agent.messages.find((message) => message.role === "tool" && message.toolName === "find_local");
  assert.match(result.content, /DeepSeek-data/);
  assert.match(result.content, /File contents were not opened/);
});

test("project analysis cannot be reported as complete without workspace tool evidence", async () => {
  const fabricated = "Analyse complète : le fichier src/fake.ts contient une erreur.";
  const ui = fakeUi();
  const provider = scriptedProvider([{ content: fabricated }, { content: fabricated }]);
  const agent = makeAgent(provider, ui);

  await assert.rejects(agent.runTurn("Analyse ce projet en profondeur et relève les anomalies."), /aucun outil n'a consulté le workspace/);
  assert.equal(provider.seen.length, 2, "one bounded retry asks the model to inspect the workspace");
  assert.equal(ui.resets, 2, "both unverified streamed answers are discarded");
  assert.equal(agent.outcome, "error");
  assert.equal(
    agent.messages.some((message) => message.content === fabricated),
    false
  );

  const continuationUi = fakeUi();
  const continuationProvider = scriptedProvider([{ content: fabricated }, { content: fabricated }]);
  const continuationAgent = makeAgent(continuationProvider, continuationUi);
  continuationAgent.currentRequest = "Analyse ce projet en profondeur et relève les anomalies.";
  continuationAgent.messages.push({ role: "user", historyNote: true, content: "[compacted history]" });
  await assert.rejects(continuationAgent.runTurn("Continue"), /aucun outil n'a consulté le workspace/);
  assert.equal(continuationProvider.seen.length, 2, "a short continuation inherits the previous analysis requirement");
});

test("an explicit workspace-change request cannot be reported complete without a successful mutation", async () => {
  const ui = fakeUi();
  const provider = scriptedProvider([{ content: "Done, the feature is implemented." }, { content: "The implementation is complete." }]);
  const agent = makeAgent(provider, ui);

  await assert.rejects(agent.runTurn("Add the missing feature to the workspace."), /aucune modification du workspace/i);
  assert.equal(provider.seen.length, 2, "the agent gets one bounded chance to perform the requested change");
  assert.equal(agent.outcome, "error");
  assert.equal(
    agent.messages.some((message) => /Done, the feature is implemented/.test(message.content)),
    false
  );
});

test("French workspace-change imperatives require an actual successful mutation", async () => {
  for (const request of [
    "Améliore le Copilot et l’autopilot dans le projet.",
    "Ajoute les fonctionnalités manquantes au projet.",
    "Enrichis le Copilot dans le workspace.",
  ]) {
    const provider = scriptedProvider([
      { toolCalls: [{ id: "inspect", name: "list_files", args: { path: "." } }] },
      { content: "C’est terminé, tout est amélioré." },
      { content: "Les changements ont été ajoutés." },
    ]);
    const agent = makeAgent(provider, fakeUi());

    await assert.rejects(agent.runTurn(request), /aucune modification du workspace/i, request);
    assert.equal(
      provider.seen.length,
      3,
      "after inspection, text-only completion receives one bounded opportunity to make the requested change"
    );
    assert.equal(agent.outcome, "error");
  }
});

test("a successful file mutation satisfies the workspace-change gate", async () => {
  const provider = scriptedProvider([
    { toolCalls: [{ id: "write-feature", name: "write_file", args: { path: "feature.md", content: "Implemented feature." } }] },
    { content: "The feature file was written." },
  ]);
  const agent = makeAgent(provider, fakeUi());

  await agent.runTurn("Add the missing feature to the workspace.");

  assert.equal(agent.outcome, "completed");
  assert.equal(fs.readFileSync(path.join(agent.toolCtx.workspace, "feature.md"), "utf8"), "Implemented feature.");
});

test("an Auto Copilot action error cannot be hidden by a text-only completion", async () => {
  const provider = scriptedProvider([
    {
      toolCalls: [{ id: "bad-edit", name: "edit_file", args: { path: "missing.js", old_text: "x", new_text: "y" } }],
    },
    { content: "C'est terminé, tout fonctionne.", toolCalls: [] },
    { content: "Le fichier demandé n'existe pas; indique un chemin valide.", toolCalls: [] },
  ]);
  const agent = makeAgent(provider, fakeUi(), "bypass");

  await assert.rejects(agent.runTurn("Corrige le fichier missing.js dans le projet."), /action de modification ou d’exécution a échoué/i);
  assert.equal(agent.outcome, "error");
  assert.equal(provider.seen.length, 3, "one bounded repair nudge is sent before the hard failure");
});

test("Auto Copilot exposes a complete structured lifecycle while creating and validating work", async () => {
  const phases = [];
  const ui = fakeUi();
  ui.autopilotPhase = (phase, label, details) => phases.push({ phase, label, details });
  const provider = scriptedProvider([
    {
      toolCalls: [
        { id: "mkdir", name: "create_folder", args: { path: "src" } },
        { id: "write", name: "write_file", args: { path: "src/main.js", content: "console.log('ok');\n" } },
      ],
    },
    { content: "Le fichier a été créé et contrôlé.", toolCalls: [] },
  ]);
  const agent = makeAgent(provider, ui, "bypass");

  await agent.runTurn("Crée le module src/main.js dans le projet et vérifie-le.");

  assert.equal(agent.outcome, "completed");
  assert.equal(fs.readFileSync(path.join(agent.toolCtx.workspace, "src", "main.js"), "utf8"), "console.log('ok');\n");
  assert.ok(phases.some((p) => p.phase === "starting"));
  assert.ok(phases.some((p) => p.phase === "planning"));
  assert.ok(phases.some((p) => p.phase === "executing" && p.details?.tool === "create_folder"));
  assert.ok(phases.some((p) => p.phase === "executing" && p.details?.tool === "write_file"));
  assert.equal(phases.at(-1).phase, "completed");
});

test("a planning-only tool call does not count as workspace analysis evidence", async () => {
  const provider = scriptedProvider([
    { toolCalls: [{ id: "plan-only", name: "plan", args: { action: "show" } }] },
    { content: "The project has been fully analyzed.", toolCalls: [] },
    { content: "The project has been fully analyzed.", toolCalls: [] },
  ]);
  const agent = makeAgent(provider, fakeUi());
  await assert.rejects(agent.runTurn("Analyse ce projet et relève ses problèmes."), /aucun outil n'a consulté le workspace/);
  assert.equal(provider.seen.length, 3, "the plan call is followed by one bounded inspection retry");
  assert.equal(agent.lastTurnWorkspaceEvidence, false);
});

test("implicit plan creation renders once; showing it does not re-arm its completion nudge", async () => {
  const provider = scriptedProvider([
    { toolCalls: [{ id: "p1", name: "plan", args: { steps: "Implement; Test" } }] },
    { content: "paused" },
    { toolCalls: [{ id: "p2", name: "plan", args: { action: "show" } }] },
    { content: "blocked and needs clarification" },
  ]);
  let updates = 0;
  const ui = fakeUi();
  ui.planUpdated = () => updates++;
  const agent = makeAgent(provider, ui);
  await agent.runTurn("build");
  assert.equal(provider.seen.length, 4);
  assert.equal(updates, 1);
});

test("a cut-off tool call (empty, truncated, no thinking) is coached to split the file", async () => {
  const provider = scriptedProvider([
    { content: "", toolCalls: [], truncated: true },
    { content: "ok, splitting", toolCalls: [] },
  ]);
  const agent = makeAgent(provider, fakeUi());
  await agent.runTurn("build it");
  const nudge = provider.seen[1].at(-1);
  assert.equal(nudge.role, "user");
  assert.match(nudge.content, /cut off by the output limit of 2000 tokens/);
  assert.match(nudge.content, /NOT executed and nothing was saved/);
  assert.match(nudge.content, /write_file with the first part/);
  assert.doesNotMatch(nudge.content, /reasoning used/);
});

test("an empty truncated reply WITH thinking is blamed on reasoning", async () => {
  const provider = scriptedProvider([
    { content: "", thinking: "hmm hmm hmm", toolCalls: [], truncated: true },
    { content: "answer", toolCalls: [] },
  ]);
  const agent = makeAgent(provider, fakeUi());
  await agent.runTurn("think");
  assert.match(provider.seen[1].at(-1).content, /reasoning used the entire output limit \(2000 tokens\)/);
});

test("reasoning exhaustion uses one action-only retry without changing session effort", async () => {
  const options = [];
  const provider = scriptedProvider([
    { thinking: "long reasoning", truncated: true },
    { toolCalls: [{ id: "read", name: "list_files", args: {} }] },
    { content: "done" },
  ]);
  const chat = provider.chat.bind(provider);
  provider.chat = (messages, _tools, opts) => {
    options.push(opts);
    return chat(messages);
  };
  provider.setEffort = () => {
    throw Error("must not mutate preference");
  };
  const ui = fakeUi();
  const agent = makeAgent(provider, ui);
  await agent.runTurn("make progress");
  assert.equal(agent.outcome, "completed");
  assert.equal(options[0].effortOverride, undefined);
  assert.equal(options[1].effortOverride, "off");
  assert.equal(options[2].effortOverride, undefined);
  assert.ok(ui.lines.some((s) => s.includes("thinking off")));
});

test("a truncated call that arrives as unparseable JSON (LM Studio) gets the same coaching", async () => {
  const provider = scriptedProvider([
    {
      content: "",
      toolCalls: [{ id: "c1", name: "write_file", args: {}, rawArgs: '{"path": "a.js", "content": "....', parseError: "invalid JSON" }],
      truncated: true,
    },
    { content: "ok", toolCalls: [] },
  ]);
  const agent = makeAgent(provider, fakeUi());
  await agent.runTurn("build it");
  const toolMsg = provider.seen[1].find((m) => m.role === "tool");
  assert.ok(toolMsg);
  assert.match(toolMsg.content, /^Error: Your tool call was cut off by the output limit of 2000 tokens/);
});

test("backend deadline failures get bounded action retries before surfacing the blocker", async () => {
  for (const [code, message] of [
    ["BACKEND_IDLE_TIMEOUT", "Backend timed out waiting for data. Check the model server and available memory."],
    ["BACKEND_REQUEST_TIMEOUT", "Backend request timed out. The model did not finish within the request deadline."],
  ]) {
    const ui = fakeUi();
    const provider = scriptedProvider([]);
    let calls = 0;
    provider.chat = async () => {
      calls++;
      const error = Object.assign(new Error(message), { code });
      throw error;
    };
    const agent = makeAgent(provider, ui);

    await assert.rejects(agent.runTurn("continue"), new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // Three in-call retries, and up to two whole-turn restarts around them:
    // the attempts stay bounded, they are just not given up on after three.
    assert.ok(calls >= 3 && calls <= 9, `bounded retries, got ${calls}`);
    assert.ok(ui.lines.some((line) => line.includes("nouvelle tentative automatique")));
    assert.ok(ui.lines.some((line) => line.includes("relance automatique du tour")));
    assert.ok(!ui.lines.some((line) => line.includes("retrying in")));
  }
});

test("a backend timeout is recovered before a requested file mutation", async () => {
  const ui = fakeUi();
  const provider = scriptedProvider([
    { content: "" },
    { toolCalls: [{ id: "create", name: "write_file", args: { path: "autopilot.txt", content: "created after recovery\n" } }] },
    { content: "Fichier créé et vérifié.", toolCalls: [] },
  ]);
  let calls = 0;
  provider.chat = async (_messages, _tools, _opts) => {
    calls++;
    if (calls === 1) {
      const error = Object.assign(new Error("Backend timed out waiting for data. Check the model server and available memory."), {
        code: "BACKEND_IDLE_TIMEOUT",
      });
      throw error;
    }
    const r = [
      { toolCalls: [{ id: "create", name: "write_file", args: { path: "autopilot.txt", content: "created after recovery\n" } }] },
      { content: "Fichier créé et vérifié.", toolCalls: [] },
    ][calls - 2] ?? { content: "Fichier créé et vérifié.", toolCalls: [] };
    return { content: "", toolCalls: [], generatedTokens: 10, promptTokens: 10, completionTokens: 10, ...r };
  };
  const agent = makeAgent(provider, ui, "bypass");
  await agent.runTurn("Crée le fichier autopilot.txt dans le projet.");
  assert.equal(calls, 3);
  assert.equal(fs.readFileSync(path.join(agent.toolCtx.workspace, "autopilot.txt"), "utf8"), "created after recovery\n");
  assert.equal(agent.outcome, "completed");
});

test("a cancelled turn notifies the UI to close pending tool activity", async () => {
  const ui = fakeUi();
  let cancellations = 0;
  ui.turnCancelled = () => cancellations++;
  const provider = scriptedProvider([]);
  provider.chat = async () => {
    const error = new Error("cancelled");
    error.name = "AbortError";
    throw error;
  };
  const agent = makeAgent(provider, ui);
  await agent.runTurn("continue");
  assert.equal(agent.outcome, "cancelled");
  assert.equal(cancellations, 1);
});

test("repeated reasoning exhaustion extends a bounded recovery interval then restores effort", async () => {
  const options = [];
  const read = (i) => ({ toolCalls: [{ id: `read${i}`, name: "list_files", args: { path: ".", limit: 10 + i } }] });
  const provider = scriptedProvider([
    { thinking: "exhausted", truncated: true },
    read(0),
    { thinking: "exhausted again", truncated: true },
    ...Array.from({ length: 4 }, (_, i) => read(i + 1)),
    { content: "done" },
  ]);
  const chat = provider.chat.bind(provider);
  provider.chat = (messages, _tools, opts) => {
    options.push(opts.effortOverride);
    return chat(messages);
  };
  provider.setEffort = () => {
    throw Error("must not mutate preference");
  };
  const agent = makeAgent(provider, fakeUi());
  await agent.runTurn("make progress");
  assert.equal(agent.outcome, "completed");
  assert.deepEqual(options, [undefined, "off", undefined, "off", "off", "off", "off", undefined]);
});

test("turn stats accumulate tokens, speed and tool calls", async () => {
  const provider = scriptedProvider([
    // list_files (not plan: an unfinished plan would trigger the quit-halfway nudge and a third call)
    { content: "", toolCalls: [{ id: "c1", name: "list_files", args: {} }], generatedTokens: 200, genTokPerSec: 100 },
    { content: "done", toolCalls: [], generatedTokens: 50, genTokPerSec: 50 },
  ]);
  const ui = fakeUi();
  const agent = makeAgent(provider, ui);
  await agent.runTurn("go");
  const st = agent.lastTurnStats;
  assert.equal(st.modelCalls, 2);
  assert.equal(st.toolCalls, 1);
  assert.equal(st.generatedTokens, 250);
  // 200 tok @ 100/s = 2 s, 50 tok @ 50/s = 1 s → 250 tok over 3 s ≈ 83 tok/s
  assert.equal(Math.round(st.generatedTokens / st.genSeconds), 83);
  assert.match(
    ui.lines.find((l) => l.startsWith("END ")),
    /1 tool · 250 tok @ 83 tok\/s/
  );
});

test("edit mode: an in-workspace command runs without asking", async () => {
  const provider = scriptedProvider([
    { content: "", toolCalls: [{ id: "c1", name: "run_command", args: { command: "echo hello-from-tree" } }] },
    { content: "done", toolCalls: [] },
  ]);
  const ui = fakeUi();
  let asked = 0;
  ui.confirmCommand = async () => {
    asked++;
    return "no";
  };
  const agent = makeAgent(provider, ui, "edit", true);
  await agent.runTurn("go");
  assert.equal(asked, 0);
  const toolMsg = provider.seen[1].find((m) => m.role === "tool");
  assert.match(toolMsg.content, /hello-from-tree/);
});

test("edit mode: a command reaching outside the workspace asks, with the reason", async () => {
  const provider = scriptedProvider([
    { content: "", toolCalls: [{ id: "c1", name: "run_command", args: { command: "node /tmp/probe.mjs && node /tmp/other.mjs" } }] },
    { content: "done", toolCalls: [] },
  ]);
  const ui = fakeUi();
  const asks = [];
  ui.confirmCommand = async (command, reason) => {
    asks.push({ command, reason });
    return "no";
  };
  const agent = makeAgent(provider, ui, "edit", true);
  await agent.runTurn("go");
  assert.equal(asks.length, 1);
  assert.match(asks[0].reason, /outside the workspace \(\/tmp\/probe\.mjs\)/);
  const toolMsg = provider.seen[1].find((m) => m.role === "tool");
  assert.match(toolMsg.content, /declined/);
});

test("edit mode: a dangerous in-workspace command still asks, with the reason", async () => {
  const provider = scriptedProvider([
    { content: "", toolCalls: [{ id: "c1", name: "run_command", args: { command: "git reset --hard HEAD" } }] },
    { content: "done", toolCalls: [] },
  ]);
  const ui = fakeUi();
  const asks = [];
  ui.confirmCommand = async (command, reason) => {
    asks.push({ command, reason });
    return "no";
  };
  const agent = makeAgent(provider, ui, "edit", true);
  await agent.runTurn("go");
  assert.equal(asks.length, 1);
  assert.match(asks[0].reason, /modifications non committées/);
  const toolMsg = provider.seen[1].find((m) => m.role === "tool");
  assert.match(toolMsg.content, /declined/);
});

test("edit mode: 'always' never covers a dangerous command — it asks again", async () => {
  const provider = scriptedProvider([
    {
      content: "",
      toolCalls: [
        { id: "c1", name: "run_command", args: { command: "git clean -fd" } },
        { id: "c2", name: "run_command", args: { command: "git clean -fd" } },
      ],
    },
    { content: "done", toolCalls: [] },
  ]);
  const ui = fakeUi();
  let asked = 0;
  ui.confirmCommand = async () => {
    asked++;
    return "always";
  };
  const agent = makeAgent(provider, ui, "edit", true);
  require("node:child_process").execFileSync("git", ["init", "-q"], {
    cwd: agent.toolCtx.workspace,
  });
  await agent.runTurn("go");
  assert.equal(asked, 2);
});

test("edit mode, headless: an outside command is refused with coaching instead of hanging", async () => {
  const provider = scriptedProvider([
    { content: "", toolCalls: [{ id: "c1", name: "run_command", args: { command: "cat ~/.npmrc" } }] },
    { content: "done", toolCalls: [] },
  ]);
  const ui = fakeUi();
  ui.confirmCommand = async () => {
    throw new Error("must not prompt when non-interactive");
  };
  const agent = makeAgent(provider, ui, "edit", false);
  await agent.runTurn("go");
  const toolMsg = provider.seen[1].find((m) => m.role === "tool");
  assert.match(toolMsg.content, /^Error: this command uses the home directory/);
  assert.match(toolMsg.content, /--mode bypass/);
});

test("bypass mode never asks", async () => {
  const provider = scriptedProvider([
    { content: "", toolCalls: [{ id: "c1", name: "run_command", args: { command: "echo ~/nothing-is-read" } }] },
    { content: "done", toolCalls: [] },
  ]);
  const ui = fakeUi();
  ui.confirmCommand = async () => {
    throw new Error("bypass must not prompt");
  };
  const agent = makeAgent(provider, ui, "bypass", true);
  await agent.runTurn("go");
  const toolMsg = provider.seen[1].find((m) => m.role === "tool");
  assert.match(toolMsg.content, /nothing-is-read/);
});

test("a matching saved skill is sent to the model and shown in turn status", async () => {
  const provider = scriptedProvider([{ content: "I used the project workflow.", toolCalls: [] }]);
  const ui = fakeUi();
  let loadedSkills = [];
  ui.skills = (names) => {
    loadedSkills = names;
  };
  const agent = makeAgent(provider, ui, "edit", false);
  const { saveSkill } = require("../dist/skills");
  saveSkill(
    agent.toolCtx.workspace,
    "release-checklist",
    "---\nname: release-checklist\ndescription: Prepare a release checklist and version notes\n---\n# Release checklist\nCheck the version and changelog."
  );

  await agent.runTurn("Prepare the release checklist");

  assert.match(JSON.stringify(provider.seen[0]), /Auto-loaded skills selected for this task/);
  assert.match(JSON.stringify(provider.seen[0]), /Check the version and changelog/);
  assert.deepEqual(loadedSkills, ["release-checklist"]);
});

test("the orchestrator's recommended coding skills are actually loaded and shown", async () => {
  const provider = scriptedProvider([
    { toolCalls: [{ id: "inspect", name: "list_files", args: {} }] },
    { toolCalls: [{ id: "fix", name: "write_file", args: { path: "fix.md", content: "Fixed." } }] },
    { content: "The project bug was fixed." },
  ]);
  const ui = fakeUi();
  const loadedSkills = [];
  ui.skills = (names) => loadedSkills.push(...names);
  const agent = makeAgent(provider, ui);

  await agent.runTurn("Fix the bug in this project.");

  assert.ok(loadedSkills.includes("bugfix-workflow"));
  assert.ok(loadedSkills.includes("coding-workflow"));
  assert.match(JSON.stringify(provider.seen[0]), /failing regression test/);
});

test("a generic one-word build request does not inject task-specific recommendation skills", async () => {
  const provider = scriptedProvider([{ content: "Ready when you are." }]);
  const agent = makeAgent(provider, fakeUi());

  await agent.runTurn("Build");

  assert.doesNotMatch(JSON.stringify(provider.seen[0]), /coding-workflow/);
});

test("broad implementation requests get a visible plan and an automatic read-only sub-agent preflight", async () => {
  const provider = scriptedProvider([
    { toolCalls: [{ id: "child-read", name: "list_files", args: { path: "." } }] },
    { content: "Found the file and UI wiring; the parent should handle changes.", toolCalls: [] },
    { toolCalls: [{ id: "p1", name: "plan", args: { action: "done" } }] },
    { toolCalls: [{ id: "p2", name: "plan", args: { action: "done" } }] },
    { toolCalls: [{ id: "p3", name: "plan", args: { action: "done" } }] },
    {
      toolCalls: [
        { id: "write-feature", name: "write_file", args: { path: "src/feature.ts", content: "export const featureReady = true;\n" } },
      ],
    },
    { content: "Completed the implementation.", toolCalls: [] },
  ]);
  const ui = fakeUi();
  const subagentEvents = [];
  const toolEvents = [];
  ui.subagent = (phase, label) => subagentEvents.push([phase, label]);
  ui.toolCall = (name, args) => toolEvents.push([name, args]);
  const agent = makeAgent(provider, ui, "edit", false);
  const request =
    "Please fix, improve, and enrich all of the IDE and Cowork workflows in depth, including agent delegation, project file navigation, live editing, tasks above chat, and clear command output. Keep Electron, Web and CLI behavior synchronized while repairing the real user-facing flows.";

  await agent.runTurn(request);

  assert.equal(agent.outcome, "completed");
  assert.deepEqual(
    subagentEvents.map(([phase]) => phase),
    ["start", "done"]
  );
  assert.match(subagentEvents[0][1], /^implementer:/, "the recommended implementer role is actually assigned to the preflight");
  assert.match(subagentEvents[1][1], /^completed: /);
  assert.equal(toolEvents[0][0], "delegate");
  assert.equal(toolEvents[0][1].tools, "read_file,list_files,search,find_local,symbols");
  assert.deepEqual(
    provider.toolsets[1].sort(),
    ["find_local", "list_files", "read_file", "search", "symbols"],
    "the selected expert retains the strict read-only preflight tool allowlist"
  );
  assert.match(provider.seen[0][0].content, /Sub-agent role: .* \(implementer\)/);
  assert.ok(
    provider.seen[2].some((m) => /Found the file and UI wiring/.test(m.content)),
    "the parent receives the child report after its workspace tool observation"
  );
  assert.match(agent.toolCtx.plan.modelView(), /\[x\]/);
  assert.ok(
    toolEvents.some(([name]) => name === "delegate"),
    "delegation is confirmed by the executed UI tool event"
  );
});

test("delegate announces sub-agent start and done to the UI", async () => {
  const provider = scriptedProvider([
    { content: "", toolCalls: [{ id: "d1", name: "delegate", args: { task: "find login" } }] },
    { content: "sub report", toolCalls: [] },
    { content: "all done", toolCalls: [] },
  ]);
  const ui = fakeUi();
  const subs = [];
  ui.subagent = (phase, label) => subs.push([phase, label]);
  const agent = makeAgent(provider, ui, "bypass", true);
  await agent.runTurn("go");
  assert.equal(agent.outcome, "completed");
  assert.equal(subs[0][0], "start");
  assert.match(subs[0][1], /find login/);
  assert.equal(subs[subs.length - 1][0], "done");
  assert.match(subs[subs.length - 1][1], /completed: 0 actions/);
  const toolMsg = provider.seen.flat().find((m) => m.role === "tool" && /Sub-agent did/.test(m.content));
  assert.ok(toolMsg, "delegate result carries the sub-agent report");
  assert.match(toolMsg.content, /execution=completed; verification=not run/);
});

test("a delegated code change propagates to parent verification and reports its actual outcome", async () => {
  const provider = scriptedProvider([
    { toolCalls: [{ id: "d1", name: "delegate", args: { task: "Create a file in the workspace", tools: "write_file" } }] },
    { toolCalls: [{ id: "w1", name: "write_file", args: { path: "delegated.txt", content: "Created by child." } }] },
    { content: "Created the requested file.", toolCalls: [] },
    { content: "The delegated change is complete.", toolCalls: [] },
  ]);
  const agent = makeAgent(provider, fakeUi(), "bypass", true);

  await agent.runTurn("Create a file in the workspace using a sub-agent.");

  assert.equal(agent.outcome, "completed");
  assert.equal(agent.workspaceChangedThisTurn, true);
  assert.equal(fs.readFileSync(path.join(agent.toolCtx.workspace, "delegated.txt"), "utf8"), "Created by child.");
  const report = agent.messages.find((message) => message.role === "tool" && message.toolName === "delegate");
  assert.match(report.content, /execution=completed; verification=not run/);
  assert.match(report.content, /Files touched: delegated\.txt/);
});

test("a delegated false completion claim is returned to the parent as an error, not a success", async () => {
  const provider = scriptedProvider([
    { toolCalls: [{ id: "d1", name: "delegate", args: { task: "Create a file in the workspace", tools: "write_file" } }] },
    { content: "The file has been created.", toolCalls: [] },
    { content: "It is definitely done.", toolCalls: [] },
    { content: "The sub-agent could not complete the request.", toolCalls: [] },
  ]);
  const ui = fakeUi();
  const subs = [];
  ui.subagent = (phase, label) => subs.push([phase, label]);
  const agent = makeAgent(provider, ui, "bypass", true);

  await agent.runTurn("Delegate this task.");

  const report = agent.messages.find((message) => message.role === "tool" && message.toolName === "delegate");
  assert.match(report.content, /Sub-agent execution=error/);
  assert.match(report.content, /aucune modification du workspace/i);
  assert.equal(fs.existsSync(path.join(agent.toolCtx.workspace, "created.txt")), false);
  assert.match(subs.at(-1)[1], /error: 0 actions/);
});

test("delegated role tool permissions are enforced, not just suggested", async () => {
  const provider = scriptedProvider([
    { toolCalls: [{ id: "d1", name: "delegate", args: { role: "architect", task: "inspect the design" } }] },
    { toolCalls: [{ id: "w1", name: "write_file", args: { path: "forbidden.txt", content: "no" } }] },
    { content: "Architecture report", toolCalls: [] },
    { content: "Done", toolCalls: [] },
  ]);
  const ui = fakeUi();
  const agent = makeAgent(provider, ui, "bypass", true);
  await agent.runTurn("Review architecture");
  assert.ok(!provider.toolsets[1].includes("write_file"));
  assert.match(JSON.stringify(provider.seen[2]), /write_file is not allowed for the architect role/);
  assert.equal(fs.existsSync(path.join(agent.toolCtx.workspace, "forbidden.txt")), false);
});

test("pro expert roles are scoped: read-only experts cannot write, editors can", async () => {
  const { BUILTIN_ROLES } = require("../dist/subagents");
  const byName = Object.fromEntries(BUILTIN_ROLES.map((r) => [r.name, r]));
  // Read-only experts must not be handed any write/edit tool.
  for (const name of ["security_auditor", "performance_profiler", "debugger"]) {
    const t = byName[name].tools.join(" ");
    assert.ok(!/\b(edit_file|write_file)\b/.test(t), `${name} must be read-only`);
  }
  // Editors are allowed to change files.
  assert.ok(/\b(edit_file|write_file)\b/.test(byName.test_engineer.tools.join(" ")), "test_engineer writes tests");
  assert.ok(/\b(edit_file|write_file)\b/.test(byName.refactorer.tools.join(" ")), "refactorer rewrites code");
  // docs_writer writes docs but runs no shell.
  assert.ok(/\b(edit_file|write_file)\b/.test(byName.docs_writer.tools.join(" ")), "docs_writer writes docs");
  assert.ok(!/\brun_command\b/.test(byName.docs_writer.tools.join(" ")), "docs_writer runs no commands");
  // A real enforcement pass: a read-only expert is blocked at the toolset.
  const provider = scriptedProvider([
    { toolCalls: [{ id: "d1", name: "delegate", args: { role: "security_auditor", task: "audit the auth code" } }] },
    { toolCalls: [{ id: "w1", name: "write_file", args: { path: "pwned.txt", content: "no" } }] },
    { content: "Audit report", toolCalls: [] },
    { content: "Done", toolCalls: [] },
  ]);
  const agent = makeAgent(provider, fakeUi(), "bypass", true);
  await agent.runTurn("Audit security");
  assert.ok(!provider.toolsets[1].includes("write_file"), "read-only expert not given write_file");
  assert.equal(fs.existsSync(path.join(agent.toolCtx.workspace, "pwned.txt")), false, "read-only expert cannot create files");
});

test("an interactive office sub-agent relays MCP approval to the user", async () => {
  const provider = scriptedProvider([
    { toolCalls: [{ id: "d1", name: "delegate", args: { role: "office_assistant", task: "prepare a Word report" } }] },
    { toolCalls: [{ id: "m1", name: "mcp", args: { server: "word", tool: "create_document" } }] },
    { content: "Report created", toolCalls: [] },
    { content: "Done", toolCalls: [] },
  ]);
  const ui = fakeUi();
  const approvals = [];
  ui.confirmCommand = async (...args) => {
    approvals.push(args);
    return "yes";
  };
  const agent = makeAgent(provider, ui, "edit", true);
  let calls = 0;
  agent.toolCtx.mcp = {
    call: async () => {
      calls++;
      return "Document created";
    },
  };
  await agent.runTurn("Prepare a report using Word");
  assert.equal(calls, 1);
  assert.equal(approvals.length, 1);
  assert.match(approvals[0][0], /word create_document/);
  assert.ok(provider.toolsets[1].includes("mcp"));
});

test("a fresh coding turn receives the saved project plan as context", async () => {
  const provider = scriptedProvider([{ content: "I will continue the saved checklist.", toolCalls: [] }]);
  const agent = makeAgent(provider, fakeUi());
  const plan = new Plan(agent.toolCtx.workspace, "cli");
  plan.set("Inspect the API\nImplement the repair\nRun verification");
  plan.markDone();
  plan.checkpoint("next: adjust src/service.ts");
  agent.toolCtx.plan = new Plan(agent.toolCtx.workspace, "cli");
  await agent.runTurn("Continue the repair");
  const sent = JSON.stringify(provider.seen[0]);
  assert.match(sent, /Saved project plan from an earlier session/);
  assert.match(sent, /Implement the repair/);
  assert.match(sent, /adjust src\/service.ts/);
});

test("delegate with custom tools spawns a restricted specialist", async () => {
  const provider = scriptedProvider([
    { toolCalls: [{ id: "d1", name: "delegate", args: { task: "find X", tools: "read_file,search", instructions: "Be terse." } }] },
    { content: "found X in a.txt" },
    { content: "done parent" },
  ]);
  const agent = makeAgent(provider, fakeUi());
  await agent.runTurn("do it");
  assert.equal(agent.outcome, "completed");
  assert.deepEqual(provider.toolsets[1].sort(), ["read_file", "search"]);
  assert.ok(agent.messages.some((m) => m.role === "tool" && /found X in a\.txt/.test(m.content)));
});

test("delegate refuses custom tools outside the parent allowlist", async () => {
  const provider = scriptedProvider([
    { toolCalls: [{ id: "d1", name: "delegate", args: { task: "x", tools: "run_command" } }] },
    { content: "done" },
  ]);
  const ui = fakeUi();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tc-agent-"));
  const toolCtx = {
    workspace: ws,
    taskManager: new TaskManager(ws),
    plan: new Plan(),
    filesTouched: new Set(),
    commandsRun: [],
    allowedTools: new Set(["delegate", "read_file", "search"]),
  };
  const agent = new Agent(provider, "bypass", "sys", toolCtx, new ContextManager(8000, 2000), new EventBus(), ui, false, 20);
  await agent.runTurn("do it");
  assert.equal(agent.outcome, "completed");
  assert.ok(agent.messages.some((m) => m.role === "tool" && /must come from your own tool list/.test(m.content)));
  assert.equal(provider.toolsets.length, 2, "no child turn ran");
});

test("delegate validates custom instruction length", async () => {
  const { executeTool } = require("../dist/tools/index");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tc-agent-"));
  const tm = new TaskManager(ws);
  try {
    const ctx = {
      workspace: ws,
      taskManager: tm,
      plan: new Plan(),
      filesTouched: new Set(),
      commandsRun: [],
      delegate: async () => "never",
    };
    assert.match(await executeTool("delegate", { task: "x", instructions: "y".repeat(1001) }, ctx), /under 1000/);
  } finally {
    try {
      tm.killAll();
    } catch {}
  }
});

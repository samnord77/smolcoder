const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyTask, formatOrchestratorSummary } = require("../dist/orchestrator");

test("orchestrator: classifies UI / design tasks correctly", () => {
  const result = classifyTask(
    "Créer une interface Electron impeccable avec un style sombre, boutons modernes et timeline d'activité fluide"
  );
  assert.equal(result.category, "ui_design");
  assert.equal(result.recommendedRole, "expert");
  assert.ok(result.recommendedSkills.includes("impeccable-design"));
  assert.ok(result.recommendedMcp.includes("playwright"));
  assert.ok(result.planSteps.length >= 3);
});

test("orchestrator: classifies bugfix tasks correctly", () => {
  const result = classifyTask("Corriger le bug de crash sur la timeline et réparer l'erreur d'affichage");
  assert.equal(result.category, "bugfix");
  assert.ok(result.recommendedSkills.includes("bugfix-workflow"));
  assert.ok(result.planSteps.some((s) => s.toLowerCase().includes("reproduire")));
});

test("orchestrator: classifies audit and security tasks", () => {
  const result = classifyTask("Auditer la sécurité et la conformité du code, vérifier les vulnérabilités et lancer le linter");
  assert.equal(result.category, "audit_security");
  assert.equal(result.recommendedRole, "quality_reviewer");
  assert.ok(result.recommendedSkills.includes("code-review-workflow"));
});

test("orchestrator: classifies architecture / investigation tasks", () => {
  const result = classifyTask("Analyser l'architecture du projet, explorer les modules et modéliser la structure de dépendances");
  assert.equal(result.category, "investigation");
  assert.equal(result.recommendedRole, "architect");
});

test("orchestrator: classifies feature tasks", () => {
  const result = classifyTask("Ajouter une nouvelle fonctionnalité d'exportation PDF avec des schémas");
  assert.equal(result.category, "feature");
  assert.equal(result.recommendedRole, "expert");
});

test("orchestrator: evaluates complexity and delegation correctly", () => {
  const shortTask = classifyTask("Corriger typo");
  assert.equal(shortTask.complexity, "simple");

  const complexTask = classifyTask(
    "Refondre l'architecture complète de l'application, migrer tous les modules, mettre à jour l'ensemble des dépendances, et aussi reconstruire l'interface utilisateur avec tous les tests et la validation de sécurité"
  );
  assert.equal(complexTask.complexity, "complex");
  assert.equal(complexTask.shouldDelegate, true);
});

test("orchestrator: formats a comprehensive summary", () => {
  const classification = classifyTask("Corriger les régressions et auditer la qualité");
  const summary = formatOrchestratorSummary({
    originalRequest: "Corriger les régressions et auditer la qualité",
    classification,
    filesTouched: ["src/agent.ts", "src/orchestrator.ts"],
    commandsRun: ["npm test", "npm run build"],
    verificationResult: { passed: true, attempts: 1, output: "All checks passed" },
    durationMs: 4200,
    stepsCompleted: { total: 3, done: 3 },
  });

  assert.ok(summary.includes("Synthèse de l'Orchestrateur Automatique"));
  assert.ok(summary.includes("src/agent.ts"));
  assert.ok(summary.includes("Validé avec succès"));
  assert.ok(summary.includes("4.2s"));
});

/**
 * Orchestrateur de tâches automatique pour Smolcoder.
 *
 * Assure les 8 piliers d'automatisation professionnelle :
 * 1. Classification automatique de la demande (catégorie, complexité, intention)
 * 2. Création automatique d'un plan de travail modulaire
 * 3. Choix du sous-agent expert le plus adapté (expert, architect, implementer, quality_reviewer, etc.)
 * 4. Sélection intelligente des skills (impeccable, corriger-un-bug, ecrire-du-code-propre, skillware)
 * 5. Sélection proactive des serveurs MCP requis (code-context-control, memory, context7, etc.)
 * 6. Exécution continue des contrôles de conformité
 * 7. Réparation automatique après échec avec rétroaction guidée
 * 8. Résumé final structuré avec fichiers touchés et validations
 */

export type TaskCategory =
  | "bugfix"
  | "ui_design"
  | "feature"
  | "refactor"
  | "audit_security"
  | "investigation"
  | "docs"
  | "general";

export type TaskComplexity = "simple" | "moderate" | "complex";

export interface TaskClassification {
  category: TaskCategory;
  complexity: TaskComplexity;
  recommendedRole: string;
  recommendedSkills: string[];
  recommendedMcp: string[];
  planSteps: string[];
  shouldDelegate: boolean;
  reasoning: string;
}

export interface OrchestrationSummaryContext {
  originalRequest: string;
  classification: TaskClassification;
  filesTouched: Iterable<string>;
  commandsRun: string[];
  verificationResult?: { passed: boolean; attempts: number; output: string } | null;
  durationMs?: number;
  stepsCompleted?: { total: number; done: number };
}

/**
 * Normalise une chaîne textuelle pour l'analyse heuristique multilingue.
 */
function normalizeText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Détermine la complexité opérationnelle d'une demande.
 */
function assessComplexity(raw: string, normalized: string): TaskComplexity {
  const multiKeywords =
    /\b(tous|toutes|tout|ensemble|global|plusieurs|multiples|et aussi|puis|ensuite|complet|complete|architecture|refonte|chaine|suite)\b/;
  const isMulti = multiKeywords.test(normalized);
  if (raw.length >= 350 || (raw.length >= 150 && isMulti)) {
    return "complex";
  }
  if (raw.length >= 90 || isMulti) {
    return "moderate";
  }
  return "simple";
}

/**
 * Classifier automatiquement une requête utilisateur pour orchestrer les sous-agents,
 * le plan de travail, les compétences et les serveurs MCP.
 */
export function classifyTask(request: string): TaskClassification {
  const normalized = normalizeText(request);
  const complexity = assessComplexity(request, normalized);

  let category: TaskCategory = "general";
  let recommendedRole = "expert";
  let recommendedSkills: string[] = [];
  let recommendedMcp: string[] = ["code-context-control", "memory"];
  let planSteps: string[] = [];
  let reasoning = "";

  // 1. Détection Bugfix / Crash / Régression (prioritaire sur l'affichage visuel)
  if (
    /\b(bug|crash|erreur|error|fix|corriger|reparer|regression|echec|fail|broken|ne marche pas|ne fonctionne pas|probleme|souci)\b/.test(
      normalized
    )
  ) {
    category = "bugfix";
    recommendedRole = complexity === "complex" ? "expert" : "implementer";
    recommendedSkills = ["corriger-un-bug", "revoir-du-code", "skillware"];
    recommendedMcp = ["code-context-control", "memory"];
    planSteps = [
      "Reproduire et isoler la cause exacte de l'erreur sans supposer",
      "Appliquer le correctif minimaliste et ciblé dans le code source",
      "Valider la syntaxe, compiler et exécuter les tests de non-régression",
    ];
    reasoning = "Demande corrective : isolation de la cause racine et vérification stricte par les tests.";
  }
  // 2. Détection UI / Frontend / Electron / Design Impeccable
  else if (
    /\b(ui|interface|css|design|style|theme|sombre|clair|bouton|timeline|activity|bar|electron|affichage|visuel|rendu|ergonomie|impeccable|composant|component)\b/.test(
      normalized
    )
  ) {
    category = "ui_design";
    recommendedRole = "expert";
    recommendedSkills = ["impeccable", "ui-ux-pro-max", "ecrire-du-code-propre"];
    recommendedMcp = ["code-context-control", "memory", "playwright"];
    planSteps = [
      "Auditer l'interface actuelle et cadrer l'expérience utilisateur Impeccable",
      "Concevoir et intégrer les composants avec styles soignés et accessibilité",
      "Vérifier la réactivité, le rendu visuel et la cohérence multi-résolution",
      "Exécuter la compilation et les tests de validation de surface",
    ];
    reasoning = "Demande axée sur l'expérience utilisateur et l'interface : application des standards Impeccable.";
  }
  // 3. Détection Audit / Sécurité / Qualité
  else if (
    /\b(audit|securite|security|vulnerabilite|faille|qualite|lint|revue|review|conformite|kpi|guard)\b/.test(
      normalized
    )
  ) {
    category = "audit_security";
    recommendedRole = "quality_reviewer";
    recommendedSkills = ["skillware", "revoir-du-code"];
    recommendedMcp = ["code-context-control", "memory"];
    planSteps = [
      "Cartographier le périmètre d'audit et analyser les surfaces d'attaque",
      "Exécuter les vérifications statiques, linter et contrôles de sécurité",
      "Formuler le rapport de conformité avec preuves tangibles et remédiations",
    ];
    reasoning = "Demande de sécurité et qualité : audit rigoureux et preuves vérifiables.";
  }
  // 4. Détection Architecture / Investigation / Recherche
  else if (
    /\b(architect|architecture|investig|explorer|analys|cherche|conception|recherche|pourquoi|comment|structure)\b/.test(
      normalized
    )
  ) {
    category = "investigation";
    recommendedRole = "architect";
    recommendedSkills = ["ecrire-du-code-propre", "revoir-du-code"];
    recommendedMcp = ["code-context-control", "context7", "memory"];
    planSteps = [
      "Explorer l'arborescence et cartographier les contrats d'interface existants",
      "Analyser les dépendances et points d'impacts architecturaux",
      "Élaborer la recommandation technique structurée et modulaire",
    ];
    reasoning = "Demande d'exploration/architecture : modélisation et contrats solides.";
  }
  // 5. Détection Refactoring
  else if (
    /\b(refactor|refactoriser|nettoyer|simplifier|modulariser|optimiser|clean)\b/.test(
      normalized
    )
  ) {
    category = "refactor";
    recommendedRole = "implementer";
    recommendedSkills = ["ecrire-du-code-propre", "revoir-du-code"];
    recommendedMcp = ["code-context-control", "memory"];
    planSteps = [
      "Identifier les duplications et responsabilités à clarifier",
      "Réusiner par étapes atomiques en préservant le comportement externe",
      "Recompiler et valider la stricte non-régression via la suite de tests",
    ];
    reasoning = "Refactorisation : simplification continue avec garantie de non-régression.";
  }
  // 6. Détection Nouvelle Fonctionnalité (Feature)
  else if (
    /\b(feature|ajouter|creer|nouvelle|nouveau|implementer|developper|build|enrichir)\b/.test(
      normalized
    )
  ) {
    category = "feature";
    recommendedRole = "expert";
    recommendedSkills = ["ecrire-du-code-propre", "finaliser-une-fonctionnalite"];
    recommendedMcp = ["code-context-control", "memory"];
    planSteps = [
      "Spécifier le contrat d'interface et les types de données nécessaires",
      "Implémenter la fonctionnalité de bout en bout de façon modulaire",
      "Ajouter les tests automatisés et vérifier la compilation",
      "Contrôler la non-régression sur l'ensemble du projet",
    ];
    reasoning = "Création de fonctionnalité : conception typée, tests et finition complète.";
  }
  // 7. Détection Documentation
  else if (
    /\b(doc|documentation|readme|guide|manuel|spec|rediger)\b/.test(
      normalized
    )
  ) {
    category = "docs";
    recommendedRole = "researcher";
    recommendedSkills = ["markdown-mermaid-writing"];
    recommendedMcp = ["code-context-control", "memory"];
    planSteps = [
      "Recenser les fonctionnalités et points d'entrée à documenter",
      "Rédiger la documentation claire avec exemples de code et schémas",
      "Valider la cohérence des liens et des commandes documentées",
    ];
    reasoning = "Documentation technique : clarté, exactitude et exemples reproductibles.";
  } else {
    // Général
    recommendedRole = "expert";
    recommendedSkills = ["ecrire-du-code-propre", "finaliser-une-fonctionnalite"];
    planSteps = [
      "Inspecter le contexte et identifier les leviers d'action",
      "Exécuter les modifications requises avec soin",
      "Valider le résultat et exécuter les contrôles de qualité",
    ];
    reasoning = "Tâche générale : traitement rigoureux avec validation continue.";
  }

  // Décision de délégation automatique (sous-agent)
  const isQuestionOnly =
    /\b(explain|describe|summari[sz]e|tell me|what|why|how|recommend|advise|advice|suggestions|should i|should we|is it worth|expliquer|explique|decrire|resumer|pourquoi|comment|qu'est-ce|devrais-je|conseil|conseiller)\b/.test(
      normalized
    ) && !/\b(fix|corrige|repare|modifie|ajoute|cree|implemente)\b/.test(normalized);

  const shouldDelegate = !isQuestionOnly && (complexity === "complex" || (complexity === "moderate" && category !== "docs"));

  return {
    category,
    complexity,
    recommendedRole,
    recommendedSkills,
    recommendedMcp,
    planSteps,
    shouldDelegate,
    reasoning,
  };
}

/**
 * Produit un résumé final d'orchestration structuré, lisible et traçable.
 */
export function formatOrchestratorSummary(ctx: OrchestrationSummaryContext): string {
  const { classification, filesTouched, commandsRun, verificationResult, durationMs, stepsCompleted } = ctx;
  const filesList = Array.from(filesTouched);

  const sections: string[] = [];

  sections.push("### 🎯 Synthèse de l'Orchestrateur Automatique");
  sections.push(
    `- **Classification :** \`${classification.category}\` (Complexité : *${classification.complexity}*)`
  );
  sections.push(
    `- **Rôle expert mobilisé :** \`${classification.recommendedRole}\` (Délégation : ${classification.shouldDelegate ? "Oui" : "Directe"})`
  );
  sections.push(
    `- **Compétences (Skills) :** ${classification.recommendedSkills.map((s) => `\`${s}\``).join(", ") || "standards"}`
  );
  sections.push(
    `- **Serveurs MCP :** ${classification.recommendedMcp.map((m) => `\`${m}\``).join(", ")}`
  );

  if (stepsCompleted) {
    sections.push(
      `- **Plan de travail :** ${stepsCompleted.done}/${stepsCompleted.total} étape(s) complétée(s)`
    );
  }

  if (filesList.length > 0) {
    sections.push("\n### 🛠️ Fichiers modifiés");
    for (const file of filesList.slice(0, 10)) {
      sections.push(`- \`${file}\``);
    }
    if (filesList.length > 10) {
      sections.push(`- *(et ${filesList.length - 10} autre(s) fichier(s))*`);
    }
  }

  if (commandsRun.length > 0) {
    sections.push("\n### ⚡ Commandes exécutées");
    for (const cmd of commandsRun.slice(-5)) {
      sections.push(`- \`${cmd}\``);
    }
  }

  if (verificationResult) {
    sections.push("\n### 🛡️ Contrôles et validations");
    if (verificationResult.passed) {
      sections.push(`- **Statut :** ✅ Validé avec succès (${verificationResult.attempts} tentative(s))`);
    } else {
      sections.push(`- **Statut :** ❌ Échec des vérifications après ${verificationResult.attempts} tentative(s)`);
    }
  }

  if (durationMs !== undefined && durationMs > 0) {
    sections.push(`\n*⏱️ Durée totale : ${(durationMs / 1000).toFixed(1)}s*`);
  }

  return sections.join("\n");
}

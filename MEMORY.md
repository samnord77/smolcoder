# Mémoire durable du projet

- L’utilisateur veut faire évoluer Smolcoder vers un IDE professionnel, dans ses trois interfaces : terminal/CLI, application de bureau Electron et interface web.
- Vision durable élargie : réunir un IDE et un harnais de codage de niveau professionnel, un assistant de travail et de vie quotidienne (type Cowork), et un SmolClaw unifié ; couvrir progressivement les métiers d’entreprise, Microsoft Office, bibliothèques, skills, outils, MCP et sous-agents réellement disponibles.
- Construire ces capacités de manière intégrée et multi-interface, par incréments solides, avec une expérience accessible à une personne débutante ; distinguer clairement les intégrations disponibles de celles qui restent à créer/configurer.
- Pour le volet Cowork inspiré des outils professionnels 2026 : tâches longues visibles et reprenables, rôles spécialisés avec permissions réellement appliquées, skills/connecteurs configurables, et demande d’accord humain avant toute action externe en mode édition.
- Les plans du harnais doivent aussi survivre aux redémarrages : clés isolées par conversation Web, et reprise stable dans le CLI/headless sans mélanger les agents parallèles.
- Conserver les réglages de raisonnement séparément pour Ollama et LM Studio ; ne pas écraser les préférences d’un serveur lorsqu’on bascule vers l’autre.
- Le harnais de validation doit découvrir les tests des principaux écosystèmes (pas seulement Node) avec des commandes conventionnelles bornées et sans exécuter de scripts arbitraires lus dans les manifestes.
- Continuer les améliorations de façon autonome et incrémentale ; l’utilisateur a explicitement autorisé les corrections et ajouts nécessaires et demande que cette ambition reste en mémoire.
- Priorités : corriger les problèmes réels, enrichir les fonctions de codage et l’expérience d’édition, garder la coloration syntaxique des réponses de code dans toutes les interfaces, et vérifier les changements avec des tests.
- L’analyse LSP des fichiers TypeScript/JavaScript est désormais visible dans les éditeurs Web et Electron à l’ouverture et après enregistrement ; les problèmes sont sélectionnables et la navigation reste bornée au projet. Étendre ensuite les diagnostics à d’autres langages et améliorer l’édition avancée sans installer silencieusement de dépendances.
- L’utilisateur débute en informatique : expliquer les résultats en français simple, ne pas lui transférer les décisions techniques ordinaires et ne pas prétendre que Smolcoder égale déjà les IDE établis tant que cela n’est pas démontré.
- Préserver les changements préexistants dans le dépôt ; inspecter avant d’éditer et ne pas inclure d’autres changements dans un commit.

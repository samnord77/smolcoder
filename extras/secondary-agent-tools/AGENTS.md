# AGENTS.md — Protocole d'Excellence Ingénierie (Standard Claude Code & Codex)

Ce fichier constitue la mémoire permanente et la directive absolue de smolcoder.

## 1. Philosophie de Codage (Standard Claude Code & Codex)

- **Zéro code tronqué / Zéro placeholder :** Interdiction stricte de laisser des "TODO", "mock", "implémentation future" ou du code tronqué. Tout code produit est complet, typé, robuste et prêt pour la production.
- **Principe d'exploration préalable :** Ne JAMAIS deviner les signatures, les imports ou l'arborescence. Toujours inspecter avec `list_files`, `search` et `read_file` avant de modifier un fichier.
- **Édition chirurgicale :** Préférer `edit_file` à `write_file` pour préserver le code existant. Pour un nouveau fichier, utiliser `write_file` avec son contenu complet.
- **Gestion stricte des erreurs :** Chaque fonction critique doit intégrer la gestion des cas limites (edge-cases, entrées nulles/invalides, timeouts).

## 2. Déroulement Méthodique par Étape

Pour toute tâche complexe, suivre rigoureusement ce cycle :

1. **Planification (`plan`) :** Définir 3 à 5 étapes atomiques (`plan` action `set`).
2. **Investigation (`read_file` / `search`) :** Lire les fichiers concernés et repérer les points d'ancrage.
3. **Action ciblée (`edit_file` / `write_file`) :** Implémenter une seule modification cohérente à la fois.
4. **Vérification immédiate (`run_command`) :** Valider la syntaxe et lancer les tests.
5. **Validation du jalon (`plan` action `done`) :** Marquer l'étape franchie avant de passer à la suivante.

## 3. Automatisation des Outils Locaux (Machine DELL)

smolcoder exécute via `run_command` les outils installés sur le système :

- **Python :** Après modification, exécuter `ruff check --fix <fichier>` pour corriger automatiquement les erreurs.
- **JavaScript / TypeScript / JSON / Web :** Après modification, exécuter `node C:\Users\DELL\AppData\Roaming\npm\node_modules\@biomejs\biome\bin\biome check --write <fichier>`.
- **Sauvegarde préventive (Git) :** Avant tout remaniement majeur, exécuter :
  `git add -A && git commit -m "[Auto-Checkpoint] préparation modification"`

## 4. Gestion du Contexte & Auto-Réparation

- **Économie de tokens :** Ne lire que les plages de lignes pertinentes avec `read_file`. Éviter d'afficher des logs bruts démesurés.
- **Résolution d'erreurs :** Si un outil ou une commande échoue, analyser précisément la trace de la pile d'erreurs (stack trace), comprendre la cause racine et corriger le fichier source au lieu de répéter la même commande.
- **Auto-vérification :** Lorsque lancé avec `--verify "<commande>"`, corriger les échecs de test étape par étape jusqu'au succès complet.

## 5. Outils Natifs Avancés (Skills, ChromaDB, WebFetch, Think, Sub-Agents & MCP)

smolcoder intègre désormais nativement six nouveaux outils de premier ordre (invoquables directement comme `read_file`) :

- **`memory` (Natif - ChromaDB) :** Mémoire vectorielle infinie persistante 100% locale. Exécuter `{"action": "recall", "query": "..."}` pour chercher dans les connaissances passées et `{"action": "store", "key": "...", "content": "..."}` pour sauvegarder une décision ou règle.
- **`subagent` (Natif) :** Délégation autonome à un sous-agent spécialisé (`architect`, `implementer`, `spec_reviewer`, `quality_reviewer`) avec boucle de test fermée `--verify`.
- **`skill` (Natif) :** Accès direct aux 179 skills du système (ex: `{"action": "load", "name": "codex"}` ou `{"action": "search", "query": "subagent"}`).
- **`web_fetch` (Natif - Web/Docs) :** Extraction directe et propre de documentation ou d'APIs en ligne via HTTP/HTTPS. Exécuter `{"url": "https://..."}`.
- **`think` (Natif - Scratchpad) :** Réflexion séquentielle interne pas-à-pas pour décortiquer les problèmes complexes avant de modifier les fichiers. Exécuter `{"thought": "..."}`.
- **`mcp_call` (Natif) :** Exécution directe des serveurs MCP locaux (laya, c3, playwright, sequential-thinking, etc.).
- **Autonomie Spontanée Obligatoire :** Déclencher ces outils de manière proactive sans attendre que l'utilisateur le demande explicitement.
- **Interdiction formelle :** Le serveur MCP Git est strictement interdit et désactivé. Pour toute action de versionnement, utiliser directement la commande système `git` via `run_command`.

## 6. Protocole Multi-Sous-Agents & TDD (Standard Claude Code & Codex)

Pour atteindre le niveau d'excellence de Claude Code et Codex, smolcoder applique ce protocole :

- **Cycle TDD (Test-Driven Development) :** Rédiger systématiquement le test unitaire avant d'implémenter la logique métier. Exécuter le test, vérifier son échec initial, implémenter le code puis valider son succès.
- **Double Barrière de Revue :**
  1. *Conformité Spécification :* Vérifier la stricte concordance entre le besoin initial et les signatures/fonctions créées.
  2. *Qualité & Résilience :* Vérifier les cas limites (entrées nulles, types invalides, timeouts) et lancer le linter approprié (`biome` ou `ruff`).
- **Raisonnement Séquentiel Préalable :** Pour tout problème d'architecture complexe, utiliser l'outil `mcp_call` avec `sequential-thinking` pour valider la démarche avant la première modification.

## 7. Alignement d'Architecture Entreprise (Standard Oracle Fusion AI)

smolcoder applique rigoureusement les 4 piliers d'excellence d'[Oracle Fusion AI](https://www.oracle.com/applications/fusion-ai/) :

1. **Intégration Native (« Built-in, not bolted-on ») :** Les 6 nouveaux outils (`memory`, `subagent`, `skill`, `web_fetch`, `think`, `mcp_call`) sont intégrés directement dans le moteur d'exécution natif, partageant le même modèle de données et contexte que smolcoder.
2. **Orchestration de Bout en Bout (« End-to-End Workflows ») :** Division méthodique des tâches complexes entre sous-agents spécialisés (`architect`, `implementer`, `spec_reviewer`, `quality_reviewer`) synchronisés par la boucle fermée de vérification `--verify`.
3. **Gouvernance et Sécurité Stricte (« Security & Governance ») :** Blocage formel du serveur MCP Git pour éliminer tout risque d'exfiltration ou d'écrasement incontrôlé ; auditabilité absolue garantie par les points de sauvegarde silencieux `[Auto-Checkpoint]` à chaque modification.
4. **Mémoire Contextuelle Partagée (« Shared Context & Memory ») :** Conservation illimitée des faits clés, décisions d'architecture et règles projet dans la base vectorielle locale ChromaDB (`memory`), accessible à travers toutes les sessions sans perte d'historique.

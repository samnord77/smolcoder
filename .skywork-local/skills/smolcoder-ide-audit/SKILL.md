---
name: smolcoder-ide-audit
description: Procédure réutilisable pour auditer, corriger, synchroniser et valider Smolcoder entre CLI terminal, web et Electron avec compilation TypeScript, tests, diagnostics MCP/skills/sous-agents, smoke tests et empaquetage Windows. Utiliser pour toute demande de vérification profonde, correction globale, enrichissement ou livraison de Smolcoder.
---

# Audit Smolcoder CLI/Web/Electron

## Objectif

Appliquer une vérification de bout en bout sans perdre les données runtime `.c3/`, `.smol/` ou les sessions. Garder un seul cœur compilé (`dist/`) utilisé par le CLI, le hub web et Electron, puis prouver le résultat par des tests et un paquet reconstruit.

## Procédure

1. Se placer explicitement dans `C:\Users\DELL\smolcoder-source`. Lire `AGENTS.md`, `package.json`, `git status --short` et les différences des fichiers concernés. Ne jamais exécuter `git reset --hard`, `git checkout --` ni supprimer `.c3/`, `.smol/` ou `C:\Users\DELL\.smolcoder`.
2. Construire immédiatement avec `cmd /c npm run build`. Toute modification TypeScript dans `src/` doit être suivie d’un nouveau build réussi.
3. Auditer les contrats partagés :
   - outils agent dans `src/tools/index.ts` et permissions `ro/edit/bypass` ;
   - skills dans `src/skills.ts`, rôles dans `src/subagents.ts` ;
   - MCP fusionné depuis l’utilisateur et le workspace dans `src/mcp.ts` ;
   - routes hub dans `src/web/hub.ts` ;
   - client partagé `src/web/client.ts`, styles `src/web/styles.ts` et pages Electron.
4. Tester les flux critiques : terminal persistant et couleurs ANSI, revue staged/unstaged et hunks, preview HTML confiné, `/status`, `/code/*`, collaboration CRDT, MCP, LSP, plan/TODO, compactage de contexte et délégation.
5. Pour les MCP, exécuter `node desktop/mcp-status.js` après compilation. Distinguer serveur sain, serveur lent, serveur désactivé, clé/API manquante et binaire absent. Ne pas désactiver automatiquement un serveur sans preuve.
6. Corriger les défauts reproductibles avec les abstractions existantes. Préserver le contrat historique des réponses web quand des clients Electron plus anciens le consomment ; enrichir la réponse plutôt que supprimer des champs.
7. Valider par lots :
   - `cmd /c npm test`
   - `node --test test/client-smoke.test.js`
   - `node --test test/web.test.js`
   - `node desktop/smoke.js` si un hub est actif
   - `node --check desktop/main.js` et `node --check desktop/preload.js`
   - `git diff --check`
8. Régénérer le paquet avec `cmd /c npm run package-win` seulement après build/tests verts. Vérifier `release/Smolcoder-win32-x64/resources/app/dist` et la syntaxe du `desktop/main.js` empaqueté.
9. Rapporter honnêtement les limites externes : backend modèle absent, MCP distant sans clé, outil non installé, timeout réseau ou smoke impossible faute de hub.

## Règles d’optimisation

* Utiliser des commandes PowerShell directes, sans pipelines Unix avec npm.
* Préférer `rg` ciblé aux recherches globales.
* Ne pas considérer une présence dans `src/` comme une activation : vérifier le chemin UI réel et les routes hub.
* Après toute correction de client embarqué, lancer les tests smoke qui exécutent le bundle dans un DOM minimal.
* Si un test échoue, isoler d’abord le fichier avec `node --test ...`, corriger la cause, puis relancer la suite complète.

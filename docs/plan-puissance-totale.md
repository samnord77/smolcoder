# Plan Puissance Totale — suivi d'avancement

Plan de l'utilisateur (2026-10-10), découpé en 3 piliers, appliqué un pilier à
la fois avec validation (build + QA + tests) et commit de sauvegarde.

## Pilier 1 — Unification visuelle Bureau (⊞ Split + Δ Diff Git) — FAIT 2026-10-10

- **Bouton `⊞` (vue fractionnée)** : un second éditeur Monaco s'ouvre à droite
  de l'éditeur principal ; tant qu'il est actif, cliquer un onglet charge ce
  fichier dans le volet droit (côté à côte, édition indépendante avec
  `Ctrl+S` propre au volet via `saveSplit` ; le volet suit les modèles Monaco
  partagés, la saleté/dirty est suivie par les onglets ; fermer l'onglet
  affiché libère le volet). Le ghost-text LSP/IA est désactivé sur le volet
  secondaire pour ne pas interroger le mauvais fichier.
- **Bouton `Δ Diff` (comparaison Git)** : compare le fichier ouvert avec sa
  version `HEAD` (diff éditeur Monaco, original à gauche, modifications à
  droite, éditables) ; `gitShowFile` (nouveau, `src/git.ts`) lit `git show
  HEAD:<chemin>` avec contenance au workspace, borne 1 Mo et descente rapide
  pour les fichiers non suivis (comparaison avec un fichier vide).
- **IPC** : `ed:gitShow` (main.js) → `gitService.showFile` (desktop/git-service.js),
  exposé en `window.smolEd.gitShow` (preload.js).
- **Validation** : `npm run build` exit 0, `npm run qa` vert, `git.test.js`
  13/13 (dont `gitShowFile`), `desktop-startup` 4/4, `editor-ui` 2/2,
  `i18n` 2/2, `web.test` 30/30, `desktop:smoke` 7/7.

## Pilier 2 — Auto-Réparation Terminal 1 clic (🤖 Réparer l'erreur) — À FAIRE

## Pilier 3 — Navigation chirurgicale (F12 / Ctrl+Clic + symboles @ dans Ctrl+P) — À FAIRE

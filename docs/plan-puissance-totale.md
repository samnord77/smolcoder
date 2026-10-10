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

## Pilier 2 — Auto-Réparation Terminal 1 clic (🤖 Réparer l'erreur) — FAIT 2026-10-10

- **Bouton `🤖 Réparer l'erreur`** : toute commande qui échoue dans le tiroir
  terminal affiche ce bouton sous la trace d'erreur. Un clic construit un
  contexte IA borné (commande + sortie/erreur, 4 000 caractères), ouvre le
  fichier fautif extrait de la trace et pré-remplit la barre inline avec la
  demande de correction (aperçu à valider avec Ctrl+S).
- **Module partagé `src/term-fix.ts`** : `extractSourcePath(trace, root)` lit
  les chemins Windows/Posix absolus, `src/…`, `test/…`, les rapports Python
  `File "…"` et les chemins contenant des espaces ; ignore `node_modules`,
  `dist`, `build`, `coverage`, `app.asar` ; ne retourne jamais un fichier hors
  du workspace (les chemins absolus sous `root` sont convertis en chemins
  relatifs) ; `buildTermErrorText(cmd, output, errText)` borne la commande à
  1 000 caractères et la trace à 4 000.
- **Pont** : `desktop/preload.js` expose `window.smolEd.buildTermErrorText` et
  `window.smolEd.extractSourcePath` (rendu Electron) ; `editor.html` garde un
  repli minimal hors Electron.
- **Validation** : build exit 0, qa vert, `term-fix.test.js` 7/7, `editor-ui`
  2/2, `desktop:smoke` 7/7.

## Pilier 3 — Navigation chirurgicale (F12 / Ctrl+Clic + symboles @ dans Ctrl+P) — FAIT 2026-10-10

- **Cœur LSP (`src/lsp-pro.ts`, commit `aef57a7`)** : nouvelles requêtes
  structurées `queryDefStructured` (définition → chemin/ligne/colonne) et
  `querySymbolsStructured` (symboles d'espace de travail bornés à 20) ; les
  anciennes réponses texte (`fmtLoc`, `fmtWorkspaceEdit`) passent désormais par
  `uriToAbs`, ce qui corrige la conversion des URI `file:///C:/…` sous Windows
  (avant : `../../C:/…`, un chemin inexploitable pour ouvrir le fichier).
- **Routes du hub** : `/code/definition` (`rel`, `line`, `col`) et
  `/code/wsymbol` (`q`, `lang`), réponses JSON bornées par session.
- **Pont desktop** : IPC `ed:definition` / `ed:wsymbol` dans `desktop/main.js`,
  exposés en `window.smolEd.definition` / `window.smolEd.wsymbol`
  (`desktop/preload.js`).
- **Rendu Bureau (`desktop/editor.html`)** : `F12` et `Ctrl+Clic` sautent à la
  définition LSP (le volet fractionné et la vue texte ont leur repli) ; la
  palette (`Ctrl+P`) accepte le préfixe `@` et cherche les symboles du
  workspace (debounce 220 ms, garde anti-réponses obsolètes, entrée → ouverture
  du fichier, curseur posé sur la ligne/colonne et recentrage).
- **Rendu Web (`src/web/client.ts`)** : mêmes raccourcis sur l'éditeur Monaco
  de l'onglet actif et même mode `@` dans la palette, alimentés par les routes
  `/code/definition` et `/code/wsymbol`.
- **Validation** : `npm run build` exit 0, `npm run qa` (typecheck + lint +
  format) vert, suites ciblées 69/69 (`lsp-pro`, `editor-ui`, `web`, `git`,
  `term-fix`, `desktop-startup`), suite complète 458/458, `desktop:smoke` 7/7.

## Enrichissements — gouttière Git, bouton « + », FlagshipRouter, correctif Ollama (2026-10-10)

### Gouttière Git dans Monaco (Bureau + Web)

- **Cœur partagé (`src/editor-gutter.ts`)** : `diffLines(head, current)` puis
  `gutterDecorations(head, current)` donnent, pour chaque ligne du fichier
  ouvert, un marqueur `added` / `modified` / `removed` par rapport à la version
  commitée. LCS borné (1 200 × 1 200 cellules, au-delà : « tout a changé »),
  fins de ligne CRLF normalisées, fichier non suivi (`head === null`) = toutes
  les lignes ajoutées. `editorGutterBrowserSource` fournit la version à inliner
  dans la page web ; le preload Electron charge la version compilée depuis
  `dist/`.
- **Bureau (`desktop/editor.html` + `desktop/preload.js`)** : barres verte
  (ajout), bleue (modification), rouge (suppression) à gauche des numéros via
  `linesDecorationsClassName` ; un « + » apparaît au survol d'une ligne dans la
  marge et un clic dessus sélectionne la ligne et ouvre l'édition IA (Ctrl+K).
  Rafraîchissement différé (450 ms) après chaque frappe, immédiat au changement
  d'onglet et à l'enregistrement.
- **Web (`src/web/client.ts` + `src/web/styles.ts`)** : mêmes barres et même
  bouton « + » sur l'éditeur Monaco de l'onglet actif, alimentés par la nouvelle
  route `/code/git-show` (`sid` + `path`) ; `glyphMargin` est activé, le survol
  de la marge à numéros affiche le « + » et le clic prépare la sélection puis
  ouvre la barre inline existante.
- **Validation** : `editor-gutter.test.js` 9/9 (dont une réécriture de
  4 000 lignes bornée dans le temps), `editor-ui` 2/2 (les deux bundles
  d'éditeur sont du JavaScript navigateur valide), suite ciblée 34/34.

### FlagshipRouter (137 modèles, `gpt-6-astra`)

- **Détection** : `src/hosts.ts` (`FLAGSHIPROUTER_PORT = 20128`),
  `src/detect.ts` (nouveau `BackendKind` `"flagship"`, `flagshipBaseUrls()`,
  `isFlagshipBase()`, sonde ajoutée à `detectAll()`). Le routeur répond en
  OpenAI-compatible sans clé sur `localhost`.
- **Affichage** : `src/session.ts` nomme le fournisseur « FlagshipRouter » et
  l'indice de contexte `flagshiprouter · <ctx> ctx` ; `src/network.ts`
  (`BACKEND_NAMES.flagship`), `src/config.ts`, `src/status.ts`,
  `src/ai-complete.ts` acceptent la même valeur.
- **Réglages** : `FLAGSHIPROUTER_BASE` ou `FLAGSHIPROUTER_URL` pour une autre
  adresse, `FLAGSHIPROUTER_KEY` / `FLAGSHIPROUTER_API_KEY` pour une clé,
  `SMOLCODER_FLAGSHIP=0` pour couper la sonde.
- **Validation** : `flagship.test.js` 5/5, plus une tâche réelle corrigée de
  bout en bout par `gpt-6-astra` (13 appels modèle, 14 appels outil,
  vérification réussie du premier coup).

### Correctif Ollama

- `src/providers/transport.ts` parlait déjà français, mais
  `src/providers/ollama.ts` cherchait encore le texte anglais des erreurs HTTP,
  donc ses échelles de repli ne se déclenchaient jamais : lancer un modèle sans
  commutateur « thinking » (`qwen2.5:3b`) tuait le CLI aussitôt. Les trois sites
  utilisent désormais `isHttp4xx(err)` exporté par transport, et deux tests à
  faux serveur Ollama échouent avec l'ancien code.
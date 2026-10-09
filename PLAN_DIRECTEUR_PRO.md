# Plan Directeur Smolcoder IDE Pro (Excellence & Zéro Régression)

Ce document constitue la feuille de route contractuelle pour transformer Smolcoder en un IDE professionnel complet, autonome et sans régression, avec son Auto-Copilot Pro et son Cowork Pro.

---

## Règle d'Or d'Exécution : Zéro Régression (Principe TDD & Checkpoints)

1. **Un seul composant traité à la fois** : Aucune modification multi-fichiers dispersée.
2. **Point de restauration avant chaque étape** : Commit Git automatique ou sauvegarde préalable.
3. **Validation binaire obligatoire après chaque retouche** : `npx tsc --noEmit && node scripts/test.cjs`. Si un seul test existant échoue, arrêt immédiat et correction avant de poursuivre.

---

## Phase 1 : Assainissement du Socle et Zéro Régression (Fondations Saines)

### Étape 1.1 — Initialisation du Dépôt Git & Point de Contrôle

* **Action :** Initialiser Git à la racine, créer le `.gitignore` protecteur et poser le commit racine.
* **Fichiers :** Racine du projet, `.gitignore`.
* **Validation :** `git status` retourne un arbre propre.

### Étape 1.2 — Nettoyage des 33 Fichiers `.bak` Parasites

* **Action :** Supprimer les fichiers de sauvegarde temporaires dans `src/`, `test/` et `desktop/`.
* **Fichiers :** 13 fichiers `src/*.ts.bak`, 13 fichiers `test/*.test.js.bak`, 7 fichiers `desktop/*.bak`.
* **Validation :** Aucun fichier `.bak` restant sur le disque.

### Étape 1.3 — Réparation du Linter Biome Local

* **Action :** Remplacer le binaire corrompu sous Windows (`0xC0000142`) par l'exécutable propre.
* **Fichiers :** `package.json`, `node_modules/@biomejs/`.
* **Validation :** `npm run lint` s'exécute avec le code retour 0.

### Étape 1.4 — Résolution des 3 Régressions de Tests

* **Action :** Réaligner les expressions régulières bilingues et apostrophes.
* **Fichiers :** `test/codeindex.test.js`, `test/code-api.test.js`.
* **Validation :** `node scripts/test.cjs` passe avec 100 % de succès (zéro échec).

---

## Phase 2 : Le Moteur d'Édition Pro (Monaco Editor)

### Étape 2.1 — Intégration de Monaco dans Electron Desktop

* **Action :** Supprimer le hack `<textarea>`/`<pre>` et instancier Monaco Editor en local.
* **Fichiers :** `desktop/editor.html`, `desktop/editor-file-service.js`, `desktop/main.js`.
* **Fonctionnalités :** Multi-curseurs, minimap, pliage de code, virtualisation pour gros fichiers (> 20 Mo).
* **Validation :** Ouverture fluide d'un fichier de 5 000 lignes sans décalage de curseur.

### Étape 2.2 — Intégration de Monaco dans le Web Hub

* **Action :** Remplacer le `<textarea>` élémentaire par l'instance Monaco liée aux sessions.
* **Fichiers :** `src/web/client.ts`, `src/web/page.ts`.
* **Validation :** Navigation d'onglet et édition sous Monaco dans le navigateur.

### Étape 2.3 — Câblage de l'Intelligence de Code LSP

* **Action :** Brancher les marqueurs d'erreurs en direct, autocomplétion et info-bulles de survol.
* **Fichiers :** `desktop/editor.html`, `src/web/code-api.ts`.
* **Validation :** Soulignement rouge instantané des erreurs de syntaxe et de typage.

---

## Phase 3 : Auto Copilot Pro (Validation Instantanée & Complétion)

### Étape 3.1 — Unification Définitive sur LSP Pro Persistant

* **Action :** Supprimer le lancement de processus éphémères (`src/lsp.ts`) au profit du serveur persistant unique en mémoire (`src/lsp-pro.ts`).
* **Fichiers :** `src/lsp.ts`, `src/lsp-pro.ts`, `src/debug.ts`, `src/workspace-diagnostics.ts`.
* **Validation :** Diagnostics LSP obtenus en moins de 100 ms au lieu de 3 secondes.

### Étape 3.2 — Validation Continue Différentielle

* **Action :** Valider uniquement les fichiers touchés sans bloquer le fil de discussion de l'agent.
* **Fichiers :** `src/continuous-validation.ts`.
* **Validation :** L'agent exécute les vérifications en tâche de fond ultra-rapide.

### Étape 3.3 — Complétion Inline Prédictive (Ghost Text)

* **Action :** Afficher les suggestions grisées en filigrane sous le curseur, validables par `Tab`.
* **Fichiers :** `desktop/editor.html`, `src/web/client.ts`.
* **Validation :** Apparition fluide du texte fantôme lors d'une pause de frappe.

---

## Phase 4 : Cowork Pro (Collaboration Temps Réel & Board)

### Étape 4.1 — CRDT avec Annulation (Undo) Isolée

* **Action :** Gérer des piles d'opérations locales par utilisateur pour que `Ctrl+Z` n'efface pas les modifications distantes.
* **Fichiers :** `src/crdt.ts`.
* **Validation :** Annulation indépendante testée entre deux sessions simultanées.

### Étape 4.2 — Présence et Curseurs Live

* **Action :** Diffuser la position des curseurs et afficher des drapeaux colorés avec les noms des participants.
* **Fichiers :** `src/web/channel.ts`, `src/web/hub.ts`, `desktop/editor.html`.
* **Validation :** Les curseurs des collaborateurs bougent en direct dans l'éditeur.

### Étape 4.3 — Tableau Kanban Interactif Cowork

* **Action :** Interface glisser-déposer pour les cartes de travail et assignation de sous-agents spécialistes.
* **Fichiers :** `src/tools/cowork.ts`, `src/web/client.ts`.
* **Validation :** Synchronisation bidirectionnelle du statut des tâches du projet.

---

## Phase 5 : Les Attributs Vitaux de l'IDE & Packaging Industriel

### Étape 5.1 — Vrai Terminal Intégré (xterm.js + PTY)

* **Action :** Remplacer le terminal rudimentaire par un terminal PTY complet (couleurs ANSI, `htop`, flèches).
* **Fichiers :** `src/web/terminal.ts`, `desktop/main.js`.
* **Validation :** Commandes interactives fonctionnelles dans le terminal intégré.

### Étape 5.2 — Palette de Commandes Rapide (`Ctrl+P` / `Ctrl+Shift+P`)

* **Action :** Recherche floue instantanée de fichiers au clavier et commandes globales.
* **Fichiers :** `desktop/editor.html`, `src/web/client.ts`.
* **Validation :** `Ctrl+P` ouvre instantanément n'importe quel fichier du projet.

### Étape 5.3 — Découpage du Monolithe UI & Packaging Windows

* **Action :** Scinder `src/web/client.ts` (6 350 lignes) en modules typés, sécuriser le build Electron.
* **Fichiers :** `src/web/client.ts`, `desktop/main.js`, `scripts/package-win.cjs`, `scripts/delivery-check.js`.
* **Validation :** Exécution réussie de `node scripts/delivery-check.js` (5/5 contrôles validés).

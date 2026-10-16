# Plugins smolcoder — gratuits, sans abonnement

smolcoder ne vend rien : tout ce qui est dedans est gratuit et tourne sur votre
machine. Les skills (dossier `.smol/skills/`) sont le système de plugins :
un savoir-faire réutilisable que l'agent charge seul pendant les tâches.

## Dedans (rien à installer)

| Domaine | Outil / skill | Coût |
| --- | --- | --- |
| Conception d'écrans | skill `impeccable-design` (adapté de pbakaus/impeccable, Apache-2.0) | gratuit |
| Lecture web (docs, API) | outil `fetch_url` (fetch intégré, sans clé) | gratuit |
| Services externes (mails, feuilles, navigateur…) | outil `mcp` + `.smol/mcp.json` | gratuit, vos serveurs |
| Réparation auto | vérification + leçons `auto-*` | gratuit |
| Mémoire projet | `AGENTS.md`, plan, compaction | gratuit |

## Brancher vos MCP (les mêmes que vos autres assistants)

Ce projet est déjà branché : `.smol/mcp.json` liste les 6 serveurs
vérifiés (copie de `docs/mcp.json`). `mcp {"server": "?", "tool": ""}`
liste serveurs et outils. Pour un autre projet, copiez `docs/mcp.json`
vers `.smol/mcp.json` :

```json
[
  { "name": "files", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
  { "name": "browse", "command": "uvx", "args": ["browser-use[cli]", "--mcp"], "timeoutMs": 90000 }
]
```

Puis `mcp {"server": "?", "tool": ""}` liste les serveurs et leurs outils.
En mode édition chaque serveur demande une fois (`toujours` mémorise par
serveur, jamais pour la prochaine commande) ; en YOLO ça ne demande pas ;
en `-p` sans terminal c'est refusé avec conseil. Les serveurs démarrent dans
le dossier projet (les chemins relatifs comme `"."` pointent dessus) et
meurent avec la session, jamais en tâche de fond.

Désactiver sans supprimer + diagnostiquer :

```json
[
  { "name": "laya", "command": "uvx", "args": ["laya"], "enabled": false }
]
```

- `"enabled": false` = ignoré par `mcp {"server": "?"}` et les appels
  (jamais lancé), mais `/mcp` l'affiche
  `○ laya — désactivé (enabled: false)`. Retirez la ligne ou mettez
  `"enabled": true` pour le réactiver.
- `/mcp` = état rapide de tous les serveurs. `/mcp debug <nom>` = test
  forcé d'un seul serveur (timeout 8000ms) avec le détail : outils listés
  (`files: OK via command "npx …" — 14 tools: …`) ou erreur exacte
  (`laya (désactivé — test forcé malgré enabled: false): ECHEC via … — …`).

## Installés et testés ici le 2026-09-24 (copiez `docs/mcp.json`)

Projet (`.smol/mcp.json`) :

| Serveur | Outils | État |
| --- | --- | --- |
| files (filesystem officiel) | 14 : lecture, écriture, dossiers, recherche | marche, lu un vrai fichier |
| fetch (page web) | 1 : fetch | marche |
| thinking (réflexion pas-à-pas) | 1 : sequentialthinking | marche |
| everything (serveur d'exemple officiel MCP) | 13 | marche |
| browser (Playwright officiel) | 25 : clic, frappe, captures, console | marche, page example.com lue pour de vrai |
| git (dépôt local) | 12 : log, diff, branches, commit | marche, log relu |
| deepwiki (doc de dépôts, distant) | 3 : question, structure, contenu | marche, vraie réponse reçue |

Machine (`~/.smolcoder/mcp.json`, vos chemins) :

| Serveur | Outils | État |
| --- | --- | --- |
| memory (votre fichier) | 9 | marche, écrit puis relu |
| sqlite (votre base) | 6 : requêtes, tables | marche |
| windows (pilote PC) | 26 : fichiers, processus, recherche | marche |
| excel (vos Documents) | 7 : lire, écrire, tableaux | marche, cellule écrite + relue pour de vrai |
| word (50 outils !) | 50 : paragraphes, tableaux, notes, PDF | marche, document créé + relu pour de vrai |
| powerbi (modélisation) | 22 : mesures, DAX, relations | serveur marche ; logique métier dès qu'un modèle est ouvert (rien de connecté ici) |
| n8n (docs et modèles) | 7 : sans serveur local requis | marche, recherche Gmail prouvée (11 nœuds) |
| firecrawl (recherche web) | 27 : scrape, crawl, recherche | marche (clé dans votre variable d'environnement, jamais dans le fichier) |
| websearch (DuckDuckGo) | 1 | marche |
| context7 (docs de libs) | 2 | marche |
| chrome-devtools (vrai Chrome) | 30 : clic, console, réseau, audit | marche |
| scrapling (extraction web) | 13 : sessions, captures | marche |
| youtube-transcripts (transcriptions) | 2 : lister, lire | marche |
| laya (décision, mails, garde-fous) | 5 : decide, email, guard, health, triage | branché, plante au démarrage sur ce PC (code 3221225477) — signale `unreachable`, à retester après mise à jour Python |
| code-context-control (contexte code) | prouvé via `c3_status` | marche, statut vivant reçu |
| zapier (automatisations, distant) | portail + vos actions | marche, clé via `${ZAPIER_MCP_KEY}` uniquement (jamais dans un fichier) |

Distants (`url` + `headers`, transport HTTP intégré) : deepwiki et zapier
prouvés en direct le 2026-09-24.

Écartés : `mcp-server-time` (bloqué au démarrage chez l'éditeur),
`@modelcontextprotocol/server-pdf` (HTTP seul, pas de mode console —
notre client HTTP ne parle que MCP, pas son API maison).

## Dehors (optionnel, à installer vous-même)

Vérifiés le 2026-09-24, licences et étoiles GitHub à cette date :

| Besoin | Projet | Note |
| --- | --- | --- |
| Piloter un vrai navigateur en langage naturel | browser-use/browser-use (~98k ★, MIT, Python) | gratuit et libre, mais demande Python + une clé de modèle payant (ou Ollama local) + un navigateur téléchargé |
| Pilote navigateur économe en jetons | browserbase/stagehand (~24k ★, MIT) | gratuit et libre, mais appels modèle facturés à la clé API |
| Automatiser/capturer des pages en code | Playwright (~95k ★, MIT) + `@playwright/mcp`, `@playwright/cli` | 100 % gratuit, sans abonnement ; ~100 Mo de navigateur au premier usage |

Ils ne sont PAS embarqués : Python, 100 Mo de navigateur et clés API
câbleraient l'installation zéro-config et la vie privée locale. Usage
recommandé : installez-les à côté, puis demandez à smolcoder de les piloter
via `run_command` ou le terminal web, et gardez la recette en skill.

## Ajouter votre plugin (2 minutes)

1. Faites la recette une fois à la main.
2. `skill {"action": "save", "name": "ma-recette", "content": "# étapes\n1. ..."}`.
3. L'agent la rechargera seul quand la tâche ressemble.

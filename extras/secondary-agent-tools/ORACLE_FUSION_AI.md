# Architecture Entreprise : Alignement sur les 4 Piliers Oracle Fusion AI

Ce document détaille la transposition des principes d'architecture d'[Oracle Fusion Cloud Applications AI](https://www.oracle.com/applications/fusion-ai/) au sein de l'écosystème autonome de smolcoder.

---

## 1. Vue d'Ensemble & Philosophie

Oracle Fusion AI postule que pour être efficace, fiable et sécurisée en environnement critique, l'intelligence artificielle ne doit pas être un module rapporté (« bolted on »), mais faire corps avec le moteur d'exécution (« built in »), en partageant le même modèle de données, les mêmes garde-fous de sécurité et la même mémoire continue.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   SMOLCODER ENTERPRISE RUNTIME                         │
├────────────────────────────────────────────────────────────────────────┤
│  1. BUILT-IN ENGINE      │ 14 Outils natifs (ChromaDB, MCP, Subagents) │
│  2. END-TO-END WORKFLOWS │ Orchestration Multi-Agents & Boucle --verify│
│  3. STRICT GOVERNANCE    │ Blocage MCP Git + Git Auto-Checkpoints      │
│  4. SHARED CONTEXT       │ Mémoire Vectorielle Infinie ChromaDB        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Déclinaison des 4 Piliers dans Smolcoder

### Pilier 1 : Intégration Native (« Built-in, not bolted-on »)

- **Principe Oracle :** Les capacités de raisonnement et d'exécution partagent directement la pile technologique et le contexte de l'application sans passer par des connecteurs intermédiaires instables.
- **Implémentation Smolcoder :**
  Les 6 outils d'extension (`memory`, `subagent`, `skill`, `web_fetch`, `think`, `mcp_call`) sont injectés directement dans le fichier compilé `dist/tools/index.js`. Ils disposent d'un accès natif au contexte de session (`ctx.workspace`, `ctx.filesTouched`, `ctx.plan`) et s'exécutent avec des performances instantanées.

### Pilier 2 : Orchestration de Bout en Bout (« End-to-End Workflows »)

- **Principe Oracle :** Les agents ne se limitent pas à générer du texte ; ils accomplissent des processus complets avec validation et correction autonome.
- **Implémentation Smolcoder :**
  Délégation du travail via l'outil `subagent` vers 4 rôles spécialisés :
  1. `architect` : Analyse de dépendances et spécification des interfaces.
  2. `implementer` : Développement rigoureux en TDD (Test-Driven Development).
  3. `spec_reviewer` : Contrôle de conformité par rapport au besoin.
  4. `quality_reviewer` : Audit de résilience, gestion des cas limites et linting.
  La boucle `--verify` exécute les tests en continu jusqu'au succès complet.

### Pilier 3 : Gouvernance et Sécurité Stricte (« Security & Governance »)

- **Principe Oracle :** Contrôle des accès, isolation des environnements et traçabilité inviolable (audit trail).
- **Implémentation Smolcoder :**
  - **Exclusion stricte du serveur MCP Git :** Bloqué au niveau de la passerelle `mcp-bridge.js` pour empêcher toute corruption ou exfiltration de dépôt.
  - **Machine à remonter le temps Git :** Chaque modification via `write_file` ou `edit_file` déclenche un commit silencieux `[Auto-Checkpoint]` permettant un rollback instantané.
  - **Auto-Linter instantané :** Biome (JS/TS) et Ruff (Python) valident et corrigent le code à chaque écriture.

### Pilier 4 : Mémoire Contextuelle Partagée (« Shared Context & Memory »)

- **Principe Oracle :** Les connaissances acquises persistent au-delà d'une session unique et bénéficient à l'ensemble des agents.
- **Implémentation Smolcoder :**
  - **ChromaDB Local :** Base vectorielle persistante stockée dans `chroma_db/chroma.sqlite3` avec le modèle d'embedding `all-minilm` (384 dimensions).
  - **Protocole :** Stockage instantané (`memory store`) et recherche sémantique (`memory recall`) pour retrouver les règles d'architecture et les solutions passées.
  - **AGENTS.md :** Fichier de mémoire permanente préservé lors des compactions de contexte.

---

## 3. Matrice de Conformité

| Exigence Oracle Fusion AI | Composant Smolcoder | Fichier de Contrôle |
| :--- | :--- | :--- |
| Agentic Workflows | Sous-agents spécialisés | `data/agents/*.json` & `tools/index.js` |
| Native Context Access | Catalogue des 14 outils | `inject-native-tools.js` |
| Immutable Audit Trail | Git Auto-Checkpoint | Hook `afterWrite` dans `index.js` |
| Enterprise Skills Library | 32 Skills affinés | `skills/*/SKILL.md` |
| Zero Data Leakage | Blocage MCP Git | `mcp-bridge.js` |
| Long-term Memory | ChromaDB Vector Store | `chroma-memory.py` |

---

## 4. Vérification et Audit

Pour auditer l'ensemble des 4 piliers en action sur votre système :

```powershell
node test-all-tools.js
```

Résultat attendu : 18 succès sur 18 assertions (100% de conformité opérationnelle).

# Smolcoder Desktop (v0.1.0)

IDE bureau Electron autour du hub smolcoder existant. Zero changement du hub.

## Lancer

```powershell
cd C:\Users\DELL\smolcoder-source
npm run build
cd desktop
npm install
npm start
```

`npm start [dossier-projet]` ouvre un dossier precis. Sans argument : le projet
smolcoder-source. Le hub demarre tout seul si besoin (Ollama ou LM Studio requis).

## Contenu

| Fichier | Role |
|---|---|
| `main.js` | Processus principal : hub, fenetres, menus, fichiers editeur |
| `preload.js` | Pont securise (6 fonctions, pas de Node dans l'editeur) |
| `editor.html` | Editeur : arbre + zone de texte + Ctrl+S |
| `hub-client.js` | Client hub Node pur (testable sans Electron) |
| `smoke.js` | Test fumee : `node smoke.js` |

## Menus natifs

Session (nouvelle, annuler, editeur Ctrl+E), Modele (/models), Mode (ro/edit/
bypass + bascule), Effort (off/low/medium/high), Taches (/tasks /plan /context
/compact + terminal), Affichage (zoom, devtools).

Chat, terminal integre, projets et sessions : fenetre principale (hub complet).
Securite editeur : confine au dossier via `dist/sandbox.js`, 1 Mo max.

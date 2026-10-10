# Gros modèles sur Kaggle GPU (sans Nvidia local)

smolcoder pilote n'importe quel serveur Ollama ou LM Studio joignable par
adresse — y compris un GPU Kaggle. Aucune clé smolcoder, aucun compte :
c'est le même circuit que « les modèles d'une autre machine ».

## Recette (10 minutes)

1. Sur Kaggle, lancez un notebook GPU qui sert Ollama
   (`ollama serve`, port 11434) et tirez votre modèle.
2. Exposez le port en HTTPS public (adresse `https://…` stable).
   Le serveur ne doit pas demander de login : smolcoder ne sait pas
   encore présenter de clé API aux serveurs de modèles.
3. Ici : `/models` → **Find models on another machine** →
   **Enter an address** → collez l'adresse `https://…`.
4. Le modèle rejoint la liste avec le nom de la machine ; le dernier
   utilisé est mémorisé avec sa machine.

## Notes

- Le trafic quitte votre PC vers Kaggle : prévoyez `https://`, jamais
  `http://` sur internet (smolcoder prévient avant d'ajouter).
- Une machine éteinte est simplement sautée au démarrage ; ses modèles
  reviennent quand elle se rallume.
- Si le serveur demande une clé (portail hébergé, OpenRouter, passerelle…),
  smolcoder la présente en bearer : fournissez-la au moment d'ajouter
  l'adresse, dans `/models`, ou via la variable d'environnement correspondante
  (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`…). Une clé n'est jamais envoyée à un
  hôte privé ni à une adresse en HTTPS/HTTP non vérifiée, et rien n'est écrit
  dans les fichiers de configuration.

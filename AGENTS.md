# DS-Studio — instructions communes

Lire [START_HERE.md](START_HERE.md). Le contexte appartient à l’étudiant.

## Carte du dépôt

- `app/shared/model.ts` : contrat des tokens, validations, diff et variables CSS.
- `app/server/store.ts` : propositions, journal local et annulations sélectives.
- `app/server/http.ts` : frontière HTTP locale et routes à périmètre fermé.
- `app/client/DesignSystem.tsx` : composants uniques partagés entre les viewers.
- `connectors/agents/` : Codex qualifié, Claude/Gemini explicitement indisponibles.
- `connectors/figma/` : contrat seulement, aucune connexion réseau.
- `workspace/` : PFE, règles, décisions et DS d’exemple versionnables.
- `.ds-studio/` : état privé d’exécution, jamais à commiter.

Ne remplacez pas le mécanisme de validation par un accès fichier libre de l’agent.
Ne laissez pas de commande ou d’écriture proposée s’exécuter automatiquement.
Le chat embarqué refuse toute exécution de commande, plutôt que de fournir une fausse
dialogue de permissions. Le chat ne propose que des tokens connus. Le brief privé possède sa propre API fermée.

## Skills

Codex peut découvrir `.agents/skills/`. Utilisez `$token-change` pour une évolution
de token et `$component-audit` pour vérifier sa propagation. Les autres agents
peuvent lire ces fichiers explicitement ; leur découverte native n’est pas affirmée.

## Vérifications

`npm run check`, `npm test`, `npm run build`, puis `npm run test:e2e` pour un
changement de parcours. Installer Chromium de test par `npx playwright install chromium`
si nécessaire. Ne pas lancer `npm run test:live` sans besoin de qualifier Codex :
il contacte un service IA et peut consommer du quota. `npm run scan` vérifie les
fichiers suivis par Git, sans inspecter les identifiants de la machine.

## V2

Le brief privé est géré par `app/server/project.ts`, son schéma par
`app/shared/project.ts`. Les écritures atomiques partagées sont dans
`app/server/files.ts`. Lire `docs/V2_CHANGELOG.md` pour les nouvelles frontières.
La récupération explicite utilise le même bail que le serveur. Ne contournez pas
ce bail et ne remplacez jamais une restauration par un effacement de `.ds-studio/`.

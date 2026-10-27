# Audit V2 et backlog priorisé

Référence : `ed6ead0`, V1.1 publiée sur origin/main et tag `v1.1.0-launchers`.
Arbre local initial propre ; tag `v1.0.0-starter` préservé. Audit du 27 octobre 2026.

## Observations

- CI V1.1, run 40418398973 : build, tests API et navigateur réussis sur les trois OS ; lanceurs en échec partout. Aucun succès global antérieur.
- Ubuntu : test de découverte Node dépendant de la machine (attend un Node utilisateur alors que /usr/local/bin/node est valide).
- Windows : après crash du panneau, PID du serveur perdu. Le serveur hérite de pipes du panneau ; indépendance du processus à corriger et qualifier.
- macOS : refus après un verrou de PID étranger mort, puis cascade de tests. Cause initiale non établie par les logs V1.1, insuffisamment détaillés ; diagnostic ajouté aux assertions. Les cas suivants ne prouvent pas des pannes indépendantes.
- Persistance : remplacement atomique et file de commits présents ; aucune copie de secours de l’état précédent ni récupération guidée.
- Interface : rechargement perd le brouillon ; session HTTP non renouvelée après redémarrage ; état manuel inutilement couplé à la détection IA.
- Architecture : composants réellement partagés, imports stricts et refus de propositions périmées déjà présents. Profil Codex sans outils conservé. Claude/Gemini et Figma non implémentés, sans simulation.

## Hypothèses / limites de qualification

Les protections Gatekeeper/SmartScreen, les stratégies Windows Script Host, les gestionnaires de fichiers et les droits des postes étudiants ne sont pas validés par une CI. Installation Node officielle nécessaire ; aucune installation privilégiée automatique. La survie Windows après crash doit être prouvée par la nouvelle CI, pas déduite du code.

## Backlog choisi

| Priorité | Travail                                                            | Impact étudiant / fiabilité | Effort | Valeur pédagogique                           |
| -------- | ------------------------------------------------------------------ | --------------------------- | ------ | -------------------------------------------- |
| P0       | Corriger cycle serveur et tests portables V1.1                     | Très élevé                  | Moyen  | Processus et frontières explicites           |
| P0       | Copie précédente validée et restauration guidée, original préservé | Très élevé                  | Moyen  | Données avant interface                      |
| P0       | Reconnexion HTTP, erreurs dans le diff, conflits visibles          | Élevé                       | Faible | Concurrence sans écrasement                  |
| P1       | Brief PFE privé configurable, sans dépendance IA                   | Élevé                       | Moyen  | Contexte personnel exportable                |
| P1       | Recherche de tokens, contrôles typés, brouillon récupérable        | Élevé                       | Moyen  | Contrat partagé et petites pièces            |
| P1       | Navigation panneaux, contrastes, clavier et tests adversariaux     | Élevé                       | Moyen  | Accessibilité et vérification                |
| P1       | Documentation multi-agents et qualification reproductible          | Élevé                       | Faible | Starter ouvert                               |
| P2       | Nouveaux fournisseurs, protocole Codex et Figma                    | Différé                     | Élevé  | Ne pas élargir une intégration non qualifiée |

Pas de refonte monolithique, pas de nouveau framework ni dépendance runtime.

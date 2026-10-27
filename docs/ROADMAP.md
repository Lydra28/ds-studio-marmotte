# Backlog ouvert — choisissez votre direction

Aucune chronologie unique ni obligation de tout construire. Pour chaque piste,
écrivez le problème, une petite hypothèse et le test qui décidera de poursuivre.

| Direction        | Pistes                                                                                              | Première preuve utile                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Figma lecture    | Client autorisé, scope fichier/variables, import et mapping explicite, cache, droits et révocation  | Lire une variable autorisée, refuser une autre cible                    |
| Figma écriture   | Validation liée au hash et à la révision, écritures bornées, relecture, idempotence et restauration | Sur copie de test, refus sans validation puis résultat relu             |
| UX de l’atelier  | Onboarding par tâche, sélection de composant, recherche, panneaux redimensionnables                 | Un étudiant autonome accomplit la boucle centrale                       |
| Recherche PFE    | Relier composants à des besoins publics, consigner hypothèses, traces de tests                      | Une décision de DS justifiée par une observation terrain                |
| Accessibilité    | Audit de toutes les paires, états focus/erreur, lecteurs d’écran, contrastes non textuels           | Défaut reproduit puis correction contrôlée au clavier et lecteur        |
| Modèle de tokens | Alias, thèmes, modes, types plus riches, conversion DTCG                                            | Migration non destructive d’un état existant et tests de cycles d’alias |
| Composants       | Variantes, tables, modales, navigation, composants spécifiques au PFE                               | Deux scénarios partagent réellement le même composant                   |
| Versioning       | Labels de versions, comparer palettes, branches de propositions, export du journal                  | Restaurer un changement sans écraser un token concurrent                |
| Visualisation    | Carte d’impact token/composant, graphe d’alias, comparaison avant/après                             | Identifier les vrais usages d’un token, sans inventer des liens         |
| Qualité          | Tests visuels, matrice navigateurs, tests utilisateurs, CI sur trois OS                             | Build et boucle centrale sur une machine fraîche de chaque OS           |
| Agents           | Claude/Gemini, streaming, permissions bloquantes, erreurs et quotas, mémoire volontaire             | Adaptateur sans outils qualifié avec les mêmes tests de refus           |
| Skills           | Audit sémantique, cohérence éditoriale, règles sectorielles, aide à la migration                    | Nouvelle demande menée correctement, sans divulgation ni reset          |
| Distribution     | Packaging desktop, signature Mac, installation Windows, gestion sûre des mises à jour               | Installation et désinstallation sur un vrai OS cible                    |
| Stockage         | Sauvegardes automatiques bornées, migration de schéma, verrous robustes après crash                 | Récupération d’un état corrompu sans perdre le fichier original         |

## Hors promesses de V2

Pas de synchronisation Figma, de génération de tout un DS depuis une capture,
d’émulation iOS native, d’orchestration multi-agent parallèle, de publication
GitHub automatique ou de confinement de l’agent de développement externe.

## Exemple d’itération courte

Une modification de composant, une règle documentée et un test utilisateur peuvent
suffire à une itération. Gardez une décision de poursuite ou d’abandon dans
`workspace/DECISIONS.md`. Les recherches et refus d’une fausse bonne idée font
partie du résultat, à condition que le scénario démontré reste fonctionnel.

## Bilan V2 et suite priorisée

Livré : recherche de tokens, brief privé et export Markdown, brouillon récupérable,
conflits visibles, copie précédente et restauration explicite, cycle serveur détaché,
tests de crash et qualification trois OS. [Audit priorisé](V2_AUDIT.md).

Prochain P0 : essais Finder/Gatekeeper et Windows Script Host/SmartScreen sur les
postes de la promotion, sans désactiver leurs protections. Alternatives de packaging
signé seulement si les politiques réelles le nécessitent.

P1 : tests avec étudiants, lecteurs d’écran, Safari/Firefox, recherche de composants,
contrastes de tous les états et migration pédagogique pour étendre les tokens.

P2 : Claude/Gemini embarqués, streaming Codex et formats d’échange enrichis restent
à qualifier ; Figma exige une cible explicite et un connecteur officiel autorisé.
Aucune de ces intégrations n’est simulée dans la V2.

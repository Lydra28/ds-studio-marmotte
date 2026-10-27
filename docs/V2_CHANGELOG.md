# V2.0.0 — changements et portée

## V1.1 → V2

| Domaine           | V1.1                                  | V2                                                                                       |
| ----------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| Manuel            | Édition, diff, validation, historique | Conservés ; session renouvelable et conflits visibles avant validation                   |
| PFE               | Fichiers workspace seulement          | Brief privé configurable et export Markdown, sans compte                                 |
| Tokens            | Sélection et saisie brute             | Recherche, couleur visuelle, dimensions typées et brouillon récupérable                  |
| Données           | État atomique sans copie précédente   | Copie précédente complète, restauration confirmée et original archivé                    |
| Processus         | Serveur enfant avec pipes du panneau  | Processus détaché et journal privé indépendant                                           |
| Tests             | CI V1.1 en échec sur trois OS         | Cas portables, tests de crash, de brief et de reprise réelle ; résultats dans le rapport |
| Figma / autres IA | Non implémentés                       | Toujours non implémentés, aucune fausse connexion                                        |

## Problèmes résolus

- Test Node dépendant des installations du runner : sonde réelle conservée et
  branches utilisateur/absence contrôlées sur copie isolée du script.
- Serveur lié aux pipes du panneau ; processus et descripteur de journal désormais
  indépendants. Le contrôle reste fondé sur une identité privée et un bail exclusif.
- Réponse de statut asynchrone pouvant réinjecter un ancien état pendant une action :
  génération d’opération vérifiée avant de modifier l’état du panneau.
- Lecture des données désormais bornée et refus des liens vérifié aussi avant commit.
- Perte du brouillon à la recharge ; capacité HTTP périmée après restart ; absence
  de secours de données. Les propositions expirées exigent toujours un nouveau diff.

## Fonctionnalités ajoutées

Brief privé avec contrôle de conflit, lien Figma validé mais non téléchargé,
export Markdown ; recherche, sélecteur de couleur et contraste proposé immédiat ; brouillon par onglet avec
abandon explicite ; accès clavier direct et navigation des panneaux ; blocage du
diff périmé ; sauvegarde de la révision précédente et restauration guidée.

## Décisions techniques

Pas de nouvelle dépendance. React/TypeScript, Node HTTP et Zod conservés. Deux
petits modules serveur partagent la lecture privée et l’écriture atomique. Le
schéma des tokens reste version 1 : les données V1.1 restent lisibles et le seed
modifié ne réinitialise jamais un état existant. Le brief est indépendant des
révisions du DS et reste ignoré par Git. Le chat Codex reçoit le brief privé lors
d’un envoi explicite ; sa restriction sans outils et sa version qualifiée restent
inchangées. Le bootstrap manuel ne lance plus aucun CLI.

Le journal serveur emploie un descripteur fichier plutôt que des pipes appartenant
au contrôleur ; comportement conforme au modèle de processus détachés de Node.
Références primaires : [processus enfants Node](https://nodejs.org/api/child_process.html#optionsdetached),
[écritures et synchronisation Node](https://nodejs.org/docs/latest-v22.x/api/fs.html).

## Tests exécutés

Plusieurs passes locales : TypeScript/build, suites store/API/agents, navigateur,
préparation npm réelle sur copie propre, cycles arrêt/redémarrage, concurrence,
crash serveur et panneau, crash pendant rafale de commits, restauration et
conservation après changement de seed. Une erreur de synchronisation du test de
Tab (avant montage React) a été reproduite et corrigée en attendant la vraie UI,
sans supprimer le contrôle clavier. Le scan a signalé une URL de credentials
**fictive dans un test** ; fixture reformulée, aucune exception de scan ajoutée.

La première CI V2 a aussi identifié une hypothèse POSIX dans le harness Windows :
`child.kill('SIGTERM')` y termine de force. Le test Windows emploie maintenant
l’arrêt HTTP privé réel, toujours avec contrôle de libération du verrou. Le wrapper
terminal ne transforme plus le Ctrl+C Windows en kill forcé du serveur enfant ;
le geste de console natif reste à tester sur un poste Windows.

La seconde CI V2, [40420840720](https://github.com/ElGrandeXu/DS-Studio/actions/runs/40420840720),
a réussi intégralement sur Ubuntu, macOS et Windows. Aucun contrôle natif
Finder/Windows Script Host n’en est déduit.

Comptages, résultats CI et limites exactes : [rapport de livraison](../DELIVERY_REPORT.md).
Un scénario simulé de capacité expirée est complété par un onglet réel conservé
pendant un redémarrage processus dans la suite des lanceurs.

## Limitations

Node/npm restent des prérequis externes. Les wrappers non signés Finder et Windows
Script Host peuvent être bloqués par les protections locales ; la CI ne valide
pas leur acceptation graphique. Pas de contournement proposé. La copie précédente
ne remplace pas une sauvegarde externe ; pas de garantie contre panne électrique.
Après restauration vers une révision plus ancienne, recharger les onglets. Le
brouillon ne garantit pas la reprise après fermeture du navigateur. Le brief
privé s’enregistre explicitement ; un rechargement demandé avant sauvegarde perd
ses modifications non enregistrées. Pas d’audit WCAG complet, de test Safari/Firefox
ou de nouvelle qualification cloud Codex pendant cette livraison.

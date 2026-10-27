---
name: token-change
description: Préparer et vérifier une modification de token dans DS-Studio avec diff, contrôle d’impact et validation humaine. Utiliser pour les évolutions de couleurs, espaces ou typographie du starter.
---

# Changer un token

Lire `workspace/DESIGN_RULES.md` et `app/shared/model.ts` : seuls les noms et types
qui y sont déclarés sont acceptés en V2. Le seed versionné est
`workspace/design-system.tokens.json`, mais l’état courant de l’application est
`.ds-studio/state.json`. Ne jamais éditer ce journal à la main.

Pour une modification des données courantes, utiliser l’éditeur de l’application
ou produire un JSON de tokens à importer. Garder la même liste de clés et types.
L’import affiche une proposition avant acceptation ; ne pas la valider à la place
de l’étudiant. Si vous intervenez sur le seed à sa demande, préciser qu’il n’est
chargé que pour un nouveau dossier de données : aucun état personnel ne sera écrasé.

Évaluer l’impact dans `app/client/DesignSystem.tsx` et `app/client/styles.css`.
Pour la marque, contrôler au minimum action principale, réservation, navigation
et vue mobile. Calculer le contraste via la fonction `contrast` partagée ; ne pas
qualifier tout le DS accessible à partir d’une seule paire de couleurs.

Donner le nom du token, l’ancienne et la nouvelle valeur, les usages touchés,
la vérification exécutée et la manière d’annuler dans l’historique. Vérifier la
persistance et la non-régression des autres tokens si le stockage a été modifié.

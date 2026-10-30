# Fiche Community du plugin DS-Studio

Textes et visuels à coller dans l'écran « Publier » de Figma (app desktop :
menu Figma → Plugins → Gérer les plugins → DS-Studio → Publier). Les deux
PNG de ce dossier sont générés par `node scripts/plugin-assets.mjs` depuis
le logo de l'app `desktop/icon.png` ; ne pas les retoucher à la main.

## Visuels

- Icône 128 × 128 : `icon-128.png` (mascotte « Pastille », fond transparent).
- Vignette 1920 × 1080 : `cover-1920x1080.png`.
- Captures (jusqu'à neuf, facultatives) : à prendre dans Figma une fois le
  plugin testé en vrai (connexion, transfert, remise à zéro).

## Textes

Nom : DS-Studio

Accroche (tagline) : Écrit la version acceptée de ton design system dans
Figma, et renvoie tes composants à l'atelier.

Description :

DS-Studio est un atelier de design system installé sur ton poste (Windows,
macOS, Linux). Tu y fais évoluer tes tokens avec un aperçu en direct, des
règles de correction et un historique de versions acceptées. Ce plugin relie
Figma à cet atelier, sur ton ordinateur seulement.

Ce que le plugin écrit dans ton fichier : les variables (collections
dédiées) et le composant Button de la dernière version acceptée, dans une
page qui lui est réservée. Il ne renomme rien et ne touche pas à ce qu'il
n'a pas créé.

Ce que le plugin lit : la liste des composants du fichier, pour les renvoyer
à l'atelier sous forme de fiches à importer ; la sélection courante, résumée
en lecture seule et seulement si tu coches la case, pour l'assistant.

Remise à zéro : supprime uniquement ce que DS-Studio a écrit, après t'avoir
montré la liste et demandé une confirmation.

Réseau : le plugin parle uniquement à l'application DS-Studio sur ton poste
(localhost). Aucune donnée ne quitte ton ordinateur. Il faut l'application
DS-Studio installée et un code d'appairage affiché par celle-ci.

Catégorie : Design tools.

Étiquette d'accès réseau attendue : « Restricted » (trois origines
`localhost`). Si l'écran affiche « Unknown », le manifeste est incomplet.

Contact de support : adresse à renseigner par Romain au moment de publier.

# Votre DS-Studio, pas celui de votre voisin

## Ouvrir et fermer son atelier

Double-cliquez sur **DS-Studio.desktop** (Linux), **DS-Studio.app** (Mac) ou
**DS-Studio.vbs** (Windows), en gardant le fichier dans le projet. Au premier
lancement, le panneau vous demande de confirmer **Installer / compiler…** si
nécessaire. Si Node.js manque, un guide graphique explique son installation ;
DS-Studio n’installe rien avec des droits administrateur.

Après préparation : **Démarrer DS-Studio**, puis **Ouvrir DS-Studio**. Les doubles-clics
suivants démarrent et ouvrent l’atelier prêt. Le panneau reste l’endroit où cliquer
sur **Arrêter** ou **Redémarrer**. Vos tokens et votre historique sont conservés.
Fermer le navigateur n’arrête pas le serveur : retrouvez le panneau par un nouveau
double-clic. **Arrêter et quitter le lanceur** ferme l’ensemble.

Une erreur reste affichée : ne supprimez jamais vos données pour la faire
disparaître. [Guide graphique](../launcher/INSTALLATION.html) et
[dépannage](LAUNCHER.md). Mac / Windows : validation native encore à effectuer.

## Première prise en main : s’approprier le starter

Installez depuis le README, effectuez la boucle de couleur **avant de demander à
une IA de modifier du code**. Observez le diff, les deux viewers, la persistance
et l’annulation. Écrivez ensuite votre sujet dans `workspace/PFE.md` et vos trois
premières règles utiles dans `workspace/DESIGN_RULES.md`.

Première tâche conseillée : choisir un token sémantique pertinent pour votre PFE,
expliquer son rôle, le tester sur deux composants et sur 320 px, puis justifier le
choix par une preuve. Créez votre dépôt privé sans y inclure de données sensibles.

## Travailler avec son assistant

Ouvrez votre CLI à la racine et demandez-lui de lire START_HERE.md. Qu’il s’agisse
Claude Code, Codex ou Gemini, l’agent utilisé pour développer n’est pas forcément
celui du chat embarqué. Vous pouvez développer sans utiliser ce chat.

Demande utile :

> Voici mon contexte PFE. Examine les composants et mes règles. Propose trois
> améliorations distinctes avec leur valeur pour mes publics. Aide-moi à en choisir
> une, puis implémente-la sans effacer mon travail et teste le parcours réel.

Demandez des observations, pas seulement « ça marche ». Notez votre décision dans
`DECISIONS.md` : problème, piste abandonnée, raison du choix et résultat de test.
Un agent peut se tromper ; demandez-lui ce qu’il n’a pas exécuté.

## Explorer sans tout faire

- **Usage et recherche** : vrais besoins des designers, onboarding, recherche de composants,
  documentation de décisions, tests d’utilisabilité.
- **Design System** : thèmes, alias, variations, composants propres au PFE, états et
  accessibilité. Un token ajouté exige une migration d’état, pas une remise à zéro.
- **Intégrations** : lecture Figma autorisée, format d’échange explicite, cache de lecture,
  droits et propositions contrôlées. D’abord une copie de test.
- **Qualité et versioning** : audit de contraste, rapports de changements, branches,
  exports comparables, tests visuels, restauration ciblée.
- **Agents et skills** : améliorer les skills existants, proposer un audit spécialisé,
  qualifier un adaptateur supplémentaire, comparer des stratégies sans auto-accepter.

Vous n’avez pas à réaliser chaque piste. [ROADMAP](ROADMAP.md) est un menu, pas un
programme imposé. Votre version peut abandonner une piste si la recherche le justifie.

## Créer un skill utile

Créez `.agents/skills/mon-skill/SKILL.md` :

```markdown
---
name: mon-skill
description: Décrire la tâche spécifique et le moment utile pour l’invoquer.
---

# Mon skill

Lire les sources utiles, expliciter les contraintes propres à mon projet,
agir dans le mandat et vérifier un résultat observable. Indiquer les limites.
```

Ne rédigez pas une dissertation générale. Un bon skill évite une erreur concrète
récurrente et référence les vrais fichiers de votre projet. Testez-le sur une
nouvelle demande : a-t-il changé utilement la décision de l’agent ? Codex découvre
le dossier ; pour un autre CLI, faites lire le fichier explicitement avant de
prétendre à une découverte native. Les skills de cette V2 n’accordent aucun droit Figma.

## Vendredi : démontrer une version personnelle

Présentez le problème de votre PFE, vos décisions et une boucle fonctionnelle.
Montrez un scénario utile, une erreur traitée, une restauration et un test exécuté.
Distinguez ce qui marche, ce qui reste partiel et ce que vous avez volontairement
écarté. Une vidéo de maquette n’est pas une preuve d’écriture ou de synchronisation.
Gardez votre contexte personnel dans un dépôt privé et n’utilisez aucun compte partagé.

## Parcours V2 sans terminal

1. Ouvrez **Mon PFE · brief privé** dans le premier panneau. Décrivez le public et
   le résultat attendu, enregistrez puis exportez le Markdown si votre agent externe
   en a besoin. Le lien Figma est un repère, aucune connexion n’est réalisée.
2. Recherchez `color`, `space` ou `font`. Le sélecteur visuel et la saisie partagent
   le même brouillon. Les valeurs enregistrées restent la référence des deux viewers.
3. Une recharge retrouve le dernier brouillon de cet onglet. **Abandonner le brouillon**
   n’annule pas une révision : rien n’avait été enregistré. L’historique, lui, annule
   un changement déjà validé en conservant les autres tokens.
4. Si un autre onglet valide entre-temps, fermez le diff périmé puis refaites-le.
   Un redémarrage fait expirer les propositions en mémoire, pas vos données.
5. Après un fichier d’état invalide, arrêtez l’atelier et restaurez la copie précédente
   depuis **Journal et réparation** du lanceur. L’original reste archivé. Rechargez
   ensuite tous les onglets. En l’absence de copie valide, ne supprimez aucun fichier.

Le brief privé et le brouillon ne doivent pas être publiés. Une copie externe de
`.ds-studio/`, atelier arrêté, conserve tokens, historique, brief et secours.
Le seed versionné est un exemple initial : changer de version du code n’efface
pas votre état. Copier seulement la nouvelle archive dans un autre dossier ne
transfère pas automatiquement vos données : sauvegardez-les et transférez-les
explicitement, les deux ateliers arrêtés.

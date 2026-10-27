# DS-Studio V2

> **Personnalisation de Romain (PFE, projet Marmotte).** Fork du starter
> [ElGrandeXu/DS-Studio](https://github.com/ElGrandeXu/DS-Studio) `v2.0.0` (MIT),
> transformé en atelier de design system : essai de tokens avec preview en
> direct → corrections par règles → acceptation d'une version → transfert
> dans Figma par l'agent (l'application elle-même ne contient pas d'IA et ne
> se connecte pas à Figma).
>
> Lancer l'instance Marmotte : `npm install`, puis
> `npx tsx app/server/index.ts --project=projects/marmotte` →
> <http://127.0.0.1:4310>.
>
> | Fait (2026-10-27) | Reste |
> | --- | --- |
> | Modèle de tokens v2 : Primitives / Tokens / Typography (desktop, mobile), alias, migration v1 non destructive | Répétition du transfert Figma (variables, planche Foundations, composant Button) |
> | Règles : espacements multiples de 4, contraste, taille de texte, nommage des composants (propose, n'applique jamais seul) | |
> | Fiches de composants par projet, éditables (diff, historique, version) ; nomenclature (noms anglais, fiches en français) ; import depuis Figma via l'agent (`scripts/components-from-figma.ts`) | Mise à jour des docs d'origine (mentions de Codex) |
> | Brouillon → diff → validation → historique annulable ; ajout et retrait de tokens ; acceptation de version (empreinte, cible, révision) | Polices Google dans la preview |
> | `scripts/figma-payload.ts` : prépare le transfert, refuse une version modifiée ; chat Codex retiré | DA de Marmotte (le jeu actuel est neutre) |
>
> Instance : [projects/marmotte/](projects/marmotte/) · journal :
> [DECISIONS.md](projects/marmotte/DECISIONS.md). Tests : `npm test`
> (26 réussis, 2 ignorés sous Windows) et `npm run test:e2e` (6 parcours navigateur).
>
> La suite de ce README est celle du starter d'origine.

Un atelier **web local** pour explorer, modifier et faire évoluer un Design System.
Ce starter pédagogique est conçu pour devenir **votre outil**, pas pour dicter vos
choix. Trois panneaux : assistant facultatif, catalogue de composants et viewport
responsive interactif. Exemple fictif fourni : **Lisière**.

**Le mode manuel fonctionne sans compte IA, sans Figma et sans Internet après installation.**
Une IA cloud nécessite un compte, Internet et du quota. Ce n’est pas un modèle local.

## Installer et lancer

Prérequis : **Node.js 22.12+**, npm fourni avec Node et un navigateur moderne.
Node LTS 22.23.4 est la version testée ; [.nvmrc](.nvmrc) la fixe pour les outils compatibles.
Téléchargez Node depuis [le site officiel](https://nodejs.org/en/download).
Git est facultatif si vous téléchargez une archive. Aucun Python, Docker, compte
Figma ou abonnement IA n’est nécessaire pour démarrer.

1. Clonez ou décompressez **tout le dossier**, puis double-cliquez sur le lanceur :

   | Système | Fichier                                                                                             |
   | ------- | --------------------------------------------------------------------------------------------------- |
   | Linux   | **DS-Studio.desktop** (icône de développement ; autoriser l’exécution / faire confiance si demandé) |
   | macOS   | **DS-Studio.app**, à laisser dans le dossier du projet                                              |
   | Windows | **DS-Studio.vbs**, sans fenêtre de console                                                          |

2. Si Node manque, le guide graphique local s’ouvre. Le lanceur cherche aussi les
   installations utilisateur hors PATH, sans exécuter vos profils shell.
   Il ne télécharge pas Node et ne lance aucune commande administrateur.
3. Au premier lancement, cliquez **Installer / compiler…**, puis confirmez
   explicitement le téléchargement des dépendances et la compilation. Internet
   est nécessaire. Le journal et les erreurs restent visibles dans le panneau.
4. Cliquez **Démarrer DS-Studio**, puis **Ouvrir DS-Studio**. Aux lancements suivants,
   un double-clic ouvre le panneau et démarre / ouvre automatiquement l’atelier
   s’il est prêt et arrêté. S’il est déjà actif, il retrouve son panneau sans
   créer un second serveur.
5. Cliquez **Arrêter DS-Studio** dans le panneau pour arrêter le vrai serveur.
   **Redémarrer** conserve les données. **Arrêter et quitter le lanceur** ferme
   aussi son petit service local. Fermer le navigateur n’arrête pas le serveur :
   un nouveau double-clic retrouve les commandes.

Le panneau utilise votre navigateur, pas Electron. Aucun runtime supplémentaire
obligatoire. [Guide graphique hors ligne](launcher/INSTALLATION.html) et
[dépannage détaillé](docs/LAUNCHER.md). Le contrôleur est **testé en CI sur les trois OS**. Les entrées Finder et Windows
Script Host restent **à tester sur les postes réels** : application Mac non signée,
Windows Script Host nécessaire au `.vbs`. Les protections de l’établissement
peuvent bloquer ces fichiers ; ne les désactivez pas. Gardez les lanceurs dans
le projet ; créez un raccourci système plutôt que de déplacer le fichier seul.

### Le terminal reste disponible

Depuis le dossier du projet :

```sh
npm ci
npm run build
npm start
```

Ouvrez **http://127.0.0.1:4310** (pas `localhost`, le contrôle d’hôte est strict).
Laissez ce terminal ouvert. **Ctrl+C** arrête le serveur ; fermer l’onglet ne l’arrête pas.
Les scripts historiques `./start.sh`, `./start.command` et `start.cmd` restent
disponibles après installation et compilation ; ils affichent l’URL sans ouvrir
le navigateur. `npm run launcher` ouvre le nouveau panneau. Si une archive a
perdu les permissions exécutables : `sh start.sh` ou `sh start.command`.

`npm run doctor` vérifie les prérequis sans ouvrir d’identifiants. Un dossier
contenant des espaces est accepté. N’utilisez ni `sudo` ni installation de service.

## Ce qui change en V2

- **Mon PFE** : brief privé éditable et exportable en Markdown ; aucun compte nécessaire.
- Recherche de tokens, sélecteur de couleur, valeurs numériques bornées et brouillon
  récupérable dans le même onglet après recharge. Rien n’est appliqué avant le diff.
- Conflits multi-onglets signalés dans le diff ; session locale renouvelée après
  redémarrage. Les erreurs réseau ne relancent jamais une écriture ambiguë.
- Copie de la révision précédente avant chaque validation ; restauration guidée
  depuis le lanceur, avec archivage de l’original. Aucun reset silencieux.
- Serveur indépendant du panneau, contrôles de fichiers renforcés, tests de crash
  et qualification automatisée sur les trois OS. Les lanceurs natifs restent à
  qualifier sur les postes réels (voir [rapport](DELIVERY_REPORT.md)).

[Changelog V1/V2](docs/V2_CHANGELOG.md) · [Audit et priorités](docs/V2_AUDIT.md)

## Votre première boucle, en deux minutes

1. Dans **Design System**, choisissez `color.brand`, remplacez la valeur par `#8A3B20`.
2. Cliquez **Proposer**. Le diff montre l’ancienne et la nouvelle valeur, sans écriture.
3. Cliquez **Valider et enregistrer**. Boutons, réservation et navigation changent dans les deux vues.
4. Testez la réservation, puis les viewports 320, 375, 430 et 1024 px (défilement horizontal si nécessaire).
5. Rechargez ou redémarrez : la valeur reste. Dans **Historique**, annulez la révision,
   examinez son diff et validez. Les changements des autres tokens sont conservés.

La propagation inter-vues utilise les valeurs enregistrées sur disque (diffusion
locale et relecture, au plus environ 1,2 seconde sans diffusion). Aucun rafraîchissement
simulé. Les propositions périmées et annulations conflictuelles sont refusées.

## Où sont mes données ?

| Emplacement                           | Responsabilité                                             |
| ------------------------------------- | ---------------------------------------------------------- |
| `workspace/PFE.md`                    | Votre sujet, publics et objectifs                          |
| `workspace/DESIGN_RULES.md`           | Vos règles de conception et contraintes                    |
| `workspace/DECISIONS.md`              | Vos arbitrages et preuves                                  |
| `workspace/design-system.tokens.json` | Seed versionné, utilisé uniquement à la création d’un état |
| `.ds-studio/project.json`             | Brief PFE privé du panneau, ignoré par Git                 |
| `.ds-studio/state.previous.json`      | Copie de la révision précédente des tokens et du journal   |
| `.ds-studio/state.json`               | Tokens courants et historique personnel, ignorés par Git   |
| `workspace/private/`                  | Vos données privées ignorées, à sauvegarder hors Git       |

Après un incident : arrêtez l’atelier, ouvrez **Journal et réparation** dans le
lanceur puis **Restaurer la copie précédente…**. Une confirmation indique l’effet ;
l’original est conservé sous `state-preserved-….json`. Le brief ne change pas.
Après restauration, rechargez les onglets de l’atelier. Sans copie valide, aucune
restauration automatique n’est tentée. Sauvegardez aussi `.ds-studio/` hors du projet.

Ne modifiez pas le journal `state.json` à la main. **Exporter les tokens** télécharge
le JSON courant ; **Importer un JSON** prépare un diff qui demande validation.
Le format est un sous-ensemble local à clés plates et valeurs explicites, **pas un
importeur universel DTCG ni un export Figma automatique**. Voir [TOKENS](docs/TOKENS.md).
Pour sauvegarder tout l’historique, arrêtez le serveur et copiez `.ds-studio/` dans
un emplacement privé. Exporter les tokens seuls ne sauvegarde pas l’historique.

Pour versionner une palette choisie, exportez-la, vérifiez-la puis remplacez le seed
versionné. Cela ne remplace jamais un état courant déjà créé. Ne supprimez pas votre
état pour essayer une autre palette : importez-la ou utilisez un autre dossier de données.

## Travailler avec votre agent préféré

Dans votre CLI (Codex, Claude Code, Gemini CLI, etc.), depuis le dossier du projet :

> Lis START_HERE.md et les instructions de ton agent. Examine le dépôt et mon
> workspace. Aide-moi à définir puis réaliser une amélioration personnelle bornée.
> Préserve mes données et vérifie le résultat. Distingue ce qui est testé de ce qui est proposé.

`AGENTS.md`, `CLAUDE.md` et `GEMINI.md` partagent le même point d’entrée.
Le développement via une CLI externe et le chat embarqué sont **deux choses différentes**.
L’agent externe a ses propres permissions ; DS-Studio ne les contrôle pas.

Codex découvre les skills dans `.agents/skills/` : demandez `$token-change` ou
`$component-audit`. Un autre agent peut lire le `SKILL.md` explicitement. Pour
créer un skill : ajoutez `.agents/skills/nom-du-skill/SKILL.md`, avec un frontmatter
`name` et `description`, puis une procédure courte, ses contraintes et ses preuves.
Inspirez-vous des deux skills fournis, sans copier vos identifiants ou vos conversations.

## État réel de V2

| Fonction                                                            | État et portée                                                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Édition manuelle, diff, commit, persistance et annulation sélective | **TESTED**, Linux, API + navigateur + redémarrage processus                                        |
| Catalogue et viewport responsive, formulaire et navigation          | **TESTED**, Chromium sous Linux                                                                    |
| Import/export JSON local                                            | **TESTED**, API + navigateur                                                                       |
| Chat Codex, JSON proposé avant acceptation                          | **TESTED**, CLI 0.164.0, compte enseignant disponible pendant la qualification ; quota non garanti |
| Claude Code / Gemini dans l’application                             | **NOT IMPLEMENTED**, adaptateurs indisponibles et contrat documenté                                |
| Figma MCP et synchronisation                                        | **NOT IMPLEMENTED**, statut non connecté, contrat et procédure future documentés                   |
| Skills et harness personnalisable                                   | **IMPLEMENTED**, structure et liens vérifiés ; pas une validation des choix d’un étudiant          |
| Qualification automatisée Windows / macOS                           | **TESTED en CI** pour API, navigateur et contrôleur ; **PARTIAL** pour Finder/WSH natifs           |
| Application desktop installable                                     | **NOT IMPLEMENTED**, application web locale uniquement                                             |

Preuves précises et réserves : [DELIVERY_REPORT.md](DELIVERY_REPORT.md).

### Codex embarqué (facultatif)

Le mode est restreint à **Codex CLI 0.164.0** : une autre version est refusée jusqu’à
qualification. Installez cette version depuis les moyens officiels de votre CLI,
puis authentifiez-vous vous-même avec `codex login` et contrôlez `codex login status`.
Aucun fichier d’authentification n’est ouvert ou copié par l’application. Un compte
compatible, une connexion et du quota sont requis. Aucun compte enseignant n’est fourni.

Choisir Codex puis **Envoyer** transmet les tokens, `PFE.md`, `DESIGN_RULES.md`, la demande
et au plus dix messages précédents. Ne mettez pas de données sensibles dans ce contexte.
Le brief privé est également transmis. Le chat ne persiste pas après recharge. Codex ne peut pas exécuter vos commandes dans
ce profil : le contrôleur valide les propositions de tokens, l’utilisateur accepte le diff.
Les MCP, plugins et outils shell sont désactivés, et le contexte est transmis en JSON
depuis un dossier temporaire vide. L’authentification reste gérée par le CLI officiel.
Détails et limites : [SECURITY](docs/SECURITY.md), [AGENTS](docs/AGENT_ADAPTERS.md).

### Figma

Figma reste la source de vérité du DS réel de votre PFE. Lisière est un exemple local,
pas une copie de votre fichier. Aucun fichier personnel autorisé n’a été fourni ;
aucun accès Figma n’a été tenté. Les clients tiers MCP doivent être autorisés par Figma.
Pas de contournement ni réutilisation de session : [contrat d’intégration](docs/FIGMA.md).

## Vérifier et développer

```sh
npm run doctor
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run qualify
npm run scan
```

`npm run dev` démarre le backend avec Vite sur la même adresse. `npm start` sert
`dist/` : reconstruisez avec `npm run build` après un changement frontend.
Les tests utilisent des dossiers temporaires et ne touchent pas vos données.
`npm run test:live` et `npm run qualify:live` sont **facultatifs et connectés à Codex** ;
ils peuvent consommer du quota, contrairement aux autres commandes.

## Créer votre dépôt privé

1. Téléchargez le starter sans reprendre de compte partagé. Personnalisez le workspace.
2. Créez vous-même un dépôt **privé** sur GitHub (interface web ou GitHub Desktop).
3. Avec GitHub Desktop, ajoutez ce dossier puis publiez en conservant **Keep this code private**.
   Avec Git, utilisez `git status`, `git add`, `git diff --cached` et `git commit` avant
   d’ajouter votre propre remote et de pousser. Ne réutilisez aucun remote enseignant.
4. Vérifiez les fichiers indexés et lancez `npm run scan` avant le premier envoi.
   Pour un nouveau dépôt non indexé : `git init`, puis `git add .` avant le scan.
5. Gardez `.ds-studio/`, `.env`, identifiants et documents sensibles hors Git. Un dépôt
   privé n’est pas un coffre-fort. `.gitignore` ne retire pas un secret déjà commité.

Le starter est sous [licence MIT](LICENSE) pour le code original ; les dépendances
conservent leurs licences. Aucune copie du code ou des mémoires personnelles de MARC.

## Pour aller plus loin

[Guide étudiant](docs/STUDENT_GUIDE.md) · [Guide enseignant](docs/TEACHER_GUIDE.md) ·
[Architecture](docs/ARCHITECTURE.md) · [Backlog ouvert](docs/ROADMAP.md)

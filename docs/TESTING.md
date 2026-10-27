# Vérifications et preuves

## Exécution locale reproductible

```sh
npm ci
npm run build
npm test
npx playwright install chromium
npm run test:e2e
npm run test:launcher
npm run qualify
npm run scan
```

Les tests unitaires/API et navigateur n’exigent ni IA ni Figma. Les fixtures sont
temporaires. Playwright écrit une synthèse JSON et des artefacts dans `test-results/`
(ignoré par Git), et arrête son serveur à la fin. Il utilise le port 4318 ; la
qualification du vrai lanceur utilise 4321. Fermez vos propres serveurs sur ces ports
avant les tests. Le mode normal utilise 4310.

| Suite                   | Vérifie réellement                                                                                                            | Ne prouve pas                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `tests/store.test.ts`   | Disque, relecture, propositions sans effet, conflits, undo sélectif, import, erreurs de fichiers                              | Durabilité après panne électrique                 |
| `tests/http.test.ts`    | API réelle sur socket locale, Host/Origin/session, chemins et clés refusés, entrées invalides                                 | Sécurité face à un attaquant administrateur       |
| `tests/agent.test.ts`   | CLI manquant réel, subprocess/timeout/arrêt réels, erreur d’auth simulée                                                      | Quota de chaque étudiant ou auth sur tout OS      |
| `tests/e2e/`            | Couleurs CSS rendues, diff, refus/acceptation, deux viewers, largeurs, interactions, clavier, import/export                   | Certification WCAG ou Safari/iOS natif            |
| `npm run qualify`       | Vrai processus et vrai lanceur, réouverture disque après arrêt, verrou interprocessus                                         | Lanceurs Finder/Windows exécutés                  |
| `npm run test:launcher` | Première préparation npm réelle et confirmée, panneau Chromium, cycle de vie, crash, concurrence, PID étranger, état préservé | Confiance .desktop, Finder ou Windows Script Host |
| `npm run test:live`     | Vrai Codex, JSON et demande hostile sans outil retourné, canari absent                                                        | Confinement formel du CLI ou intégration Figma    |
| `npm run qualify:live`  | Vrai Codex via API, absence d’auto-commit puis acceptation explicite                                                          | Compte, permissions et quota des étudiants        |

## Tests optionnels connectés

Les commandes suffixées `live` utilisent un contexte fictif et le compte officiel
Codex déjà configuré. Elles peuvent consommer du quota ; elles ne lisent ni ne
copient d’identifiants. Le test canari vise uniquement un fichier temporaire créé
pour le contrôle, jamais un document personnel. Aucune écriture Figma n’est requise.

Les erreurs d’auth de la suite normale sont simulées pour rester hors ligne. `npm run test:auth`
ajoute une vérification optionnelle avec un CODEX_HOME temporaire vide,
sans modifier le compte enseignant ; sa portée exacte figure dans DELIVERY_REPORT.

## Qualification et limites

### Session graphique Linux

`npm run qualify:desktop` exige une session graphique Linux, GIO, wmctrl et les
dépendances de test installées. Il ouvre réellement le navigateur par défaut via
le vrai `.desktop` depuis une copie temporaire déplacée avec espaces, apostrophe
et dollar. Le PATH ne contient pas Node ; le bootstrap retrouve l’installation
utilisateur. Il contrôle le démarrage automatique, un double lancement, l’ouverture,
les clics Arrêter / Redémarrer / Quitter et une relance après arrêt. L’état étudiant
n’est pas utilisé ; ses octets sont comparés avant/après si le fichier existe.
La capture du panneau de test va dans `test-results/launcher-linux.png` (ignoré).
Ce n’est pas un essai du geste physique de double-clic ni de tous les gestionnaires
de fichiers : GIO exécute la même entrée `.desktop`.

`test:launcher` utilise un projet temporaire sans dépendances pour le premier
lancement ; il effectue réellement `npm ci` puis `npm run build`, après avoir
vérifié le refus sans confirmation et l’annulation du dialogue du navigateur.
Il nécessite donc Internet / le cache npm et Chromium de test. Le test Node hors
PATH utilise un domicile temporaire et ne désinstalle ni ne déplace le Node réel.
La branche utilisateur et la branche absence sont aussi testées dans une copie
du script dont les seuls chemins système fixes sont neutralisés. Le script livré
est testé séparément avec les installations réellement présentes sur le runner. Les fixtures sont supprimées après arrêt de leurs processus.

### macOS et Windows : validation native obligatoire avant diffusion en classe

La CI comprend `test:launcher` sur les trois OS, mais un workflow écrit ou une
exécution Linux ne valide ni Finder ni Windows Script Host. Vérifier sur une vraie
machine, sous un compte étudiant sans privilèges :

| Étape                                                                                                        | Résultat attendu                                                                                |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Télécharger l’archive, extraire tout, chemin avec espaces et accents                                         | `.app` / `.vbs` ouvrable sans console ; aucune exécution depuis l’archive                       |
| macOS : vérifier signature/quarantaine/translocation ; Windows : vérifier présence et politique WSH/VBScript | Blocage expliqué si applicable ; aucune désactivation de protection                             |
| Node absent ou ancien                                                                                        | Guide local graphique, aucune installation privilégiée automatique                              |
| Node hors PATH (installation officielle / nvm / fnm)                                                         | Détection réelle de la version correcte ; npm trouvé auprès du Node sélectionné                 |
| Premier lancement sans `node_modules` / `dist`, annuler puis confirmer                                       | Aucun téléchargement avant accord ; installation et build visibles dans le journal après accord |
| Deux doubles-clics rapprochés, puis redémarrer                                                               | Un seul serveur sur le dossier ; commandes retrouvées ; PID renouvelé au redémarrage            |
| Ouvrir, fermer tous les onglets puis retrouver le panneau                                                    | Le serveur reste actif et peut être arrêté par son panneau                                      |
| Arrêter puis relancer deux fois                                                                              | Processus réellement terminé ; verrous libérés ; journal et tokens identiques                   |
| Port 4310 déjà occupé par un programme de test                                                               | Erreur claire ; occupant inchangé ; reprise après libération                                    |
| Crash du serveur puis du contrôleur                                                                          | Verrou abandonné récupéré ; pas de suppression d’un verrou actif                                |
| Verrou désignant un PID étranger ou ancien format vivant                                                     | Refus d’arrêt ; aucun processus étranger tué                                                    |
| État corrompu et projet sans droits d’écriture                                                               | Refus explicite ; original non réinitialisé                                                     |
| `npm start`, Ctrl+C, `start.command` / `start.cmd`                                                           | Ancien lancement fonctionnel, même protection des données                                       |

Consigner version de l’OS, architecture, Node/npm, navigateur, méthode de
téléchargement et autorisations requises. Comparer l’empreinte de `state.json`
avant/après les cycles, sans le publier. Tester aussi l’arrêt pendant un commit
et un projet déplacé après arrêt complet. Ne pas qualifier une plateforme si
un des points essentiels demeure bloqué par une politique locale.

Avant une nouvelle intégration : authentification officielle, droits minimaux,
refus et arrêt, révision concurrente, erreurs de réseau/quota, isolation des outils,
proposition/acceptation et relecture. Une interface définie ne compte pas comme un test.

## Contrôles V2 supplémentaires

- `tests/crash.test.ts` : processus tué brutalement pendant une rafale de commits ;
  relecture et validation du fichier courant et de sa copie précédente. Ne simule
  pas une panne électrique ou une corruption du système de fichiers.
- `tests/project.test.ts` : brief privé, deux sauvegardes concurrentes, liens Figma
  non autorisés et fichier invalide préservé.
- Store : copie/restauration/archivage, sauvegarde impossible sans commit,
  lien ajouté après ouverture et seed changé sans remise à zéro de données.
- HTTP : bootstrap manuel indépendant d’un CLI bloqué et API de brief fermée.
- Navigateur : brief persistant, brouillon après recharge, recherche, conflits entre
  onglets, renouvellement de capacité simulé, clavier à 375 px et stockage refusé.
- Lanceur : onglet conservé pendant un **vrai redémarrage**, récupération de session
  et diff sans écriture ; restauration réelle et refus sans confirmation.

Les résultats exacts et les échecs corrigés sont dans [DELIVERY_REPORT](../DELIVERY_REPORT.md).
La CI conserve sept jours les traces/captures de données fictives. Les tests normaux
ne contactent aucun fournisseur IA. `npm audit` complète le scan heuristique local ;
il consulte le registre npm, sans ouvrir les fichiers d’authentification de la machine.

## Matrice V2 qualifiée

Run [40420840720](https://github.com/ElGrandeXu/DS-Studio/actions/runs/40420840720) :
les trois jobs réussis, Node 22.23.4. Ubuntu : 29 unitaires/API, 10 navigateur,
22 lanceurs. macOS : 29, 10, 20 (2 contrôles Linux ignorés). Windows : 27, 10,
20 (2 contrôles symlink unitaires et 2 contrôles Linux lanceurs explicitement
ignorés). `qualify` et `scan` réussis partout. La CI du dernier commit documentaire
est aussi exigée avant publication ; ses liens définitifs sont dans la release.

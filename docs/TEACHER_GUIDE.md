# Guide enseignant

## Avant l’atelier

Le README suffit pour le premier lancement. Sur chaque OS, vérifier Node/npm,
`npm ci`, `npm run build`, `npm start`, la boucle manuelle et le redémarrage. Seul
Linux Mint a été exécuté pour cette livraison : prévoir un essai réel sur Mac et
Windows avant d’annoncer leur prise en charge validée. Les droits Figma et les
quotas IA sont propres à chaque étudiant. Ne distribuer aucun compte enseignant.

Prévoir une installation des dépendances avant de couper Internet : le cœur n’a
besoin d’aucun service cloud après installation. `npm ci` et le téléchargement du
navigateur de test nécessitent le réseau. Chromium n’est pas requis pour utiliser
l’application, seulement pour exécuter les tests Playwright.

## Démonstration centrale

Changer `color.brand`, montrer que le diff ne modifie pas encore les boutons,
refuser une fois, puis accepter. Observer réservation et navigation dans l’iframe.
Choisir 320 px puis 1024 px, réserver une place ou remplir le formulaire fictif.
Changer ensuite `space.md`, redémarrer le serveur et annuler la seule première
révision : l’espacement doit rester changé. Exporter puis réimporter un JSON.

Le DS d’exemple n’est pas la source Figma personnelle d’un étudiant. L’atelier ne
requiert pas une connexion Figma opérationnelle le premier matin.

## Dépannage ciblé

| Symptôme                          | Action                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `node` ou `npm` introuvable       | Installer Node LTS officiel, rouvrir le terminal, `node --version`, `npm --version`                                    |
| Dépendances absentes              | `npm ci` à la racine, sans `--omit=dev`                                                                                |
| Interface non compilée / ancienne | `npm run build`, puis relancer `npm start`                                                                             |
| Hôte refusé                       | Utiliser `http://127.0.0.1:4310`, pas localhost ni IP réseau                                                           |
| Port occupé                       | Fermer son ancien serveur, ou définir PORT dans son terminal                                                           |
| Page déconnectée                  | Contrôler le terminal du serveur et recharger ; ne pas accepter un ancien diff                                         |
| Proposition périmée               | Fermer le diff, relire le DS puis refaire la proposition                                                               |
| Annulation en conflit             | Une valeur a changé après la révision ; comparer et proposer une nouvelle valeur explicitement                         |
| CLI absent / mauvaise version     | Utiliser Manuel ; Codex embarqué n’accepte que la version qualifiée                                                    |
| IA non authentifiée / quota       | `codex login status`, puis login officiel si nécessaire ; aucun identifiant dans l’application                         |
| Seed changé sans effet            | L’état courant est conservé intentionnellement. Importer le JSON via le diff                                           |
| `state.json` invalide             | Arrêter, sauvegarder le dossier privé et réparer/relire les données ; ne pas supprimer pour faire disparaître l’erreur |
| Test navigateur sans Chromium     | `npx playwright install chromium`, puis `npm run test:e2e`                                                             |

### Port et données personnalisés

Bash/macOS : `PORT=4320 npm start`.
PowerShell : `$env:PORT="4320"; npm start`.
Windows cmd : `set PORT=4320` puis `npm start`.
La variable `DS_STUDIO_DATA_DIR` choisit un autre dossier de données privé au démarrage,
jamais depuis une requête réseau. `.env.example` documente les variables mais `.env`
n’est **pas** chargé automatiquement. Garder ce dossier hors de tout dépôt public.

### Verrou après crash

Le verrou contient maintenant une identité JSON (PID, identifiant d’instance,
racine, dossier, port et capacité privée). Un garde noyau local empêche deux
serveurs et sérialise la récupération. Après un crash, un PID disparu permet la
récupération automatique ; `state.json` reste intact. Le vieux format PID seul
est également récupéré si le PID est mort. Un PID actif, même réutilisé par un
autre programme, n’est jamais tué ni effacé automatiquement.

Le panneau arrête uniquement une instance qui répond au protocole privé avec
la bonne identité. Une ancienne instance sans ce protocole doit être arrêtée
par son terminal d’origine. Un verrou mal formé, un lien symbolique ou une identité
non confirmée provoque un refus, pas un nettoyage destructif. Pour une intervention
manuelle exceptionnelle, identifier le propriétaire dans le gestionnaire de
processus et vérifier l’absence de serveur avant tout retrait du seul verrou.
Ne jamais supprimer `state.json`. Voir [LAUNCHER](LAUNCHER.md).

## Qualification reproductible

`npm test` teste validation, fichier invalide, concurrence, annulations, HTTP,
permissions et erreurs CLI simulées/réelles selon le cas. `npm run test:e2e` teste
le navigateur avec un dossier temporaire. `npm run qualify` lance réellement le
serveur depuis un cwd à espaces, teste le verrou interprocessus, ferme et redémarre
avant de vérifier la persistance. Ces commandes ne contactent aucun LLM.

`npm run test:live` contacte Codex avec un contexte fictif pour vérifier le JSON
et le refus d’une demande hostile. `npm run qualify:live` teste le chemin Codex
vers l’API puis le commit explicite. Ces commandes sont facultatives, consomment
potentiellement du quota et ne constituent pas une qualification multi-OS.

Consulter DELIVERY_REPORT.md pour les nombres et périmètres réellement exécutés.
Ne pas transformer des tests simulés d’erreur d’auth en preuve de connexion réussie.

## Critères pour les 19 démonstrations

| Axe           | Observation demandée                                                                |
| ------------- | ----------------------------------------------------------------------------------- |
| Appropriation | Un besoin PFE clairement identifié et une différence justifiée avec V1              |
| Conception    | Règles et composants cohérents, états et viewport pertinents                        |
| Fiabilité     | Parcours réel, persistance, cas d’erreur et possibilité de revenir en arrière       |
| IA            | Instructions/skills utiles, droits expliqués, aucune acceptation automatique cachée |
| Honnêteté     | Statuts explicites, limites connues et preuves exécutées                            |

Ne pas récompenser uniquement le nombre de connecteurs annoncés. Un outil utile
sans Figma connecté peut être plus abouti qu’un écran « synchronisé » sans relecture.

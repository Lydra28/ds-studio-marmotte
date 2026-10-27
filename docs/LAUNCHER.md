# Lancement graphique

## Choix léger

Une petite page de contrôle dans le navigateur existant remplace une application
desktop lourde. Le contrôleur utilise uniquement Node et sa bibliothèque standard ;
il fonctionne avant l’installation npm. Les scripts de plateforme masquent la
console et proposent le guide HTML local si Node est absent. Aucun nouveau paquet
npm, Python, Rust, Electron ou compte IA n’est requis par ce lanceur.

| Système | Point d’entrée                                                       | Limite connue                                                                      |
| ------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Linux   | `DS-Studio.desktop`, icône système, `Terminal=false`                 | Autorisation d’exécution / confiance propre au bureau ; fichiers à garder ensemble |
| macOS   | `DS-Studio.app`, petit bundle shell Finder                           | Non signé / non notarié, quarantaine et translocation à qualifier sur Mac          |
| Windows | `DS-Studio.vbs`, Windows Script Host, `windowsHide` pour les enfants | VBScript peut être absent ou désactivé ; aucune activation automatique             |

Le cycle contrôleur/serveur est qualifié automatiquement par CI ; les essais natifs
Finder/Windows Script Host restent distincts. Voir DELIVERY_REPORT.md pour les résultats. Le bundle Mac et le script Windows ne
sont pas présentés comme des binaires installables signés. Une machine administrée
qui les bloque nécessite l’aide de l’établissement, pas un contournement de ses
protections. [Instructions graphiques](../launcher/INSTALLATION.html).

## Utilisation

Un double-clic retrouve le contrôleur du projet. Si le serveur est prêt et arrêté,
il démarre et ouvre l’atelier automatiquement ; sinon le panneau explique la
préparation. Un second double-clic retrouve le panneau actif, sans second serveur.
Les boutons permettent démarrage, ouverture, arrêt et redémarrage. L’état est
`arrêté`, `démarrage`, `actif` ou `erreur` ; une installation en cours apparaît comme
une préparation dans le journal. Le panneau est utilisable au clavier.

L’atelier écoute par défaut sur `http://127.0.0.1:4310`. Le panneau utilise un port
local libre différent. Fermer le navigateur laisse les processus actifs ; un
nouveau double-clic retrouve les boutons. **Arrêter** ferme le serveur, pas seulement
la page. **Arrêter et quitter le lanceur** ferme aussi le contrôleur. Aucun service,
autostart, processus privilégié ou configuration système n’est installé.

## Dépendances et préparation

Node 22.12+ est vérifié par exécution. Le bootstrap Unix cherche le PATH, les
emplacements usuels officiels / Homebrew et les installations utilisateur sous
`.local/opt`, nvm, fnm, Volta, asdf et mise. Il ne source pas `.bashrc` ou autre
profil. Windows cherche le PATH, Program Files, l’installation utilisateur,
NVM, fnm, Volta et mise. Les dispositions non standard peuvent nécessiter une
installation officielle ou l’aide de l’enseignant.

Le panneau vérifie les outils npm requis, le build et les dates des sources de
l’interface / configurations. Une source plus récente demande une recompilation.
**Installer / compiler…** exige une confirmation explicite, puis lance exactement
`npm ci` et `npm run build` dans le projet, avec le Node détecté et son npm.
`npm ci` exécute les scripts du projet et de ses dépendances : n’acceptez que pour
un projet de confiance. Aucune suppression de l’état étudiant, installation Node,
commande privilégiée, modification du PATH global ou installation de CLI IA.
Un verrou empêche un serveur d’utiliser le dossier pendant cette préparation.

Le contrôle par dates est un raccourci : si un outil restaure d’anciens timestamps
en modifiant les sources, lancez volontairement **Installer / compiler…**. Pour
un futur système de mises à jour distribué, remplacer ce contrôle par un manifeste
de contenu. L’installation nécessite un projet accessible en écriture et Internet.
Pour refaire volontairement la préparation d’une installation déjà prête, arrêter
l’atelier puis ouvrir **Journal et réparation de l’installation** et choisir
**Réinstaller / recompiler…**. La même confirmation explicite s’applique.

## Identité, concurrence et arrêt

`server.lock` et `launcher.lock`, privés dans `.ds-studio/`, contiennent un PID,
un identifiant aléatoire, une capacité de contrôle, le dossier, la racine et le port.
La publication se fait par fichier temporaire puis remplacement atomique. Un crash
ne laisse donc pas un JSON partiellement réécrit. Ces fichiers ne doivent jamais
être publiés, même s’ils ne sont pas des identifiants de compte.

Chaque propriétaire garde une socket TCP exclusive de protection sur loopback,
à un port déterministe calculé depuis le chemin canonique du dossier et le rôle.
Ce garde est libéré par le noyau après un crash et empêche deux récupérations de
verrou de s’effacer mutuellement. Le garde précède toute lecture/écriture du store,
même pour `npm start`, `npm run dev` et les anciens scripts. Les alias de chemins
du même dossier ne permettent pas deux écrivains.

Une collision de port de protection avec un autre logiciel est possible : le
démarrage échoue sans supprimer de verrou ni toucher aux données. Deux gardes
supplémentaires maximum (serveur et panneau) utilisent la plage 49152–65535.
Ne les ouvrez pas sur le réseau et ne désactivez pas le pare-feu pour le lanceur.

Un verrou abandonné n’est remplacé que si son PID n’existe plus, garde acquis.
Une ancienne version au format PID seul est prise en charge si morte ; un PID
vivant ou réutilisé, un fichier mal formé ou un lien symbolique est conservé.
Le refus est volontaire si l’identité ne peut pas être établie sans risque.

L’arrêt ne repose pas sur `kill(pid)` : le contrôleur vérifie la réponse privée
du serveur (PID, instance, racine, dossier et capacité), puis lui demande un arrêt
HTTP authentifié. Le serveur ferme son écoute, interrompt ses requêtes agent,
attend ses écritures et libère son propre verrou. Il reste contrôlable lorsque
tous les onglets ont été fermés ou après un crash du seul panneau. Aucune recherche
globale de Node et aucun `killall`, `pkill` ou `taskkill`.

Un délai ou un refus d’identité ne déclenche jamais de terminaison forcée.
Une ancienne instance sans protocole privé doit être fermée par son terminal.
Le navigateur et le contrôleur n’ouvrent pas d’accès fichier ou commande libre.
Le contrôleur expose seulement ses actions fixes, sous jeton aléatoire, vérification
d’hôte / origine et refus cross-site. Ce n’est pas une protection contre un autre
programme malveillant exécuté sous le même compte utilisateur.

## Dépannage

| Symptôme                              | Action                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Node absent / trop ancien             | Guide graphique local ; installer Node officiel avec npm, puis relancer                                                     |
| npm absent de la distribution Node    | Réinstaller une distribution officielle comprenant npm                                                                      |
| Installation échouée                  | Lire le journal du panneau ; vérifier Internet et les droits d’écriture, puis réessayer                                     |
| Port application occupé               | Arrêter son ancien serveur via le panneau ou identifier l’application dans le gestionnaire système ; ne pas tuer un inconnu |
| Port de protection occupé             | Fermer l’autre DS-Studio concerné ; faire identifier l’occupant par l’enseignant si nécessaire                              |
| PID actif mais identité non confirmée | Réessayer après démarrage ; utiliser l’ancien terminal ou demander un diagnostic, jamais supprimer l’état                   |
| `state.json` invalide                 | Original préservé ; faire une sauvegarde privée avant réparation, aucune remise à zéro                                      |
| Navigateur non ouvert                 | Vérifier le navigateur par défaut ; utiliser le lien direct dans le panneau si disponible                                   |

Arrêtez le serveur **et quittez le panneau** avant de déplacer le dossier entier.
Les points d’entrée sont relatifs à leur propre emplacement. Ne copiez pas un
`.desktop` ou un `.app` seul sur le Bureau : créez un raccourci vers l’original.
Pour le port et le dossier de données personnalisés par environnement, voir le
[guide enseignant](TEACHER_GUIDE.md) ; aucune requête réseau ne choisit ces chemins.

## Restauration V2

Avant chaque commit, l’état précédent complet est enregistré dans
`.ds-studio/state.previous.json`. Pour revenir à cette copie :

1. Arrêter l’atelier ; ouvrir **Journal et réparation de l’installation**.
2. Cliquer **Restaurer la copie précédente…** puis lire et confirmer l’effet.
3. Le contrôleur prend le bail exclusif, valide la copie et archive l’original
   sous `state-preserved-….json`, sans le supprimer. Le brief reste inchangé.
4. Démarrer puis recharger les onglets. Une proposition antérieure doit être refaite.

Si la copie est invalide, la restauration échoue sans toucher au courant. Une
seule génération est conservée automatiquement : ce n’est pas une sauvegarde
externe ni un outil de réparation disque. Les archives de réparation ne sont
pas supprimées automatiquement. Copiez le dossier privé hors du projet, atelier
arrêté, avant une mise à jour importante.

Le serveur est détaché du panneau et son journal est un fichier privé, pour qu’un
crash du panneau ne coupe pas ses pipes. Un nouveau double-clic retrouve le même
serveur par identité HTTP ; aucun PID inconnu n’est terminé.

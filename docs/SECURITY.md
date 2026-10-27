# Périmètre et sécurité V2

## Ce qui est effectivement contrôlé

- Écoute sur **127.0.0.1 uniquement**, hôte exact et origine same-origin, refus cross-site.
- POST JSON, capacité aléatoire par démarrage et schémas stricts ; pas de CORS ouvert.
- Catalogue public compilé seulement ; le journal, le workspace et les adaptateurs
  ne sont pas distribués comme fichiers HTTP. En dev, seules les sources frontend,
  le modèle partagé et les ressources Vite sont admis.
- Proposition immuable serveur, acceptation explicite par diff, révisions concurrentes
  refusées, aucune commande reçue du client, aucun choix de chemin envoyé par l’agent.
- Verrou d’instance, remplacement atomique du journal, refus de liens symboliques
  directs du dossier et du fichier d’état ; fichier corrompu préservé.
- Codex : version qualifiée unique, configuration utilisateur ignorée sans toucher
  l’authentification, dossier temporaire vide, outils shell/plugins/apps/MCP désactivés,
  sandbox read-only, aucun mécanisme d’approbation automatique.

Les variables d’environnement envoyées à Codex sont une liste limitée de chemins,
paramètres système et proxy/TLS nécessaires. Les clés d’API OpenAI/Codex ne sont
pas transmises. Le CLI officiel peut gérer son propre cache et rafraîchir sa session ;
l’application ne lit et ne copie aucun fichier d’identifiants.

La vérification de sortie refuse les événements d’outil inattendus mais n’annulerait
pas un effet déjà exécuté : ce n’est **pas** la frontière principale. Celle-ci dépend
également de la configuration du CLI qualifiée. Une nouvelle version, un plugin,
une configuration administrée ou un fournisseur différent exige de requalifier
l’absence d’outils avant activation. Le test hostile observé ne prouve pas une
isolation formelle contre tout défaut du CLI. Le cwd seul n’est jamais présenté
comme un confinement.

## Ce qui n’est pas promis

Aucune protection contre un logiciel malveillant déjà exécuté sous votre utilisateur,
aucune isolation réseau de tous les processus du compte, aucun chiffrement du disque,
aucun compte multi-utilisateur ou service exposable sur Internet. Une application
locale n’est pas sûre à partager sur le réseau en changeant son adresse d’écoute.

Pas de garantie de durabilité face à une coupure électrique, de récupération disque,
de révocation de compte IA ou de sandbox desktop sur les OS non testés. `fsync` du
fichier et rename réduisent les écritures partielles ; une sauvegarde privée reste
nécessaire. Les parents de dossiers sélectionnés par l’opérateur sont de confiance ;
les checks de symlink ne protègent pas d’un acteur local qui modifie les chemins
pendant l’opération. Aucun téléversement personnel n’est nécessaire à la qualification.

Le chat est du texte React échappé, pas du HTML exécuté. Les propositions ne permettent
ni URLs CSS, ni code, ni nouveaux noms de token. Les réponses et stderr CLI bruts ne
sont pas stockés. Le chat reste en mémoire de l’onglet ; `--ephemeral` évite les
rollouts de cette session agent, sans promettre l’absence de télémétrie fournisseur.

## Identifiants et distribution

Le [lanceur](LAUNCHER.md) possède une capacité de contrôle privée distincte des
API de tokens. Elle n’est pas exposée par le bootstrap de l’application. Les
routes de cycle de vie refusent les requêtes non authentifiées et cross-site.
L’arrêt valide l’identité de l’instance sans envoyer de signal à un PID inconnu.
Le panneau ne propose que des actions fixes ; l’installation npm est précédée
d’une confirmation explicite et n’emploie jamais de droits administrateur.
Les scripts npm des dépendances restent du code du projet : ne préparer qu’un
dépôt de confiance. Les verrous et journaux privés restent exclus de Git.

Ne jamais publier `.ds-studio/`, les caches des CLI, `.env`, les conversations ou les
exports PFE sensibles. Le scan versionné détecte des motifs fréquents mais n’est
pas une preuve mathématique d’absence de secret. Relire le contenu indexé ; un
`.gitignore` n’efface aucun secret déjà présent dans l’historique. Si un secret a
été publié, le révoquer par les moyens officiels, pas seulement supprimer le fichier.

Les skills sont des instructions, pas un contrôle d’accès. Le Codex qui développe
le projet dans un terminal a ses permissions propres, distinctes du profil embarqué.

## Données V2

Le brief du panneau est privé (`project.json`) et limité aux champs nom, public,
objectif et lien Figma HTTPS `www.figma.com`, sans identifiants dans l’URL. Le lien
n’est ni téléchargé ni envoyé à Figma. Le brief rejoint le contexte cloud uniquement
lors d’un envoi explicite au chat Codex, conformément à la notice du formulaire.
Les exports Markdown peuvent contenir vos informations : relisez avant de partager.
La récupération conserve l’original dans le même dossier privé. Aucune copie de
secours, archive ou journal d’exécution n’est publiée avec le code.

# Adaptateurs d’agents

## Contrat commun

`connectors/agents/types.ts` définit `status()` et `reply(message, context, signal)`.
Entrée : tokens structurés, contexte PFE, règles et dix messages précédents maximum.
Sortie : `{message, changes:[{key,value}]}` validée par Zod. L’adaptateur ne reçoit
pas de Store et ne peut pas accepter une proposition. Le contrôleur HTTP prépare
le diff avec la révision de départ ; l’UI décide de sa validation humaine.

Les conversations de fournisseurs ne sont pas reprises ni mélangées. Le chat embarqué
est en mémoire dans le navigateur ; après recharge l’historique affiché est vide.
Les refus, délais et interruptions n’entraînent aucun renvoi automatique ni commit.
Pas d’orchestration parallèle de plusieurs agents dans la V2 : architecture multi-fournisseurs,
un fournisseur intégré et qualifié, deux points d’extension indisponibles.

## Codex — TESTED sous Linux avec 0.164.0

Le CLI officiel fournit `exec --json`, `--ephemeral` et `--ignore-user-config`.
Ce dernier ignore la configuration globale mais conserve la gestion officielle de
l’authentification. Référence : [official OpenAI documentation — CLI](https://learn.chatgpt.com/docs/cli/reference).
L’activation des outils shell est une option documentée ; le profil du starter la
désactive ainsi que les plugins, apps, MCP et la recherche web.
[Configuration officielle](https://learn.chatgpt.com/docs/config-file/config-reference).

Le processus n’est pas lancé dans le dépôt : un dossier temporaire vide évite de
charger la configuration du projet. Pas de shell interpolé : arguments en liste,
prompt via stdin. Authentification par `codex login`, effectuée par l’utilisateur.
Le starter ne déduit pas la validité d’une session de l’existence d’un fichier.
La disponibilité initiale signifie seulement binaire/version détectés ; le compte,
le réseau et le quota sont réellement sollicités à l’envoi. Délai maximum 120 s.

Choix : `exec` plutôt qu’app-server réduit les RPC, sessions et approbations à
maintenir pour ce profil à propositions seules. Le flux manuel reste indépendant.
Le protocole et la version ont été exécutés, pas seulement décrits. Pour changer
la version acceptée, refaire le smoke test, le test hostile, le refus sans auth,
la proposition/validation via API et les essais sur chaque OS cible.

## Claude Code — NOT IMPLEMENTED

Point d’extension : `unvalidatedAdapter('claude')`. L’interface affiche son indisponibilité.
La [documentation officielle headless](https://code.claude.com/docs/en/headless)
décrit `claude -p` et des sorties structurées. Elle ne valide pas un contrôle des
permissions par notre interface. Avant activation : vérifier authentification
sans exporter le cache, désactiver les outils ou construire un protocole de demandes
d’approbation réellement bloquant, normaliser les erreurs et le JSON, puis tester
le refus, l’arrêt, le quota, les écritures hors scope et la non-connexion Figma.
Ne pas remplacer cette qualification par `--dangerously-skip-permissions`.

## Gemini CLI — NOT IMPLEMENTED

Point d’extension : `unvalidatedAdapter('gemini')`. La [référence headless officielle](https://geminicli.com/docs/cli/headless/)
présente JSON/stream-json. L’authentification et les callbacks de permissions restent
à éprouver dans un vrai processus embarqué. Ne pas utiliser de mode yolo ou
supposer qu’un login étudiant permet un usage gratuit sans quota. Même série de
tests que Claude avant d’exposer un bouton actif.

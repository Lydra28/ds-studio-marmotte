---
name: safe-recovery
description: Diagnostiquer une panne de lancement ou un état DS-Studio invalide en préservant les données, puis vérifier une reprise sans remise à zéro.
---

# Récupérer sans effacer

Lire `docs/LAUNCHER.md`, `docs/ARCHITECTURE.md` et l’erreur exacte. Distinguer
port occupé, dépendances absentes, verrou vivant, fichier mal formé et données
invalides. Ne pas lire d’identifiants ni tuer un PID inconnu.

Le panneau possède Démarrer/Arrêter/Redémarrer et une restauration de copie
précédente. Si elle est demandée, atelier arrêté, expliquer qu’elle revient à la
révision précédente et archive l’original ; laisser la confirmation graphique à
l’étudiant. Aucun effacement de verrou actif ou de dossier de données.

Si la copie est absente ou invalide, conserver les fichiers et proposer une
réparation ciblée sur une copie privée. Ne jamais prétendre qu’un reset est une
récupération. Ne pas publier le contenu du brief, des tokens personnels ou des logs.

Après reprise, relire la révision, tester un diff sans acceptation puis recharger
les onglets ; vérifier que le brief est intact. Consigner seulement le diagnostic,
le contrôle exécuté et les limites dans les décisions privées de l’étudiant.

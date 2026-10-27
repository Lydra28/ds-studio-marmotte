---
name: component-audit
description: Auditer la cohérence et les interactions des composants DS-Studio dans le catalogue et le viewport responsive, notamment après un changement de token ou de composant.
---

# Auditer les composants partagés

La source des deux vues est `app/client/DesignSystem.tsx`. Le chrome de l’atelier
n’appartient pas au DS ; un changement de marque ne doit pas recolorer ses contrôles.
Dans `styles.css`, vérifier les règles `.ds` et leurs variables issues de `tokenCss`.
Ne pas remplacer des usages par des valeurs hexadécimales isolées.

Tester les boutons normal/survol/focus/désactivé, le formulaire avec erreur et
confirmation locale, ainsi que la navigation. Les inscriptions sont fictives :
aucune collecte réelle ne doit être sous-entendue.

Exécuter `npm run build` puis `npm run test:e2e`. Ces tests utilisent de nouvelles
données temporaires, jamais celles de l’étudiant. Vérifier les largeurs CSS
320, 375, 430 et 1024 px, le débordement interne de l’iframe et l’accès clavier.
Une capture seule ne valide pas les interactions. Pour une preuve complémentaire,
conserver seulement des captures de données fictives dans un dossier privé ignoré.

Rapporter les défauts reproductibles, leur gravité, le composant et le viewport,
avec le statut réel des contrôles. Un audit rapide n’est pas une certification WCAG.

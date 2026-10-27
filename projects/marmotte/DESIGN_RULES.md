# Règles de conception — Marmotte

Vérifiées automatiquement par l'atelier (`app/shared/rules.ts`) : l'outil
signale et propose, il n'applique jamais seul.

- Espacements (`space/*`, `layout/*`) en multiples de 4 ; 0 et 2 px admis.
- Contraste ≥ 4,5:1 pour le texte, ≥ 3:1 pour les bordures d'interface et le focus.
- Texte courant ≥ 16 px en mobile ; aucun texte sous 12 px.
- Composants : nom anglais en PascalCase, propriétés `Variant`, `State`,
  `Size`, valeurs en minuscules ; fiche en français.
- Tokens sémantiques nommés par l'usage (`text/primary`), jamais par la teinte.

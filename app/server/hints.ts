import { inDesktop } from './desktop.js';

// Messages quand un service manque. Dans l'app installée, plus personne
// n'édite un `.env` : on renvoie vers Réglages (la connexion au compte arrive
// avec le relais, cadrage SaaS V1 lots 2 et 3). Depuis les sources, le `.env`
// du dépôt reste le mode des développeurs.
export const assistantOff = () =>
  inDesktop
    ? 'Assistant indisponible dans cette version : la connexion au compte arrive dans Réglages. Tout le reste fonctionne.'
    : 'Assistant désactivé : ajoute OPENROUTER_API_KEY dans .env, puis relance l’atelier.';

export const githubOff = () =>
  inDesktop
    ? 'Pull request non ouverte : aucun jeton GitHub dans cette installation.'
    : 'GITHUB_TOKEN absent de .env : PR non ouverte. Ajoute le jeton puis relance l’atelier.';

import { inDesktop } from './desktop.js';

// Messages quand un service manque. Dans l'app installée, plus personne
// n'édite un `.env` ; depuis les sources, le `.env` du dépôt reste le mode des
// développeurs. L'assistant et le Mur, eux, dépendent du compte (account.ts).
export const githubOff = () =>
  inDesktop
    ? 'Pull request non ouverte : aucun jeton GitHub dans cette installation.'
    : 'GITHUB_TOKEN absent de .env : PR non ouverte. Ajoute le jeton puis relance l’atelier.';

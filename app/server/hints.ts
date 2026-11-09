// Messages quand un service manque. L'assistant et le Mur dépendent du compte
// (account.ts) ; la PR GitHub, de la connexion GitHub de l'app (plan GitHub,
// G5 : plus de jeton dans un `.env`).
export const githubOff = () => 'Pull request non ouverte : GitHub n’est pas connecté (Réglages → GitHub, DS-Studio Pro), puis « Réessayer ».';

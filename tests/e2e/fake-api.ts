import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { generateKeys, issueLicense } from '../../server/license.js';

// Faux serveur DS-Studio pour les tests navigateur (scripts/e2e-server.mjs) :
// deux comptes (Pro offert ; gratuit avec sa génération de bienvenue), relais
// qui répond « Réponse simulée » et débite comme le vrai, faux Stripe du lot 4
// (Checkout et portail rendent une URL locale, le webhook est simulé
// sur-le-champ). Sa clé de licence est générée à chaque lancement et écrite
// dans le fichier reçu en argument, que l'atelier lit par
// DS_STUDIO_LICENSE_KEY_FILE. Aucun réseau.
const [, , keyFile, portArg] = process.argv;
if (!keyFile || !portArg) throw new Error('usage : fake-api.ts <fichier-cle-publique> <port>');
const keys = generateKeys();
await writeFile(keyFile, keys.publicKeyPem);
const base = `http://127.0.0.1:${portArg}`;

export const E2E_USER = { email: 'associe@example.com', password: 'mot-de-passe-de-test' };
export const E2E_FREE = { email: 'libre@example.com', password: 'mot-de-passe-de-test' };
interface Subscription {
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}
interface Fake {
  email: string;
  password: string;
  plan: 'free' | 'pro';
  gifted: boolean;
  creditCents: number;
  welcome: boolean;
  includedLeftCents: number;
  customer: boolean;
  subscription: Subscription | null;
  todayCents: number;
  monthCents: number;
  relayCalls: number;
}
const accounts: Fake[] = [
  { ...E2E_USER, plan: 'free', gifted: true, creditCents: 0, welcome: false, includedLeftCents: 0, customer: false, subscription: null, todayCents: 12, monthCents: 340, relayCalls: 0 },
  { ...E2E_FREE, plan: 'free', gifted: false, creditCents: 1, welcome: true, includedLeftCents: 0, customer: false, subscription: null, todayCents: 0, monthCents: 0, relayCalls: 0 },
];
const sessions = new Map<string, Fake>();
const me = (a: Fake) => ({
  email: a.email,
  plan: a.plan,
  tier: a.gifted ? 'pro' : a.plan,
  gifted: a.gifted,
  dailyCapCents: 200,
  creditCents: a.creditCents,
  welcome: a.welcome,
  subscription: a.subscription,
  usage: { todayCents: a.todayCents, monthCents: a.monthCents, resetAt: new Date(Date.now() + 3600_000).toISOString(), includedLeftCents: a.includedLeftCents },
  catalog: CATALOG,
});
// Même forme que `catalog` de server/billing.ts (lot 7) ; montants du faux serveur.
const CATALOG = {
  currency: 'eur',
  mode: 'test',
  pro: { amountCents: 999, interval: 'month', includedCents: 1100 },
  packs: [
    { pack: '5', amountCents: 500 },
    { pack: '10', amountCents: 1000 },
    { pack: '20', amountCents: 2000 },
  ],
  welcomeCents: 1,
  generationCents: { wall: 4, assistant: 1 },
};
const readJson = (req: http.IncomingMessage) =>
  new Promise<Record<string, unknown>>((resolve) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      try {
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });

const server = http.createServer(async (req, res) => {
  const body = await readJson(req);
  const send = (status: number, json: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  };
  const route = `${req.method} ${(req.url ?? '').split('?')[0]}`;
  if (route === 'POST /v1/auth/login') {
    const a = accounts.find((x) => x.email === body.email && x.password === body.password);
    if (!a) return send(401, { error: 'Adresse ou mot de passe incorrect.' });
    const token = `jeton-e2e-${Date.now()}-${sessions.size}`;
    sessions.set(token, a);
    return send(200, { token, account: me(a) });
  }
  if (route === 'POST /v1/auth/signup') return send(201, { message: 'Un mail de confirmation vient de partir : clique sur son lien.' });
  if (route === 'POST /v1/auth/forgot') return send(200, { message: 'Si l’adresse existe, un mail vient de partir avec un code.' });
  if (route === 'POST /v1/auth/reset') return send(200, { message: 'Mot de passe changé : connecte-toi.' });
  if (route === 'GET /v1/billing/done') {
    // Page de retour de Stripe, ouverte dans un nouvel onglet par Réglages.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><title>Paiement simulé</title><p>Paiement enregistré (simulé). Retourne dans DS-Studio et clique « Actualiser ».</p>');
  }
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const a = sessions.get(token);
  if (!a) return send(401, { error: 'Session invalide.' });
  if (route === 'GET /v1/me') return send(200, me(a));
  if (route === 'POST /v1/license') {
    const issued = issueLicense(keys, { id: `e2e-${a.email}`, email: a.email, plan: a.plan, gifted: a.gifted, dailyCapCents: 200 }, new Date());
    return send(200, { license: issued.token, tier: issued.payload.tier, expiresAt: new Date(issued.payload.exp).toISOString() });
  }
  if (route === 'POST /v1/relay/chat') {
    // Mêmes gardes que server/relay.ts : inclus Pro, puis crédits, 402 à zéro ; offert jamais débité.
    if (!a.gifted) {
      const included = a.plan === 'pro' && a.includedLeftCents > 0;
      if (!included && a.creditCents <= 0)
        return send(402, {
          error:
            a.plan === 'pro'
              ? 'Usage inclus du mois épuisé et solde de crédits à zéro : recharge des crédits dans Réglages → Compte.'
              : 'Solde de crédits à zéro : recharge des crédits dans Réglages → Compte pour utiliser l’agent et le Mur.',
        });
      if (included) a.includedLeftCents -= 2;
      else {
        a.creditCents -= 1;
        a.welcome = false;
      }
    }
    a.relayCalls += 1;
    const origin = String(req.headers['x-ds-origin']);
    // Réponse longue pour l'assistant : le fil doit défiler jusqu'au bout (recette du 2026-11-05).
    const detail = origin === 'assistant' ? '\n\n' + Array.from({ length: 25 }, (_, i) => `Détail ${i + 1} de la réponse.`).join('\n') : '';
    const reply = {
      choices: [{ message: { content: `Réponse simulée ${a.relayCalls} (${origin}).${detail}` } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.00001 },
    };
    if (req.headers['x-ds-keepalive'] !== '1') return send(200, reply);
    // Maintien de server/relay.ts : espaces d'attente, puis la réponse.
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.write('   ');
    return void setTimeout(() => res.end(JSON.stringify(reply)), 50);
  }
  if (route === 'POST /v1/billing/checkout') {
    if (body.kind === 'pro' && (a.gifted || a.plan === 'pro')) return send(409, { error: 'Déjà abonné à Pro : gère ton abonnement depuis le portail.' });
    // Le paiement et son webhook sont simulés sur-le-champ : l'e2e vérifie l'affichage après « Actualiser ».
    a.customer = true;
    if (body.kind === 'pro') {
      a.plan = 'pro';
      a.includedLeftCents = 300;
      a.subscription = { status: 'active', currentPeriodEnd: new Date(Date.now() + 30 * 86400_000).toISOString(), cancelAtPeriodEnd: false };
    } else a.creditCents += Number(body.pack ?? '5') * 100;
    return send(200, { url: `${base}/v1/billing/done?s=ok` });
  }
  if (route === 'POST /v1/billing/portal') {
    if (!a.customer) return send(409, { error: 'Aucun achat encore : rien à gérer.' });
    // Résiliation programmée dans le portail, simulée.
    if (a.subscription) a.subscription = { ...a.subscription, cancelAtPeriodEnd: true };
    return send(200, { url: `${base}/v1/billing/done?s=portal` });
  }
  if (route === 'POST /v1/auth/logout') {
    sessions.delete(token);
    return send(200, { ok: true });
  }
  return send(404, { error: `Route inconnue : ${route}` });
});
server.listen(Number(portArg), '127.0.0.1', () => console.log(`faux serveur DS-Studio sur ${portArg}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));

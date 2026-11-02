import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { generateKeys, issueLicense } from '../../server/license.js';

// Faux serveur DS-Studio pour les tests navigateur (scripts/e2e-server.mjs) :
// un seul compte, Pro offert, relais qui répond « Réponse simulée ». Sa clé
// de licence est générée à chaque lancement et écrite dans le fichier reçu en
// argument, que l'atelier lit par DS_STUDIO_LICENSE_KEY_FILE. Aucun réseau.
const [, , keyFile, portArg] = process.argv;
if (!keyFile || !portArg) throw new Error('usage : fake-api.ts <fichier-cle-publique> <port>');
const keys = generateKeys();
await writeFile(keyFile, keys.publicKeyPem);

export const E2E_USER = { email: 'associe@example.com', password: 'mot-de-passe-de-test' };
let token: string | null = null;
let relayCalls = 0;
const me = () => ({
  email: E2E_USER.email,
  plan: 'free',
  tier: 'pro',
  gifted: true,
  dailyCapCents: 200,
  creditCents: 0,
  usage: { todayCents: 12, monthCents: 340, resetAt: new Date(Date.now() + 3600_000).toISOString(), includedLeftCents: 0 },
});
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
  const route = `${req.method} ${req.url}`;
  if (route === 'POST /v1/auth/login') {
    if (body.email !== E2E_USER.email || body.password !== E2E_USER.password) return send(401, { error: 'Adresse ou mot de passe incorrect.' });
    token = `jeton-e2e-${Date.now()}`;
    return send(200, { token, account: me() });
  }
  if (route === 'POST /v1/auth/signup') return send(201, { message: 'Un mail de confirmation vient de partir : clique sur son lien.' });
  if (route === 'POST /v1/auth/forgot') return send(200, { message: 'Si l’adresse existe, un mail vient de partir avec un code.' });
  if (route === 'POST /v1/auth/reset') return send(200, { message: 'Mot de passe changé : connecte-toi.' });
  if (!token || req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'Session invalide.' });
  if (route === 'GET /v1/me') return send(200, me());
  if (route === 'POST /v1/license') {
    const issued = issueLicense(keys, { id: 'e2e', email: E2E_USER.email, plan: 'free', gifted: true, dailyCapCents: 200 }, new Date());
    return send(200, { license: issued.token, tier: issued.payload.tier, expiresAt: new Date(issued.payload.exp).toISOString() });
  }
  if (route === 'POST /v1/relay/chat') {
    relayCalls += 1;
    return send(200, {
      choices: [{ message: { content: `Réponse simulée ${relayCalls} (${String(req.headers['x-ds-origin'])}).` } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.00001 },
    });
  }
  if (route === 'POST /v1/auth/logout') {
    token = null;
    return send(200, { ok: true });
  }
  return send(404, { error: `Route inconnue : ${route}` });
});
server.listen(Number(portArg), '127.0.0.1', () => console.log(`faux serveur DS-Studio sur ${portArg}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));

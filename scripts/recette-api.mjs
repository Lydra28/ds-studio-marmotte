// Recette de l'API DS-Studio (runbook, étape 8) : santé, inscription,
// confirmation par le lien du mail, connexion, compte, licence, relais.
// Rien n'est écrit sur le poste ; le jeton de session n'est jamais affiché.
//   npm run recette:api                        (production)
//   npm run recette:api -- http://127.0.0.1:8787   (serveur local)
// Adresse et mot de passe sont demandés dans le terminal (le mot de passe y
// reste visible : prendre un mot de passe de recette, pas un vrai).
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

const base = (process.argv[2] ?? 'https://api.design-system-studio.fr').replace(/\/+$/, '');

// Questions posées au clavier, ou lues d'une entrée redirigée (tests) : les
// lignes arrivées trop tôt sont gardées, une entrée finie répond vide.
const rl = createInterface({ input: stdin, output: stdout });
const lines = [];
const waiters = [];
let closed = false;
rl.on('line', (line) => (waiters.length ? waiters.shift()(line) : lines.push(line)));
rl.on('close', () => {
  closed = true;
  for (const resolve of waiters.splice(0)) resolve('');
});
function ask(question) {
  if (closed) {
    stdout.write(question);
    return Promise.resolve(lines.shift() ?? '');
  }
  rl.setPrompt(question);
  rl.prompt();
  if (lines.length) return Promise.resolve(lines.shift());
  return new Promise((resolve) => waiters.push(resolve));
}

async function call(path, { json, token, headers = {}, method } = {}) {
  const h = { ...headers };
  if (json !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(base + path, {
      method: method ?? (json !== undefined ? 'POST' : 'GET'),
      headers: h,
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
  } catch (e) {
    return { status: 0, body: { error: `injoignable (${e.cause?.code ?? e.message})` } };
  }
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: `réponse non JSON : ${text.slice(0, 60)}` };
  }
  return { status: res.status, body };
}

const results = [];
function show(label, r, { okStatuses = [200, 201] } = {}) {
  const ok = okStatuses.includes(r.status);
  const message = r.body.error ?? r.body.message ?? '';
  console.log(`${ok ? '✓' : '✗'} ${label} → ${r.status || 'réseau'}${message ? ' : ' + message : ''}`);
  results.push({ label, ok });
  return r;
}

// Le parcours ; rend le code de sortie.
async function main() {
  console.log(`Recette de ${base}`);
  console.log('');

  const health = show('santé', await call('/v1/health'));
  if (health.status !== 200) {
    console.log('Le serveur ne répond pas : regarder Render → Logs, puis le domaine (Cloudflare).');
    return 1;
  }
  console.log(`  version ${health.body.version}, schéma ${health.body.schema}, heure serveur ${health.body.at}`);
  console.log('');

  const email = (await ask('Adresse mail de recette (tu dois pouvoir y lire le mail) : ')).trim();
  const password = await ask('Mot de passe de recette (12 caractères ou plus) : ');
  console.log('');

  const signup = show('inscription', await call('/v1/auth/signup', { json: { email, password } }), { okStatuses: [201, 409] });
  if (signup.status === 201) {
    console.log('');
    await ask('Ouvre le mail « Confirme ton adresse », clique le lien (page « Adresse confirmée »), puis appuie sur Entrée ici : ');
    console.log('');
  } else if (signup.status === 409) {
    console.log('  (compte déjà créé : on passe à la connexion)');
  }

  const login = show('connexion', await call('/v1/auth/login', { json: { email, password, client: 'app' } }));
  if (login.status !== 200) {
    if (login.status === 403) console.log('  Le lien du mail n’a pas été ouvert (ou pas encore reçu) : vérifie la boîte et les indésirables, puis relance.');
    if (login.status === 401 && signup.status === 409) console.log('  Compte existant avec un autre mot de passe : reprends le même, ou une autre adresse.');
    return 1;
  }
  const token = login.body.token;

  const me = show('compte (/v1/me)', await call('/v1/me', { token }));
  if (me.status === 200) {
    const u = me.body.usage ?? {};
    console.log(
      `  ${me.body.email} : plan ${me.body.plan}${me.body.gifted ? ' (offert)' : ''}, plafond ${me.body.dailyCapCents} c/jour, crédits ${me.body.creditCents} c, aujourd’hui ${u.todayCents} c`,
    );
  }

  const license = show('licence', await call('/v1/license', { token, method: 'POST' }));
  if (license.status === 200) console.log(`  palier ${license.body.tier}, valable jusqu’au ${license.body.expiresAt}, grâce jusqu’au ${license.body.graceUntil}`);

  const relay = show(
    'relais OpenRouter',
    await call('/v1/relay/chat', {
      token,
      headers: { 'x-ds-origin': 'assistant' },
      json: { messages: [{ role: 'user', content: 'Réponds seulement : ok' }], max_tokens: 200 },
    }),
    { okStatuses: [200, 402] },
  );
  if (relay.status === 200) {
    const content = relay.body.choices?.[0]?.message?.content ?? '';
    console.log(`  réponse « ${String(content).trim().slice(0, 60)} », coût ${relay.body.usage?.cost ?? '?'} $`);
  } else if (relay.status === 402) {
    console.log('  Attendu pour un compte gratuit dont la génération de bienvenue est passée. Après « npm run admin -- grant <mail> » ou « credit <mail> <centimes> », relancer : 200.');
  } else if (relay.status === 503) {
    console.log('  OPENROUTER_API_KEY absente côté serveur (Render → Environment).');
  }

  console.log('');
  const failed = results.filter((r) => !r.ok).map((r) => r.label);
  console.log(failed.length ? `Recette : ${failed.length} étape(s) en échec (${failed.join(', ')}).` : 'Recette : tout est vert.');
  return failed.length ? 1 : 0;
}

// Pas de `process.exit` : sur Windows, il plante Node si l'entrée redirigée
// est encore en cours de fermeture. Le code de sortie suffit.
process.exitCode = await main();
if (!closed) rl.close();

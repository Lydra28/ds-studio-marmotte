import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountClient } from '../app/server/account.js';
import type { BillingClient } from '../server/billing.js';
import { lastToken, testApp } from './server/helpers.js';

// Le compte de l'app contre le vrai serveur DS-Studio, en mémoire (Hono +
// PGlite, tests/server/helpers.ts) : même contrat qu'en production, aucun
// réseau, horloge partagée entre l'app et le serveur.
const DAY = 86400_000;
const user = { email: 'romain@example.com', password: 'mot-de-passe-solide' };

test('compte : inscription, confirmation, connexion, licence pro offerte, relais, reprise, grâce, expiration', async (t) => {
  const srv = await testApp();
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-account-'));
  t.after(async () => {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  });
  // Réseau simulé : les requêtes vont à l'app Hono ; `down` coupe tout.
  let down = false;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (down) throw new TypeError('fetch failed');
    return srv.app.request(String(url), init);
  }) as typeof fetch;
  const open = (overrides: Partial<Parameters<typeof AccountClient.open>[0]> = {}) =>
    AccountClient.open({ dir, apiUrl: 'http://server.test/', publicKey: srv.keys.publicKeyPem, fetch: fetchImpl, now: srv.now, ...overrides });

  const account = await open();
  assert.equal(account.status().status, 'none');
  assert.deepEqual(account.enabled(), { enabled: false, reason: 'account' });
  await assert.rejects(account.relay({ messages: [] }, 'assistant'), /connecte-toi/i);

  assert.match(await account.signup(user.email, user.password), /mail de confirmation/);
  await assert.rejects(account.signup(user.email, user.password), /existe déjà/);
  // Avant le clic sur le lien du mail : refus du serveur, transmis tel quel.
  await assert.rejects(account.login(user.email, user.password), /non confirmée/);
  assert.equal(account.status().status, 'none');
  await srv.api('/v1/auth/verify', { json: { token: lastToken(srv.mailer, user.email) } });
  // Compte offert par l'administrateur (`npm run admin -- grant`) : Pro sans paiement.
  await srv.db.query('UPDATE accounts SET gifted = true WHERE email = $1', [user.email]);

  const status = await account.login(user.email, user.password);
  assert.equal(status.status, 'connected');
  assert.equal(status.email, user.email);
  assert.equal(status.online, true);
  assert.equal(status.tier, 'pro');
  assert.equal(status.gifted, true);
  assert.equal(status.license?.state, 'valid');
  assert.equal(status.license?.expiresAt, new Date(srv.now().getTime() + 7 * DAY).toISOString());
  assert.deepEqual(account.enabled(), { enabled: true, reason: null });
  assert.equal(status.usage?.todayCents, 0);
  assert.equal(status.usage?.dailyCapCents, 200);
  // Le fichier porte le jeton ; l'état rendu au navigateur, jamais.
  const stored = JSON.parse(await readFile(path.join(dir, 'account.json'), 'utf8')) as { token: string; license: string };
  assert.ok(stored.token.length > 20);
  assert.ok(stored.license.includes('.'));
  assert.ok(!JSON.stringify(status).includes(stored.token));

  // Relais : corps transmis, modèle imposé par le serveur, réponse OpenRouter telle quelle, usage compté.
  const data = await account.relay<{ choices: { message: { content: string } }[] }>(
    { model: 'pas/ce-modele', messages: [{ role: 'user', content: 'ok' }], max_tokens: 10 },
    'wall',
  );
  assert.equal(data.choices[0].message.content, 'Réponse simulée.');
  const call = srv.openRouter.calls.at(-1)!;
  assert.equal(call.body.model, 'deepseek/deepseek-v4.1-flash-1017');
  assert.equal(call.body.max_tokens, 10);
  assert.ok((await account.refresh()).usage!.todayCents > 0, 'usage du jour lu sur /v1/me');

  // Reprise : un nouveau client relit le fichier et retrouve tout sans réseau.
  down = true;
  const again = await open();
  assert.equal(again.status().status, 'connected');
  assert.equal(again.status().tier, 'pro');
  assert.equal(again.status().license?.state, 'valid');
  // Hors ligne : l'agent se grise, le relais explique, puis le retour se constate au prochain appel.
  await assert.rejects(again.relay({ messages: [] }, 'assistant'), /injoignable/);
  assert.equal(again.status().online, false);
  assert.deepEqual(again.enabled(), { enabled: false, reason: 'offline' });
  assert.match(again.status().message ?? '', /injoignable/);
  down = false;
  assert.equal((await again.refresh()).online, true);
  assert.deepEqual(again.enabled(), { enabled: true, reason: null });

  // Licence en grâce après 7 jours sans renouvellement, expirée après 14 : palier gratuit, rien ne casse.
  srv.tick(8 * DAY);
  assert.equal(again.status().license?.state, 'grace');
  assert.equal(again.status().tier, 'pro');
  srv.tick(7 * DAY);
  assert.equal(again.status().license?.state, 'expired');
  assert.equal(again.status().tier, 'free');
  assert.equal(again.status().status, 'connected');
  // En ligne, le rafraîchissement renouvelle la licence.
  assert.equal((await again.refresh()).license?.state, 'valid');
  assert.equal(again.status().tier, 'pro');

  // Jeton de licence forgé : refusé ; sans clé publique : jamais vérifiable.
  const file = path.join(dir, 'account.json');
  const genuine = await readFile(file, 'utf8');
  const forged = JSON.parse(genuine) as { license: string };
  const [payload] = forged.license.split('.');
  forged.license = `${payload}.${Buffer.from('signature forgée').toString('base64url')}`;
  await writeFile(file, JSON.stringify(forged));
  const bad = await open();
  assert.equal(bad.status().license?.state, 'invalid');
  assert.equal(bad.status().tier, 'free');
  await writeFile(file, genuine);
  const unverifiable = await open({ publicKey: null });
  assert.equal(unverifiable.status().license?.state, 'invalid');
  assert.equal(unverifiable.status().tier, 'free');

  // Déconnexion : fichier effacé, session fermée côté serveur.
  const token = (JSON.parse(genuine) as { token: string }).token;
  assert.equal((await again.logout()).status, 'none');
  await assert.rejects(readFile(file), /ENOENT/);
  assert.equal((await srv.api('/v1/me', { token })).status, 401);
  assert.equal((await open()).status().status, 'none');
});

// Faux Stripe minimal : le serveur rend l'URL, l'app ne fait que la transmettre.
const fakeBilling: BillingClient = {
  customers: { create: async () => ({ id: 'cus_app' }) },
  products: { create: async () => ({ id: 'prod_app' }) },
  prices: {
    list: async (p) => ({ data: [{ id: `price_${p.lookup_keys?.[0]}`, lookup_key: p.lookup_keys?.[0] ?? null, unit_amount: 500, active: true, product: 'prod_app' }] }),
    create: async () => ({ id: 'price_x' }),
  },
  checkout: { sessions: { create: async (p) => ({ id: 'cs_app', url: `https://checkout.stripe.test/${p.mode}` }) } },
  billingPortal: { sessions: { create: async () => ({ url: 'https://portal.stripe.test/' }) } },
  webhooks: {
    constructEvent: () => {
      throw new Error('non utilisé');
    },
  },
};

test('compte : bienvenue, achats (URL Stripe transmise), passage Pro vu sans attendre, mot de passe oublié, session perdue, erreurs transmises', async (t) => {
  const srv = await testApp({ billing: { client: fakeBilling, webhookSecret: 'whsec_app' } });
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-account-'));
  t.after(async () => {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  });
  const fetchImpl = ((url: RequestInfo | URL, init?: RequestInit) => srv.app.request(String(url), init)) as typeof fetch;
  const account = await AccountClient.open({ dir, apiUrl: 'http://server.test', publicKey: srv.keys.publicKeyPem, fetch: fetchImpl, now: srv.now });

  await assert.rejects(account.signup('pas-une-adresse', user.password), /Adresse mail invalide/);
  await assert.rejects(account.signup(user.email, 'court'), /trop court/);
  await account.signup(user.email, user.password);
  await srv.api('/v1/auth/verify', { json: { token: lastToken(srv.mailer, user.email) } });
  await assert.rejects(account.login(user.email, 'mauvais-mot-de-passe'), /incorrect/);
  await account.login(user.email, user.password);
  assert.equal(account.status().plan, 'free');
  assert.equal(account.status().welcome, true, 'une génération offerte');
  assert.equal(account.status().subscription, null);
  assert.equal(account.status().usage?.creditCents, 1);
  // Crédit de bienvenue (lot 4) : une génération passe, puis le relais répond 402 avec le message du serveur.
  const welcome = (await account.relay({ messages: [{ role: 'user', content: 'ok' }] }, 'assistant')) as { choices: { message: { content: string } }[] };
  assert.equal(welcome.choices[0].message.content, 'Réponse simulée.', 'génération offerte');
  await assert.rejects(account.relay({ messages: [{ role: 'user', content: 'ok' }] }, 'assistant'), (e: Error & { status: number }) => {
    assert.equal(e.status, 402);
    assert.match(e.message, /Réglages → Compte/);
    return true;
  });
  assert.equal(account.status().tier, 'free');
  assert.equal((await account.refresh()).welcome, false, 'bienvenue consommée');

  // Achats : portail refusé avant le premier achat ; Checkout rend l'URL de Stripe, telle quelle.
  await assert.rejects(account.portal(), /rien à gérer/);
  assert.equal((await account.checkout('credits', '10')).url, 'https://checkout.stripe.test/payment');
  assert.equal((await account.checkout('pro')).url, 'https://checkout.stripe.test/subscription');
  assert.match((await account.portal()).url, /portal\.stripe\.test/);
  assert.ok(!JSON.stringify(account.status()).includes('cus_app'), 'client Stripe jamais rendu');

  // Passage Pro côté serveur (webhook Stripe) : la licence suit au rafraîchissement suivant, sans attendre 6 h.
  await srv.db.query("UPDATE accounts SET plan = 'pro', monthly_included_cents = 300, subscription_status = 'active' WHERE email = $1", [user.email]);
  const pro = await account.refresh();
  assert.equal(pro.plan, 'pro');
  assert.equal(pro.tier, 'pro', 'licence renouvelée au changement de palier');
  assert.equal(pro.subscription?.status, 'active');
  assert.equal(pro.usage?.includedLeftCents, 300);
  await assert.rejects(account.checkout('pro'), /Déjà abonné/);
  await srv.db.query("UPDATE accounts SET plan = 'free', monthly_included_cents = 0, subscription_status = 'canceled' WHERE email = $1", [user.email]);
  assert.equal((await account.refresh()).tier, 'free', 'retour au gratuit vu aussitôt');

  // Mot de passe oublié : code par mail, nouveau mot de passe ; l'ancienne session tombe,
  // ce que l'app constate au rafraîchissement suivant.
  assert.match(await account.forgot(user.email), /mail vient de partir/);
  const code = lastToken(srv.mailer, user.email);
  await assert.rejects(account.reset('code-faux-xxxxxxxxxx', 'nouveau-mot-de-passe-1'), /invalide/);
  assert.match(await account.reset(code, 'nouveau-mot-de-passe-1'), /changé/);
  const lost = await account.refresh();
  assert.equal(lost.status, 'none');
  assert.match(lost.message ?? '', /Session expirée/);
  assert.deepEqual(account.enabled(), { enabled: false, reason: 'account' });
  await assert.rejects(account.login(user.email, user.password), /incorrect/);
  assert.equal((await account.login(user.email, 'nouveau-mot-de-passe-1')).status, 'connected');
});

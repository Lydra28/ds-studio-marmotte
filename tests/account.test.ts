import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountClient } from '../app/server/account.js';
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

test('compte : mot de passe oublié, session perdue détectée, erreurs du serveur transmises', async (t) => {
  const srv = await testApp();
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
  // Crédit de bienvenue (lot 4) : une génération passe, puis le relais répond 402 avec le message du serveur.
  const welcome = (await account.relay({ messages: [{ role: 'user', content: 'ok' }] }, 'assistant')) as { choices: { message: { content: string } }[] };
  assert.equal(welcome.choices[0].message.content, 'Réponse simulée.', 'génération offerte');
  await assert.rejects(account.relay({ messages: [{ role: 'user', content: 'ok' }] }, 'assistant'), (e: Error & { status: number }) => {
    assert.equal(e.status, 402);
    assert.match(e.message, /crédits/);
    return true;
  });
  assert.equal(account.status().tier, 'free');

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

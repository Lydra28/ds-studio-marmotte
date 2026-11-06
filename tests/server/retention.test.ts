import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAdminApp } from '../../server/admin-ui.js';
import { listAccounts, runAdmin } from '../../server/admin.js';
import { addCredits } from '../../server/credits.js';
import { memoryDb, migrate, MIGRATIONS_DIR } from '../../server/db.js';
import { memoryMailer } from '../../server/mail.js';
import { deleteAccount, purge, RETENTION } from '../../server/retention.js';
import { connect, testApp } from './helpers.js';

// Durées de conservation validées le 2026-11-06 (server/retention.ts).
const DAY = 86400_000;
const user = (n: number) => ({ email: `conservation${n}@exemple.test`, password: 'mot-de-passe-solide' });
const yearsAgo = (now: Date, years: number, plusDays = 0) => {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return new Date(d.getTime() + plusDays * DAY);
};

type T = Awaited<ReturnType<typeof testApp>>;
const idOf = async (t: T, email: string) =>
  (await t.db.query<{ id: string }>('SELECT id FROM accounts WHERE email = $1', [email])).rows[0]?.id;
const row = async (t: T, id: string) =>
  (await t.db.query<Record<string, unknown>>('SELECT * FROM accounts WHERE id = $1', [id])).rows[0];
const count = async (t: T, table: string, id: string) =>
  Number((await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE account_id = $1`, [id])).rows[0].n);
const useAt = (t: T, id: string, at: Date, origin = 'assistant', cost = 0.4, charged = 2) =>
  t.db.query(
    `INSERT INTO usage_events (account_id, origin, model, cost_cents, cost_source, charged_to, created_at, charged_cents)
     VALUES ($1, $2, 'deepseek/deepseek-v4.1-flash-1017', $3, 'openrouter', 'credits', $4, $5)`,
    [id, origin, cost, at, charged],
  );

test('migration 0005 : dernière activité reprise des sessions et de l’usage', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-migrations-'));
  const db = await memoryDb();
  try {
    for (const f of (await readdir(MIGRATIONS_DIR)).filter((f) => f < '0005')) await cp(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    await migrate(db, dir);
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO accounts (email, password_hash, created_at) VALUES ('a@exemple.test', 'x', '2025-01-01'), ('b@exemple.test', 'x', '2025-02-01') RETURNING id",
    );
    await db.query("INSERT INTO sessions (token_hash, account_id, last_seen_at, expires_at) VALUES ('h', $1, '2026-03-01', '2026-04-01')", [rows[0].id]);
    await db.query(
      "INSERT INTO usage_events (account_id, origin, model, cost_cents, cost_source, charged_to, created_at) VALUES ($1, 'wall', 'm', 1, 'openrouter', 'credits', '2026-05-01')",
      [rows[0].id],
    );
    await migrate(db);
    const after = await db.query<{ email: string; last_active_at: Date }>('SELECT email, last_active_at FROM accounts ORDER BY email');
    assert.deepEqual(
      after.rows.map((r) => [r.email, new Date(r.last_active_at).toISOString().slice(0, 10)]),
      [
        ['a@exemple.test', '2026-05-01'],
        ['b@exemple.test', '2025-02-01'],
      ],
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('activité : connexion et requête authentifiée la repoussent et annulent l’avertissement', async () => {
  const t = await testApp();
  try {
    const token = await connect(t, user(1));
    const id = (await idOf(t, user(1).email))!;
    assert.equal(new Date((await row(t, id)).last_active_at as Date).getTime(), t.now().getTime());
    await t.db.query('UPDATE accounts SET inactivity_warned_at = $2 WHERE id = $1', [id, t.now()]);
    t.tick(2 * 3600_000);
    assert.equal((await t.api('/v1/me', { token })).status, 200);
    const r = await row(t, id);
    assert.equal(new Date(r.last_active_at as Date).getTime(), t.now().getTime());
    assert.equal(r.inactivity_warned_at, null);
  } finally {
    await t.close();
  }
});

test('purge : compte non confirmé supprimé après 30 jours, sessions et jetons expirés', async () => {
  const t = await testApp();
  try {
    await t.api('/v1/auth/signup', { json: user(1) });
    await connect(t, user(2));
    const pending = (await idOf(t, user(1).email))!;
    const confirmed = (await idOf(t, user(2).email))!;
    const mailer = memoryMailer();

    let r = await purge(t.db, mailer, new Date(t.now().getTime() + (RETENTION.unverifiedDays - 1) * DAY));
    assert.equal(r.unverified, 0);
    assert.ok(await row(t, pending), 'à 29 jours, gardé');

    const later = new Date(t.now().getTime() + (RETENTION.unverifiedDays + 1) * DAY);
    r = await purge(t.db, mailer, later);
    assert.deepEqual(r.errors, []);
    assert.equal(r.unverified, 1);
    assert.equal(await row(t, pending), undefined, 'effacé, jetons compris (cascade)');
    assert.ok(await row(t, confirmed));
    assert.equal(r.sessions, 1, 'session de 30 jours expirée');
    assert.equal(await count(t, 'sessions', confirmed), 0);
    // Jeton de vérification consommé, expiré depuis moins de 30 jours : encore là.
    assert.equal(await count(t, 'email_tokens', confirmed), 1);
    r = await purge(t.db, mailer, new Date(later.getTime() + RETENTION.emailTokenDays * DAY));
    assert.equal(r.emailTokens, 1);
    assert.equal(mailer.sent.length, 0);
  } finally {
    await t.close();
  }
});

test('purge : inactif 3 ans, avertissement 30 jours avant puis suppression ; reconnexion qui sauve', async () => {
  const t = await testApp();
  try {
    await connect(t, user(1));
    await connect(t, user(2));
    const a = (await idOf(t, user(1).email))!;
    const b = (await idOf(t, user(2).email))!;
    const now = t.now();
    // Inactifs depuis 3 ans moins 29 jours : dans la fenêtre d'avertissement.
    await t.db.query('UPDATE accounts SET last_active_at = $1', [yearsAgo(now, RETENTION.inactiveYears, 29)]);
    const mailer = memoryMailer();

    let r = await purge(t.db, mailer, now);
    assert.deepEqual(r.errors, []);
    assert.equal(r.warned, 2, 'le solde de bienvenue (offert) ne protège pas');
    assert.equal(mailer.sent.length, 2);
    assert.match(mailer.sent[0].subject, /supprimé dans 30 jours/);
    assert.match(mailer.sent[0].text, /projets restent sur ton poste/);
    r = await purge(t.db, mailer, now);
    assert.equal(mailer.sent.length, 2, 'un seul avertissement');

    // B se reconnecte : avertissement annulé, dernière activité à jour.
    const login = await t.api('/v1/auth/login', { json: user(2) });
    assert.equal(login.status, 200);
    assert.equal((await row(t, b)).inactivity_warned_at, null);

    r = await purge(t.db, mailer, new Date(now.getTime() + 30 * DAY));
    assert.deepEqual(r.errors, []);
    assert.equal(r.inactive, 1);
    assert.equal(await row(t, a), undefined, 'jamais rien acheté : effacé');
    assert.ok(await row(t, b));
  } finally {
    await t.close();
  }
});

test('purge : solde acheté ou abonnement en cours, jamais supprimé d’office', async () => {
  const t = await testApp();
  try {
    await connect(t, user(1));
    await connect(t, user(2));
    const a = (await idOf(t, user(1).email))!;
    const b = (await idOf(t, user(2).email))!;
    await addCredits(t.db, { accountId: a, deltaCents: 500, reason: 'topup', ref: 'cs_test_a', now: t.now() });
    await t.db.query("UPDATE accounts SET plan = 'pro', stripe_customer_id = 'cus_b', subscription_status = 'past_due' WHERE id = $1", [b]);
    await t.db.query('UPDATE accounts SET last_active_at = $1', [yearsAgo(t.now(), 5)]);
    const mailer = memoryMailer();
    const r = await purge(t.db, mailer, t.now());
    assert.equal(r.warned, 0);
    assert.equal(r.inactive, 0);
    assert.ok(await row(t, a));
    assert.ok(await row(t, b));
  } finally {
    await t.close();
  }
});

test('suppression sur demande : anonymisé après achat, effacé sinon, refusée avec abonnement', async () => {
  const t = await testApp();
  try {
    const token = await connect(t, user(1));
    await connect(t, user(2));
    await connect(t, user(3));
    const a = (await idOf(t, user(1).email))!;
    const b = (await idOf(t, user(2).email))!;
    const c = (await idOf(t, user(3).email))!;
    await addCredits(t.db, { accountId: a, deltaCents: 500, reason: 'topup', ref: 'cs_test_a', now: t.now() });
    await t.db.query("UPDATE accounts SET stripe_customer_id = 'cus_a' WHERE id = $1", [a]);
    await useAt(t, a, t.now());
    await t.db.query("UPDATE accounts SET stripe_customer_id = 'cus_c', subscription_status = 'active', plan = 'pro' WHERE id = $1", [c]);

    const refused = await deleteAccount(t.db, c, t.now());
    assert.equal(refused.ok, false);
    assert.ok(await row(t, c));

    const r = await deleteAccount(t.db, a, t.now());
    assert.deepEqual(r, { ok: true, mode: 'anonymised', forfeitedCents: 501 });
    const anon = await row(t, a);
    assert.equal(anon.email, `supprime+${a}@invalid`);
    assert.equal(anon.password_hash, '!');
    assert.equal(Number(anon.credit_cents), 0);
    assert.equal(anon.stripe_customer_id, 'cus_a', 'pièce comptable gardée');
    assert.ok(anon.deleted_at);
    assert.equal(await count(t, 'sessions', a), 0);
    assert.equal(await count(t, 'usage_events', a), 0);
    const ledger = await t.db.query<{ delta_cents: number; ref: string | null }>('SELECT delta_cents, ref FROM credit_events WHERE account_id = $1 ORDER BY id', [a]);
    assert.deepEqual(
      ledger.rows.map((e) => e.delta_cents),
      [1, 500, -501],
      'bienvenue, recharge, solde perdu',
    );
    assert.equal((await t.api('/v1/me', { token })).status, 401, 'session tombée');
    assert.equal((await t.api('/v1/auth/login', { json: user(1) })).status, 401, 'plus de connexion possible');
    assert.equal((await t.api('/v1/auth/signup', { json: user(1) })).status, 201, 'adresse libérée');
    assert.equal((await deleteAccount(t.db, a, t.now())).ok, false, 'pas deux fois');
    assert.equal(
      (await listAccounts(t.db, t.now())).some((x) => x.id === a),
      false,
      'absent de la liste d’administration',
    );

    assert.deepEqual(await deleteAccount(t.db, b, t.now()), { ok: true, mode: 'erased', forfeitedCents: 1 });
    assert.equal(await row(t, b), undefined);

    // 10 ans après, la ligne anonymisée et son grand livre partent.
    const mailer = memoryMailer();
    let p = await purge(t.db, mailer, yearsAgo(t.now(), -RETENTION.ledgerYears, -1));
    assert.equal(p.ledgerExpired, 0);
    p = await purge(t.db, mailer, yearsAgo(t.now(), -RETENTION.ledgerYears, 1));
    assert.equal(p.ledgerExpired, 1);
    assert.equal(await row(t, a), undefined);
    assert.equal(await count(t, 'credit_events', a), 0);
  } finally {
    await t.close();
  }
});

test('purge : usage de plus de 12 mois résumé par mois et par origine', async () => {
  const t = await testApp();
  try {
    await connect(t, user(1));
    const a = (await idOf(t, user(1).email))!;
    const now = t.now(); // 2026-10-31
    await useAt(t, a, new Date('2025-08-03T10:00:00Z'), 'assistant', 0.4, 2);
    await useAt(t, a, new Date('2025-08-20T10:00:00Z'), 'assistant', 0.6, 3);
    await useAt(t, a, new Date('2025-08-21T10:00:00Z'), 'wall', 1.5, 5);
    await useAt(t, a, new Date('2025-10-30T10:00:00Z'), 'wall', 1, 3);
    await useAt(t, a, new Date('2025-11-02T10:00:00Z'), 'wall', 1, 3); // moins de 12 mois : gardé
    const mailer = memoryMailer();
    let r = await purge(t.db, mailer, now);
    assert.deepEqual(r.errors, []);
    assert.equal(r.usageRolledUp, 4);
    assert.equal(await count(t, 'usage_events', a), 1);
    const monthly = async () =>
      (
        await t.db.query<{ month: string; origin: string; calls: number; cost: number; charged: number }>(
          "SELECT to_char(month, 'YYYY-MM') AS month, origin, calls, cost_cents::float8 AS cost, charged_cents AS charged FROM usage_monthly WHERE account_id = $1 ORDER BY month, origin",
          [a],
        )
      ).rows;
    assert.deepEqual(await monthly(), [
      { month: '2025-08', origin: 'assistant', calls: 2, cost: 1, charged: 5 },
      { month: '2025-08', origin: 'wall', calls: 1, cost: 1.5, charged: 5 },
      { month: '2025-10', origin: 'wall', calls: 1, cost: 1, charged: 3 },
    ]);
    // Un mois déjà résumé reçoit le reste de ses appels en s'additionnant.
    await useAt(t, a, new Date('2025-10-31T09:00:00Z'), 'wall', 2, 6);
    r = await purge(t.db, mailer, now);
    assert.equal(r.usageRolledUp, 1);
    assert.deepEqual((await monthly())[2], { month: '2025-10', origin: 'wall', calls: 2, cost: 3, charged: 9 });
  } finally {
    await t.close();
  }
});

test('administration : delete-account demande « confirmer », admin:ui l’adresse retapée', async () => {
  const t = await testApp();
  try {
    await connect(t, user(1));
    await connect(t, user(2));
    const lines: string[] = [];
    assert.equal(await runAdmin(t.db, ['delete-account', user(1).email], (l) => lines.push(l), t.now()), 1);
    assert.match(lines.join('\n'), /tout sera effacé.*confirmer/);
    assert.ok(await idOf(t, user(1).email), 'rien supprimé sans confirmer');
    assert.equal(await runAdmin(t.db, ['delete-account', user(1).email, 'confirmer'], (l) => lines.push(l), t.now()), 0);
    assert.equal(await idOf(t, user(1).email), undefined);

    const origin = 'http://127.0.0.1:4999';
    const admin = createAdminApp({ db: t.db, token: 'jeton', origin, label: 'test', now: t.now });
    const id = (await idOf(t, user(2).email))!;
    const call = (p: string, body?: unknown) =>
      admin.request(origin + p, {
        method: body ? 'POST' : 'GET',
        headers: { host: '127.0.0.1:4999', 'x-admin-token': 'jeton', origin, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    const preview = (await (await call(`/api/accounts/${id}/deletion`)).json()) as Record<string, unknown>;
    assert.deepEqual(preview, { creditCents: 1, activeSubscription: false, mode: 'erased', deleted: false });
    assert.equal((await call(`/api/accounts/${id}/delete`, { email: 'autre@exemple.test' })).status, 400);
    assert.ok(await idOf(t, user(2).email));
    const done = await call(`/api/accounts/${id}/delete`, { email: user(2).email.toUpperCase() });
    assert.equal(done.status, 200);
    assert.equal(await idOf(t, user(2).email), undefined);
  } finally {
    await t.close();
  }
});

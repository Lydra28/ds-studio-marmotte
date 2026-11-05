// Interface d'administration locale (décision du 2026-11-05) : une page sur
// 127.0.0.1, jamais déployée, jamais exposée par le serveur public.
//   npm run admin:ui            base de `DATABASE_URL` (URL externe de Render)
//   npm run admin:ui -- --demo  base en mémoire avec des comptes fictifs
//   options : --port=<n> (sinon un port libre), --no-open (pas de navigateur)
// Garde : jeton aléatoire par lancement (fragment de l'URL ouverte, jamais
// envoyé au serveur sauf en en-tête des appels), hôte 127.0.0.1 exigé (pas de
// rebond DNS), origine exigée sur les écritures.
import { serve } from '@hono/node-server';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { z } from 'zod';
import { accountHistory, adjustCredits, listAccounts, setCap, setGift } from './admin.js';
import { memoryDb, migrate, pgDb, type Db } from './db.js';

const PAGE = new URL('./admin-ui.html', import.meta.url);

const capBody = z.object({ cents: z.number().int().min(0).max(100_000) });
const giftBody = z.object({ gifted: z.boolean() });
const creditBody = z.object({
  cents: z
    .number()
    .int()
    .refine((n) => n !== 0, 'montant non nul')
    .refine((n) => Math.abs(n) <= 100_000, '1 000 € au plus'),
  note: z.string().trim().min(1, 'motif obligatoire').max(200),
});

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createAdminApp(opts: { db: Db; token: string; origin: string; label: string; now?: () => Date }) {
  const now = opts.now ?? (() => new Date());
  const host = new URL(opts.origin).host;
  const app = new Hono();

  app.use('*', async (c, next) => {
    if (c.req.header('host') !== host) return c.text('Hôte refusé.', 403);
    await next();
    c.header('cache-control', 'no-store');
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
  });
  app.use('/api/*', async (c, next) => {
    if (!same(c.req.header('x-admin-token') ?? '', opts.token)) return c.json({ error: 'Jeton absent ou invalide : relance npm run admin:ui.' }, 401);
    if (c.req.method !== 'GET' && c.req.header('origin') !== opts.origin) return c.json({ error: 'Origine refusée.' }, 403);
    await next();
  });

  app.get('/', async (c) => {
    c.header('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'");
    return c.html(await readFile(PAGE, 'utf8'));
  });

  app.get('/api/accounts', async (c) => c.json({ label: opts.label, now: now().toISOString(), accounts: await listAccounts(opts.db, now()) }));
  app.get('/api/accounts/:id/history', async (c) => c.json(await accountHistory(opts.db, c.req.param('id'))));

  const known = async (id: string) =>
    z.uuid().safeParse(id).success && (await opts.db.query('SELECT 1 FROM accounts WHERE id = $1', [id])).rows.length === 1;
  const body = async <T>(c: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>) => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    return parsed.success ? { ok: true as const, data: parsed.data } : { ok: false as const, error: parsed.error.issues.map((i) => i.message).join(' ; ') };
  };

  app.post('/api/accounts/:id/gift', async (c) => {
    const id = c.req.param('id');
    if (!(await known(id))) return c.json({ error: 'Compte inconnu.' }, 404);
    const b = await body(c, giftBody);
    if (!b.ok) return c.json({ error: b.error }, 400);
    return c.json({ dailyCapCents: await setGift(opts.db, id, b.data.gifted) });
  });
  app.post('/api/accounts/:id/cap', async (c) => {
    const id = c.req.param('id');
    if (!(await known(id))) return c.json({ error: 'Compte inconnu.' }, 404);
    const b = await body(c, capBody);
    if (!b.ok) return c.json({ error: b.error }, 400);
    await setCap(opts.db, id, b.data.cents);
    return c.json({ dailyCapCents: b.data.cents });
  });
  app.post('/api/accounts/:id/credit', async (c) => {
    const id = c.req.param('id');
    if (!(await known(id))) return c.json({ error: 'Compte inconnu.' }, 404);
    const b = await body(c, creditBody);
    if (!b.ok) return c.json({ error: b.error }, 400);
    return c.json({ creditCents: await adjustCredits(opts.db, id, b.data.cents, b.data.note, now()) });
  });
  return app;
}

// Comptes fictifs pour `--demo` : jamais de vraie adresse.
async function seedDemo(db: Db) {
  await migrate(db);
  const t = Date.now();
  const add = async (email: string, plan: 'free' | 'pro', gifted: boolean, credit: number, cap: number, calls: [string, number][]) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO accounts (email, password_hash, email_verified_at, plan, gifted, daily_cap_cents, credit_cents, monthly_included_cents, created_at)
       VALUES ($1, 'demo', now(), $2, $3, $4, $5, $6, $7) RETURNING id`,
      [email, plan, gifted, cap, credit, plan === 'pro' ? 300 : 0, new Date(t - 20 * 864e5)],
    );
    for (const [origin, cost] of calls)
      await db.query(
        `INSERT INTO usage_events (account_id, origin, model, prompt_tokens, completion_tokens, cost_cents, cost_source, charged_to, created_at, charged_cents)
         VALUES ($1, $2, 'deepseek/deepseek-v4.1-flash-1017', 8000, 900, $3, 'openrouter', $4, $5, $6)`,
        [rows[0].id, origin, cost, gifted ? 'gift' : plan === 'pro' ? 'pro' : 'credits', new Date(t - 3600e3), gifted ? 0 : Math.max(1, Math.ceil(cost * 3))],
      );
  };
  await add('testeur@example.test', 'free', true, 0, 10, [['wall', 0.62], ['assistant', 0.11], ['wall', 0.7]]);
  await add('pro@example.test', 'pro', false, 0, 200, [['assistant', 0.12], ['assistant', 0.2]]);
  await add('gratuit@example.test', 'free', false, 1, 200, []);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const demo = process.argv.includes('--demo');
  let db: Db;
  let label: string;
  if (demo) {
    db = await memoryDb();
    await seedDemo(db);
    label = 'démo (base en mémoire, comptes fictifs)';
  } else {
    if (!process.env.DATABASE_URL) {
      try {
        process.loadEnvFile(new URL('.env', import.meta.url));
      } catch {
        /* pas de server/.env */
      }
    }
    const url = process.env.DATABASE_URL;
    if (!url || url === 'memory') {
      console.error('DATABASE_URL manquante : pose l’URL externe de la base Render dans ce terminal, ou lance npm run admin:ui -- --demo.');
      process.exit(1);
    }
    db = await pgDb(url);
    // Seul l'hôte est affiché : jamais l'utilisateur ni le mot de passe.
    label = new URL(url).hostname.endsWith('render.com') ? 'production (Render)' : new URL(url).hostname;
  }
  const token = randomBytes(24).toString('base64url');
  let app: Hono | null = null;
  const server = serve({ fetch: (req) => app!.fetch(req), hostname: '127.0.0.1', port: Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 0) }, (info) => {
    const origin = `http://127.0.0.1:${info.port}`;
    app = createAdminApp({ db, token, origin, label });
    const url = `${origin}/#${token}`;
    console.log(`Administration DS-Studio, base ${label} :\n  ${url}\nCtrl+C pour arrêter (le lien ne sert plus ensuite).`);
    if (!process.argv.includes('--no-open')) {
      const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
    }
  });
  const stop = async () => {
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

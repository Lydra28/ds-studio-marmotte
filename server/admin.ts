// Administration du serveur, depuis un poste (jamais exposée en HTTP) :
//   npm run admin -- keys                    paire Ed25519 qui signe les licences
//   npm run admin -- grant <mail>            compte offert (Pro et jamais débité)
//   npm run admin -- cap <mail> <centimes>   plafond journalier de coût LLM
//   npm run admin -- usage <mail>            usage du jour, du mois, crédits, derniers appels
// Base : `DATABASE_URL` (server/.env en local ; depuis le poste, l'URL
// externe de la base Render). `keys` n'a pas besoin de base.
import { pathToFileURL } from 'node:url';
import { pgDb, type Db } from './db.js';
import { generateKeys } from './license.js';
import { usageSummary } from './relay.js';

const USAGE = 'Usage : npm run admin -- keys | grant <mail> | cap <mail> <centimes> | usage <mail>';

interface Row {
  id: string;
  email: string;
  plan: 'free' | 'pro';
  gifted: boolean;
  daily_cap_cents: number;
  credit_cents: number | string;
  monthly_included_cents: number;
}
const cents = (n: number | string) => String(Math.round(Number(n) * 1000) / 1000);
const iso = (d: Date | string) => new Date(d).toISOString().slice(0, 16).replace('T', ' ');

export async function runAdmin(db: Db | null, argv: string[], out: (line: string) => void, now = new Date()): Promise<number> {
  const [command, email, value] = argv;
  if (command === 'keys') {
    const keys = generateKeys();
    out('# Clé privée : variable LICENSE_PRIVATE_KEY du serveur (Render), jamais dans le dépôt.');
    out(keys.privateKeyPem.trimEnd());
    out('');
    out('# Clé publique : server/license-public.pem (suivie par git, embarquée dans l’app au lot 3).');
    out(keys.publicKeyPem.trimEnd());
    return 0;
  }
  if (!command || !['grant', 'cap', 'usage'].includes(command) || !email) {
    out(USAGE);
    return 1;
  }
  if (!db) {
    out('DATABASE_URL manquante (server/.env ou environnement) : impossible d’administrer.');
    return 1;
  }
  const { rows } = await db.query<Row>(
    'SELECT id, email, plan, gifted, daily_cap_cents, credit_cents, monthly_included_cents FROM accounts WHERE email = $1',
    [email.trim().toLowerCase()],
  );
  const account = rows[0];
  if (!account) {
    out(`Aucun compte ${email}.`);
    return 1;
  }
  if (command === 'grant') {
    await db.query('UPDATE accounts SET gifted = true WHERE id = $1', [account.id]);
    out(`${account.email} : compte offert (palier effectif Pro, jamais débité ; plafond journalier ${account.daily_cap_cents} centimes).`);
    return 0;
  }
  if (command === 'cap') {
    const cap = Number(value);
    if (!Number.isInteger(cap) || cap < 0) {
      out('Plafond : nombre entier de centimes attendu.');
      return 1;
    }
    await db.query('UPDATE accounts SET daily_cap_cents = $2 WHERE id = $1', [account.id, cap]);
    out(`${account.email} : plafond journalier ${cap} centimes.`);
    return 0;
  }
  const usage = await usageSummary(db, account, now);
  out(
    `${account.email} : ${account.plan}${account.gifted ? ' (offert)' : ''} ; aujourd’hui ${cents(usage.todayCents)} c, mois ${cents(usage.monthCents)} c, ` +
      `plafond ${account.daily_cap_cents} c, crédits ${cents(account.credit_cents)} c, inclus restant ${cents(Math.max(0, account.monthly_included_cents - usage.monthProCents))} c`,
  );
  const events = await db.query<{ created_at: Date | string; origin: string; model: string; prompt_tokens: number; completion_tokens: number; cost_cents: number | string; charged_to: string }>(
    'SELECT created_at, origin, model, prompt_tokens, completion_tokens, cost_cents, charged_to FROM usage_events WHERE account_id = $1 ORDER BY id DESC LIMIT 10',
    [account.id],
  );
  for (const e of events.rows) {
    out(`  ${iso(e.created_at)} ${e.origin} ${e.model} ${e.prompt_tokens}+${e.completion_tokens} jetons ${cents(e.cost_cents)} c → ${e.charged_to}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  let db: Db | null = null;
  if (argv[0] !== 'keys') {
    if (!process.env.DATABASE_URL) {
      try {
        process.loadEnvFile(new URL('.env', import.meta.url));
      } catch {
        /* pas de server/.env */
      }
    }
    const url = process.env.DATABASE_URL;
    if (url === 'memory') {
      console.error('DATABASE_URL=memory : base éphémère, rien à administrer.');
      process.exit(1);
    }
    db = url ? await pgDb(url) : null;
  }
  const code = await runAdmin(db, argv, (line) => console.log(line));
  await db?.close();
  process.exit(code);
}

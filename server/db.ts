// Accès à Postgres : un `Db` minimal (requête paramétrée, script SQL) que
// remplissent `pg` en production et PGlite (Postgres en WebAssembly, en
// mémoire) dans les tests, sans serveur à installer. Migrations : fichiers
// SQL numérotés de `server/migrations/`, appliqués une fois chacun, dans
// l'ordre, chacun dans sa transaction (`db.transaction`, une seule
// connexion) ; la table `schema_migrations` garde la liste. Jamais de
// migration destructive sans sauvegarde (AGENTS.md).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Db {
  /** Une requête, paramètres `$1`, `$2`… */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Un script SQL de plusieurs instructions, sans paramètre. */
  exec(sql: string): Promise<void>;
  /**
   * Plusieurs requêtes dans une transaction, sur une seule connexion :
   * validée si `fn` aboutit, annulée sinon. Avec un pool, deux `query` ou
   * `exec` successifs peuvent changer de connexion (pg-pool jette celle
   * d'une requête en erreur) : jamais de BEGIN/COMMIT par `exec`.
   */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export type Tx = Pick<Db, 'query' | 'exec'>;

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// Production : `pg` sur l'URL de Render (`DATABASE_URL`). TLS : `DATABASE_SSL`
// = `require` (défaut hors local : chiffré, certificat de Render non vérifié
// faute de chaîne publique, réseau interne Render) ou `off` (URL interne de
// Render, Postgres local). Import dynamique pour que les tests sur PGlite
// n'aient pas besoin de `pg` chargé.
export async function pgDb(url: string, sslMode = process.env.DATABASE_SSL): Promise<Db> {
  const { default: pg } = await import('pg');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const ssl = (sslMode ?? (local ? 'off' : 'require')) === 'off' ? undefined : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString: url, ssl, max: 5 });
  return {
    async query(text, params) {
      const result = await pool.query(text, params as unknown[]);
      return { rows: result.rows };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          async query(text, params) {
            const r = await client.query(text, params as unknown[]);
            return { rows: r.rows };
          },
          async exec(sql) {
            await client.query(sql);
          },
        });
        await client.query('COMMIT');
        client.release();
        return result;
      } catch (e) {
        // Connexion rendue propre après ROLLBACK, jetée si elle ne répond plus.
        await client.query('ROLLBACK').then(() => client.release(), () => client.release(true));
        throw e;
      }
    },
    close: () => pool.end(),
  };
}

// Tests : PGlite en mémoire, un Postgres complet par test.
export async function memoryDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = new PGlite();
  await lite.waitReady;
  return {
    async query(text, params) {
      const result = await lite.query(text, params as unknown[]);
      return { rows: result.rows as never[] };
    },
    async exec(sql) {
      await lite.exec(sql);
    },
    transaction: (fn) =>
      lite.transaction((tx) =>
        fn({
          async query(text, params) {
            const result = await tx.query(text, params as unknown[]);
            return { rows: result.rows as never[] };
          },
          async exec(sql) {
            await tx.exec(sql);
          },
        }),
      ),
    close: () => lite.close(),
  };
}

export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    try {
      await db.transaction(async (tx) => {
        await tx.exec(sql);
        await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      });
    } catch (e) {
      throw new Error(`Migration ${file} échouée : ${(e as Error).message}`);
    }
    applied.push(file);
  }
  return applied;
}

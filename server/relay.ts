// Relais OpenRouter (étape 2.4) : l'app n'a plus de clé, le serveur appelle
// OpenRouter avec la sienne, impose le modèle, compte l'usage et applique les
// gardes : plafond journalier (429), solde (402), panne (502). La réponse
// OpenRouter est renvoyée telle quelle : même contrat que `callOpenRouter`
// de l'app (plan du lot 2, « relais non streamé en V0 »).
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { body, requireAccount, type Account } from './auth.js';
import { ApiError, clock, type Deps } from './core.js';
import type { Db } from './db.js';

// Modèles que le serveur accepte de relayer ; tout autre est remplacé par le
// premier (même liste que l'assistant de l'app : modèle par défaut, plan B).
export const RELAY_MODELS: readonly string[] = ['deepseek/deepseek-v4.1-flash-1017', 'openai/gpt-6.1-terra'];
export const DEFAULT_RELAY_MODEL = RELAY_MODELS[0];
// Le Mur envoie ses inspirations en data: (jusqu'à 5 Mo chacune).
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models';
const PRICES_TTL_MS = 24 * 3600_000;
const DAY_MS = 86400_000;

export type Origin = 'assistant' | 'wall' | 'other';
export type ChargedTo = 'gift' | 'pro' | 'credits';

export interface UsageSummary {
  /** Coût du jour UTC, en centimes. */
  todayCents: number;
  /** Coût du mois UTC, en centimes. */
  monthCents: number;
  /** Part du mois imputée à l'usage inclus Pro. */
  monthProCents: number;
  /** Prochaine remise à zéro du plafond journalier (minuit UTC). */
  resetAt: string;
}

interface Completion {
  id?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string };
}

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const startOfUtcMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

export async function usageSummary(db: Db, account: Pick<Account, 'id'>, now: Date): Promise<UsageSummary> {
  const day = startOfUtcDay(now);
  const { rows } = await db.query<{ today: number; month: number; month_pro: number }>(
    `SELECT
       COALESCE(SUM(cost_cents) FILTER (WHERE created_at >= $2), 0)::float8 AS today,
       COALESCE(SUM(cost_cents), 0)::float8 AS month,
       COALESCE(SUM(cost_cents) FILTER (WHERE charged_to = 'pro'), 0)::float8 AS month_pro
     FROM usage_events WHERE account_id = $1 AND created_at >= $3`,
    [account.id, day, startOfUtcMonth(now)],
  );
  const r = rows[0];
  return {
    todayCents: Number(r?.today ?? 0),
    monthCents: Number(r?.month ?? 0),
    monthProCents: Number(r?.month_pro ?? 0),
    resetAt: new Date(day.getTime() + DAY_MS).toISOString(),
  };
}

// Qui paie l'appel : un compte offert ne paie jamais ; un Pro puise dans son
// usage inclus du mois tant qu'il n'est pas consommé (l'appel qui le dépasse
// est encore inclus), puis dans ses crédits ; un compte gratuit, ses crédits.
export function chargeTo(account: Pick<Account, 'gifted' | 'plan' | 'monthlyIncludedCents'>, usage: UsageSummary): ChargedTo {
  if (account.gifted) return 'gift';
  if (account.plan === 'pro' && usage.monthProCents < account.monthlyIncludedCents) return 'pro';
  return 'credits';
}

const originOf = (header: string | undefined): Origin => (header === 'assistant' || header === 'wall' ? header : 'other');

// Prix publics des modèles, en secours si une réponse n'a pas de `usage.cost`
// (la doc dit qu'il est toujours présent) : dollars par jeton, chaînes.
function pricesCache(fetchImpl: typeof fetch) {
  let at = 0;
  let table = new Map<string, { prompt: number; completion: number }>();
  return async (model: string, now: Date) => {
    if (now.getTime() - at > PRICES_TTL_MS) {
      try {
        const res = await fetchImpl(MODELS_ENDPOINT, { signal: AbortSignal.timeout(15_000) });
        const data = (await res.json()) as { data?: { id: string; pricing?: { prompt?: string; completion?: string } }[] };
        table = new Map((data.data ?? []).map((m) => [m.id, { prompt: Number(m.pricing?.prompt ?? 0), completion: Number(m.pricing?.completion ?? 0) }]));
        at = now.getTime();
      } catch {
        /* table précédente conservée, peut-être vide */
      }
    }
    return table.get(model);
  };
}

const relaySchema = z.looseObject({
  model: z.string().max(200).optional(),
  messages: z.array(z.unknown()).min(1, 'messages : au moins un message').max(500),
});

export function relayRoutes(deps: Deps) {
  const app = new Hono();
  const account = requireAccount(deps);
  const fetchImpl = deps.openRouter.fetch ?? fetch;
  const prices = pricesCache(fetchImpl);
  const limit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: `Requête trop lourde (plus de ${MAX_BODY_BYTES / 1024 / 1024} Mo).` }, 413),
  });

  app.post('/chat', limit, async (c) => {
    const me = await account(c);
    if (!deps.openRouter.apiKey) throw new ApiError('Relais OpenRouter désactivé sur ce serveur.', 503);
    const now = clock(deps)();
    const usage = await usageSummary(deps.db, me, now);
    if (usage.todayCents >= me.dailyCapCents) {
      return c.json(
        { error: `Plafond journalier atteint (${me.dailyCapCents} centimes) : remise à zéro à ${usage.resetAt}.`, resetAt: usage.resetAt },
        429,
      );
    }
    const charged = chargeTo(me, usage);
    if (charged === 'credits' && me.creditCents <= 0) {
      throw new ApiError(
        me.plan === 'pro'
          ? 'Usage inclus du mois épuisé et solde de crédits à zéro : recharge des crédits.'
          : 'Solde de crédits à zéro : recharge des crédits pour utiliser l’agent et le Mur.',
        402,
      );
    }

    const input = await body(c, relaySchema);
    const model = input.model && RELAY_MODELS.includes(input.model) ? input.model : DEFAULT_RELAY_MODEL;
    // Non streamé en V0 ; le modèle est celui du serveur.
    const { stream_options: _streamOptions, ...rest } = input as Record<string, unknown>;
    const payload = { ...rest, model, stream: false };

    let res: Response;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deps.openRouter.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'DS-Studio',
          'HTTP-Referer': 'https://design-system-studio.fr',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new ApiError('OpenRouter injoignable (réseau ou délai dépassé). Réessaie.', 502);
    }
    const data = (await res.json().catch(() => ({}))) as Completion;
    if (!res.ok) {
      // Message du fournisseur, jamais la clé ni la requête.
      throw new ApiError(`OpenRouter a refusé la requête (${res.status})${data.error?.message ? ' : ' + data.error.message.slice(0, 200) : ''}.`, 502);
    }

    // Comptage : coût lu dans la réponse (crédits OpenRouter = dollars), sinon
    // estimé par les prix publics, sinon inconnu (0, signalé).
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;
    let costCents = 0;
    let source: 'openrouter' | 'estimate' | 'unknown' = 'unknown';
    if (typeof data.usage?.cost === 'number') {
      costCents = data.usage.cost * 100;
      source = 'openrouter';
    } else {
      const price = await prices(model, now);
      if (price) {
        costCents = (promptTokens * price.prompt + completionTokens * price.completion) * 100;
        source = 'estimate';
      } else {
        console.warn(`Coût inconnu pour ${model} (ni usage.cost ni prix public) : événement compté à 0.`);
      }
    }
    // Événement et débit des crédits en une seule instruction : atomique
    // sans `db.transaction`, et une seule requête sur le pool.
    await deps.db.query(
      `WITH e AS (
         INSERT INTO usage_events (account_id, origin, model, prompt_tokens, completion_tokens, cost_cents, cost_source, charged_to, generation_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING account_id
       )
       UPDATE accounts a SET credit_cents = a.credit_cents - $11 FROM e WHERE a.id = e.account_id`,
      [me.id, originOf(c.req.header('x-ds-origin')), model, promptTokens, completionTokens, costCents, source, charged, data.id ?? null, now, charged === 'credits' ? costCents : 0],
    );
    return c.json(data);
  });

  return app;
}

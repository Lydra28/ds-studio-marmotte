// Types et erreurs partagés par les modules du serveur (évite les imports
// circulaires entre app.ts et les routes).
import type { Billing } from './billing.js';
import type { Db } from './db.js';
import type { LicenseKeys } from './license.js';
import type { Mailer } from './mail.js';

export interface Deps {
  db: Db;
  mailer: Mailer;
  /** Paire Ed25519 qui signe les licences ; clé publique embarquée dans l'app. */
  keys: LicenseKeys;
  /** Clé OpenRouter du serveur (vide : relais désactivé) ; `fetch` remplaçable par les tests. */
  openRouter: { apiKey: string; fetch?: typeof fetch };
  /** Stripe (lot 4) : client et secret du webhook ; absent, les routes de paiement répondent 503. */
  billing?: Billing;
  /** Remontée des erreurs inattendues (Sentry en production). */
  report?: (err: unknown) => void;
  /** URL publique du serveur, pour les liens des mails (https://api.design-system-studio.fr). */
  publicUrl: string;
  /** Domaine du cookie de session du site (.design-system-studio.fr) ; absent en local. */
  cookieDomain?: string;
  /** Version affichée par /v1/health (paquet + commit déployé). */
  version: string;
  now?: () => Date;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export const clock = (deps: Pick<Deps, 'now'>) => deps.now ?? (() => new Date());

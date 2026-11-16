// Types et erreurs partagés par les modules du serveur (évite les imports
// circulaires entre app.ts et les routes).
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Billing } from './billing.js';
import type { Db } from './db.js';
import type { LicenseKeys } from './license.js';
import type { Mailer } from './mail.js';
import type { OAuthConfig } from './oauth.js';

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
  /**
   * Site vitrine (lot 7, https://design-system-studio.fr) : seule origine admise
   * par CORS avec cookie, cible du lien de confirmation et des retours Stripe.
   * Absent : pages minimales de l'API, aucune origine admise.
   */
  siteUrl?: string;
  /** Connexion avec Google et GitHub (2026-11-16) : clients OAuth ; un fournisseur absent répond « indisponible ». */
  oauth?: OAuthConfig;
  /** Adresse de Romain prévenue à chaque rétractation (server/withdrawal.ts) ; absente : aucun mail. */
  adminEmail?: string;
  /** Version affichée par /v1/health (paquet + commit déployé). */
  version: string;
  /**
   * Secret d'origine (revue du 2026-11-13, n° 9) : Cloudflare l'ajoute à chaque
   * requête (en-tête `ORIGIN_HEADER`) ; sans lui, la requête est venue en direct
   * par l'URL onrender.com. Absent : contrôle éteint. `enforce` faux (premier
   * temps) : noté dans les journaux, requête servie ; vrai : 403.
   */
  originSecret?: { value: string; enforce: boolean };
  now?: () => Date;
}

export const ORIGIN_HEADER = 'x-ds-origin-secret';
/** `off` : pas de secret configuré ; `ok` : en-tête juste (passé par Cloudflare) ; `bad` : absent ou faux. */
export function originCheck(deps: Pick<Deps, 'originSecret'>, header: string | undefined): 'off' | 'ok' | 'bad' {
  if (!deps.originSecret) return 'off';
  if (!header) return 'bad';
  // Comparaison à temps constant, sur des empreintes de même longueur.
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(deps.originSecret.value).digest();
  return timingSafeEqual(a, b) ? 'ok' : 'bad';
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

// Types et erreurs partagés par les modules du serveur (évite les imports
// circulaires entre app.ts et les routes).
import type { Db } from './db.js';
import type { Mailer } from './mail.js';

export interface Deps {
  db: Db;
  mailer: Mailer;
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

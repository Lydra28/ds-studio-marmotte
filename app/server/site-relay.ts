import http from 'node:http';
import type { Registry } from './registry.js';

// Relais « Site en direct » : `http://<projet>.localhost:<port>/` sert le site
// public du projet (config.site.url), en lecture seule, et y ajoute un script
// qui reçoit de l'atelier le CSS des tokens en cours (brouillon compris).
// Origine à part de l'atelier : le site ne peut ni le lire ni appeler son API,
// et seul l'atelier peut l'afficher dans un cadre. Rien n'est écrit sur le site.

const MAX_BODY = 25_000_000;
const MAX_CACHE = 80_000_000;
const CACHE_MS = 10 * 60_000;

// Script injecté dans chaque page : la feuille reçue passe toujours en dernier
// dans <head>, donc l'emporte sur les tokens du site (comme l'import de la PR).
export const liveScript = (atelier: string) => `(() => {
  const atelier = ${JSON.stringify(atelier)};
  const style = document.createElement('style');
  style.id = 'ds-studio-live';
  addEventListener('message', (e) => {
    if (e.origin !== atelier || !e.data || e.data.type !== 'ds-css') return;
    style.textContent = String(e.data.css);
    document.head.appendChild(style);
  });
  parent.postMessage({ type: 'ds-site-ready', path: location.pathname }, atelier);
})();
`;

export function injectLive(html: string) {
  const tag = '<script src="/__ds-studio/live.js"></script>';
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${tag}</head>`) : tag + html;
}

export function createSiteRelay(registry: Registry, options: { atelier: string; fetch?: typeof fetch }) {
  const cache = new Map<string, { at: number; type: string; body: Buffer }>();
  let cached = 0;
  const server = http.createServer(async (req, res) => {
    const fail = (status: number, message: string) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(message);
    };
    try {
      const port = (server.address() as { port: number }).port;
      const host = /^([a-z0-9][a-z0-9-]{0,39})\.localhost:(\d+)$/.exec(req.headers.host ?? '');
      if (!host || Number(host[2]) !== port) return fail(403, 'Hôte refusé : <projet>.localhost attendu.');
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'Site en lecture seule dans l’atelier.');
      const headers = {
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        // Seul l'atelier peut afficher le site dans un cadre.
        'Content-Security-Policy': `frame-ancestors ${options.atelier}`,
      };
      const path = req.url ?? '/';
      if (path === '/__ds-studio/live.js') {
        res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(liveScript(options.atelier));
      }
      const { config } = await registry.get(host[1]).catch(() => ({ config: null }));
      if (!config?.site) return fail(404, 'Pas de site configuré pour ce projet.');
      const origin = new URL(config.site.url).origin;
      const upstream = new URL(path, origin);
      if (upstream.origin !== origin) return fail(400, 'Adresse hors du site.');

      let hit = cache.get(upstream.href);
      if (!hit || Date.now() - hit.at > CACHE_MS) {
        const r = await (options.fetch ?? fetch)(upstream, {
          redirect: 'manual',
          headers: { Accept: String(req.headers.accept ?? '*/*'), 'User-Agent': 'DS-Studio (site en direct)' },
          signal: AbortSignal.timeout(15_000),
        });
        const location = r.headers.get('location');
        if (r.status >= 300 && r.status < 400 && location) {
          const to = new URL(location, upstream);
          if (to.origin !== origin) return fail(502, 'Redirection hors du site refusée.');
          res.writeHead(302, { ...headers, Location: to.pathname + to.search });
          return res.end();
        }
        const body = Buffer.from(await r.arrayBuffer());
        if (body.length > MAX_BODY) return fail(502, 'Fichier du site trop volumineux.');
        const type = r.headers.get('content-type') ?? 'application/octet-stream';
        if (!r.ok) {
          res.writeHead(r.status, { ...headers, 'Content-Type': type, 'Cache-Control': 'no-store' });
          return res.end(body);
        }
        const old = cache.get(upstream.href);
        if (old) {
          cache.delete(upstream.href);
          cached -= old.body.length;
        }
        hit = { at: Date.now(), type, body };
        // Pages HTML jamais gardées : elles reflètent le site au moment de l'affichage.
        if (!type.startsWith('text/html') && cached + body.length <= MAX_CACHE) {
          cache.set(upstream.href, hit);
          cached += body.length;
        }
      }
      const body = hit.type.startsWith('text/html') ? Buffer.from(injectLive(hit.body.toString('utf8'))) : hit.body;
      res.writeHead(200, {
        ...headers,
        'Content-Type': hit.type,
        'Content-Length': body.length,
        'Cache-Control': hit.type.startsWith('text/html') ? 'no-store' : 'max-age=600',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      fail(502, `Site injoignable : ${(e as Error).message}`);
    }
  });
  return server;
}

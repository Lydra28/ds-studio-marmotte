import http from 'node:http';
import fs from 'node:fs/promises';
import { cssName } from '../shared/model.js';
import { exportName } from '../shared/export.js';
import { scanFile } from '../shared/repo-scan.js';
import type { Registry } from './registry.js';
import { planFile, readPlan, type RepoPlan } from './repo-read.js';

// Relais « Site en direct » : `http://<projet>.localhost:<port>/` sert le site
// public du projet (config.site.url), en lecture seule, et y ajoute un script
// qui reçoit de l'atelier le CSS des tokens en cours (brouillon compris).
// Origine à part de l'atelier : le site ne peut ni le lire ni appeler son API,
// et seul l'atelier peut l'afficher dans un cadre. Rien n'est écrit sur le site.
// G4 : projet rattaché à un dépôt, les valeurs en dur des réponses CSS et HTML
// deviennent les tokens du plan (comme la PR), pour que Comparaison montre le
// site après la PR. `brut.<projet>.localhost` sert le site tel qu'en ligne.

const MAX_BODY = 25_000_000;
const MAX_CACHE = 80_000_000;
const CACHE_MS = 10 * 60_000;

// Barres de défilement pixel de l'atelier (couleurs de pixel.css en dur : le
// site n'a pas les variables de l'atelier). `scrollbar-color: auto` sur la
// racine seulement : une valeur posée par le site masquerait ces règles dans
// Chromium ; les zones que le site cache (`scrollbar-width: none`) restent cachées.
export const scrollbarCss = `html{scrollbar-color:auto!important}
::-webkit-scrollbar{width:14px;height:14px}
::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background-color:#0b0b0c;background-image:radial-gradient(#2a2a2e 1px,transparent 1.2px);background-size:4px 4px}
::-webkit-scrollbar-thumb{background:#9a9890;border:3px solid #0b0b0c;box-shadow:inset -2px -2px 0 rgba(0,0,0,.45),inset 2px 2px 0 rgba(255,255,255,.35)}
::-webkit-scrollbar-thumb:hover{background:#e8ff3a}
::-webkit-scrollbar-button{display:none}`;

// Script injecté dans chaque page : la feuille reçue passe toujours en dernier
// dans <head>, donc l'emporte sur les tokens du site (comme l'import de la PR).
export const liveScript = (atelier: string) => `(() => {
  const atelier = ${JSON.stringify(atelier)};
  const style = document.createElement('style');
  style.id = 'ds-studio-live';
  const bars = document.createElement('style');
  bars.id = 'ds-studio-scrollbars';
  bars.textContent = ${JSON.stringify(scrollbarCss)};
  (document.head || document.documentElement).appendChild(bars);
  // Défilement lié (comparaison côte à côte) : position en fraction de la page,
  // sans renvoyer l'écho d'un défilement demandé par l'atelier.
  let quiet = 0;
  const room = () => Math.max(1, document.documentElement.scrollHeight - innerHeight);
  addEventListener('message', (e) => {
    if (e.origin !== atelier || !e.data) return;
    if (e.data.type === 'ds-css') {
      style.textContent = String(e.data.css);
      document.head.appendChild(style);
    }
    if (e.data.type === 'ds-scroll-to') {
      quiet = Date.now() + 200;
      scrollTo(0, Math.min(1, Math.max(0, Number(e.data.y) || 0)) * room());
    }
  });
  addEventListener('scroll', () => {
    if (Date.now() > quiet) parent.postMessage({ type: 'ds-scroll', y: scrollY / room() }, atelier);
  }, { passive: true });
  parent.postMessage({ type: 'ds-site-ready', path: location.pathname }, atelier);
})();
`;

// Erreur du relais dans le cadre de l'atelier : page lisible qui prévient
// aussi l'atelier (`ds-site-error`), qui affiche le message en grand au-dessus
// du cadre (Site.tsx). Les ressources (feuilles, images) gardent un texte brut.
const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function errorPage(atelier: string, message: string) {
  const data = JSON.stringify({ type: 'ds-site-error', message }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Site en direct</title></head>
<body style="margin:0;padding:48px;background:#0b0b0c;color:#e8e6df;font:28px/1.4 system-ui,sans-serif">
<p style="max-width:40ch">${escapeHtml(message)}</p>
<script>parent.postMessage(${data}, ${JSON.stringify(atelier)});</script>
</body></html>`;
}
// Navigation du cadre (document) plutôt que ressource de la page.
export const wantsPage = (headers: http.IncomingHttpHeaders) => {
  const dest = headers['sec-fetch-dest'];
  return dest ? dest === 'iframe' || dest === 'document' : /text\/html/.test(String(headers.accept ?? ''));
};

export function injectLive(html: string) {
  const tag = '<script src="/__ds-studio/live.js"></script>';
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${tag}</head>`) : tag + html;
}

// --- Plan du dépôt appliqué aux réponses (G4) -------------------------------

/** Nom de variable d'une valeur en dur du site (`--color-x`), null : pas de token. */
export type SiteLookup = (kind: 'color' | 'length' | 'font', property: string, normalized: string) => string | null;

// Même valeur, même propriété que dans le dépôt : le token le plus souvent
// choisi par le plan. Couleur et police : la valeur seule suffit aussi (CSS
// compilé, classes Tailwind) ; longueur : la propriété doit correspondre
// (16px d'un padding n'est pas une taille de texte).
export function planLookup(plan: Pick<RepoPlan, 'entries'>, rename: Record<string, string>): SiteLookup {
  const votes = new Map<string, Map<string, number>>();
  const vote = (k: string, token: string) => {
    const m = votes.get(k) ?? new Map<string, number>();
    m.set(token, (m.get(token) ?? 0) + 1);
    votes.set(k, m);
  };
  for (const e of plan.entries) {
    if (!e.token || (e.kind !== 'color' && e.kind !== 'length' && e.kind !== 'font')) continue;
    vote(`${e.kind}|${(e.property ?? '').toLowerCase()}|${e.normalized}`, e.token);
    if (e.kind !== 'length') vote(`${e.kind}||${e.normalized}`, e.token);
  }
  // Valeur seule : seulement si le plan n'a qu'un token pour elle (sinon un
  // texte blanc prendrait le token d'un fond blanc), la valeur reste en dur.
  const best = new Map<string, string>();
  for (const [k, m] of votes)
    if (!k.includes('||') || m.size === 1) best.set(k, [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]);
  return (kind, property, normalized) => {
    const key = best.get(`${kind}|${property}|${normalized}`) ?? (kind === 'length' ? undefined : best.get(`${kind}||${normalized}`));
    return key ? cssName(exportName(key, rename)) : null;
  };
}

/** Valeurs en dur d'une feuille ou d'une page → `var(--x, valeur)` ; scripts jamais touchés. */
export function applyPlan(text: string, kind: 'css' | 'html', lookup: SiteLookup) {
  const scripts = kind === 'html' ? [...text.matchAll(/<script\b[\s\S]*?<\/script\s*>/gi)].map((m) => [m.index!, m.index! + m[0].length]) : [];
  let out = '';
  let last = 0;
  let count = 0;
  for (const o of scanFile(kind === 'css' ? 'site.css' : 'site.html', text)) {
    if (o.detector !== 'hardcoded' || (o.via !== 'css' && o.via !== 'style-attr') || o.offset < last) continue;
    if (o.kind !== 'color' && o.kind !== 'length' && o.kind !== 'font') continue;
    if (scripts.some(([a, b]) => o.offset >= a && o.offset < b)) continue;
    const code = lookup(o.kind, (o.name ?? '').toLowerCase(), o.normalized);
    if (!code) continue;
    // `!important` reste hors de var() (sinon la déclaration ne vaut plus rien).
    const original = text.slice(o.offset, o.offset + o.length).replace(/\s*!\s*important\s*$/i, '');
    out += `${text.slice(last, o.offset)}var(${code}, ${original})`;
    last = o.offset + original.length;
    count++;
  }
  return { text: out + text.slice(last), count };
}

export function createSiteRelay(registry: Registry, options: { atelier: string; fetch?: typeof fetch }) {
  const cache = new Map<string, { at: number; type: string; body: Buffer; applied?: { plan: string; body: Buffer } }>();
  let cached = 0;
  // Plan relu seulement quand son fichier (ou le renommage) change.
  const plans = new Map<string, { stamp: string; lookup: SiteLookup | null }>();
  const lookupFor = async (dataDir: string, rename: Record<string, string>) => {
    const file = planFile(dataDir);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) return null;
    const stamp = `${file}:${stat.mtimeMs}:${JSON.stringify(rename)}`;
    const known = plans.get(file);
    if (known?.stamp === stamp) return known;
    const plan = await readPlan(dataDir).catch(() => null);
    const found = { stamp, lookup: plan ? planLookup(plan, rename) : null };
    plans.set(file, found);
    return found;
  };
  const server = http.createServer(async (req, res) => {
    const fail = (status: number, message: string) => {
      if (res.headersSent) return res.destroy();
      if (wantsPage(req.headers)) {
        res.writeHead(status, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': `frame-ancestors ${options.atelier}`,
        });
        return res.end(errorPage(options.atelier, message));
      }
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(message);
    };
    try {
      const port = (server.address() as { port: number }).port;
      const host = /^(brut\.)?([a-z0-9][a-z0-9-]{0,39})\.localhost:(\d+)$/.exec(req.headers.host ?? '');
      if (!host || Number(host[3]) !== port) return fail(403, 'Hôte refusé : <projet>.localhost attendu.');
      const raw = !!host[1];
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
      const instance = await registry.get(host[2]).catch(() => null);
      const config = instance?.config;
      if (!instance || !config?.site) return fail(404, 'Pas de site configuré pour ce projet.');
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
          cached -= old.body.length + (old.applied?.body.length ?? 0);
        }
        hit = { at: Date.now(), type, body };
        // Pages HTML jamais gardées : elles reflètent le site au moment de l'affichage.
        if (!type.startsWith('text/html') && cached + body.length <= MAX_CACHE) {
          cache.set(upstream.href, hit);
          cached += body.length;
        }
      }
      const html = hit.type.startsWith('text/html');
      const css = hit.type.startsWith('text/css');
      let body = hit.body;
      // Plan appliqué à la copie brute du cache, gardé tant que le plan ne change pas.
      const github = config.github;
      // Texte non UTF-8 annoncé : laissé tel quel (le réencoder corromprait ses octets).
      const utf8 = !/charset\s*=/i.test(hit.type) || /charset\s*=\s*"?utf-?8/i.test(hit.type);
      const plan = !raw && utf8 && (html || css) && github?.source === 'repo' ? await lookupFor(instance.store.directory, github.rename) : null;
      if (plan?.lookup) {
        if (hit.applied?.plan === plan.stamp) body = hit.applied.body;
        else {
          body = Buffer.from(applyPlan(hit.body.toString('utf8'), html ? 'html' : 'css', plan.lookup).text);
          // Gardée avec la copie brute si elle tient sous le plafond du cache.
          const kept = cache.get(upstream.href) === hit;
          if (kept) cached -= hit.applied?.body.length ?? 0;
          hit.applied = undefined;
          if (kept && cached + body.length <= MAX_CACHE) {
            hit.applied = { plan: plan.stamp, body };
            cached += body.length;
          }
        }
      }
      if (html) body = Buffer.from(injectLive(body.toString('utf8')));
      res.writeHead(200, {
        ...headers,
        'Content-Type': hit.type,
        'Content-Length': body.length,
        // Feuilles revalidées à chaque page : le plan peut changer entre deux lectures.
        'Cache-Control': html ? 'no-store' : css ? 'no-cache' : 'max-age=600',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      fail(502, `Site injoignable : ${(e as Error).message}`);
    }
  });
  return server;
}

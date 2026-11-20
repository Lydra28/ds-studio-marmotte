// Plan du site pour les moteurs (Search Console, demande de Romain du
// 2026-11-19). Pages publiques seules : ni compte/app, ni compte/verifier, ni
// merci, ni paiement-annule (pages de passage, sans intérêt en recherche).
import type { APIRoute } from 'astro';

const PUBLIC_PAGES = [
  '/',
  '/telecharger/',
  '/plugin-figma/',
  '/prix/',
  '/compte/',
  '/mentions-legales/',
  '/cgv/',
  '/confidentialite/',
];

export const GET: APIRoute = ({ site }) => {
  const urls = PUBLIC_PAGES.map((p) => `  <url><loc>${new URL(p, site).href}</loc></url>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};

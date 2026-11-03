// Script de lecture des styles calculés d'une page (lot 5), exécuté DANS la
// page par le Chromium local : `page.evaluate` de Playwright depuis les
// sources, `webContents.executeJavaScript` dans l'app Electron. Gardé en
// chaîne et non en fonction sérialisée : la minification du bundle et les
// aides d'esbuild (`__name`) casseraient un `toString()`. Aucune dépendance,
// aucune écriture, aucun réseau. Sa sortie n'est pas fiable (le site peut
// remplacer `getComputedStyle`) : toujours la valider par `inventorySchema`.
//
// Relevé, élément par élément (3 000 rendus au plus) :
// - couleurs : texte (poids = caractères propres), fond (poids = surface),
//   fond de « carte » (fond + rayon, bordure ou ombre), bordure, usage sur un
//   lien ou un bouton ; fond de la page depuis html puis body (blanc sinon) ;
//   alpha < 0,5 ignoré, couleurs hors rgb() comptées dans `unread` ;
// - textes : taille, graisse, première famille de la pile, hauteur de ligne
//   en % de la taille (0 si `normal`), pondérés par les caractères ;
// - espacements (padding, marge, gap), rayons (999 = plein), largeurs de
//   bordure, ombres (chaîne calculée).
// Les calques fixed ou sticky qui couvrent plus de la moitié de la fenêtre
// (bandeaux de consentement, modales) sont écartés avec leur contenu et
// comptés dans `overlays`.
export const PAGE_SCRIPT = String.raw`(() => {
  const MAX = 3000;
  const vw = window.innerWidth, vh = window.innerHeight;
  const colors = new Map(), texts = new Map(), spacings = new Map(), radii = new Map(), borders = new Map(), shadows = new Map();
  let elements = 0, overlays = 0, unread = 0, truncated = false;
  const bump = (map, key, field, n) => {
    let e = map.get(key);
    if (!e) { e = {}; map.set(key, e); }
    e[field] = (e[field] || 0) + n;
  };
  const rgb = (v) => {
    if (!v || v === 'transparent') return null;
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
    if (!m) { unread++; return null; }
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (!(a >= 0.5)) return null;
    const h = (x) => Math.max(0, Math.min(255, Math.round(+x))).toString(16).padStart(2, '0');
    return ('#' + h(m[1]) + h(m[2]) + h(m[3])).toUpperCase();
  };
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const ownChars = (el) => {
    let n = 0;
    for (const node of el.childNodes) if (node.nodeType === 3) n += node.textContent.replace(/\s+/g, ' ').trim().length;
    return n;
  };
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'IMG', 'PICTURE', 'SOURCE', 'OBJECT', 'EMBED']);
  const html = 'http://www.w3.org/1999/xhtml';
  const root = document.documentElement;
  const docArea = Math.max(root.scrollWidth, vw) * Math.max(root.scrollHeight, vh);
  let canvas = rgb(getComputedStyle(root).backgroundColor);
  if (!canvas && document.body) canvas = rgb(getComputedStyle(document.body).backgroundColor);
  bump(colors, canvas || '#FFFFFF', 'area', docArea);
  bump(colors, canvas || '#FFFFFF', 'canvas', 1);
  const walker = document.createTreeWalker(document.body || root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(el) {
      if (el.namespaceURI !== html || skip.has(el.tagName)) return NodeFilter.FILTER_REJECT;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return NodeFilter.FILTER_REJECT;
      if (s.position === 'fixed' || s.position === 'sticky') {
        const r = el.getBoundingClientRect();
        if (r.width * r.height > vw * vh * 0.5) { overlays++; return NodeFilter.FILTER_REJECT; }
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const sides = ['Top', 'Right', 'Bottom', 'Left'];
  let el;
  while ((el = walker.nextNode())) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (elements >= MAX) { truncated = true; break; }
    elements++;
    const s = getComputedStyle(el);
    const area = r.width * r.height;
    const interactive = el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button';
    const chars = ownChars(el);
    const fg = rgb(s.color);
    if (chars) {
      if (fg) bump(colors, fg, 'text', chars);
      const size = Math.round(px(s.fontSize));
      const weight = Math.round(+s.fontWeight) || 400;
      const family = (s.fontFamily.split(',')[0] || '').trim().replace(/^["']|["']$/g, '').slice(0, 80);
      const lhPx = parseFloat(s.lineHeight);
      const lh = s.lineHeight === 'normal' || !Number.isFinite(lhPx) || !size ? 0 : Math.round((lhPx / size) * 100);
      if (size) bump(texts, [size, weight, family, lh].join('|'), 'chars', chars);
    }
    let border = 0, borderColor = null;
    for (const k of sides) {
      const w = px(s['border' + k + 'Width']);
      const style = s['border' + k + 'Style'];
      if (w > border && style !== 'none' && style !== 'hidden') { border = w; borderColor = s['border' + k + 'Color']; }
    }
    if (border > 0) {
      bump(borders, Math.round(border), 'count', 1);
      const bc = rgb(borderColor);
      if (bc) bump(colors, bc, 'border', 1);
    }
    const shadow = s.boxShadow && s.boxShadow !== 'none' ? s.boxShadow.slice(0, 200) : '';
    if (shadow) bump(shadows, shadow, 'count', 1);
    const raw = s.borderTopLeftRadius;
    let radius = raw.endsWith('%') ? (parseFloat(raw) >= 50 ? 999 : 0) : px(raw);
    if (radius > 0 && radius >= Math.min(r.width, r.height) / 2) radius = 999;
    const bg = rgb(s.backgroundColor);
    if (bg) {
      bump(colors, bg, 'area', area);
      if (radius > 0 || border > 0 || shadow) bump(colors, bg, 'card', area);
    }
    if (interactive) {
      if (bg) bump(colors, bg, 'interactive', 1);
      else if (fg) bump(colors, fg, 'interactive', 1);
    }
    if (radius > 0 && (bg || border > 0 || shadow)) bump(radii, Math.round(radius), 'count', 1);
    for (const k of sides) {
      for (const v of [px(s['padding' + k]), px(s['margin' + k])]) if (v > 0 && v <= 400) bump(spacings, Math.round(v), 'count', 1);
    }
    if (/flex|grid/.test(s.display)) {
      for (const v of [px(s.rowGap), px(s.columnGap)]) if (v > 0 && v <= 400) bump(spacings, Math.round(v), 'count', 1);
    }
  }
  const sorted = (map, make, weight, n) => [...map].map(make).sort((a, b) => weight(b) - weight(a)).slice(0, n);
  return {
    url: location.href.slice(0, 500),
    title: document.title.slice(0, 200),
    viewport: { width: vw, height: vh },
    elements, overlays, unread, truncated,
    colors: sorted(colors, ([hex, v]) => ({
      hex, text: v.text || 0, area: Math.round(v.area || 0), card: Math.round(v.card || 0),
      border: v.border || 0, interactive: v.interactive || 0, canvas: !!v.canvas,
    }), (c) => c.text + c.area / 1000 + c.border + c.interactive, 200),
    texts: sorted(texts, ([k, v]) => {
      const [size, weight, family, lineHeight] = k.split('|');
      return { size: +size, weight: +weight, family, lineHeight: +lineHeight, chars: v.chars };
    }, (t) => t.chars, 200),
    spacings: sorted(spacings, ([value, v]) => ({ value: +value, count: v.count }), (x) => x.count, 100),
    radii: sorted(radii, ([value, v]) => ({ value: +value, count: v.count }), (x) => x.count, 50),
    borderWidths: sorted(borders, ([value, v]) => ({ value: +value, count: v.count }), (x) => x.count, 20),
    shadows: sorted(shadows, ([value, v]) => ({ value, count: v.count }), (x) => x.count, 20),
  };
})()`;

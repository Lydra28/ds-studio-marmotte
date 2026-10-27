import { resolve, type TokenSet } from '../shared/model.js';

// Familles Google Fonts citées par les tokens fontFamily, chargées une fois
// par document (atelier ou preview). Les familles système sont ignorées.
const system =
  /^(system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont|segoe ui|sans-serif|serif|monospace|cursive|fantasy|arial|helvetica|helvetica neue|georgia|times|times new roman|courier|courier new|verdana|tahoma|inherit|initial)$/i;
export function fontFamilies(set: TokenSet) {
  const out = new Set<string>();
  for (const [key, token] of Object.entries(set.tokens))
    if (token.$type === 'fontFamily') {
      const first = String(resolve(set, key)).split(',')[0].trim().replace(/^['"]|['"]$/g, '');
      if (first && !system.test(first) && /^[A-Za-z0-9 ]{2,60}$/.test(first)) out.add(first);
    }
  return [...out];
}
export function loadFonts(families: string[], doc: Document = document) {
  for (const family of families) {
    const id = `gf-${family.replace(/\s+/g, '-').toLowerCase()}`;
    if (doc.getElementById(id)) continue;
    const link = doc.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@400;500;600;700&display=swap`;
    doc.head.appendChild(link);
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  proposeFromInventory,
  siteInventorySchema,
  type PageInventory,
  type SiteInventory,
} from '../app/shared/extract.js';
import { applyChanges, resolve, tokenSetSchema, type Change, type TokenSet } from '../app/shared/model.js';

// Lot 5, étape 5.2 : proposition de tokens depuis un inventaire, sans
// Chromium ni réseau. Inventaire réel (page de fixture) puis cas synthétiques.
const load = async (file: string) => tokenSetSchema.parse(JSON.parse(await readFile(file, 'utf8')));
const blank = await load('templates/blank/design-system.tokens.json');
const marmotte = await load('projects/marmotte/design-system.tokens.json');
const fixture = siteInventorySchema.parse(JSON.parse(await readFile('tests/fixtures/site/inventory.json', 'utf8')));

type C = PageInventory['colors'][number];
const colour = (hex: string, w: Partial<C>): C => ({ hex, text: 0, area: 0, card: 0, border: 0, interactive: 0, canvas: false, ...w });
const page = (w: Partial<PageInventory>): PageInventory => ({
  url: 'https://exemple.test/',
  title: 'Exemple',
  viewport: { width: 1280, height: 800 },
  elements: 100,
  overlays: 0,
  unread: 0,
  truncated: false,
  colors: [colour('#FFFFFF', { area: 1_000_000, canvas: true }), colour('#222222', { text: 5000 })],
  texts: [{ size: 16, weight: 400, family: 'Inter', lineHeight: 150, chars: 5000 }],
  spacings: [],
  radii: [],
  borderWidths: [],
  shadows: [],
  ...w,
});
const site = (desktop: PageInventory, mobile = desktop): SiteInventory => siteInventorySchema.parse({ desktop, mobile });
const valueOf = (changes: Change[], key: string, mode = 'default') =>
  changes.find((c) => !('op' in c) && c.key === key && c.mode === mode) as { value: string | number } | undefined;
const applied = (set: TokenSet, changes: Change[]) => tokenSetSchema.parse(applyChanges(set, changes));

test('proposition : la page de fixture donne marque, gris, sémantiques, police et tailles', () => {
  const { changes, rejected, report } = proposeFromInventory(fixture, blank);
  assert.deepEqual(rejected, []);
  const next = applied(blank, changes);
  assert.equal(report.brand, '#2563EB');
  assert.equal(next.tokens['color/brand/600'].$values.default, '#2563EB');
  assert.equal(resolve(next, 'bg/brand', { tokens: 'light' }), '#2563EB');
  assert.equal(resolve(next, 'text/primary', { tokens: 'light' }), '#1F2937');
  assert.equal(resolve(next, 'text/muted', { tokens: 'light' }), '#6B7280');
  assert.equal(resolve(next, 'border/default', { tokens: 'light' }), '#E5E7EB');
  assert.equal(resolve(next, 'bg/canvas', { tokens: 'light' }), '#F7F7F5');
  assert.equal(next.tokens['font/family/sans'].$values.default, 'Inter');
  // Tailles : desktop à 1280 px, mobile à 390 px (media query de la fixture).
  assert.deepEqual(
    ['body', 'label', 'heading', 'display'].map((s) => next.tokens[`font/size/${s}`].$values.desktop),
    [16, 13, 24, 40],
  );
  assert.deepEqual(
    ['heading', 'display'].map((s) => next.tokens[`font/size/${s}`].$values.mobile),
    [20, 28],
  );
  assert.equal(resolve(next, 'font/weight/heading', { typography: 'desktop' }), 600);
  // Sémantiques toujours en alias, jamais en valeur brute.
  for (const c of changes) if (!('op' in c) && blank.tokens[c.key]?.$collection === 'tokens') assert.match(String(c.value), /^\{.+\}$/);
  assert.ok(report.notes.some((n) => /Ombres : 1/.test(n)));
});

test('proposition : rouge des boutons = marque ; rouge discret à côté d’une marque = danger', () => {
  const redBrand = proposeFromInventory(
    site(page({ colors: [colour('#FFFFFF', { area: 1e6, canvas: true }), colour('#222222', { text: 5000 }), colour('#DC2626', { area: 40_000, interactive: 6 })] })),
    blank,
  );
  assert.equal(redBrand.report.brand, '#DC2626');
  assert.equal(redBrand.report.danger, null);
  assert.equal(valueOf(redBrand.changes, 'color/brand/600')?.value, '#DC2626');

  const withDanger = proposeFromInventory(
    site(
      page({
        colors: [
          colour('#FFFFFF', { area: 1e6, canvas: true }),
          colour('#222222', { text: 5000 }),
          colour('#2563EB', { area: 40_000, interactive: 6 }),
          colour('#DC2626', { text: 120 }),
        ],
      }),
    ),
    blank,
  );
  assert.equal(withDanger.report.brand, '#2563EB');
  assert.equal(withDanger.report.danger, '#DC2626');
  assert.equal(valueOf(withDanger.changes, 'color/danger/600')?.value, '#DC2626');
});

test('proposition : gris « slate » restent des gris, seconde teinte ajoutée en accent', () => {
  const { changes, report, rejected } = proposeFromInventory(
    site(
      page({
        colors: [
          colour('#F1F5F9', { area: 1e6, canvas: true }),
          colour('#0F172A', { text: 6000 }),
          colour('#64748B', { text: 1500 }),
          colour('#2563EB', { area: 30_000, interactive: 8 }),
          colour('#16A34A', { area: 200_000, text: 800, interactive: 2 }),
        ],
      }),
    ),
    blank,
  );
  assert.deepEqual(rejected, []);
  assert.equal(report.brand, '#2563EB');
  assert.equal(report.accent, '#16A34A');
  const next = applied(blank, changes);
  assert.equal(next.tokens['color/accent/600'].$values.default, '#16A34A');
  assert.equal(resolve(next, 'text/primary', { tokens: 'light' }), '#0F172A');
  assert.ok(Object.values(next.tokens).filter((t) => t.$values.default === '#64748B').length === 1);
});

test('proposition : police générique ignorée, échelles recalées par fenêtre et jamais par rang', () => {
  const { changes, report } = proposeFromInventory(
    site(
      page({
        texts: [{ size: 16, weight: 400, family: 'sans-serif', lineHeight: 0, chars: 5000 }],
        spacings: [
          { value: 4, count: 1000 },
          { value: 36, count: 50 },
          { value: 70, count: 20 },
          { value: 200, count: 80 },
        ],
        radii: [{ value: 7, count: 10 }, { value: 999, count: 4 }],
      }),
    ),
    blank,
  );
  assert.equal(report.family, null);
  assert.equal(valueOf(changes, 'font/family/sans'), undefined);
  assert.ok(report.notes.some((n) => /Police du site non lue/.test(n)));
  assert.equal(valueOf(changes, 'space/md'), undefined);
  assert.equal(valueOf(changes, 'space/xl')?.value, 36);
  assert.equal(valueOf(changes, 'space/3xl')?.value, 72);
  assert.equal(valueOf(changes, 'space/4xl'), undefined);
  assert.equal(valueOf(changes, 'radius/sm')?.value, 7);
  assert.equal(valueOf(changes, 'radius/full'), undefined);
  // Hauteur de ligne `normal` (0) : rien proposé.
  assert.equal(valueOf(changes, 'font/line-height/body', 'desktop'), undefined);
});

test('proposition : site non adaptatif, mobile = desktop ; tailles manquantes gardent l’ordre', () => {
  const desktop = page({
    texts: [
      { size: 17, weight: 400, family: 'Inter', lineHeight: 160, chars: 6000 },
      { size: 15, weight: 500, family: 'Inter', lineHeight: 140, chars: 600 },
      { size: 60, weight: 800, family: 'Inter', lineHeight: 110, chars: 120 },
    ],
  });
  const { changes, rejected } = proposeFromInventory(site(desktop), blank);
  assert.deepEqual(rejected, []);
  const next = applied(blank, changes);
  const scale = (mode: string) =>
    ['caption', 'label', 'body', 'title', 'heading', 'display'].map((s) => next.tokens[`font/size/${s}`].$values[mode] as number);
  // Crans lus sur le site : identiques dans les deux modes ; les autres gardent
  // la valeur du gabarit de leur mode (titre 20 en desktop, 18 en mobile).
  const [d, m] = [scale('desktop'), scale('mobile')];
  for (const i of [1, 2, 5]) assert.equal(d[i], m[i]);
  assert.deepEqual([d[1], d[2], d[5]], [15, 17, 60]);
  for (const s of [d, m]) for (let i = 1; i < s.length; i++) assert.ok(s[i] > s[i - 1], `ordre des tailles : ${s.join(', ')}`);
  assert.equal(next.tokens['font/weight/extrabold'].$values.default, 800);
  assert.equal(next.tokens['font/line-height/body'].$values.desktop, 160);
});

test('proposition : inventaire vide ou jeu d’un vrai projet, jamais de jeu invalide', () => {
  const empty = proposeFromInventory(site(page({ colors: [], texts: [] })), blank);
  assert.deepEqual(empty.changes, []);
  assert.ok(empty.report.notes.some((n) => /Aucune couleur de marque/.test(n)));

  // Jeu de Marmotte (autres valeurs, mêmes clés ou non) : la proposition reste
  // applicable et le jeu obtenu valide.
  const onMarmotte = proposeFromInventory(fixture, marmotte);
  assert.deepEqual(onMarmotte.rejected, []);
  applied(marmotte, onMarmotte.changes);

  // Jeu sans typographie ni gamme neutre : rien d'inventé.
  const bare = tokenSetSchema.parse({
    modes: blank.modes,
    tokens: { 'color/brand/600': blank.tokens['color/brand/600'] },
  });
  const onBare = proposeFromInventory(fixture, bare);
  assert.deepEqual(onBare.rejected, []);
  assert.deepEqual(Object.keys(applied(bare, onBare.changes).tokens), ['color/brand/600']);
});

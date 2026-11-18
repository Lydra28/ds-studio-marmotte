import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { applyChanges, tokenSetSchema, type TokenSet } from '../app/shared/model.js';
import { proposeFromRepo } from '../app/shared/repo-propose.js';
import { locate, rewriteRepo, stillProposed } from '../app/shared/repo-rewrite.js';
import { scanRepo } from '../app/shared/repo-scan.js';

// PR qui modifie le code (plan GitHub, G5) : réécriture pure sur un dépôt fictif.
const template = () => tokenSetSchema.parse(JSON.parse(readFileSync('templates/blank/design-system.tokens.json', 'utf8')));

const TOKENS = [
  ':root {',
  '  --color-ink-900: #111111;',
  '  --color-paper: #FAFAF7;',
  '  --color-accent-500: #2F6FEB;',
  '  --color-accent-600: #1F5AD1;',
  '  --text-primary: var(--color-ink-900);',
  '  --bg-canvas: var(--color-paper);',
  '  --bg-brand: var(--color-accent-500);',
  '  --space-sm: 8px;',
  '  --space-md: 1rem;',
  '  --space-lg: 24px;',
  '  --radius-card: 12px;',
  '  --font-body: "Satoshi", sans-serif;',
  '}',
  '',
].join('\n');
const CARD = [
  '.card { background: #FAFAF7; color: #121212; border-radius: 12px; margin: 11px; font-family: Satoshi, sans-serif; }',
  '.btn { background: var(--bg-brand); }',
  '',
].join('\n');
const APP = 'export const A = () => <div className="bg-[#2F6FEB] p-4" style={{ padding: 24 }} />;\n';

const repo = { 'src/styles/tokens.css': TOKENS, 'src/components/Card.css': CARD, 'src/App.tsx': APP, 'src/styles/app.css': '@import "tailwindcss";\n' };
const files = (over: Record<string, string> = {}) => new Map(Object.entries({ ...repo, ...over }));

function setup() {
  const set0 = template();
  const plan = proposeFromRepo(scanRepo(Object.entries(repo).map(([path, text]) => ({ path, text }))), set0, { mode: 'create' });
  const set: TokenSet = applyChanges(set0, plan.changes);
  return { plan, set };
}

test('réécriture : position vérifiée, sinon même valeur seule sur sa ligne', () => {
  const text = 'a {\n  color: #fff; background: #000;\n}\n';
  assert.equal(locate(text, 13, '#fff', 2), 13);
  // Texte décalé sur la même ligne : retrouvé.
  assert.equal(locate('a {\n    color: #fff; background: #000;\n}\n', 13, '#fff', 2), 15);
  // Valeur absente ou deux fois sur la ligne : rien n'est deviné.
  assert.equal(locate('a {\n  color: #eee;\n}\n', 13, '#fff', 2), null);
  assert.equal(locate('a {\n  color: #fff; border-color: #fff;\n}\n', 99, '#fff', 2), null);
});

test('réécriture : plan sur le jeu tel quel, valeurs en dur remplacées, rien d’autre', () => {
  const { plan, set } = setup();
  assert.equal(plan.tokens.find((t) => t.code === '--bg-brand')!.uses, 1);
  assert.equal(plan.tokens.find((t) => t.code === '--color-accent-600')!.uses, 0);
  const r = rewriteRepo({ tokens: plan.tokens, entries: plan.entries, set, rename: {}, files: files() });
  assert.deepEqual(r.blocked, []);
  assert.deepEqual(r.changed, [], 'aucune variable changée : le jeu est celui du dépôt');
  const card = r.files.find((f) => f.path === 'src/components/Card.css')!.text;
  assert.match(card, /background: var\(--bg-canvas\);/);
  assert.match(card, /border-radius: var\(--radius-card\);/);
  assert.match(card, /font-family: var\(--font-body\);/);
  // #121212 : proche de --text-primary (#111111), remplacé et signalé comme écart de rendu.
  assert.match(card, /color: var\(--text-primary\);/);
  assert.ok(r.gaps.some((g) => g.value === '#121212' && g.code === 'var(--text-primary)'));
  // 11px : aucun cran assez proche, laissé.
  assert.match(card, /margin: 11px;/);
  assert.ok(r.unmapped >= 1);
  // Classe Tailwind arbitraire : type explicite pour v3 et v4.
  const app = r.files.find((f) => f.path === 'src/App.tsx')!.text;
  assert.match(app, /className="bg-\[color:var\(--bg-brand\)\] p-4"/);
  assert.match(app, /padding: 24/, 'objet de style JS jamais réécrit');
  assert.ok(r.skipped.some((s) => s.file === 'src/App.tsx' && /objet de style JS/.test(s.reason)));
  // Le fichier des variables ne change pas, sauf les tokens du gabarit gardés (ajoutés).
  const tokens = r.files.find((f) => f.path === 'src/styles/tokens.css');
  if (tokens) assert.ok(tokens.text.startsWith(TOKENS.slice(0, TOKENS.indexOf('}'))));
});

test('réécriture : variable changée sur place, police gardée avec ses replis, token ajouté, déclaration retirée', () => {
  const { plan, set } = setup();
  set.tokens['color/accent/500'].$values.default = '#2255CC';
  set.tokens['space/md'].$values.default = 20;
  set.tokens['font/body'].$values.default = 'Inter Tight';
  set.tokens['space/xl'] = { $type: 'dimension', $collection: 'primitives', $values: { default: 32 } };
  delete set.tokens['color/accent/600'];
  const r = rewriteRepo({ tokens: plan.tokens, entries: plan.entries, set, rename: {}, files: files() });
  const css = r.files.find((f) => f.path === 'src/styles/tokens.css')!.text;
  assert.match(css, /--color-accent-500: #2255CC;/);
  assert.match(css, /--space-md: 20px;/);
  assert.match(css, /--font-body: "Inter Tight", sans-serif;/);
  assert.match(css, /--bg-brand: var\(--color-accent-500\);/, 'alias inchangé, non réécrit');
  assert.doesNotMatch(css, /--color-accent-600/);
  assert.deepEqual(r.removed, ['--color-accent-600']);
  // Nouveau token : après la dernière variable, même retrait, avant la fermeture du bloc.
  assert.match(css, /--font-body: "Inter Tight", sans-serif;\n {2}--space-xl: 32px;[\s\S]*\n\}\n$/);
  assert.ok(r.added.some((a) => a.code === '--space-xl' && a.file === 'src/styles/tokens.css'));
  assert.deepEqual([...r.changed].sort(), ['--color-accent-500', '--font-body', '--space-md']);
});

test('réécriture : token retiré encore utilisé → bloqué ; code changé depuis la lecture → signalé, jamais deviné', () => {
  const { plan, set } = setup();
  delete set.tokens['bg/brand'];
  const blocked = rewriteRepo({ tokens: plan.tokens, entries: plan.entries, set, rename: {}, files: files() });
  // Plan d'avant la recette du 2026-11-17 (sans `proposed`) : même blocage qu'avant.
  assert.deepEqual(blocked.blocked, [{ code: '--bg-brand', key: 'bg/brand', file: 'src/styles/tokens.css', line: 8, uses: 1 }]);

  const fresh = setup();
  fresh.set.tokens['color/paper'].$values.default = '#FFFFFF';
  // Le dev a changé la ligne de --color-paper et la carte depuis la lecture.
  const moved = files({
    'src/styles/tokens.css': TOKENS.replace('--color-paper: #FAFAF7;', '--color-paper: #FAFAF8;'),
    'src/components/Card.css': CARD.replace('background: #FAFAF7;', 'background: #FAFAF8;'),
  });
  const r = rewriteRepo({ tokens: fresh.plan.tokens, entries: fresh.plan.entries, set: fresh.set, rename: {}, files: moved });
  assert.ok(r.skipped.some((s) => s.value === '--color-paper' && /déplacée/.test(s.reason)));
  assert.ok(r.skipped.some((s) => s.value === '#FAFAF7' && /déplacée/.test(s.reason)));
  const card = r.files.find((f) => f.path === 'src/components/Card.css')!.text;
  assert.match(card, /background: #FAFAF8;/, 'valeur du dev intacte');
});

test('réécriture : fins de ligne Windows gardées', () => {
  const crlf = TOKENS.replace(/\n/g, '\r\n');
  const set0 = template();
  const plan = proposeFromRepo(scanRepo([{ path: 'src/styles/tokens.css', text: crlf }]), set0, { mode: 'create' });
  const set = applyChanges(set0, plan.changes);
  set.tokens['space/xl'] = { $type: 'dimension', $collection: 'primitives', $values: { default: 32 } };
  const r = rewriteRepo({ tokens: plan.tokens, entries: plan.entries, set, rename: {}, files: new Map([['src/styles/tokens.css', crlf]]) });
  const css = r.files[0].text;
  assert.match(css, /--font-body: "Satoshi", sans-serif;\r\n {2}--space-xl: 32px;/);
  assert.doesNotMatch(css.replace(/\r\n/g, ''), /\n/);
});

// Recette du 2026-11-17 : projet créé depuis un dépôt, panneau fermé sans
// « Mettre en brouillon », puis « Accepter ». Les tokens du dépôt n'ont été que
// proposés : ni « retirés » (blocage), ni déclarations supprimées.
const FEW = [
  ':root {',
  '  --brand-main: #2563eb;',
  '  --ink-strong: #111827;',
  '  --gap-base: 16px;',
  '}',
  '.a { color: var(--brand-main); padding: 16px; }',
  '',
].join('\n');

test('réécriture : token seulement proposé et encore utilisé → signalé « jamais repris », jamais bloqué', () => {
  const set0 = template();
  const plan = proposeFromRepo(scanRepo([{ path: 'src/a.css', text: FEW }]), set0, { mode: 'create' });
  assert.ok(plan.proposed.includes('brand/main'), 'tokens absents du jeu à la lecture marqués comme proposés');
  const r = rewriteRepo({ tokens: plan.tokens, entries: plan.entries, set: set0, rename: {}, files: new Map([['src/a.css', FEW]]), proposed: plan.proposed });
  assert.deepEqual(r.blocked, []);
  const main = r.untaken.find((u) => u.code === '--brand-main');
  assert.deepEqual(main, { code: '--brand-main', key: 'brand/main', file: 'src/a.css', line: 2, uses: 1 });
});

test('réécriture : token seulement proposé sans usage → déclaration gardée, jamais comptée retirée', () => {
  const set0 = template();
  const quiet = FEW.replace('var(--brand-main)', '#2563eb');
  const plan = proposeFromRepo(scanRepo([{ path: 'src/a.css', text: quiet }]), set0, { mode: 'create' });
  const r = rewriteRepo({ tokens: plan.tokens, entries: plan.entries, set: set0, rename: {}, files: new Map([['src/a.css', quiet]]), proposed: plan.proposed });
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.untaken.map((u) => u.code).sort(), ['--brand-main', '--gap-base', '--ink-strong']);
  const out = r.files.find((f) => f.path === 'src/a.css')?.text ?? quiet;
  assert.ok(out.startsWith(':root {\n  --brand-main: #2563eb;\n  --ink-strong: #111827;\n  --gap-base: 16px;\n}'), 'les trois déclarations restent');
  // Valeur en dur rattachée à un token jamais repris : laissée, avec la bonne raison.
  assert.ok(r.skipped.every((s) => !/retiré/.test(s.reason)));
});

test('réécriture : token présent à la lecture puis retiré → toujours bloqué, avec clé, fichier et ligne', () => {
  const { plan, set } = setup();
  delete set.tokens['bg/brand'];
  const r = rewriteRepo({ tokens: plan.tokens, entries: plan.entries, set, rename: {}, files: files(), proposed: [] });
  assert.deepEqual(r.blocked, [{ code: '--bg-brand', key: 'bg/brand', file: 'src/styles/tokens.css', line: 8, uses: 1 }]);
  assert.deepEqual(r.untaken, []);
});

// Relecture du 2026-11-18 : un token proposé à la lecture, repris dans une
// version, puis retiré, est un vrai retrait (le plan n'est pas recalculé).
test('réécriture : token proposé, accepté puis retiré, encore utilisé → bloqué', () => {
  const set0 = template();
  const plan = proposeFromRepo(scanRepo([{ path: 'src/a.css', text: FEW }]), set0, { mode: 'create' });
  const readAt = '2026-11-18T10:00:00.000Z';
  const taken = applyChanges(set0, plan.changes);
  assert.ok(taken.tokens['brand/main'], 'repris dans la version 1');
  const accepted = [
    { acceptedAt: '2026-11-18T09:00:00.000Z', set: taken }, // avant la lecture : ignorée
    { acceptedAt: '2026-11-18T11:00:00.000Z', set: taken },
  ];
  const left = stillProposed(plan.proposed, readAt, accepted);
  assert.ok(!left.includes('brand/main'));
  assert.deepEqual(stillProposed(plan.proposed, readAt, accepted.slice(0, 1)), plan.proposed, 'version d’avant la lecture : rien de repris');
  assert.deepEqual(stillProposed(undefined, readAt, accepted), []);

  const removed = structuredClone(taken);
  delete removed.tokens['brand/main'];
  const r = rewriteRepo({ tokens: plan.tokens, entries: plan.entries, set: removed, rename: {}, files: new Map([['src/a.css', FEW]]), proposed: left });
  assert.deepEqual(r.blocked.map((b) => b.code), ['--brand-main']);
  assert.ok(!r.untaken.some((u) => u.code === '--brand-main'));
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { applyChanges, resolve, tokenSetSchema, type TokenSet } from '../app/shared/model.js';
import { configSchema } from '../app/shared/project.js';
import { keyFor, proposeFromRepo } from '../app/shared/repo-propose.js';
import { scanRepo } from '../app/shared/repo-scan.js';

// Projet depuis un dépôt et rattachement (plan GitHub, G3), sur dépôts fictifs.
const template = () => tokenSetSchema.parse(JSON.parse(readFileSync('templates/blank/design-system.tokens.json', 'utf8')));

const structured = [
  {
    path: 'src/styles/tokens.css',
    text: [
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
      '  --font-size-body: 16px;',
      '  --font-weight-bold: 700;',
      '  --shadow-card: 0 1px 2px rgba(0,0,0,.1);',
      '  --overlay: #00000080;',
      '}',
      '@media (max-width: 767px) { :root { --font-size-body: 15px; } }',
      '@media (prefers-color-scheme: dark) { :root { --bg-canvas: #000000; } }',
      '.card { --radius-card: 4px; padding: 16px; background: #FAFAF7; color: #121212; border-radius: 12px; margin: 11px; }',
      '.hero { color: #FF00AA; gap: 22px; font-family: Satoshi, sans-serif; }',
    ].join('\n'),
  },
  { path: 'src/components/Button.css', text: '.btn { padding: 8px 24px; background: var(--bg-brand); }' },
];

test('repo-propose : noms du dépôt vers des noms de projet', () => {
  assert.equal(keyFor({ detector: 'css-var', name: '--color-brand-500' }), 'color/brand/500');
  assert.equal(keyFor({ detector: 'scss-var', name: '$brandPrimary' }), 'brand-primary');
  assert.equal(keyFor({ detector: 'tailwind-v3', name: 'colors.brand.500' }), 'color/brand/500');
  assert.equal(keyFor({ detector: 'tailwind-v3', name: 'fontSize.hero' }), 'font/size/hero');
  assert.equal(keyFor({ detector: 'tokens-json', name: 'color.brandDark.500' }), 'color/brand-dark/500');
});

test('repo-propose : création depuis un dépôt structuré, gabarit remplacé, modes, alias, plan', () => {
  const set = template();
  const scan = scanRepo(structured);
  const p = proposeFromRepo(scan, set, { mode: 'create' });
  assert.equal(p.report.strategy, 'explicit');
  const next = applyChanges(set, p.changes);
  // Tokens du dépôt repris avec leurs noms, alias gardés.
  assert.equal(next.tokens['color/ink/900'].$values.default, '#111111');
  assert.equal(next.tokens['text/primary'].$values.light, '{color/ink/900}');
  assert.equal(next.tokens['bg/brand'].$values.light, '{color/accent/500}');
  assert.equal(next.tokens['space/md'].$values.default, 16);
  assert.equal(next.tokens['font/body'].$values.default, 'Satoshi');
  assert.equal(next.tokens['font/weight/bold'].$values.default, 700);
  // Mode mobile repris (typographie), mode sombre absent du projet : non repris.
  assert.deepEqual(next.tokens['font/size/body'].$values, { desktop: 16, mobile: 15 });
  assert.ok(p.report.declared.modeIgnored >= 1);
  // Gabarit : ce qui ne vient pas du dépôt est retiré.
  assert.equal(next.tokens['color/neutral/500'], undefined);
  assert.ok(p.report.declared.removed > 30);
  // Refus expliqués : ombre, alpha ; redéclaration locale ignorée.
  const reasons = Object.fromEntries(p.report.rejected.map((r) => [r.name, r.reason]));
  assert.match(reasons['--shadow-card'], /ombre/);
  assert.match(reasons['--overlay'], /alpha/);
  assert.equal(p.report.declared.local, 1);
  assert.equal(p.rejected.length, 0, 'aucun refus à l’essai à blanc');
  // Plan : valeurs en dur rattachées, écarts mesurés.
  const by = (v: string) => p.entries.filter((e) => e.value === v);
  assert.equal(by('#FAFAF7')[0].token, 'bg/canvas', 'fond : token sémantique de fond préféré');
  assert.equal(by('#FAFAF7')[0].gap, 0);
  assert.equal(by('#121212')[0].token, 'text/primary');
  assert.ok(by('#121212')[0].gap! > 0 && by('#121212')[0].gap! < 0.05);
  assert.equal(by('#FF00AA')[0].token, null, 'aucune couleur proche');
  assert.equal(by('16px')[0].token, 'space/md');
  assert.equal(by('11px')[0].token, null, '11 px hors de la fenêtre de space/md (16 ± 4) et space/sm (8 ± 2)');
  assert.equal(by('22px')[0].token, 'space/lg');
  assert.equal(by('22px')[0].gap, 2);
  assert.equal(by('Satoshi, sans-serif')[0].token, 'font/body');
  assert.equal(by('12px')[0].token, 'radius/card');
  assert.ok(p.report.gaps.length > 0);
  // Couleur d'ombre (transparente) lue depuis la recette du 2026-11-09 : sans token.
  assert.deepEqual(p.report.unmapped.map((u) => u.value).sort(), ['#0000001A', '#FF00AA', '11px']);
  // Déclarations gardées pour G5 : nom de code et position.
  const ink = p.tokens.find((t) => t.key === 'color/ink/900')!;
  assert.equal(ink.code, '--color-ink-900');
  assert.equal(structured[0].text.slice(ink.offset, ink.offset + ink.length), '#111111');
});

test('repo-propose : rattachement, correspondance par nom de code (rename), seuls les manquants ajoutés', () => {
  const set = template();
  // Projet existant exporté avec « bg/ » → « color/bg/ » : --color-bg-canvas = bg/canvas.
  const files = [
    {
      path: 'site.css',
      text: ':root { --color-bg-canvas: #FFFFFF; --color-bg-surface: #EEEEEE; --color-bg-hero: #123456; --space-md: 16px; --space-huge: 96px; }',
    },
  ];
  const before = resolve(set, 'bg/surface');
  const p = proposeFromRepo(scanRepo(files), set, { mode: 'attach', rename: { 'bg/': 'color/bg/' } });
  assert.equal(p.report.strategy, 'explicit');
  assert.equal(p.report.declared.matched, 3, 'bg/canvas, bg/surface, space/md');
  const next = applyChanges(set, p.changes);
  assert.equal(next.tokens['bg/hero'].$values.light ?? next.tokens['bg/hero'].$values.default, '#123456', 'nom renommé à l’envers');
  assert.equal(next.tokens['space/huge'].$values.default, 96);
  assert.equal(next.tokens['color/neutral/500'] !== undefined, true, 'rien retiré');
  assert.equal(resolve(next, 'bg/surface'), before, 'valeur du projet gardée');
  assert.ok(p.report.differing.some((d) => d.key === 'bg/surface' && d.repo === '#EEEEEE'));
  assert.equal(p.report.declared.removed, 0);
  assert.ok(p.changes.every((c) => 'op' in c && c.op === 'add'), 'que des ajouts');
});

test('repo-propose : dépôt en désordre (création), valeurs en dur regroupées sur le gabarit', () => {
  const set = template();
  const messy = [
    {
      path: 'src/App.css',
      text: [
        'body { color: #222222; background: #FFFFFF; font-family: "Work Sans", sans-serif; }',
        '.btn { background: #E8590C; color: #FFFFFF; padding: 8px 16px; border-radius: 6px; }',
        '.btn:hover { background: #E8590C; }',
        '.card { background: #F4F4F4; padding: 24px; border: 1px solid #DDDDDD; border-radius: 6px; }',
        'h1 { font-size: 40px; color: #222222; } p { font-size: 16px; color: #555555; }',
        'a { color: #E8590C; }',
      ].join('\n'),
    },
  ];
  const p = proposeFromRepo(scanRepo(messy), set, { mode: 'create' });
  assert.equal(p.report.strategy, 'inventory');
  const next = applyChanges(set, p.changes);
  assert.equal(next.tokens['font/family/sans'].$values.default, 'Work Sans');
  assert.ok(Object.keys(next.tokens).includes('color/neutral/500'), 'gabarit gardé');
  assert.equal(resolve(next, 'color/brand/600').toString().toUpperCase(), '#E8590C', 'marque au cran 600');
  assert.equal(p.entries.find((e) => e.value === '#E8590C')!.gap, 0);
  assert.ok(p.report.hardcoded.mapped >= p.report.hardcoded.total - 3);
});

test('repo-propose : DTCG et Tailwind v3, limite de 500 tokens', () => {
  const set = template();
  const json = {
    path: 'tokens/base.tokens.json',
    text: JSON.stringify({ color: { $type: 'color', brand: { 500: { $value: '#3366FF' } }, link: { $value: '{color.brand.500}' } } }),
  };
  const tw = { path: 'tailwind.config.js', text: "module.exports = { theme: { extend: { colors: { mint: '#3EB489' }, spacing: { '18': '4.5rem' } } } };" };
  const p = proposeFromRepo(scanRepo([json, tw]), set, { mode: 'attach' });
  const next = applyChanges(set, p.changes);
  assert.equal(next.tokens['color/link'].$values.light, '{color/brand/500}');
  assert.equal(next.tokens['color/brand/500'].$values.default, set.tokens['color/brand/500'].$values.default, 'existant gardé au rattachement');
  assert.equal(next.tokens['color/mint'].$values.default, '#3EB489');
  assert.equal(next.tokens['space/18'].$values.default, 72);

  const many = { path: 'big.css', text: ':root {\n' + Array.from({ length: 520 }, (_, i) => `  --c-${i}: #${(i * 997).toString(16).padStart(6, '0').slice(-6)};`).join('\n') + '\n}' };
  const big = proposeFromRepo(scanRepo([many]), set, { mode: 'create' });
  const after = applyChanges(set, big.changes);
  assert.ok(Object.keys(after.tokens).length <= 500);
  assert.ok(big.report.rejected.some((r) => /limite de 500/.test(r.reason)));
});

test('config : migration non destructive des configs GitHub d’avant G3', () => {
  const old = configSchema.parse({ name: 'x', github: { repo: 'a/b', dir: 'src/styles' } });
  assert.equal(old.github!.source, 'tokens');
  assert.equal(old.github!.subdir, null);
  assert.equal(old.github!.base, 'main');
  assert.throws(() => configSchema.parse({ name: 'x', github: { repo: 'a/b', dir: '.', subdir: '../x' } }));
  const _typed: TokenSet = template();
  assert.ok(_typed);
});

test('repo-propose (recette 2026-11-09) : fichier de tokens prioritaire, écarts resserrés, dégradés liés', () => {
  const files = [
    // Planche de référence lue avant le site : ses couleurs ne doivent pas gagner.
    { path: 'references/planche.html', text: '<style>:root { --canvas: #FF0000; --surface: #00FF00; }</style>' },
    {
      path: 'site/src/styles/tokens.css',
      text: [
        ':root {',
        '  --canvas: #0B0B0C;',
        '  --surface: #16161A;',
        '  --brand: #7C3AED;',
        '  --text: #F5F5F4;',
        '  --muted: #A1A1AA;',
        '  --brand-gradient: linear-gradient(135deg, #7C3AED, #0b0b0c 60%, rgba(0,0,0,.5));',
        '  --label: "white";',
        '  --space-md: 16px;',
        '  --space-3xl: 64px;',
        '  --space-x: 8px;',
        '  --space-y: 12px;',
        '  --space-z: 24px;',
        '  --radius-2xl: 32px;',
        '}',
      ].join('\n'),
    },
    { path: 'site/src/styles/layout.css', text: '.hero { padding: 80px; margin: 17px; border-radius: 40px; gap: 65px; row-gap: 6px; }' },
  ];
  const p = proposeFromRepo(scanRepo(files), template(), { mode: 'create' });
  const set = applyChanges(template(), p.changes);
  assert.equal(resolve(set, 'canvas'), '#0B0B0C');
  assert.equal(resolve(set, 'surface'), '#16161A');
  assert.equal(p.tokens.find((t) => t.code === '--canvas')?.file, 'site/src/styles/tokens.css');
  assert.ok(p.report.conflicts.some((c) => c.name === '--canvas'));
  // 80px n'est plus rattaché à 64px ; 65px l'est (1 px), 17px aussi (16px, 1 px).
  const entry = (v: string) => p.entries.find((e) => e.value === v);
  assert.equal(entry('80px')?.token, null);
  assert.equal(entry('40px')?.token, null);
  assert.equal(entry('65px')?.token, 'space/3xl');
  assert.equal(entry('17px')?.token, 'space/md');
  assert.equal(entry('6px')?.token, null); // 6px → 8px : plus de 25 % de la valeur en dur
  // Dégradé : pas de token, mais ses couleurs en dur sont rattachées (alpha exclue).
  assert.match(p.report.rejected.find((r) => r.name === '--brand-gradient')!.reason, /dégradé/);
  const g = p.report.composite?.find((c) => c.name === '--brand-gradient');
  assert.deepEqual({ kind: g?.kind, colors: g?.colors, bound: g?.bound }, { kind: 'gradient', colors: 3, bound: 2 });
  assert.equal(p.entries.find((e) => e.value === '#7C3AED' && e.property === '--brand-gradient')?.token, 'brand');
  assert.equal(p.entries.some((e) => e.property === '--label'), false); // couleur dans une chaîne : jamais lue
});

// Recette du 2026-11-17 : dépôt de moins de 10 variables (regroupement des
// valeurs en dur sur le gabarit) dont une porte un nom du gabarit. Deux
// changements sur le même token et le même mode faisaient refuser tout le
// brouillon par le client. La valeur déclarée dans le code l'emporte.
test('repo-propose : variable au nom du gabarit dans un dépôt peu structuré → un seul changement, valeur du code', () => {
  const cases: [string, string, string, string | number][] = [
    ['--space-md: 20px', '.a { padding: 18px; margin: 18px; gap: 18px; }\n.b { padding: 18px 6px; }', 'space/md@default', 20],
    ['--text-primary: #111827', 'body { color: #222222; background: #ffffff; }\n.b { color: #fff; }', 'text/primary@light', '#111827'],
    ['--font-family-sans: "Inter", sans-serif', 'body { font-family: Georgia, serif; }', 'font/family/sans@default', 'Inter'],
    ['--radius-md: 10px', '.a { border-radius: 6px; } .b { border-radius: 6px; } .c { border-radius: 14px; }', 'radius/md@default', 10],
  ];
  for (const [decl, rest, id, expected] of cases) {
    const css = `:root {\n  --brand-main: #2563eb;\n  ${decl};\n}\n${rest}\n`;
    const set = template();
    const p = proposeFromRepo(scanRepo([{ path: 'src/a.css', text: css }]), set, { mode: 'create' });
    assert.equal(p.report.strategy, 'inventory', decl);
    const ids = p.changes.map((c) => ('op' in c ? `${c.op}:${'key' in c ? c.key : c.name}` : `${c.key}@${c.mode}`));
    assert.deepEqual(ids.filter((x, i) => ids.indexOf(x) !== i), [], `${decl} : aucun doublon clé@mode`);
    const next = applyChanges(set, p.changes);
    const [key, mode] = id.split('@');
    assert.equal(next.tokens[key].$values[mode], expected, `${decl} : valeur déclarée dans le code gardée`);
  }
});

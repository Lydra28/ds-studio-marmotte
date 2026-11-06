import assert from 'node:assert/strict';
import test from 'node:test';
import { parseColor, parseLength, scanFile, scanRepo, summarizeScan, type Occurrence } from '../app/shared/repo-scan.js';

// Détecteurs du dépôt (plan GitHub, G2) sur fixtures fictives, aucun réseau.
// Chaque occurrence doit pointer exactement sa valeur dans le texte (G5).
const at = (text: string, o: Occurrence) => text.slice(o.offset, o.offset + o.length);
const pick = (list: Occurrence[], detector: string) => list.filter((o) => o.detector === detector);
function positionsExact(file: string, text: string, list: Occurrence[]) {
  const lines = text.split('\n');
  for (const o of list) {
    assert.equal(o.file, file);
    const offset = lines.slice(0, o.line - 1).reduce((n, l) => n + l.length + 1, 0) + o.col - 1;
    assert.equal(offset, o.offset, `ligne/colonne de ${o.value}`);
    assert.ok(o.length > 0 && o.offset + o.length <= text.length);
  }
}

test('repo-scan : valeurs normalisées (hex, rgb, hsl, oklch, longueurs)', () => {
  assert.equal(parseColor('#fff'), '#FFFFFF');
  assert.equal(parseColor('#3366ffcc'), '#3366FFCC');
  assert.equal(parseColor('#3366FFFF'), '#3366FF');
  assert.equal(parseColor('rgb(51, 102, 255)'), '#3366FF');
  assert.equal(parseColor('rgb(51 102 255 / 50%)'), '#3366FF80');
  assert.equal(parseColor('hsl(0, 100%, 50%)'), '#FF0000');
  assert.equal(parseColor('white'), '#FFFFFF');
  assert.match(parseColor('oklch(62.8% 0.2577 29.23)')!, /^#F[A-F0-9]0{1}[0-9A-F]{3}$|^#F[0-9A-F]{5}$/);
  assert.equal(parseColor('rgb(var(--x))'), null);
  assert.equal(parseColor('transparent'), null);
  assert.equal(parseLength('1.5rem'), '24px');
  assert.equal(parseLength('12PX'), '12px');
  assert.equal(parseLength('1.25em'), '1.25em');
  assert.equal(parseLength('10%'), null);
});

test('repo-scan : CSS propre, variables, alias, @theme v4, valeurs en dur avec position exacte', () => {
  const file = 'src/styles/global.css';
  const text = [
    '@import "tailwindcss";',
    '/* --commentaire: #000; */',
    '@theme {',
    '  --color-brand-500: oklch(0.6 0.2 260);',
    '  --radius-card: 12px;',
    '}',
    ':root {',
    '  --text-primary: #1a1a1a;',
    '  --text-link: var(--color-brand-500);',
    '  --font-body: "Inter", system-ui, sans-serif;',
    '}',
    '.card { padding: 1rem 24px; color: #FFF; background: rgba(0,0,0,.5); border-radius: var(--radius-card); }',
    '.hero{margin:0 auto;font-family:Georgia, serif;white-space:nowrap}',
    '@media (min-width: 768px) { .card { gap: 8px } }',
    '.logo { background: url(#abc) }',
  ].join('\n');
  const list = scanFile(file, text);
  positionsExact(file, text, list);
  const theme = pick(list, 'theme-v4');
  assert.deepEqual(theme.map((o) => [o.name, o.kind]), [['--color-brand-500', 'color'], ['--radius-card', 'length']]);
  const vars = pick(list, 'css-var');
  assert.deepEqual(vars.map((o) => [o.name, o.kind, o.normalized]), [
    ['--text-primary', 'color', '#1A1A1A'],
    ['--text-link', 'alias', 'var(--color-brand-500)'],
    ['--font-body', 'font', 'inter'],
  ]);
  const hard = pick(list, 'hardcoded');
  assert.deepEqual(hard.map((o) => [o.name, o.kind, at(text, o), o.normalized]), [
    ['padding', 'length', '1rem', '16px'],
    ['padding', 'length', '24px', '24px'],
    ['color', 'color', '#FFF', '#FFFFFF'],
    ['background', 'color', 'rgba(0,0,0,.5)', '#00000080'],
    ['font-family', 'font', 'Georgia, serif', 'georgia'],
    ['gap', 'length', '8px', '8px'],
  ]);
  assert.deepEqual(pick(list, 'var-use').map((o) => o.normalized), ['var(--radius-card)']);
  assert.equal(list.find((o) => o.value.includes('#000')), undefined, 'commentaire ignoré');
});

test('repo-scan : SCSS, Vue, Svelte, Astro, attributs style', () => {
  const scss = '$brand: #ff6600 !default;\n// $old: #123456;\n.btn { color: $brand; padding: 4px 8px; &:hover { color: darken($brand, 10%); } }';
  const s = scanFile('a/_vars.scss', scss);
  positionsExact('a/_vars.scss', scss, s);
  assert.deepEqual(pick(s, 'scss-var').map((o) => [o.name, o.value, o.normalized]), [['$brand', '#ff6600', '#FF6600']]);
  assert.deepEqual(pick(s, 'hardcoded').map((o) => o.normalized), ['4px', '8px']);

  const vue = '<template><div style="color: #222; padding: 2px">x</div></template>\n<style lang="scss" scoped>\n$gap: 12px;\n.a { margin: 6px; }\n</style>';
  const v = scanFile('src/A.vue', vue);
  positionsExact('src/A.vue', vue, v);
  assert.deepEqual(v.map((o) => [o.detector, o.via, at(vue, o)]), [
    ['hardcoded', 'style-attr', '#222'],
    ['hardcoded', 'style-attr', '2px'],
    ['scss-var', 'css', '12px'],
    ['hardcoded', 'css', '6px'],
  ]);

  const svelte = '<button class="btn">ok</button>\n<style>\n.btn { background: hsl(200 80% 40%); }\n</style>';
  assert.deepEqual(scanFile('src/B.svelte', svelte).map((o) => o.kind), ['color']);
  const astro = '---\nconst x = 1;\n---\n<h1 style="font-size: 32px">t</h1>';
  assert.deepEqual(scanFile('src/pages/index.astro', astro).map((o) => o.normalized), ['32px']);
});

test('repo-scan : JSX (objets style, sx), styled-components et css``', () => {
  const file = 'src/Card.tsx';
  const text = [
    "import styled, { css } from 'styled-components';",
    'const Box = styled.div<{ active: boolean }>`',
    '  color: #0a0a0a;',
    '  padding: ${(p) => (p.active ? 8 : 4)}px 16px;',
    '  // border: 1px solid #ff0000;',
    '`;',
    'const mixin = css`border-radius: 6px;`;',
    'const Title = styled(Base).attrs({ role: "heading" })`font-family: "Poppins";`;',
    'export function Card() {',
    "  return <div style={{ backgroundColor: '#fafafa', marginTop: 12, zIndex: 3, borderRadius: '4px' }} sx={{ p: 2, color: 'rgb(1, 2, 3)' }} />;",
    '}',
    "const notStyle = { color: '#999999' };",
  ].join('\n');
  const list = scanFile(file, text);
  positionsExact(file, text, list);
  assert.deepEqual(list.map((o) => [o.via, o.name, at(text, o), o.normalized]), [
    ['css-in-js', 'color', '#0a0a0a', '#0A0A0A'],
    ['css-in-js', 'padding', '16px', '16px'],
    ['css-in-js', 'border-radius', '6px', '6px'],
    ['css-in-js', 'font-family', '"Poppins"', 'poppins'],
    ['jsx-style', 'background-color', '#fafafa', '#FAFAFA'],
    ['jsx-style', 'margin-top', '12', '12px'],
    ['jsx-style', 'border-radius', '4px', '4px'],
    ['jsx-style', 'color', 'rgb(1, 2, 3)', '#010203'],
  ]);
});

test('repo-scan : config Tailwind v3 lue statiquement, jamais exécutée', () => {
  const file = 'tailwind.config.js';
  const text = [
    "const colors = require('tailwindcss/colors');",
    'module.exports = {',
    "  content: ['./src/**/*.{js,tsx}'],",
    '  theme: {',
    "    spacing: { '18': '4.5rem', px: '1px' },",
    '    extend: {',
    '      colors: {',
    "        brand: { DEFAULT: '#2255EE', 500: '#3366ff', dark: 'rgb(10 20 30)' },",
    '        gray: colors.slate,',
    "        'accent-soft': '#ffccaa', // commentaire",
    '      },',
    "      fontFamily: { display: ['Satoshi', 'sans-serif'] },",
    "      fontSize: { hero: ['3rem', { lineHeight: '1.1' }] },",
    "      borderRadius: { card: `14px` },",
    '      boxShadow: { soft: "0 1px 2px rgba(0,0,0,.1)" },',
    '      screens: { xl2: "1440px" },',
    '    },',
    '  },',
    '  plugins: [require("@tailwindcss/forms")],',
    '};',
  ].join('\n');
  const list = scanFile(file, text);
  positionsExact(file, text, list);
  assert.deepEqual(list.map((o) => [o.name, o.kind, at(text, o), o.normalized]), [
    ['spacing.18', 'length', '4.5rem', '72px'],
    ['spacing.px', 'length', '1px', '1px'],
    ['colors.brand', 'color', '#2255EE', '#2255EE'],
    ['colors.brand.500', 'color', '#3366ff', '#3366FF'],
    ['colors.brand.dark', 'color', 'rgb(10 20 30)', '#0A141E'],
    ['colors.accent-soft', 'color', '#ffccaa', '#FFCCAA'],
    ['fontFamily.display', 'font', 'Satoshi', 'satoshi'],
    ['fontSize.hero', 'length', '3rem', '48px'],
    ['borderRadius.card', 'length', '14px', '14px'],
    ['boxShadow.soft', 'shadow', '0 1px 2px rgba(0,0,0,.1)', '0 1px 2px rgba(0,0,0,.1)'],
  ]);
});

test('repo-scan : JSON DTCG (type hérité, alias, valeur objet) et Style Dictionary', () => {
  const file = 'tokens/base.tokens.json';
  const text = JSON.stringify(
    {
      color: {
        $type: 'color',
        brand: { 500: { $value: '#3366FF' }, 600: { $value: { colorSpace: 'srgb', components: [0, 0.2, 0.8], hex: '#0033CC' } } },
        link: { $value: '{color.brand.500}' },
      },
      space: { md: { $type: 'dimension', $value: { value: 16, unit: 'px' } } },
      font: { body: { $type: 'fontFamily', $value: ['Inter', 'sans-serif'] } },
    },
    null,
    2,
  );
  const list = scanFile(file, text);
  positionsExact(file, text, list);
  assert.deepEqual(list.map((o) => [o.name, o.kind, o.normalized]), [
    ['color.brand.500', 'color', '#3366FF'],
    ['color.brand.600', 'color', '#0033CC'],
    ['color.link', 'alias', '{color.brand.500}'],
    ['space.md', 'length', '16px'],
    ['font.body', 'font', 'inter'],
  ]);
  const legacy = '{ "color": { "primary": { "value": "#123456", "type": "color" } } }';
  assert.deepEqual(scanFile('design/tokens.json', legacy).map((o) => [o.name, o.normalized]), [['color.primary', '#123456']]);
  assert.deepEqual(scanFile('styles/theme-data.json', '{ "rows": [1, 2] }'), []);
});

test('repo-scan : thème JS (styled-components / MUI), couleurs et polices seulement', () => {
  const text = "export const theme = {\n  colors: { primary: '#0055ff', text: 'rgb(20, 20, 20)' },\n  space: [0, 4, 8],\n  fonts: { body: 'Inter, sans-serif' },\n  breakpoints: ['40em'],\n  label: 'Bonjour',\n};";
  const list = scanFile('src/theme.ts', text);
  positionsExact('src/theme.ts', text, list);
  assert.deepEqual(list.map((o) => [o.detector, o.name, o.normalized]), [
    ['js-theme', 'colors.primary', '#0055FF'],
    ['js-theme', 'colors.text', '#141414'],
    ['js-theme', 'fonts.body', 'inter'],
  ]);
});

test('repo-scan : dépôt en désordre avec Tailwind, classes par défaut, du thème et arbitraires', () => {
  const files = [
    { path: 'package.json', text: '{ "devDependencies": { "tailwindcss": "^3.4.0" } }' },
    { path: 'tailwind.config.ts', text: "export default { theme: { extend: { colors: { brand: { 500: '#3366ff' }, 'brand-dark': '#112244' } } } };" },
    { path: 'src/index.css', text: '@tailwind base;\n.x { color: #ABCDEF }' },
    {
      path: 'src/App.tsx',
      text: [
        'export const App = () => (',
        '  <main className="flex p-4 md:px-6 bg-blue-500 hover:bg-brand-500 text-brand-dark rounded-lg text-sm shadow">',
        "    <p className={'mt-2 text-[#ff0000] p-[13px] bg-[var(--surface)] -mx-1.5 !text-white'}>x</p>",
        "    <button className={cn('rounded', active && 'bg-slate-900/50', `w-10`)}>ok</button>",
        '  </main>',
        ');',
      ].join('\n'),
    },
    { path: 'node_modules/x/y.css', text: '.z{color:red}' },
    { path: 'README.md', text: '#ffffff' },
  ];
  const scan = scanRepo(files);
  assert.equal(scan.tailwind, 'v3');
  assert.equal(scan.files, 3, 'package.json, node_modules et README non comptés');
  const app = files[3].text;
  const classes = scan.occurrences.filter((o) => o.file === 'src/App.tsx');
  positionsExact('src/App.tsx', app, classes);
  assert.deepEqual(classes.map((o) => [o.detector, at(app, o), o.normalized]), [
    ['tailwind-class', 'p-4', '16px'],
    ['tailwind-class', 'px-6', '24px'],
    ['tailwind-class', 'bg-blue-500', 'color:blue-500'],
    ['tailwind-class', 'bg-brand-500', 'color:brand-500'],
    ['tailwind-class', 'text-brand-dark', 'color:brand-dark'],
    ['tailwind-class', 'rounded-lg', 'radius:lg'],
    ['tailwind-class', 'text-sm', 'text:sm'],
    ['tailwind-class', 'shadow', 'shadow:DEFAULT'],
    ['tailwind-class', 'mt-2', '8px'],
    ['hardcoded', 'text-[#ff0000]', '#FF0000'],
    ['hardcoded', 'p-[13px]', '13px'],
    ['var-use', 'bg-[var(--surface)]', 'var(--surface)'],
    ['tailwind-class', '-mx-1.5', '6px'],
    ['tailwind-class', 'text-white', 'color:white'],
    ['tailwind-class', 'rounded', 'radius:DEFAULT'],
    ['tailwind-class', 'bg-slate-900/50', 'color:slate-900'],
  ]);
  const summary = summarizeScan(scan);
  assert.equal(summary.byDetector['tailwind-v3']?.occurrences, 2);
  assert.equal(summary.hardcoded.color?.distinct, 2, '#ABCDEF et #FF0000');
  assert.doesNotMatch(JSON.stringify(summary), /App\.tsx|#ABCDEF|brand/i, 'la sonde ne rend que des chiffres');
});

test('repo-scan : sans Tailwind, les classes ne sont pas lues ; sous-dossier respecté', () => {
  const files = [
    { path: 'apps/web/src/A.jsx', text: '<div className="p-4 bg-blue-500" />' },
    { path: 'apps/web/src/a.css', text: '.a{color:#010101}' },
    { path: 'apps/docs/b.css', text: '.b{color:#020202}' },
  ];
  const scan = scanRepo(files, { subdir: 'apps/web' });
  assert.equal(scan.tailwind, null);
  assert.deepEqual(scan.occurrences.map((o) => o.normalized), ['#010101']);
});

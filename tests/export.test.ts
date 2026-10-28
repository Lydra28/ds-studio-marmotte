import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportTailwind, tailwindName } from '../app/shared/export.js';
import type { TokenSet } from '../app/shared/model.js';

const set = {
  modes: { primitives: ['default'], tokens: ['light'], typography: ['desktop', 'mobile'] },
  tokens: {
    'color/brand/500': { $type: 'color', $collection: 'primitives', $values: { default: '#3355ff' } },
    'bg/brand': { $type: 'color', $collection: 'tokens', $values: { light: '{color/brand/500}' } },
    'space/md': { $type: 'dimension', $collection: 'primitives', $values: { default: 16 } },
    'border-width/thin': { $type: 'dimension', $collection: 'primitives', $values: { default: 1 } },
    'font/size/body': { $type: 'dimension', $collection: 'typography', $values: { desktop: 18, mobile: 16 } },
  },
} as unknown as TokenSet;

test('export Tailwind : variables CSS, puis @theme inline vers les noms du code', () => {
  assert.equal(tailwindName('bg/brand', 'color'), '--color-bg-brand');
  assert.equal(tailwindName('color/brand/500', 'color'), '--color-brand-500');
  assert.equal(tailwindName('font/size/body', 'dimension'), '--text-body');
  assert.equal(tailwindName('border-width/thin', 'dimension'), null);

  const out = exportTailwind(set, { rename: { 'bg/': 'color/bg/' }, mobileQuery: '(max-width: 767px)' }, 'Test');
  assert.match(out, /^\/\* Test · à importer après @import "tailwindcss"; \*\//);
  // Nom identique dans le code (bg/ → color/bg/) : la valeur, jamais `--x: var(--x)`.
  assert.match(out, /--color-bg-brand: var\(--color-brand-500\);/);
  assert.doesNotMatch(out, /^\s*(--[\w-]+): var\(\1\);/m);
  assert.match(out, /--spacing-md: var\(--space-md\);/);
  assert.match(out, /@media \(max-width: 767px\)/); // mode mobile gardé
  assert.doesNotMatch(out, /border-width-thin\)/);
});

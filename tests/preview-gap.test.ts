import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PREVIEW_KEYS, previewUnfit } from '../app/client/DesignSystem.js';
import { cssName, tokenSetSchema, type TokenSet } from '../app/shared/model.js';

const template = (): TokenSet =>
  tokenSetSchema.parse(JSON.parse(readFileSync('templates/blank/design-system.tokens.json', 'utf8')));

test('écrans d’exemple : le gabarit les nourrit, un token retiré ne suffit pas à les déclarer muets', () => {
  const set = template();
  assert.equal(previewUnfit(set), false);
  delete set.tokens['bg/brand'];
  assert.equal(previewUnfit(set), false);
});

test('écrans d’exemple : projet aux noms de son dépôt, signalé', () => {
  const set = template();
  for (const key of Object.keys(set.tokens)) delete set.tokens[key];
  set.tokens['salmon-pink'] = { $type: 'color', $collection: 'tokens', $values: { light: '#FF8F9C' } };
  assert.equal(previewUnfit(set), true);
  // Dépôt qui déclare la moitié des noms (comme `dev-e2e/site-vitrine`) : les écrans le suivent en partie.
  const half = template();
  for (const key of Object.keys(half.tokens)) if (!['bg/canvas', 'bg/brand', 'text/primary', 'space/md', 'font/size/body'].includes(key)) delete half.tokens[key];
  assert.equal(previewUnfit(half), false);
  delete half.tokens['font/size/body'];
  assert.equal(previewUnfit(half), true);
});

test('écrans d’exemple : chaque nom surveillé est bien lu par leurs styles', () => {
  const css = readFileSync('app/client/styles.css', 'utf8');
  for (const key of PREVIEW_KEYS) assert.ok(css.includes(`var(${cssName(key)}`), key);
});

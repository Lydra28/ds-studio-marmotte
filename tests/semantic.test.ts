import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { applyChanges, resolve, tokenSetSchema } from '../app/shared/model.js';
import { proposeFromRepo } from '../app/shared/repo-propose.js';
import { rewriteRepo } from '../app/shared/repo-rewrite.js';
import { scanRepo } from '../app/shared/repo-scan.js';
import { familyOf, proposeSemanticLayer } from '../app/shared/semantic.js';

// Couche sémantique (recette du 2026-11-09, option b) sur un dépôt fictif « à plat ».
const template = () => tokenSetSchema.parse(JSON.parse(readFileSync('templates/blank/design-system.tokens.json', 'utf8')));
const css = [
  ':root {',
  '  --canvas: #0B0B0C;',
  '  --surface: #16161A;',
  '  --text: #F5F5F4;',
  '  --brand: #7C3AED;',
  '  --brand-strong: #7C3AED;',
  '  --link: var(--brand);',
  '  --blue-500: #3B82F6;',
  '  --accent: #3B82F6;',
  '  --space-sm: 8px;',
  '  --space-md: 16px;',
  '  --radius-md: 8px;',
  '}',
  '.card { background: #16161A; }',
].join('\n');

test('couche sémantique : palette créée ou réutilisée, rôles en tokens sémantiques, alias gardés', () => {
  const files = [{ path: 'src/tokens.css', text: css }];
  const read = proposeFromRepo(scanRepo(files), template(), { mode: 'create' });
  const flat = applyChanges(template(), read.changes);
  assert.equal(flat.tokens.canvas.$collection, 'primitives');

  const layer = proposeSemanticLayer(flat);
  const set = applyChanges(flat, layer.changes);
  // Rôles : même nom, collection sémantique, alias vers une primitive de même couleur.
  for (const key of ['canvas', 'surface', 'text', 'brand', 'brand/strong', 'accent']) {
    assert.equal(set.tokens[key].$collection, 'tokens', key);
    assert.equal(String(resolve(set, key)).toUpperCase(), String(resolve(flat, key)).toUpperCase(), key);
  }
  // Même couleur : une seule primitive ; palette du dépôt réutilisée.
  assert.equal(set.tokens.brand.$values.light, set.tokens['brand/strong'].$values.light);
  assert.equal(set.tokens.accent.$values.light, '{blue/500}');
  assert.equal(set.tokens['blue/500'].$collection, 'primitives');
  assert.equal(set.tokens.canvas.$values.light, '{color/neutral/950}');
  assert.equal(set.tokens.text.$values.light, '{color/neutral/50}');
  assert.match(set.tokens.brand.$values.light as string, /^\{color\/violet\/\d+\}$/);
  // Alias du dépôt vers un rôle : toujours valide après le déplacement.
  assert.equal(resolve(set, 'link'), '#7C3AED');
  assert.ok(layer.notes[0].includes('primitive(s) de palette créée(s)'));
  // Deuxième passage : rien à proposer.
  assert.equal(proposeSemanticLayer(set).changes.length, 0);

  // PR : les variables du dépôt renvoient à la palette, ajoutée dans le même fichier.
  const out = rewriteRepo({ tokens: read.tokens, entries: read.entries, set, rename: {}, files: new Map([['src/tokens.css', css]]) });
  const text = out.files.find((f) => f.path === 'src/tokens.css')!.text;
  assert.match(text, /--canvas: var\(--color-neutral-950\);/);
  assert.match(text, /--accent: var\(--blue-500\);/);
  assert.match(text, /--color-neutral-950: #0B0B0C;/);
  assert.match(text, /--link: var\(--brand\);/);
});

test('couche sémantique : familles par teinte, gris sous le seuil', () => {
  assert.equal(familyOf('#0B0B0C').family, 'neutral');
  assert.equal(familyOf('#3B82F6').family, 'blue');
  assert.equal(familyOf('#DC2626').family, 'red');
  assert.equal(familyOf('#16A34A').family, 'green');
});

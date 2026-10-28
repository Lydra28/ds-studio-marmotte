import assert from 'node:assert/strict';
import test from 'node:test';
import { brandColor } from '../app/client/Mascot.js';
import type { TokenSet } from '../app/shared/model.js';

const set = (tokens: TokenSet['tokens']): TokenSet => ({
  modes: { primitives: ['default'], tokens: ['light'], typography: ['desktop'] },
  tokens,
  components: {},
});
const color = (collection: 'primitives' | 'tokens', value: string) => ({
  $type: 'color' as const,
  $collection: collection,
  $values: { [collection === 'primitives' ? 'default' : 'light']: value },
});

test('mascotte : couleur de bg/brand, alias résolu, brouillon compris', () => {
  const s = set({
    'color/green/500': color('primitives', '#04D939'),
    'bg/brand': color('tokens', '{color/green/500}'),
    'bg/accent': color('tokens', '#FF00AA'),
  });
  assert.equal(brandColor(s), '#04D939');
});

test('mascotte : sans bg/brand, premier token brand puis primary puis accent ; sinon couleur par défaut', () => {
  assert.equal(brandColor(set({ 'text/primary': color('tokens', '#111111'), 'color/brand/500': color('primitives', '#2F6BFF') })), '#2F6BFF');
  assert.equal(brandColor(set({ 'bg/accent': color('tokens', '#FF00AA') })), '#FF00AA');
  assert.equal(brandColor(set({ 'bg/brand': color('tokens', '{color/absent}') })), '#7C5CFF'); // alias cassé
  assert.equal(brandColor(set({})), '#7C5CFF');
});

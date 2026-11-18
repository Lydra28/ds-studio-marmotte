import assert from 'node:assert/strict';
import test from 'node:test';
import { guardDrafts, hasDraft } from '../app/client/draft-guard.js';

// Alerte à la fermeture quand un brouillon existe (Romain, 2026-11-18).
const store = (entries: Record<string, string>) => {
  const keys = Object.keys(entries);
  return { length: keys.length, key: (i: number) => keys[i] ?? null, getItem: (k: string) => entries[k] ?? null };
};

test('brouillon : détecté dans les valeurs, la structure ou les fiches, tous projets', () => {
  assert.equal(hasDraft(store({})), false);
  assert.equal(hasDraft(store({ 'ds-drafts:marmotte': '[]', 'ds-structure:marmotte': '[]', 'ds-components:marmotte': '[]' })), false);
  assert.equal(hasDraft(store({ 'ds-onboarding': '1', 'ds-start:x': 'board' })), false, 'autres clés ignorées');
  assert.equal(hasDraft(store({ 'ds-drafts:a': '[]', 'ds-drafts:b': '[["bg/brand@light","#225588"]]' })), true);
  assert.equal(hasDraft(store({ 'ds-structure:a': '[["font/family/display",null]]' })), true);
  assert.equal(hasDraft(store({ 'ds-components:a': '[["Button",null]]' })), true);
});

test('brouillon : déchargement refusé seulement s’il existe', () => {
  let listener: ((e: Event) => void) | undefined;
  let entries: Record<string, string> = {};
  const target = {
    get sessionStorage() {
      return store(entries);
    },
    addEventListener: (_: string, l: (e: Event) => void) => void (listener = l),
    removeEventListener: () => void (listener = undefined),
  } as unknown as Window;
  const stop = guardDrafts(target);
  const fire = () => {
    const e = { defaultPrevented: false, returnValue: undefined as unknown, preventDefault() { this.defaultPrevented = true; } };
    listener!(e as unknown as Event);
    return e.defaultPrevented;
  };
  assert.equal(fire(), false);
  entries = { 'ds-drafts:marmotte': '[["space/sm@default",15]]' };
  assert.equal(fire(), true);
  // Lu par desktop/main.mjs avant d'arrêter le serveur.
  assert.equal((target as Window & { __dsHasDraft: () => boolean }).__dsHasDraft(), true);
  entries = {};
  assert.equal((target as Window & { __dsHasDraft: () => boolean }).__dsHasDraft(), false);
  stop();
  assert.equal(listener, undefined);
});

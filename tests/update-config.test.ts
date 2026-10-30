import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUpdateConfig } from '../desktop/update-config.mjs';

const build = { url: 'https://releases.example.test/ds-studio/stable/', channel: 'stable', macSigned: false };

test('mises à jour : flux, canal et refus sans signature Mac', () => {
  // Depuis les sources : jamais, même avec un flux.
  const dev = resolveUpdateConfig({ platform: 'win32', packaged: false, build });
  assert.equal(dev.enabled, false);
  assert.match(dev.reason!, /sources/);
  // Installée sans flux : désactivée, raison affichable.
  const none = resolveUpdateConfig({ platform: 'win32', packaged: true, build: null });
  assert.deepEqual(none, { enabled: false, reason: 'Aucun flux de mise à jour configuré dans cette version.', url: null, channel: 'stable' });
  // Windows et Linux : actives, barre finale retirée.
  for (const platform of ['win32', 'linux']) {
    const on = resolveUpdateConfig({ platform, packaged: true, build });
    assert.equal(on.enabled, true, platform);
    assert.equal(on.url, 'https://releases.example.test/ds-studio/stable');
    assert.equal(on.channel, 'stable');
  }
  // Mac : désactivées tant que l'app n'est pas signée, actives ensuite.
  const mac = resolveUpdateConfig({ platform: 'darwin', packaged: true, build });
  assert.equal(mac.enabled, false);
  assert.match(mac.reason!, /signature/);
  assert.equal(resolveUpdateConfig({ platform: 'darwin', packaged: true, build: { ...build, macSigned: true } }).enabled, true);
  // Flux http ou canal farfelu : refusés, canal ramené à stable.
  assert.equal(resolveUpdateConfig({ platform: 'linux', packaged: true, build: { url: 'http://x.test/' } }).enabled, false);
  assert.equal(resolveUpdateConfig({ platform: 'linux', packaged: true, build: { ...build, channel: 'Bêta 1' } }).channel, 'stable');
});

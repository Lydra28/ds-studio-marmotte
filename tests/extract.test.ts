import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readSite } from '../app/server/extract.js';
import { siteInventorySchema } from '../app/shared/extract.js';

// Lot 5 : lecture d'un site, côté serveur, avec la lecture injectée (aucun
// Chromium, aucun réseau). L'inventaire de fixture vient du vrai script
// (scripts/extract-fixture.ts).
const inventory = siteInventorySchema.parse(JSON.parse(await readFile('tests/fixtures/site/inventory.json', 'utf8')));
const status = (e: unknown) => (e as { status?: number }).status;

test('lecture d’un site : adresse publique exigée, échecs et réponses trafiquées expliqués', async () => {
  let called = 0;
  const read = async () => (called++, inventory);
  for (const url of ['http://localhost:3000', 'http://192.168.1.10/', 'file:///etc/passwd', 'https://atelier.local/'])
    await assert.rejects(readSite(url, read), (e) => status(e) === 400);
  assert.equal(called, 0);

  const ok = await readSite('https://atelier-fixture.example', read);
  assert.equal(called, 1);
  assert.equal(ok.desktop.title, 'Atelier Fixture');

  await assert.rejects(
    readSite('https://atelier-fixture.example', async () => { throw new Error('Site trop lent.'); }),
    (e) => status(e) === 502 && /Site trop lent/.test((e as Error).message),
  );
  // Page qui remplace getComputedStyle et rend n'importe quoi : refusée.
  const forged = { ...inventory, desktop: { ...inventory.desktop, colors: [{ hex: 'red', text: -1 }] } };
  await assert.rejects(readSite('https://atelier-fixture.example', async () => forged), (e) => status(e) === 502);
  await assert.rejects(readSite('https://atelier-fixture.example', async () => ({ ...inventory, extra: 1 })), (e) => status(e) === 502);

  const empty = { ...inventory.desktop, elements: 0, colors: [inventory.desktop.colors[0]], texts: [] };
  await assert.rejects(
    readSite('https://atelier-fixture.example', async () => ({ desktop: empty, mobile: empty })),
    (e) => status(e) === 422,
  );
});

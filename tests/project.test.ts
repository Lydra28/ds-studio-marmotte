import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../app/server/project.js';
import { projectSchema } from '../app/shared/project.js';

test('brief privé : persistance, concurrence, validation et préservation', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-project-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ProjectStore(directory);
  const initial = await store.read();
  const project = {
    ...initial.project,
    name: 'Ateliers partagés',
    goal: 'Réserver sans compte IA',
  };
  const competing = await Promise.allSettled([
    store.save(initial.base, project),
    store.save(initial.base, { ...project, name: 'Autre' }),
  ]);
  assert.equal(competing.filter((x) => x.status === 'fulfilled').length, 1);
  const saved = await new ProjectStore(directory).read();
  assert.equal(saved.project.name, project.name);
  assert.notEqual(saved.base, initial.base);
  await assert.rejects(() =>
    store.save(saved.base, { ...project, figmaUrl: 'https://evil.invalid/' }),
  );
  assert.throws(() => projectSchema.parse({ ...project, extra: 'no' }));
  const credentialUrl = new URL('https://www.figma.com/');
  credentialUrl.username = 'fixture';
  credentialUrl.password = 'fixture';
  assert.throws(() =>
    projectSchema.parse({ ...project, figmaUrl: credentialUrl.href }),
  );
  await writeFile(path.join(directory, 'project.json'), '{broken');
  await assert.rejects(() => store.read(), /Original préservé/);
  await assert.rejects(
    () => store.save(saved.base, project),
    /Original préservé/,
  );
  assert.equal(
    await readFile(path.join(directory, 'project.json'), 'utf8'),
    '{broken',
  );
});

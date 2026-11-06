import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { readTarGz, repoPath } from '../app/server/tar.js';
import { readArchive } from '../app/server/repo-read.js';

// Lecteur tar maison (plan GitHub, G2) sur archives fabriquées ici, au format
// de GitHub (dossier racine `<owner>-<repo>-<sha>/`, en-têtes pax).
type Entry = { name: string; body?: string | Buffer; type?: string; linkname?: string; pax?: Record<string, string> };

function header(name: string, size: number, type: string, linkname = '') {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write(linkname, 157);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
function paxBody(fields: Record<string, string>) {
  return Buffer.from(
    Object.entries(fields)
      .map(([k, v]) => {
        const rest = ` ${k}=${v}\n`;
        let len = rest.length + 1;
        while (String(len).length + rest.length !== len) len = String(len).length + rest.length;
        return `${len}${rest}`;
      })
      .join(''),
  );
}
function tarGz(entries: Entry[]) {
  const parts: Buffer[] = [];
  for (const e of entries) {
    if (e.pax) {
      const body = paxBody(e.pax);
      parts.push(header('PaxHeader', body.length, 'x'), pad(body));
    }
    const body = Buffer.isBuffer(e.body) ? e.body : Buffer.from(e.body ?? '');
    parts.push(header(e.name, e.type === '0' || !e.type ? body.length : 0, e.type ?? '0', e.linkname), ...(e.type && e.type !== '0' ? [] : [pad(body)]));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const ROOT = 'dev-site-abc1234/';
const all = { maxBytes: 10_000_000, maxFiles: 100, maxFileBytes: 1000, accept: () => true };

test('tar : fichiers sous la racine GitHub, pax global ignoré, chemin long pax', () => {
  const long = ROOT + 'src/' + 'tres-long-dossier/'.repeat(8) + 'theme.css';
  const archive = tarGz([
    { name: 'pax_global_header', type: 'g', body: '' },
    { name: ROOT, type: '5' },
    { name: ROOT + 'src/styles.css', body: ':root { --brand: #3366FF; }' },
    { name: long.slice(0, 100), body: 'a { color: red }', pax: { path: long } },
  ]);
  const r = readTarGz(archive, all);
  assert.deepEqual(
    r.files.map((f) => f.path),
    ['src/styles.css', long.slice(ROOT.length)],
  );
  assert.equal(r.files[0].text, ':root { --brand: #3366FF; }');
  assert.equal(r.truncated, false);
});

test('tar : archive piégée (chemin .., absolu, lien, fichier géant) écartée sans rien écrire', () => {
  const archive = tarGz([
    { name: ROOT + '../../etc/passwd', body: 'x' },
    { name: '/abs/olu.css', body: 'x' },
    { name: ROOT + 'lien.css', type: '2', linkname: '/etc/passwd' },
    { name: ROOT + 'dur.css', type: '1', linkname: ROOT + 'ok.css' },
    { name: ROOT + 'geant.css', body: 'a'.repeat(5000) },
    { name: ROOT + 'ok.css', body: 'ok' },
  ]);
  const r = readTarGz(archive, all);
  assert.deepEqual(r.files.map((f) => f.path), ['ok.css']);
  assert.deepEqual(r.skipped, { filtered: 0, tooLarge: 1, links: 2, unsafe: 2 });
  assert.equal(repoPath('a/b/../c'), null);
  assert.equal(repoPath('C:/x/y'), null);
});

test('tar : bombe de décompression refusée, nombre de fichiers borné, archive tronquée', () => {
  const bomb = tarGz([{ name: ROOT + 'zero.css', body: Buffer.alloc(3_000_000) }]);
  assert.ok(bomb.length < 50_000, 'archive minuscule');
  assert.throws(() => readTarGz(bomb, { ...all, maxBytes: 1_000_000 }), /trop volumineux/);

  const many = tarGz(Array.from({ length: 10 }, (_, i) => ({ name: `${ROOT}f${i}.css`, body: 'x' })));
  const r = readTarGz(many, { ...all, maxFiles: 3 });
  assert.equal(r.files.length, 3);
  assert.equal(r.truncated, true);

  assert.throws(() => readTarGz(Buffer.from('pas une archive'), all), /illisible/);
  const cut = gzipSync(Buffer.concat([header(ROOT + 'a.css', 4000, '0'), Buffer.alloc(512)]));
  assert.throws(() => readTarGz(cut, all), /tronquée/);
});

test('tar : filtre du dépôt (node_modules, build, .env, minifiés, binaires) et sous-dossier', () => {
  const archive = tarGz(
    [
      'node_modules/lib/x.css',
      'dist/app.css',
      'apps/web/.next/x.css',
      '.env',
      '.env.local',
      'public/app.min.css',
      'public/logo.png',
      'apps/web/src/app.css',
      'apps/web/tailwind.config.ts',
      'apps/web/package.json',
      'apps/web/tokens/color.json',
      'apps/web/tsconfig.json',
      'apps/docs/site.css',
    ].map((p) => ({ name: ROOT + p, body: 'x' })),
  );
  assert.deepEqual(
    readArchive(archive, 'apps/web').files.map((f) => f.path),
    ['apps/web/src/app.css', 'apps/web/tailwind.config.ts', 'apps/web/package.json', 'apps/web/tokens/color.json'],
  );
  assert.equal(readArchive(archive, null).files.length, 5);
});

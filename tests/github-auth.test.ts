import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GithubAuth, PRO_ONLY } from '../app/server/github-auth.js';

// Connexion GitHub (plan GitHub, G1) : device flow d'une GitHub App contre un
// faux GitHub, aucun réseau. Jamais de secret envoyé, jamais de jeton rendu.
const ACCESS = 'ghu_jeton_acces_1234567890';
const REFRESH = 'ghr_jeton_renouv_1234567890';

function fakeGithub() {
  const calls: { url: string; body: string; auth: string | null }[] = [];
  const queue: Record<string, unknown>[] = [];
  let accessCount = 0;
  let refreshError: string | null = null;
  let userStatus = 200;
  let tarball: Buffer = Buffer.from('archive-de-test');
  let tarballLength = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fakeFetch: typeof fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = String(init.body ?? '');
    const auth = new Headers(init.headers).get('authorization');
    calls.push({ url, body, auth });
    const form = new URLSearchParams(body);
    if (url === 'https://gh.test/login/device/code')
      return json(200, { device_code: 'code-appareil-1234567890', user_code: 'WDJB-MJHT', verification_uri: 'https://gh.test/login/device', expires_in: 900, interval: 5 });
    if (url === 'https://gh.test/login/oauth/access_token') {
      if (form.get('grant_type') === 'refresh_token') {
        if (refreshError) return json(200, { error: refreshError });
        accessCount++;
        return json(200, { access_token: `${ACCESS}-${accessCount}`, expires_in: 28800, refresh_token: `${REFRESH}-${accessCount}`, refresh_token_expires_in: 15897600 });
      }
      const next = queue.shift();
      if (next) return json(200, next);
      accessCount++;
      return json(200, { access_token: `${ACCESS}-${accessCount}`, expires_in: 28800, refresh_token: `${REFRESH}-${accessCount}`, refresh_token_expires_in: 15897600 });
    }
    if (url === 'https://api.gh.test/user') return json(userStatus, userStatus === 200 ? { login: 'dev-test' } : { message: 'Bad credentials' });
    if (url.startsWith('https://api.gh.test/user/installations?'))
      return userStatus === 200 ? json(200, { installations: [{ id: 7 }, { id: 8 }] }) : json(401, { message: 'Bad credentials' });
    const repos = /\/user\/installations\/(\d+)\/repositories\?per_page=100&page=(\d+)$/.exec(url);
    if (repos) {
      const [, id, page] = repos;
      if (id === '7' && page === '1')
        return json(200, { repositories: Array.from({ length: 100 }, (_, i) => ({ full_name: `org/r${String(i).padStart(3, '0')}`, private: i === 0, default_branch: 'main' })) });
      if (id === '7' && page === '2') return json(200, { repositories: [{ full_name: 'org/r100', private: false, default_branch: 'develop' }] });
      return json(200, { repositories: [{ full_name: 'org/r000', private: true, default_branch: 'main' }, { full_name: 'moi/site', private: false, default_branch: '' }] });
    }
    const tar = /^https:\/\/api\.gh\.test\/repos\/([^/]+\/[^/]+)\/tarball\/(.+)$/.exec(url);
    if (tar) {
      if (userStatus !== 200) return json(401, { message: 'Bad credentials' });
      if (tar[1] !== 'dev-test/site' || tar[2] !== 'feature/theme') return json(404, { message: 'Not Found' });
      const headers: Record<string, string> = { 'content-type': 'application/x-gzip' };
      if (tarballLength) headers['content-length'] = String(tarballLength);
      return new Response(new Uint8Array(tarball), { status: 200, headers });
    }
    return json(404, { message: `inconnu ${url}` });
  }) as typeof fetch;
  return {
    fetch: fakeFetch,
    calls,
    queue,
    setRefreshError: (e: string | null) => (refreshError = e),
    setUserStatus: (s: number) => (userStatus = s),
    setTarball: (b: Buffer, announced = 0) => ((tarball = b), (tarballLength = announced)),
  };
}

async function setup(pro = true) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-github-'));
  const gh = fakeGithub();
  let clock = new Date('2026-11-06T12:00:00Z').getTime();
  const flags = { pro };
  const open = () =>
    GithubAuth.open({
      dir,
      isPro: () => flags.pro,
      clientId: 'Iv23-test',
      loginUrl: 'https://gh.test',
      apiUrl: 'https://api.gh.test',
      fetch: gh.fetch,
      now: () => new Date(clock),
      autoPoll: false,
    });
  const auth = await open();
  return {
    dir,
    gh,
    auth,
    flags,
    open,
    advance: (ms: number) => (clock += ms),
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

test('github : réservé à Pro, connexion refusée sans palier Pro', async () => {
  const s = await setup(false);
  try {
    assert.equal(s.auth.status().pro, false);
    await assert.rejects(s.auth.start(), (e: Error & { status?: number }) => e.message === PRO_ONLY && e.status === 402);
    assert.equal(s.gh.calls.length, 0, 'aucun appel à GitHub sans Pro');
  } finally {
    await s.close();
  }
});

test('github : device flow, attente, ralentissement, puis jetons gardés sur le poste et jamais rendus', async () => {
  const s = await setup();
  try {
    const started = await s.auth.start();
    assert.equal(started.status, 'pending');
    assert.equal(started.userCode, 'WDJB-MJHT');
    assert.equal(started.verificationUri, 'https://gh.test/login/device');
    assert.equal(new URLSearchParams(s.gh.calls[0].body).get('client_id'), 'Iv23-test');

    s.gh.queue.push({ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 });
    s.advance(5000);
    assert.equal((await s.auth.pollOnce()).status, 'pending');
    s.advance(5000);
    assert.equal((await s.auth.pollOnce()).status, 'pending', 'slow_down : on continue, plus lentement');
    s.advance(10_000);
    const done = await s.auth.pollOnce();
    assert.equal(done.status, 'connected');
    assert.equal(done.login, 'dev-test');
    assert.equal(done.userCode, null);

    for (const c of s.gh.calls) assert.doesNotMatch(c.body, /client_secret/, 'aucun secret envoyé');
    const poll = new URLSearchParams(s.gh.calls[1].body);
    assert.equal(poll.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
    assert.equal(poll.get('device_code'), 'code-appareil-1234567890');

    assert.doesNotMatch(JSON.stringify(done), /ghu_|ghr_/, 'état sans jeton');
    const file = path.join(s.dir, 'github.json');
    assert.match(await readFile(file, 'utf8'), /ghu_jeton_acces/);
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o077, 0, 'fichier privé');
    // Relu au redémarrage.
    assert.equal((await s.open()).status().status, 'connected');
  } finally {
    await s.close();
  }
});

test('github : refus sur github.com, code expiré, annulation', async () => {
  const s = await setup();
  try {
    await s.auth.start();
    s.gh.queue.push({ error: 'access_denied' });
    const denied = await s.auth.pollOnce();
    assert.equal(denied.status, 'none');
    assert.match(String(denied.message), /refusée/);

    await s.auth.start();
    s.advance(901_000);
    const expired = await s.auth.pollOnce();
    assert.equal(expired.status, 'none');
    assert.match(String(expired.message), /expiré/);

    await s.auth.start();
    assert.equal(s.auth.cancel().status, 'none');
  } finally {
    await s.close();
  }
});

test('github : jeton renouvelé sans secret à son expiration ; renouvellement refusé → déconnecté', async () => {
  const s = await setup();
  try {
    await s.auth.start();
    await s.auth.pollOnce();
    assert.equal(await s.auth.token(), `${ACCESS}-1`);
    s.advance(8 * 3600_000);
    assert.equal(await s.auth.token(), `${ACCESS}-2`, 'renouvelé');
    const refresh = s.gh.calls.find((c) => new URLSearchParams(c.body).get('grant_type') === 'refresh_token')!;
    assert.equal(new URLSearchParams(refresh.body).get('refresh_token'), `${REFRESH}-1`);
    assert.equal(new URLSearchParams(refresh.body).get('client_secret'), null);

    s.advance(8 * 3600_000);
    s.gh.setRefreshError('bad_refresh_token');
    await assert.rejects(s.auth.token(), (e: Error & { status?: number }) => e.status === 401);
    assert.equal(s.auth.status().status, 'none');
    assert.match(String(s.auth.status().message), /reconnecter GitHub/);
  } finally {
    await s.close();
  }
});

test('github : dépôts des installations, pages et doublons ; 401 → déconnecté ; plus Pro → refusé', async () => {
  const s = await setup();
  try {
    await s.auth.start();
    await s.auth.pollOnce();
    const repos = await s.auth.repos();
    assert.equal(repos.length, 102, '101 de l’installation 7 + 1 nouveau de la 8, doublon retiré');
    assert.deepEqual(repos.find((r) => r.fullName === 'moi/site'), { fullName: 'moi/site', private: false, defaultBranch: 'main' });
    assert.equal(repos.find((r) => r.fullName === 'org/r100')?.defaultBranch, 'develop');
    assert.ok(s.gh.calls.every((c) => !c.url.startsWith('https://api.gh.test') || c.auth === `Bearer ${ACCESS}-1`));

    s.flags.pro = false;
    await assert.rejects(s.auth.repos(), (e: Error & { status?: number }) => e.status === 402);
    s.flags.pro = true;

    s.gh.setUserStatus(401);
    await assert.rejects(s.auth.repos(), (e: Error & { status?: number }) => e.status === 401);
    assert.equal(s.auth.status().status, 'none');
  } finally {
    await s.close();
  }
});

test('github : déconnexion efface les jetons du poste', async () => {
  const s = await setup();
  try {
    await s.auth.start();
    await s.auth.pollOnce();
    assert.equal((await s.auth.logout()).status, 'none');
    await assert.rejects(readFile(path.join(s.dir, 'github.json'), 'utf8'), /ENOENT/);
    assert.equal((await s.open()).status().status, 'none');
  } finally {
    await s.close();
  }
});

test('github : archive d’une branche bornée en taille, noms vérifiés, 404 et 401 clairs', async () => {
  const s = await setup();
  try {
    await s.auth.start();
    await s.auth.pollOnce();
    const got = await s.auth.archive('dev-test/site', 'feature/theme', 1000);
    assert.equal(got.toString(), 'archive-de-test');
    const call = s.gh.calls.at(-1)!;
    assert.equal(call.url, 'https://api.gh.test/repos/dev-test/site/tarball/feature/theme');
    assert.equal(call.auth, `Bearer ${ACCESS}-1`);

    s.gh.setTarball(Buffer.alloc(2000));
    await assert.rejects(s.auth.archive('dev-test/site', 'feature/theme', 1000), (e: Error & { status?: number }) => e.status === 413);
    s.gh.setTarball(Buffer.alloc(10), 5_000_000);
    await assert.rejects(s.auth.archive('dev-test/site', 'feature/theme', 1000), /trop volumineux/, 'taille annoncée refusée avant lecture');

    for (const [repo, ref] of [['../x', 'main'], ['dev-test/site/../y', 'main'], ['dev-test/site', '../main'], ['dev-test/site', 'a b'], ['a', 'main']])
      await assert.rejects(s.auth.archive(repo, ref, 1000), (e: Error & { status?: number }) => e.status === 400, `${repo}@${ref}`);
    await assert.rejects(s.auth.archive('dev-test/autre', 'main', 1000), (e: Error & { status?: number }) => e.status === 404);

    s.gh.setUserStatus(401);
    await assert.rejects(s.auth.archive('dev-test/site', 'feature/theme', 1000), (e: Error & { status?: number }) => e.status === 401);
    assert.equal(s.auth.status().status, 'none');
  } finally {
    await s.close();
  }
});

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AccountClient } from '../app/server/account.js';

// Compte DS-Studio connecté dont le serveur est simulé : `reply` répond au
// relais (et à tout autre appel), aucun réseau. Le fichier `account.json` est
// posé dans `dir`, le dossier jetable du test.
export const FAKE_TOKEN = 'jeton-de-session-de-test-0123456789abcdef';
export interface FakeCall {
  url: string;
  body: any;
  headers: Record<string, string>;
}
export async function fakeAccount(reply: (call: FakeCall) => Response | Promise<Response>, dir: string) {
  await writeFile(
    path.join(dir, 'account.json'),
    JSON.stringify({ token: FAKE_TOKEN, email: 'test@example.com', license: null, licenseAt: null }),
  );
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const call: FakeCall = {
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    return reply(call);
  }) as typeof fetch;
  return AccountClient.open({ dir, apiUrl: 'http://server.test', publicKey: null, fetch: fetchImpl });
}

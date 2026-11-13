import assert from 'node:assert/strict';
import test from 'node:test';
import { watchDone } from '../app/client/Settings.js';
import type { AccountStatus } from '../app/client/api.js';

// Seuls les champs lus par watchDone comptent ici.
const acc = (p: Partial<AccountStatus> & { credit?: number }) =>
  ({ status: 'connected', plan: 'free', gifted: false, ...p, usage: p.credit === undefined ? undefined : { creditCents: p.credit } }) as unknown as AccountStatus;

test('attente après Stripe : fin seulement sur le changement que l’achat produit', () => {
  const free = acc({ credit: 300 });
  // Recharge : une consommation pendant l'attente n'est pas un paiement.
  assert.equal(watchDone('credits', free, acc({ credit: 280 })), false);
  assert.equal(watchDone('credits', free, acc({ credit: 300 })), false);
  assert.equal(watchDone('credits', free, acc({ credit: 800 })), true);
  // Solde inconnu au départ : tout changement compte.
  assert.equal(watchDone('credits', acc({}), acc({ credit: 500 })), true);
  // Pro : palier serveur passé à pro, quel que soit le solde.
  assert.equal(watchDone('pro', free, acc({ credit: 250 })), false);
  assert.equal(watchDone('pro', free, acc({ plan: 'pro', credit: 300 })), true);
  // Portail : l'abonnement bouge, pas le solde.
  const sub = { status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: '2026-12-13T00:00:00Z' };
  const pro = acc({ plan: 'pro', credit: 300, subscription: sub } as Partial<AccountStatus>);
  assert.equal(watchDone('portal', pro, acc({ plan: 'pro', credit: 100, subscription: sub } as Partial<AccountStatus>)), false);
  assert.equal(watchDone('portal', pro, acc({ plan: 'pro', credit: 300, subscription: { ...sub, cancelAtPeriodEnd: true } } as Partial<AccountStatus>)), true);
  // Session perdue : fin silencieuse.
  assert.equal(watchDone('credits', free, { status: 'disconnected' } as unknown as AccountStatus), true);
});

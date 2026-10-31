// Licence : jeton signé Ed25519 (crypto de Node, pas de JWT externe) que
// l'app renouvelle et vérifie hors ligne avec la clé publique embarquée
// (lot 3). Charge utile en clair : compte, palier effectif, offert, plafond,
// dates. Validité 7 jours, puis 7 jours de grâce hors ligne ; au-delà,
// l'app retombe en gratuit sans rien casser (cadrage O2). Module sans
// dépendance au reste du serveur : l'app pourra reprendre `verifyLicense`.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

export const LICENSE_DAYS = 7;
export const GRACE_DAYS = 7;
const DAY = 86400_000;

export interface LicenseKeys {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyPem: string;
}

export interface LicensePayload {
  v: 1;
  /** Identifiant du compte. */
  sub: string;
  email: string;
  /** Palier effectif : `pro` aussi pour un compte offert. */
  tier: 'free' | 'pro';
  gifted: boolean;
  /** Plafond journalier de coût LLM, en centimes. */
  cap: number;
  /** Émission, expiration, fin de grâce (ms depuis l'époque). */
  iat: number;
  exp: number;
  grace: number;
}

export type LicenseCheck =
  | { status: 'valid' | 'grace'; payload: LicensePayload }
  | { status: 'expired'; payload: LicensePayload }
  | { status: 'invalid'; reason: string };

// PEM dans une variable d'environnement : les sauts de ligne arrivent
// parfois échappés (`\n` littéral) ; on les rétablit.
const pem = (value: string) => value.replace(/\\n/g, '\n').trim() + '\n';

export function loadKeys(privatePem: string): LicenseKeys {
  const privateKey = createPrivateKey(pem(privatePem));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('LICENSE_PRIVATE_KEY : clé Ed25519 attendue');
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string };
}

export function generateKeys(): LicenseKeys & { privateKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}

const b64 = (buf: Buffer) => buf.toString('base64url');

export function issueLicense(
  keys: LicenseKeys,
  account: { id: string; email: string; plan: 'free' | 'pro'; gifted: boolean; dailyCapCents: number },
  now: Date,
): { token: string; payload: LicensePayload } {
  const iat = now.getTime();
  const payload: LicensePayload = {
    v: 1,
    sub: account.id,
    email: account.email,
    tier: account.gifted ? 'pro' : account.plan,
    gifted: account.gifted,
    cap: account.dailyCapCents,
    iat,
    exp: iat + LICENSE_DAYS * DAY,
    grace: iat + (LICENSE_DAYS + GRACE_DAYS) * DAY,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign(null, body, keys.privateKey);
  return { token: `${b64(body)}.${b64(signature)}`, payload };
}

export function verifyLicense(publicKey: KeyObject | string, token: string, now: Date): LicenseCheck {
  const key = typeof publicKey === 'string' ? createPublicKey(pem(publicKey)) : publicKey;
  const parts = token.split('.');
  if (parts.length !== 2) return { status: 'invalid', reason: 'format' };
  const body = Buffer.from(parts[0], 'base64url');
  const signature = Buffer.from(parts[1], 'base64url');
  let ok = false;
  try {
    ok = verify(null, body, key, signature);
  } catch {
    ok = false;
  }
  if (!ok) return { status: 'invalid', reason: 'signature' };
  let payload: LicensePayload;
  try {
    payload = JSON.parse(body.toString('utf8')) as LicensePayload;
  } catch {
    return { status: 'invalid', reason: 'charge utile' };
  }
  if (payload.v !== 1 || typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return { status: 'invalid', reason: 'version' };
  const t = now.getTime();
  if (t < payload.exp) return { status: 'valid', payload };
  if (t < payload.grace) return { status: 'grace', payload };
  return { status: 'expired', payload };
}

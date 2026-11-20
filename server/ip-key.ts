// Clé de comptage des plafonds par adresse IP (audit du 2026-11-18, n° 2).
// Une connexion IPv6 reçoit tout un préfixe /64 (2^64 adresses) : compter
// l'adresse exacte laisserait un script en changer à chaque requête. Une
// adresse IPv6 compte donc par /64 (4 premiers groupes, forme normalisée),
// une IPv4 (ou IPv4 mappée `::ffff:a.b.c.d`) par adresse. En-tête absent
// ou illisible : une seule clé commune, jamais une clé par valeur reçue
// (sinon des valeurs fantaisistes contourneraient le plafond).
// Seulement pour compter : la comparaison « même réseau » de la liaison
// d'app (`ip_hash` d'oauth.ts) garde l'adresse exacte.
// shortcut: un abonné à qui l'opérateur donne un /56 ou un /48 a 256 à 65 536
// préfixes /64 ; le plafond global et la règle Cloudflare restent le filet
// (revoir quand un abus par préfixe large est vu dans les journaux).
import { isIP } from 'node:net';
import type { Context } from 'hono';

export const UNKNOWN_IP = 'inconnue';

/** Clé de comptage d'une adresse : IPv4 telle quelle, IPv6 par /64 (`2001:db8:0:1::/64`). */
export function ipKey(raw: string | undefined | null): string {
  const ip = raw?.trim() ?? '';
  const kind = isIP(ip);
  if (kind === 4) return ip;
  if (kind !== 6) return UNKNOWN_IP;
  const groups = expandIpv6(ip);
  if (!groups) return UNKNOWN_IP;
  // IPv4 mappée (::ffff:a.b.c.d ou ::ffff:aabb:ccdd) : la même machine que l'IPv4.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff)
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

/** Clé de comptage de la requête, d'après `CF-Connecting-IP` (jamais `X-Forwarded-For`, écrit par le client). */
export const requestIpKey = (c: Context) => ipKey(c.req.header('cf-connecting-ip'));

// Adresse IPv6 déjà validée par `isIP` → ses 8 groupes de 16 bits.
function expandIpv6(ip: string): number[] | null {
  const bare = ip.split('%')[0]; // identifiant de zone (fe80::1%eth0)
  const parts = (s: string) => {
    if (!s) return [];
    const out: number[] = [];
    for (const p of s.split(':')) {
      if (p.includes('.')) {
        const [a, b, c, d] = p.split('.').map(Number);
        out.push((a << 8) | b, (c << 8) | d);
      } else out.push(parseInt(p, 16));
    }
    return out;
  };
  const [head, tail] = bare.split('::');
  const left = parts(head);
  const right = tail === undefined ? [] : parts(tail);
  const fill = 8 - left.length - right.length;
  if (fill < 0 || (tail === undefined && fill !== 0)) return null;
  const groups = [...left, ...Array<number>(fill).fill(0), ...right];
  return groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

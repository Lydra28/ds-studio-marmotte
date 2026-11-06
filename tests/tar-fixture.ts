import { gzipSync } from 'node:zlib';

// Archives tar.gz fabriquées pour les tests, au format de GitHub (dossier
// racine `<owner>-<repo>-<sha>/`, en-têtes pax) : tests du lecteur tar et
// faux GitHub des e2e (tests/e2e/fake-api.ts).
export type Entry = { name: string; body?: string | Buffer; type?: string; linkname?: string; pax?: Record<string, string> };

export function header(name: string, size: number, type: string, linkname = '') {
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
export function tarGz(entries: Entry[]) {
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

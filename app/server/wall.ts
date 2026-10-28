import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { applyChanges, changeSchema, isAlias, type Change, type TokenSet } from '../shared/model.js';
import type { Project } from '../shared/project.js';
import { atomicWrite, readPrivate } from './files.js';
import { StudioError } from './store.js';
import { callOpenRouter, DEFAULT_MODEL, type AssistantOptions } from './assistant.js';
import { captureInDesktop, inDesktop } from './desktop.js';

// Mur des DA d'un projet : inspirations (images fournies, captures de liens)
// et dernière génération de 1 à 3 directions. Tout reste dans les données
// privées du projet (`.ds-studio/wall/`), jamais dans le dépôt.
export interface Inspiration {
  id: string;
  kind: 'image' | 'capture';
  name: string;
  url?: string;
  type: 'image/jpeg' | 'image/png' | 'image/webp';
  date: string;
}
export interface Direction {
  name: string;
  intention: string;
  rationale: string;
  fonts: { heading: string; body: string };
  changes: Change[];
  dropped: number;
  droppedReasons?: string[];
}
export interface WallResult {
  date: string;
  model: string;
  note: string;
  directions: Direction[];
  usage?: { prompt: number; completion: number };
}
interface WallIndex {
  inspirations: Inspiration[];
  result?: WallResult;
}
const imageTypes = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;
export const imageSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    dataUrl: z.string().max(5_000_000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/),
  })
  .strict();
export const linkSchema = z.object({ url: z.string().trim().url().max(500) }).strict();
export const directionsRequestSchema = z
  .object({ note: z.string().trim().max(2000).default(''), count: z.number().int().min(1).max(3).default(3) })
  .strict();
const MAX_INSPIRATIONS = 8;

// Liens publics seulement : pas de réseau local ni d'adresse privée.
// shortcut: pas de résolution DNS (un nom public pointant vers une IP privée
// passerait), acceptable pour un atelier local mono-utilisateur ; à revoir
// avant toute mise en ligne.
export function publicUrl(raw: string) {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const privateIp =
    (isIP(host) === 4 && /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) ||
    (isIP(host) === 6 && (host === '::1' || /^(fc|fd|fe80)/.test(host)));
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    privateIp
  )
    throw new StudioError('Lien refusé : adresse web publique en http(s) attendue.');
  return url.toString();
}

export class Wall {
  private queue: Promise<unknown> = Promise.resolve();
  private dir: string;
  constructor(
    directory: string,
    private options: AssistantOptions,
    private capture: (url: string) => Promise<Buffer> = inDesktop ? captureInDesktop : captureWithPlaywright,
  ) {
    this.dir = path.join(directory, 'wall');
  }
  private serial<T>(work: () => Promise<T>) {
    const run = this.queue.then(work);
    this.queue = run.catch(() => {});
    return run;
  }
  async read(): Promise<WallIndex> {
    try {
      return JSON.parse(await readPrivate(path.join(this.dir, 'index.json'), 2_000_000));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { inspirations: [] };
      throw new StudioError('Mur illisible : original préservé.', 500);
    }
  }
  private async write(index: WallIndex) {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(this.dir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  }
  private async add(entry: Omit<Inspiration, 'id' | 'date'>, data: Buffer) {
    const index = await this.read();
    if (index.inspirations.length >= MAX_INSPIRATIONS)
      throw new StudioError(`${MAX_INSPIRATIONS} inspirations au plus : retires-en une d'abord.`);
    const item: Inspiration = { ...entry, id: randomUUID(), date: new Date().toISOString() };
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(this.dir, `${item.id}.${imageTypes[item.type]}`), data);
    await this.write({ ...index, inspirations: [...index.inspirations, item] });
    return item;
  }
  addImage(input: z.infer<typeof imageSchema>, url?: string) {
    return this.serial(async () => {
      const [, type, b64] = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(input.dataUrl)!;
      const data = Buffer.from(b64, 'base64');
      if (data.length > 3_500_000) throw new StudioError('Image trop lourde (3,5 Mo au plus).', 413);
      return this.add({ kind: 'image', name: input.name, type: type as Inspiration['type'], ...(url ? { url } : {}) }, data);
    });
  }
  addLink(raw: string) {
    return this.serial(async () => {
      const url = publicUrl(raw);
      let data: Buffer;
      try {
        data = await this.capture(url);
      } catch {
        throw new StudioError('Capture impossible (site injoignable ou Chromium absent). Fournis la capture toi-même.', 502);
      }
      return this.add({ kind: 'capture', name: new URL(url).hostname, url, type: 'image/jpeg' }, data);
    });
  }
  remove(id: string) {
    return this.serial(async () => {
      const index = await this.read();
      const item = index.inspirations.find((i) => i.id === id);
      if (!item) throw new StudioError('Inspiration introuvable.', 404);
      await fs.rm(path.join(this.dir, `${item.id}.${imageTypes[item.type]}`), { force: true });
      await this.write({ ...index, inspirations: index.inspirations.filter((i) => i.id !== id) });
    });
  }
  async file(id: string) {
    const index = await this.read();
    const item = index.inspirations.find((i) => i.id === id);
    if (!item) throw new StudioError('Inspiration introuvable.', 404);
    return { type: item.type, data: await fs.readFile(path.join(this.dir, `${item.id}.${imageTypes[item.type]}`)) };
  }
  directions(request: z.infer<typeof directionsRequestSchema>, context: { project: Project; name: string; set: TokenSet }) {
    return this.serial(async () => {
      if (!this.options.apiKey)
        throw new StudioError('Assistant désactivé : ajoute OPENROUTER_API_KEY dans .env, puis relance l’atelier.', 503);
      const index = await this.read();
      const images = await Promise.all(
        index.inspirations.map(async (i) => {
          const { type, data } = await this.file(i.id);
          return { label: `${i.name}${i.url ? ' (' + i.url + ')' : ''}`, url: `data:${type};base64,${data.toString('base64')}` };
        }),
      );
      const model = this.options.model ?? DEFAULT_MODEL;
      const data = await callOpenRouter(this.options, {
        model,
        response_format: { type: 'json_object' },
        max_tokens: 32000,
        messages: [
          { role: 'system', content: directionsPrompt(context, request.count) },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  (request.note ? `Précisions de Romain : ${request.note}\n\n` : '') +
                  (images.length
                    ? `Inspirations (dans l'ordre) : ${images.map((i, n) => `${n + 1}. ${i.label}`).join(' ; ')}`
                    : 'Aucune image : pars de la doctrine et des idées.'),
              },
              ...images.map((i) => ({ type: 'image_url', image_url: { url: i.url } })),
            ],
          },
        ],
      });
      const raw = data.choices?.[0]?.message?.content ?? '';
      // Dernière réponse brute gardée en privé pour comprendre un rejet.
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await atomicWrite(path.join(this.dir, 'last-response.txt'), raw);
      const directions = parseDirections(raw, context.set).slice(0, request.count);
      if (!directions.length) throw new StudioError('L’assistant n’a rendu aucune DA exploitable. Réessaie.', 502);
      const result: WallResult = {
        date: new Date().toISOString(),
        model,
        note: request.note,
        directions,
        usage: data.usage && { prompt: data.usage.prompt_tokens ?? 0, completion: data.usage.completion_tokens ?? 0 },
      };
      await this.write({ ...index, result });
      return result;
    });
  }
}

function directionsPrompt(context: { project: Project; name: string; set: TokenSet }, count: number) {
  const tokens = Object.entries(context.set.tokens)
    .map(([k, t]) => `${k} [${t.$type}, ${t.$collection}] ${Object.entries(t.$values).map(([m, v]) => `${m}=${v}`).join(' ')}`)
    .join('\n');
  return [
    `Tu es directeur artistique et expert en design systems. Projet : « ${context.name} ».`,
    `Propose ${count} direction(s) artistique(s) nettement différente(s), tirées des inspirations, de la doctrine et des idées.`,
    context.project.doctrine && `Doctrine :\n${context.project.doctrine}`,
    context.project.ideas && `Premières idées :\n${context.project.ideas}`,
    'Chaque DA s’exprime en modifiant le jeu de tokens ci-dessous (mêmes clés, mêmes modes) :',
    '- couleurs : toutes les primitives de couleur (rampe neutre 0 à 900 et rampes de marque, danger…) en hexadécimal #RRGGBB ; tu peux aussi réorienter les alias sémantiques ("{chemin}") ;',
    '- typographie : uniquement des familles Google Fonts. Corps : valeur de font/family/sans, ex. "Inter, system-ui, sans-serif". Titres avec une autre famille : ajoute la primitive font/family/display {"op":"add","key":"font/family/display","token":{"$type":"fontFamily","$collection":"primitives","$values":{"default":"Fraunces, serif"}}} et le token {"op":"add","key":"font/family/heading","token":{"$type":"fontFamily","$collection":"typography","$values":{"desktop":"{font/family/display}","mobile":"{font/family/display}"}}} ;',
    '- formes : rayons (radius/*), éventuellement tailles de texte et graisses.',
    'N’inclus que les valeurs que tu changes (60 changements au plus par DA) : ce qui ne bouge pas reste tel quel.',
    'Contraintes : espacements multiples de 4 ; contraste au moins 4,5:1 pour text/primary sur bg/canvas et bg/surface, et pour text/on-brand sur bg/brand ; texte courant d’au moins 16 px.',
    'Réponds uniquement en JSON : {"directions":[{"name":"2 à 4 mots","intention":"une phrase","rationale":"2 phrases qui citent les inspirations par numéro","fonts":{"heading":"Famille","body":"Famille"},"changes":[{"key":"color/brand/600","mode":"default","value":"#1E6B52"}, …]}]}',
    `Jeu actuel (clé [type, collection] valeurs) :\n${tokens}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// Sortie du modèle = donnée non fiable : schéma par changement, ajout d'un
// token existant ramené à des changements de valeur, essai à blanc cumulatif.
export function parseDirections(raw: string, set: TokenSet): Direction[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return [];
  }
  const list = z
    .object({
      directions: z.array(
        z.object({
          name: z.string().max(80),
          intention: z.string().max(400).default(''),
          rationale: z.string().max(1200).default(''),
          fonts: z.object({ heading: z.string().max(80), body: z.string().max(80) }).partial().default({}),
          changes: z.array(z.unknown()).max(120).default([]),
        }),
      ),
    })
    .safeParse(parsed);
  if (!list.success) return [];
  return list.data.directions.map((d) => {
    const kept: Change[] = [];
    let current = set;
    let dropped = 0;
    const reasons: string[] = [];
    for (const rawChange of d.changes) {
      const c = changeSchema.safeParse(rawChange);
      if (!c.success) {
        dropped++;
        reasons.push(`format illisible : ${JSON.stringify(rawChange).slice(0, 80)}`);
        continue;
      }
      const expanded = normalize(c.data, current);
      try {
        current = applyChanges(current, expanded);
        kept.push(...expanded);
      } catch (e) {
        dropped++;
        reasons.push((e as Error).message.slice(0, 120));
      }
    }
    return {
      name: d.name,
      intention: d.intention,
      rationale: d.rationale,
      fonts: { heading: d.fonts.heading ?? '', body: d.fonts.body ?? '' },
      changes: kept,
      dropped,
      droppedReasons: reasons.slice(0, 8),
    };
  }).filter((d) => d.changes.length > 0);
}

// Écarts de forme fréquents du modèle, corrigés sans deviner le fond :
// ajout d'un token existant → valeurs ; nombre écrit en texte ("48", "48px")
// → nombre ; police de titre écrite comme une valeur → ajout des deux tokens
// documentés dans le prompt.
export function normalize(change: Change, set: TokenSet): Change[] {
  if ('op' in change) {
    if (change.op === 'add' && set.tokens[change.key])
      return Object.entries(change.token.$values).map(([mode, value]) => ({ key: change.key, mode, value }));
    return [change];
  }
  const token = set.tokens[change.key];
  if (token) {
    const numeric = ['dimension', 'number', 'fontWeight'].includes(token.$type);
    if (numeric && typeof change.value === 'string' && /^-?\d+(\.\d+)?\s*(px|%)?$/.test(change.value.trim()))
      return [{ ...change, value: parseFloat(change.value) }];
    return [change];
  }
  const family = String(change.value);
  const heading = (modes: string[]): Change => ({
    op: 'add',
    key: 'font/family/heading',
    token: {
      $type: 'fontFamily',
      $collection: 'typography',
      $values: Object.fromEntries(modes.map((m) => [m, '{font/family/display}'])),
    },
  });
  if (change.key === 'font/family/display')
    return [
      { op: 'add', key: 'font/family/display', token: { $type: 'fontFamily', $collection: 'primitives', $values: { default: family } } },
      ...(set.tokens['font/family/heading'] ? [] : [heading(set.modes.typography)]),
    ];
  // Nouveau cran d'une échelle existante (ex. font/weight/semibold) : type et
  // collection repris des voisins de même nature (valeurs brutes ou alias)
  // s'ils sont tous identiques.
  const parent = change.key.split('/').slice(0, -1).join('/');
  const alias = isAlias(change.value);
  const siblings = Object.entries(set.tokens).filter(
    ([k, t]) =>
      k.split('/').slice(0, -1).join('/') === parent && Object.values(t.$values).every((v) => isAlias(v) === alias),
  );
  const kinds = new Set(siblings.map(([, t]) => `${t.$type}|${t.$collection}`));
  if (parent && siblings.length && kinds.size === 1 && !change.key.startsWith('font/family/')) {
    const [, sample] = siblings[0];
    const value =
      sample.$type !== 'color' && typeof change.value === 'string' && /^-?\d+(\.\d+)?\s*(px|%)?$/.test(change.value.trim())
        ? parseFloat(change.value)
        : change.value;
    return [
      {
        op: 'add',
        key: change.key,
        token: {
          $type: sample.$type,
          $collection: sample.$collection,
          $values: Object.fromEntries(set.modes[sample.$collection].map((m) => [m, value])),
        },
      },
    ];
  }
  if (change.key === 'font/family/heading' && !family.startsWith('{'))
    return [
      { op: 'add', key: 'font/family/display', token: { $type: 'fontFamily', $collection: 'primitives', $values: { default: family } } },
      heading(set.modes.typography),
    ].filter((c) => !set.tokens[(c as { key: string }).key]) as Change[];
  return [change];
}

async function captureWithPlaywright(url: string): Promise<Buffer> {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
    await page.waitForTimeout(1200);
    return await page.screenshot({ type: 'jpeg', quality: 62 });
  } finally {
    await browser.close();
  }
}

import path from 'node:path';
import { z } from 'zod';
import { applyChanges, changeSchema, type Change, type TokenSet } from '../shared/model.js';
import { runRules } from '../shared/rules.js';
import type { Project } from '../shared/project.js';
import { atomicWrite, readPrivate } from './files.js';
import { StudioError } from './store.js';

// Assistant du projet : il explique et propose, il n'écrit jamais. Une
// proposition devient un brouillon côté navigateur, puis diff et validation
// humaine comme toute autre modification. La clé reste sur le serveur.
export const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
  date: string;
  proposal?: { reason: string; changes: Change[] };
  usage?: { prompt: number; completion: number };
}
const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(20_000),
  date: z.string(),
  proposal: z.object({ reason: z.string(), changes: z.array(changeSchema) }).optional(),
  usage: z.object({ prompt: z.number(), completion: z.number() }).optional(),
});
export const chatSchema = z.object({ message: z.string().trim().min(1).max(4000) }).strict();

export interface AssistantOptions {
  apiKey?: string;
  model?: string;
  fetch?: typeof fetch;
}
export const assistantFromEnv = (): AssistantOptions => ({
  apiKey: process.env.OPENROUTER_API_KEY || undefined,
  model: process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
});

const proposeTool = {
  type: 'function',
  function: {
    name: 'propose_changes',
    description:
      "Propose des modifications du jeu de tokens ou des fiches. Elles arrivent en brouillon : Romain les relit dans le diff et décide. N'appelle cet outil que si on te demande de changer quelque chose.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['reason', 'changes'],
      properties: {
        reason: { type: 'string', description: 'Pourquoi, en une ou deux phrases, en français.' },
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: 30,
          description:
            'Changer une valeur : {"key","mode","value"} (alias écrit "{chemin}"). Ajouter : {"op":"add","key","token":{"$type","$collection","$values"}}. Retirer : {"op":"remove","key"}.',
          items: { type: 'object' },
        },
      },
    },
  },
};

function systemPrompt(project: Project, name: string, set: TokenSet) {
  const tokens = Object.entries(set.tokens)
    .map(([k, t]) => `${k} [${t.$type}, ${t.$collection}] ${Object.entries(t.$values).map(([m, v]) => `${m}=${v}`).join(' ')}`)
    .join('\n');
  const findings = runRules(set).map((f) => `- ${f.key}${f.mode ? '@' + f.mode : ''} : ${f.message}`);
  const components = Object.entries(set.components ?? {}).map(
    ([n, c]) => `- ${n} (${c.status}) ${Object.entries(c.props).map(([p, v]) => `${p}=${v?.join('|')}`).join(' ')}`,
  );
  return [
    `Tu es l'assistant de DS-Studio, l'atelier de design system du projet « ${name} ».`,
    "Rôle : aider Romain, designer UI/UX, à comprendre et construire un design system. Explique simplement, en français, sans jargon inutile, avec des exemples tirés de son jeu.",
    'Bonnes pratiques à défendre : deux couches (primitives brutes, tokens sémantiques nommés par l’usage en alias) ; espacements multiples de 4 ; contraste 4,5:1 pour le texte courant, 3:1 pour le grand texte et les composants ; texte d’au moins 16 px en mobile ; noms de composants en PascalCase anglais, propriétés Variant / State / Size, valeurs en minuscules.',
    'Tu ne modifies jamais rien toi-même. Pour proposer un changement, appelle l’outil propose_changes : il arrive en brouillon et Romain valide par le diff.',
    'Réponds court : 3 à 8 phrases ou une liste, sauf demande contraire. Ne cite que des tokens qui existent.',
    project.doctrine && `Doctrine du projet :\n${project.doctrine}`,
    project.ideas && `Premières idées :\n${project.ideas}`,
    `Modes : ${JSON.stringify(set.modes)}`,
    `Tokens (clé [type, collection] valeurs) :\n${tokens}`,
    findings.length ? `Écarts actuels des règles :\n${findings.join('\n')}` : 'Aucun écart des règles.',
    components.length ? `Fiches de composants :\n${components.join('\n')}` : 'Aucune fiche de composant.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export class Assistant {
  private queue: Promise<unknown> = Promise.resolve();
  private file: string;
  constructor(
    directory: string,
    private options: AssistantOptions,
  ) {
    this.file = path.join(directory, 'assistant.json');
  }
  get status() {
    return { enabled: !!this.options.apiKey, model: this.options.model ?? DEFAULT_MODEL };
  }
  async history(): Promise<AssistantMessage[]> {
    try {
      return z.array(messageSchema).parse(JSON.parse(await readPrivate(this.file, 2_000_000)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new StudioError('Conversation illisible : original préservé.', 500);
    }
  }
  private save(messages: AssistantMessage[]) {
    return atomicWrite(this.file, JSON.stringify(messages.slice(-60), null, 2) + '\n');
  }
  reset() {
    return this.serial(() => this.save([]));
  }
  private serial<T>(work: () => Promise<T>) {
    const run = this.queue.then(work);
    this.queue = run.catch(() => {});
    return run;
  }
  chat(message: string, context: { project: Project; name: string; set: TokenSet }) {
    return this.serial(async () => {
      if (!this.options.apiKey)
        throw new StudioError('Assistant désactivé : ajoute OPENROUTER_API_KEY dans .env, puis relance l’atelier.', 503);
      const history = await this.history();
      const question: AssistantMessage = { role: 'user', content: message, date: new Date().toISOString() };
      const reply = await this.complete(context, [...history, question]);
      await this.save([...history, question, reply]);
      return [question, reply];
    });
  }
  private async complete(
    context: { project: Project; name: string; set: TokenSet },
    messages: AssistantMessage[],
  ): Promise<AssistantMessage> {
    const body = {
      model: this.options.model ?? DEFAULT_MODEL,
      messages: [
        { role: 'system', content: systemPrompt(context.project, context.name, context.set) },
        ...messages.slice(-20).map((m) => ({ role: m.role, content: m.content || m.proposal?.reason || '' })),
      ],
      tools: [proposeTool],
      max_tokens: 4000,
    };
    const data = await callOpenRouter(this.options, body);
    const choice = data.choices?.[0]?.message;
    if (!choice) throw new StudioError('Réponse vide de l’assistant. Réessaie.', 502);
    const reply: AssistantMessage = {
      role: 'assistant',
      content: (choice.content ?? '').trim(),
      date: new Date().toISOString(),
      usage: data.usage && { prompt: data.usage.prompt_tokens ?? 0, completion: data.usage.completion_tokens ?? 0 },
    };
    const call = choice.tool_calls?.find((c) => c.function?.name === 'propose_changes');
    if (call) {
      const proposal = parseProposal(call.function.arguments, context.set);
      if ('error' in proposal)
        reply.content = `${reply.content}\n\n(Proposition écartée : ${proposal.error})`.trim();
      else reply.proposal = proposal;
    }
    if (!reply.content && !reply.proposal) reply.content = '(Pas de réponse.)';
    return reply;
  }
}

// La proposition du modèle est une donnée non fiable : schéma, puis essai à
// blanc sur le jeu courant. Rien n'est écrit.
export function parseProposal(raw: string, set: TokenSet) {
  try {
    const parsed = z
      .object({ reason: z.string().max(1000), changes: z.array(changeSchema).min(1).max(30) })
      .parse(JSON.parse(raw));
    applyChanges(set, parsed.changes);
    return parsed;
  } catch (e) {
    return { error: e instanceof z.ZodError ? 'format invalide' : (e as Error).message.slice(0, 200) };
  }
}

interface Completion {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}
export async function callOpenRouter(options: AssistantOptions, body: unknown): Promise<Completion> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'DS-Studio',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new StudioError('OpenRouter injoignable (réseau ou délai dépassé). Réessaie.', 502);
  }
  const data = (await response.json().catch(() => ({}))) as Completion;
  if (!response.ok)
    // Message du fournisseur sans jamais renvoyer la clé ni la requête.
    throw new StudioError(
      `OpenRouter a refusé la requête (${response.status})${data.error?.message ? ' : ' + data.error.message.slice(0, 200) : ''}.`,
      502,
    );
  return data;
}

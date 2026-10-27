import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Change } from '../shared/model.js';
import { askAssistant, getAssistant, resetAssistant, type AssistantMessage, type AssistantState } from './api.js';

const describe = (c: Change) =>
  'op' in c
    ? c.op === 'add'
      ? `+ ${c.key}`
      : c.op === 'remove'
        ? `− ${c.key}`
        : `${c.component ? '✎' : '−'} fiche ${c.name}`
    : `${c.key}@${c.mode} → ${c.value}`;

// Markdown minimal des réponses (gras, code, listes), rendu en éléments React :
// jamais de HTML venu du modèle.
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
      <code key={i}>{part.slice(1, -1)}</code>
    ) : (
      part
    ),
  );
}
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((block, i) => {
        const lines = block.split('\n');
        const item = /^\s*(?:[-*•]|\d+[.)])\s+/;
        if (lines.every((l) => item.test(l)))
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(item, ''))}</li>
              ))}
            </ul>
          );
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <span key={j}>
                {j > 0 && <br />}
                {inline(l.replace(/^#+\s+/, ''))}
              </span>
            ))}
          </p>
        );
      })}
    </>
  );
}

const starters = [
  'Explique-moi la différence entre primitives et tokens sémantiques',
  'Qu’est-ce que je devrais corriger en priorité ?',
  'Comment bien nommer les variantes de mes composants ?',
];

// Panneau de l'assistant : questions libres, propositions mises en brouillon
// sur demande. Rien n'est enregistré sans le diff.
export default function AssistantPanel({
  onDraft,
  onClose,
}: {
  onDraft: (changes: Change[]) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<AssistantState>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drafted, setDrafted] = useState<Set<string>>(new Set());
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    getAssistant().then(setState).catch((e) => setError(e.message));
  }, []);
  // scrollIntoView peut renvoyer une promesse : ne jamais la rendre à React comme nettoyage.
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' });
  }, [state?.messages.length, busy]);

  const send = async (message: string) => {
    if (!message.trim() || busy) return;
    setBusy(true);
    setError('');
    setText('');
    const pending: AssistantMessage = { role: 'user', content: message, date: new Date().toISOString() };
    setState((s) => s && { ...s, messages: [...s.messages, pending] });
    try {
      const { messages } = await askAssistant(message);
      setState((s) => s && { ...s, messages: [...s.messages.slice(0, -1), ...messages] });
    } catch (e) {
      setError((e as Error).message);
      setState((s) => s && { ...s, messages: s.messages.slice(0, -1) });
      setText(message);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(text);
  };
  return (
    <aside className="assistant" aria-label="Assistant">
      <header className="assistant-head">
        <div>
          <strong>Assistant</strong>
          {state && <small className="mono">{state.model}</small>}
        </div>
        <div className="assistant-tools">
          <button
            onClick={() => resetAssistant().then((r) => setState((s) => s && { ...s, messages: r.messages }))}
            disabled={busy || !state?.messages.length}
            title="Nouvelle conversation"
          >
            Effacer
          </button>
          <button onClick={onClose} aria-label="Fermer l’assistant">
            ×
          </button>
        </div>
      </header>
      <div className="assistant-log" aria-live="polite">
        {state && !state.enabled && (
          <p className="assistant-off">
            Assistant désactivé : ajoute <code>OPENROUTER_API_KEY</code> dans <code>studio/.env</code>, puis relance
            l’atelier. Tout le reste fonctionne sans lui.
          </p>
        )}
        {state?.enabled && !state.messages.length && (
          <div className="starters">
            <p>Pose une question sur ton design system, ou demande une correction : elle arrivera en brouillon.</p>
            {starters.map((s) => (
              <button key={s} onClick={() => void send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {state?.messages.map((m, i) => (
          <div key={m.date + i} className={`bubble ${m.role}`}>
            {m.content && (m.role === 'assistant' ? <Rich text={m.content} /> : <p>{m.content}</p>)}
            {m.proposal && (
              <div className="proposal">
                <p>{m.proposal.reason}</p>
                <ul className="mono">
                  {m.proposal.changes.map((c, j) => (
                    <li key={j}>{describe(c)}</li>
                  ))}
                </ul>
                <button
                  className="primary"
                  disabled={drafted.has(m.date)}
                  onClick={() => {
                    onDraft(m.proposal!.changes);
                    setDrafted((d) => new Set(d).add(m.date));
                  }}
                >
                  {drafted.has(m.date) ? 'Dans le brouillon' : 'Mettre en brouillon'}
                </button>
              </div>
            )}
            {m.usage && (
              <small className="usage mono">
                {m.usage.prompt} + {m.usage.completion} tokens
              </small>
            )}
          </div>
        ))}
        {busy && <div className="bubble assistant pending">L’assistant réfléchit…</div>}
        <div ref={end} />
      </div>
      {error && (
        <p className="add-error assistant-error" role="alert">
          {error}
        </p>
      )}
      <form className="assistant-input" onSubmit={submit}>
        <textarea
          aria-label="Message à l’assistant"
          rows={3}
          value={text}
          disabled={!state?.enabled}
          placeholder="Demander…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <button type="submit" className="primary" disabled={!state?.enabled || busy || !text.trim()}>
          Envoyer
        </button>
      </form>
    </aside>
  );
}

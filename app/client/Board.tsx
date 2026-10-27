import { useEffect, useState } from 'react';
import {
  isAlias,
  resolve,
  type Token,
  type TokenSet,
  type TokenValue,
} from '../shared/model.js';
import type { Finding } from '../shared/rules.js';
import { components } from '../shared/components.js';
import Nomenclature from './Nomenclature.js';

type Edit = (key: string, mode: string, value: TokenValue) => void;
interface BoardProps {
  set: TokenSet;
  drafts: Map<string, TokenValue>;
  findings: Finding[];
  onEdit: Edit;
}

// Éditeur d'une valeur : alias vers une primitive du même type, ou valeur brute.
function ValueEditor({
  set,
  tokenKey,
  token,
  mode,
  onEdit,
  label,
}: {
  set: TokenSet;
  tokenKey: string;
  token: Token;
  mode: string;
  onEdit: Edit;
  label: string;
}) {
  const value = token.$values[mode];
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const aliases =
    token.$collection === 'primitives'
      ? []
      : Object.entries(set.tokens)
          .filter(
            ([k, t]) =>
              k !== tokenKey &&
              t.$type === token.$type &&
              t.$collection === 'primitives',
          )
          .map(([k]) => k);
  const commitText = (raw: string) => {
    setText(raw);
    if (token.$type === 'color') {
      if (/^#[0-9a-fA-F]{6}$/.test(raw)) onEdit(tokenKey, mode, raw.toUpperCase());
    } else if (token.$type === 'fontFamily') {
      if (raw.trim()) onEdit(tokenKey, mode, raw);
    } else if (raw.trim() !== '' && Number.isFinite(Number(raw)))
      onEdit(tokenKey, mode, Number(raw));
  };
  if (isAlias(value) || aliases.length)
    return (
      <span className="editor">
        <select
          aria-label={label}
          value={isAlias(value) ? value : '__raw'}
          onChange={(e) =>
            e.target.value === '__raw'
              ? onEdit(tokenKey, mode, resolve(set, tokenKey, { [token.$collection]: mode }))
              : onEdit(tokenKey, mode, e.target.value)
          }
        >
          {aliases.map((k) => (
            <option key={k} value={`{${k}}`}>
              {k}
            </option>
          ))}
          <option value="__raw">valeur brute…</option>
        </select>
        {!isAlias(value) && (
          <input
            aria-label={`${label} (valeur brute)`}
            className="raw"
            value={text}
            onChange={(e) => commitText(e.target.value)}
          />
        )}
      </span>
    );
  return (
    <span className="editor">
      {token.$type === 'color' && (
        <input
          type="color"
          aria-label={`${label} (sélecteur)`}
          value={String(value).toLowerCase()}
          onChange={(e) => commitText(e.target.value)}
        />
      )}
      <input
        aria-label={label}
        className="raw"
        inputMode={token.$type === 'fontFamily' || token.$type === 'color' ? 'text' : 'numeric'}
        value={text}
        onChange={(e) => commitText(e.target.value)}
      />
      {token.$type === 'dimension' && <span className="unit">px</span>}
      {token.$type === 'number' && <span className="unit">%</span>}
    </span>
  );
}

function Flag({ findings }: { findings: Finding[] }) {
  if (!findings.length) return null;
  return (
    <span className="flag" title={findings.map((f) => f.message).join('\n')}>
      {findings.length > 1 ? `${findings.length} écarts` : 'écart'}
    </span>
  );
}

export default function Board({ set, drafts, findings, onEdit }: BoardProps) {
  const entries = Object.entries(set.tokens);
  const byKey = (key: string) => findings.filter((f) => f.key === key);
  const isDraft = (key: string) =>
    [...drafts.keys()].some((d) => d.startsWith(`${key}@`));
  const ramps = new Map<string, [string, Token][]>();
  for (const [key, token] of entries)
    if (token.$collection === 'primitives' && token.$type === 'color') {
      const ramp = key.split('/').slice(0, -1).join('/');
      ramps.set(ramp, [...(ramps.get(ramp) ?? []), [key, token]]);
    }
  const semantic = entries.filter(([, t]) => t.$collection === 'tokens');
  const groups = [...new Set(semantic.map(([k]) => k.split('/')[0]))];
  const typography = entries.filter(([, t]) => t.$collection === 'typography');
  const scales = entries.filter(
    ([k, t]) => t.$collection === 'primitives' && t.$type === 'dimension' && !k.startsWith('color/'),
  );
  const scaleGroups = [...new Set(scales.map(([k]) => k.split('/')[0]))];
  const rowClass = (key: string) =>
    `token-row ${isDraft(key) ? 'is-draft' : ''} ${byKey(key).length ? 'has-flag' : ''}`;

  return (
    <div className="board">
      <section aria-labelledby="h-colors">
        <h2 id="h-colors">Couleurs · Primitives</h2>
        <p className="hint">Valeurs brutes. Les tokens sémantiques y renvoient : change une primitive, tout suit.</p>
        {[...ramps].map(([ramp, list]) => (
          <div className="ramp" key={ramp}>
            <h3>{ramp}</h3>
            <div className="swatches">
              {list.map(([key, token]) => (
                <div className={`swatch ${isDraft(key) ? 'is-draft' : ''}`} key={key}>
                  <span className="name">{key.split('/').at(-1)}</span>
                  <ValueEditor set={set} tokenKey={key} token={token} mode="default" onEdit={onEdit} label={key} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section aria-labelledby="h-tokens">
        <h2 id="h-tokens">Tokens sémantiques</h2>
        <p className="hint">Nommés par l’usage, jamais par la teinte. Seule couche utilisée par les composants.</p>
        {groups.map((group) => (
          <div className="token-group" key={group}>
            <h3>{group}/</h3>
            {semantic
              .filter(([k]) => k.startsWith(`${group}/`))
              .map(([key, token]) => (
                <div className={rowClass(key)} key={key}>
                  {token.$type === 'color' ? (
                    <span className="chip" style={{ background: String(resolve(set, key)) }} />
                  ) : (
                    <span className="chip chip-dim">{String(resolve(set, key))}</span>
                  )}
                  <span className="meta">
                    <code>{key}</code>
                    {token.$description && <small>{token.$description}</small>}
                  </span>
                  {set.modes.tokens.map((mode) => (
                    <ValueEditor key={mode} set={set} tokenKey={key} token={token} mode={mode} onEdit={onEdit} label={`${key} ${mode}`} />
                  ))}
                  <Flag findings={byKey(key)} />
                </div>
              ))}
          </div>
        ))}
      </section>

      <section aria-labelledby="h-type">
        <h2 id="h-type">Typographie</h2>
        <p className="hint">Un mode par écran : {set.modes.typography.join(' / ')}. La preview passe en mobile sous 768 px.</p>
        <div className="type-head token-row">
          <span />
          <span className="meta">Token</span>
          {set.modes.typography.map((m) => (
            <span key={m} className="mode-label">{m}</span>
          ))}
        </div>
        {typography.map(([key, token]) => (
          <div className={rowClass(key)} key={key}>
            {key.startsWith('font/size/') ? (
              <span
                className="specimen"
                style={{ fontSize: Math.min(Number(resolve(set, key)), 40), fontFamily: String(resolve(set, 'font/family/base')) }}
              >
                Aa
              </span>
            ) : (
              <span className="chip chip-dim">{String(resolve(set, key)).slice(0, 10)}</span>
            )}
            <span className="meta">
              <code>{key}</code>
              {token.$description && <small>{token.$description}</small>}
            </span>
            {set.modes.typography.map((mode) => (
              <ValueEditor key={mode} set={set} tokenKey={key} token={token} mode={mode} onEdit={onEdit} label={`${key} ${mode}`} />
            ))}
            <Flag findings={byKey(key)} />
          </div>
        ))}
      </section>

      <section aria-labelledby="h-scales">
        <h2 id="h-scales">Espacements, rayons, contours</h2>
        {scaleGroups.map((group) => (
          <div className="token-group" key={group}>
            <h3>{group}/</h3>
            {scales
              .filter(([k]) => k.startsWith(`${group}/`))
              .map(([key, token]) => {
                const v = Number(token.$values.default);
                return (
                  <div className={rowClass(key)} key={key}>
                    {group === 'radius' ? (
                      <span className="radius-demo" style={{ borderRadius: Math.min(v, 28) }} />
                    ) : (
                      <span className="scale-bar" style={{ width: Math.min(v, 120), height: group === 'border-width' ? v : 12 }} />
                    )}
                    <span className="meta">
                      <code>{key}</code>
                    </span>
                    <ValueEditor set={set} tokenKey={key} token={token} mode="default" onEdit={onEdit} label={key} />
                    <Flag findings={byKey(key)} />
                  </div>
                );
              })}
          </div>
        ))}
      </section>

      <section aria-labelledby="h-components">
        <h2 id="h-components">Composants</h2>
        <p className="hint">Nom anglais, fiche en français. « Figma » : composant créé au transfert ; « Fiche » : documenté seulement.</p>
        <div className="fiches">
          {components.map((c) => (
            <article className="fiche" key={c.name}>
              <header>
                <h3>{c.name}</h3>
                <span className={`status ${c.status}`}>{c.status === 'figma' ? 'Figma' : 'Fiche'}</span>
                <Flag findings={byKey(c.name)} />
              </header>
              <p className="props">
                {Object.entries(c.props).map(([k, v]) => (
                  <span key={k}>
                    <code>{k}</code> {v.join(' · ')}
                  </span>
                ))}
              </p>
              <dl>
                <dt>À quoi il sert</dt>
                <dd>{c.role}</dd>
                <dt>Quand l’utiliser</dt>
                <dd>{c.use}</dd>
                <dt>Quand l’éviter</dt>
                <dd>{c.avoid}</dd>
                <dt>Accessibilité</dt>
                <dd>{c.a11y}</dd>
                <dt>Tokens</dt>
                <dd className="token-list">
                  {c.tokens.map((t) => (
                    <code key={t} className={set.tokens[t] ? '' : 'missing'} title={set.tokens[t] ? '' : 'token absent du jeu'}>
                      {t}
                    </code>
                  ))}
                </dd>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="h-names">
        <h2 id="h-names">Nomenclature</h2>
        <Nomenclature />
      </section>
    </div>
  );
}

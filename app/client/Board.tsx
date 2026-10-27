import { useEffect, useState } from 'react';
import {
  isAlias,
  isTokenKey,
  resolve,
  type Collection,
  type Token,
  type TokenSet,
  type TokenType,
  type TokenValue,
} from '../shared/model.js';
import { checkComponentName, type Finding } from '../shared/rules.js';
import { componentName, propNames, type ComponentDoc } from '../shared/components.js';
import Nomenclature from './Nomenclature.js';

type Edit = (key: string, mode: string, value: TokenValue) => void;
type Add = (key: string, token: Token) => void;
interface BoardProps {
  set: TokenSet;
  drafts: Map<string, TokenValue>;
  added: Map<string, Token | null>;
  findings: Finding[];
  onEdit: Edit;
  onAdd: Add;
  onRemove: (key: string) => void;
  componentDrafts: Map<string, ComponentDoc | null>;
  onComponent: (name: string, doc: ComponentDoc | null) => void;
}

// Valeur de départ d'un nouveau token, à régler ensuite sur la planche.
const starter: Record<TokenType, TokenValue> = {
  color: '#808080',
  dimension: 16,
  fontFamily: 'system-ui',
  fontWeight: 400,
  number: 100,
};
const typeLabel: Record<TokenType, string> = {
  color: 'couleur',
  dimension: 'dimension (px)',
  fontFamily: 'police',
  fontWeight: 'graisse',
  number: 'nombre (%)',
};

function AddToken({
  set,
  collection,
  types,
  prefix,
  onAdd,
}: {
  set: TokenSet;
  collection: Collection;
  types: TokenType[];
  prefix: string;
  onAdd: Add;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(prefix);
  const [type, setType] = useState(types[0]);
  if (!open)
    return (
      <button className="add" onClick={() => setOpen(true)}>
        + Ajouter un token
      </button>
    );
  const problem = set.tokens[key]
    ? 'existe déjà'
    : !isTokenKey(key)
      ? 'minuscules, chiffres et tirets, « / » entre les niveaux'
      : '';
  const submit = () => {
    if (problem) return;
    onAdd(key, {
      $type: type,
      $collection: collection,
      $values: Object.fromEntries(set.modes[collection].map((m) => [m, starter[type]])),
    });
    setKey(prefix);
    setOpen(false);
  };
  return (
    <form
      className="add-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        aria-label="Nom du nouveau token"
        autoFocus
        value={key}
        onChange={(e) => setKey(e.target.value.trim())}
        placeholder={`${prefix}nom`}
      />
      {types.length > 1 && (
        <select
          aria-label="Type du nouveau token"
          value={type}
          onChange={(e) => setType(e.target.value as TokenType)}
        >
          {types.map((t) => (
            <option key={t} value={t}>
              {typeLabel[t]}
            </option>
          ))}
        </select>
      )}
      <button type="submit" className="primary" disabled={!!problem}>
        Ajouter
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Annuler
      </button>
      {key !== prefix && problem && <small className="add-error">{problem}</small>}
    </form>
  );
}

const emptyDoc: ComponentDoc = {
  status: 'fiche',
  props: {},
  role: '',
  use: '',
  avoid: '',
  a11y: '',
  tokens: [],
};
const splitList = (raw: string) =>
  raw
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);

// Formulaire de fiche : création ou modification, le nom est vérifié en direct
// par la nomenclature. Rien n'est enregistré avant le diff et la validation.
function ComponentForm({
  set,
  name: initialName = '',
  doc = emptyDoc,
  onSave,
  onCancel,
}: {
  set: TokenSet;
  name?: string;
  doc?: ComponentDoc;
  onSave: (name: string, doc: ComponentDoc) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [status, setStatus] = useState(doc.status);
  const [props, setProps] = useState<Record<string, string>>(
    Object.fromEntries(propNames.map((p) => [p, (doc.props[p] ?? []).join(', ')])),
  );
  const [text, setText] = useState({ role: doc.role, use: doc.use, avoid: doc.avoid, a11y: doc.a11y });
  const [tokens, setTokens] = useState(doc.tokens.join(', '));
  const check = checkComponentName(name);
  const taken = name !== initialName && !!set.components?.[name];
  const valid = componentName.test(name) && !taken;
  const unknown = splitList(tokens).filter((t) => !set.tokens[t]);
  const submit = () => {
    if (!valid) return;
    onSave(name, {
      status,
      props: Object.fromEntries(
        propNames
          .map((p) => [p, splitList(props[p]).map((v) => v.toLowerCase())] as const)
          .filter(([, v]) => v.length),
      ),
      ...text,
      tokens: splitList(tokens),
    });
  };
  const area = (field: keyof typeof text, label: string) => (
    <label>
      {label}
      <textarea
        rows={2}
        value={text[field]}
        onChange={(e) => setText({ ...text, [field]: e.target.value })}
      />
    </label>
  );
  return (
    <form
      className="fiche fiche-form"
      aria-label={initialName ? `Modifier ${initialName}` : 'Nouveau composant'}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label>
        Nom (anglais, PascalCase)
        <input value={name} autoFocus onChange={(e) => setName(e.target.value.trim())} placeholder="Card/Project" />
      </label>
      {name && (check.issues.length > 0 || taken) && (
        <p className="add-error">
          {taken ? 'Ce composant existe déjà.' : check.issues.join(' ')}{' '}
          {check.suggestion && check.suggestion !== name && (
            <button type="button" onClick={() => setName(check.suggestion)}>
              Utiliser {check.suggestion}
            </button>
          )}
        </p>
      )}
      <label>
        Statut au transfert
        <select value={status} onChange={(e) => setStatus(e.target.value as ComponentDoc['status'])}>
          <option value="fiche">Fiche : documenté sur la page</option>
          <option value="figma">Figma : vrai composant avec variantes</option>
        </select>
      </label>
      <div className="props-edit">
        {propNames.map((p) => (
          <label key={p}>
            {p}
            <input
              value={props[p]}
              placeholder={p === 'State' ? 'default, hover, disabled' : ''}
              onChange={(e) => setProps({ ...props, [p]: e.target.value })}
            />
          </label>
        ))}
      </div>
      {area('role', 'À quoi il sert')}
      {area('use', 'Quand l’utiliser')}
      {area('avoid', 'Quand l’éviter')}
      {area('a11y', 'Accessibilité')}
      <label>
        Tokens utilisés (séparés par des virgules)
        <textarea rows={2} value={tokens} onChange={(e) => setTokens(e.target.value)} />
      </label>
      {unknown.length > 0 && <p className="add-error">Absents du jeu : {unknown.join(', ')}</p>}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={!valid}>
          {initialName ? 'Mettre à jour' : 'Ajouter'} en brouillon
        </button>
        <button type="button" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </form>
  );
}

function Remove({ tokenKey, onRemove }: { tokenKey: string; onRemove: (key: string) => void }) {
  return (
    <button
      className="remove"
      aria-label={`Retirer ${tokenKey}`}
      title="Retirer (brouillon : rien n’est supprimé avant validation)"
      onClick={() => onRemove(tokenKey)}
    >
      ×
    </button>
  );
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

export default function Board({
  set,
  drafts,
  added,
  findings,
  onEdit,
  onAdd,
  onRemove,
  componentDrafts,
  onComponent,
}: BoardProps) {
  // Fiche en cours d'édition : son nom, '' pour une nouvelle, undefined sinon.
  const [editing, setEditing] = useState<string>();
  const entries = Object.entries(set.tokens);
  const byKey = (key: string) => findings.filter((f) => f.key === key);
  const isDraft = (key: string) =>
    added.has(key) || [...drafts.keys()].some((d) => d.startsWith(`${key}@`));
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
  const others = entries.filter(
    ([, t]) => t.$collection === 'primitives' && t.$type !== 'color' && t.$type !== 'dimension',
  );
  const baseFont = set.tokens['font/family/base'] ? String(resolve(set, 'font/family/base')) : undefined;
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
                  <span className="name">
                    {key.split('/').at(-1)}
                    <Remove tokenKey={key} onRemove={onRemove} />
                  </span>
                  <ValueEditor set={set} tokenKey={key} token={token} mode="default" onEdit={onEdit} label={key} />
                </div>
              ))}
            </div>
          </div>
        ))}
        <AddToken set={set} collection="primitives" types={['color']} prefix="color/" onAdd={onAdd} />
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
                  <Remove tokenKey={key} onRemove={onRemove} />
                </div>
              ))}
          </div>
        ))}
        <AddToken
          set={set}
          collection="tokens"
          types={['color', 'dimension', 'fontWeight', 'number', 'fontFamily']}
          prefix=""
          onAdd={onAdd}
        />
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
                style={{ fontSize: Math.min(Number(resolve(set, key)), 40), fontFamily: baseFont }}
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
            <Remove tokenKey={key} onRemove={onRemove} />
          </div>
        ))}
        <AddToken
          set={set}
          collection="typography"
          types={['dimension', 'fontWeight', 'number', 'fontFamily']}
          prefix="font/size/"
          onAdd={onAdd}
        />
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
                    <Remove tokenKey={key} onRemove={onRemove} />
                  </div>
                );
              })}
          </div>
        ))}
        <AddToken set={set} collection="primitives" types={['dimension']} prefix="space/" onAdd={onAdd} />
      </section>

      <section aria-labelledby="h-others">
        <h2 id="h-others">Autres primitives</h2>
        <p className="hint">Polices, graisses et nombres bruts, repris par la typographie.</p>
        {others.map(([key, token]) => (
          <div className={rowClass(key)} key={key}>
            <span className="chip chip-dim">{String(token.$values.default).slice(0, 10)}</span>
            <span className="meta">
              <code>{key}</code>
              {token.$description && <small>{token.$description}</small>}
            </span>
            <ValueEditor set={set} tokenKey={key} token={token} mode="default" onEdit={onEdit} label={key} />
            <Flag findings={byKey(key)} />
            <Remove tokenKey={key} onRemove={onRemove} />
          </div>
        ))}
        <AddToken
          set={set}
          collection="primitives"
          types={['fontWeight', 'fontFamily', 'number']}
          prefix="font/"
          onAdd={onAdd}
        />
      </section>

      <section aria-labelledby="h-components">
        <h2 id="h-components">Composants</h2>
        <p className="hint">
          Nom anglais, fiche en français. « Figma » : composant créé au transfert ; « Fiche » :
          documenté seulement. Depuis Figma : demande à ton agent « ajoute les composants de mon
          Figma », puis importe le fichier qu’il prépare.
        </p>
        <div className="fiches">
          {Object.entries(set.components ?? {}).map(([name, c]) =>
            editing === name ? (
              <ComponentForm
                key={name}
                set={set}
                name={name}
                doc={c}
                onCancel={() => setEditing(undefined)}
                onSave={(next, doc) => {
                  if (next !== name) onComponent(name, null);
                  onComponent(next, doc);
                  setEditing(undefined);
                }}
              />
            ) : (
              <article className={`fiche ${componentDrafts.has(name) ? 'is-draft' : ''}`} key={name}>
                <header>
                  <h3>{name}</h3>
                  <span className={`status ${c.status}`}>{c.status === 'figma' ? 'Figma' : 'Fiche'}</span>
                  <Flag findings={byKey(name)} />
                  <span className="fiche-actions">
                    <button className="remove" aria-label={`Modifier ${name}`} title="Modifier la fiche" onClick={() => setEditing(name)}>
                      ✎
                    </button>
                    <button
                      className="remove"
                      aria-label={`Retirer ${name}`}
                      title="Retirer (brouillon : rien n’est supprimé avant validation)"
                      onClick={() => onComponent(name, null)}
                    >
                      ×
                    </button>
                  </span>
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
                  <dd>{c.role || '—'}</dd>
                  <dt>Quand l’utiliser</dt>
                  <dd>{c.use || '—'}</dd>
                  <dt>Quand l’éviter</dt>
                  <dd>{c.avoid || '—'}</dd>
                  <dt>Accessibilité</dt>
                  <dd>{c.a11y || '—'}</dd>
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
            ),
          )}
          {editing === '' && (
            <ComponentForm
              set={set}
              onCancel={() => setEditing(undefined)}
              onSave={(name, doc) => {
                onComponent(name, doc);
                setEditing(undefined);
              }}
            />
          )}
        </div>
        {editing === undefined && (
          <button className="add" onClick={() => setEditing('')}>
            + Ajouter un composant
          </button>
        )}
      </section>

      <section aria-labelledby="h-names">
        <h2 id="h-names">Nomenclature</h2>
        <Nomenclature />
      </section>
    </div>
  );
}

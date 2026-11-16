import { useEffect, useState, type FormEvent } from 'react';
import type { Change } from '../shared/model.js';
import type { Config } from '../shared/project.js';
import type { RepoReport } from '../shared/repo-propose.js';
import {
  attachRepo,
  getGithub,
  getRepoPlan,
  githubAction,
  previewRepoAgent,
  readProjectRepo,
  sendRepoAgent,
  type AgentPreview,
  type GithubRepo,
  type RepoPlanSummary,
  type RepoResult,
} from './api.js';

// Panneau « Dépôt » (plan GitHub, G3) : dépôt GitHub lu sur le poste, tokens
// repris, valeurs en dur rattachées à un token (plan gardé pour la PR de G5).
// Rien n'est écrit dans le projet : « Mettre en brouillon » rejoint la boucle
// habituelle (écarts, diff, validation). Rien n'est écrit dans le dépôt.
type Phase =
  | { status: 'idle' }
  | { status: 'loading'; what: string }
  | { status: 'error'; message: string }
  | { status: 'form'; repos: GithubRepo[] | null; reason: string | null }
  | { status: 'done'; result: RepoResult }
  | { status: 'plan'; plan: RepoPlanSummary | null }
  // G6 : écran de consentement, puis réponse de l'agent.
  | { status: 'consent'; preview: AgentPreview; sending: boolean }
  | { status: 'agent'; reason: string; changes: Change[]; dropped: number };

const label = (c: Change) =>
  !('op' in c) ? `${c.key} (${c.mode}) → ${c.value}` : c.op === 'add' ? `+ ${c.key}` : c.op === 'remove' ? `− ${c.key}` : c.name;
const gap = (kind: 'color' | 'px', g: number) => (kind === 'px' ? `${g} px` : `ΔE ${Math.round(g * 1000) / 10}`);

export default function RepoPanel({
  config,
  start,
  onConfig,
  onDraft,
  onSemantic,
  onClose,
}: {
  config: Config;
  // `create` : projet tout juste créé depuis un dépôt, lecture lancée tout de suite.
  start: 'create' | 'open';
  onConfig: (config: Config) => void;
  onDraft: (changes: Change[], from?: string) => void;
  // Second brouillon : couleurs à plat → primitives de palette + tokens sémantiques.
  onSemantic: () => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  const attached = config.github?.source === 'repo' ? config.github : null;

  const read = (mode: 'create' | 'attach') => {
    setPhase({ status: 'loading', what: `Lecture de ${config.github?.repo ?? 'du dépôt'}…` });
    readProjectRepo(mode).then(
      (result) => setPhase({ status: 'done', result }),
      (e: Error) => setPhase({ status: 'error', message: e.message }),
    );
  };
  const openForm = async () => {
    setPhase({ status: 'loading', what: 'Dépôts accessibles…' });
    try {
      const status = await getGithub();
      if (!status.pro) return setPhase({ status: 'form', repos: null, reason: 'GitHub est réservé à DS-Studio Pro : passer Pro dans Réglages → Compte.' });
      if (status.status !== 'connected') return setPhase({ status: 'form', repos: null, reason: 'Connecter GitHub dans Réglages → GitHub, puis revenir ici.' });
      const { repos } = await githubAction('repos');
      setPhase({ status: 'form', repos: repos ?? [], reason: null });
    } catch (e) {
      setPhase({ status: 'error', message: (e as Error).message });
    }
  };
  const askAgent = () => {
    setPhase({ status: 'loading', what: 'Préparation des extraits (rien n’est envoyé)…' });
    previewRepoAgent().then(
      (preview) => setPhase({ status: 'consent', preview, sending: false }),
      (e: Error) => setPhase({ status: 'error', message: e.message }),
    );
  };
  const sendAgent = (preview: AgentPreview) => {
    setPhase({ status: 'consent', preview, sending: true });
    sendRepoAgent(preview.nonce).then(
      (r) => setPhase({ status: 'agent', ...r }),
      // Un aperçu ne sert qu'une fois : un nouvel essai repasse par le consentement.
      (e: Error) => setPhase({ status: 'error', message: `${e.message} Pour réessayer, redemande à l’agent : nouvel aperçu, nouvelle confirmation.` }),
    );
  };
  const backToPlan = () =>
    getRepoPlan().then(
      (plan) => setPhase({ status: 'plan', plan }),
      (e: Error) => setPhase({ status: 'error', message: e.message }),
    );
  useEffect(() => {
    if (start === 'create' && attached) return read('create');
    if (!attached) {
      void openForm();
      return;
    }
    getRepoPlan().then(
      (plan) => setPhase({ status: 'plan', plan }),
      (e: Error) => setPhase({ status: 'error', message: e.message }),
    );
    // Lancé une fois à l'ouverture du panneau.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="extract repo" aria-label="Dépôt GitHub">
      <div className="extract-head">
        <div>
          <h2>{attached ? `Dépôt ${attached.repo}` : 'Rattacher un dépôt GitHub'}</h2>
          <p className="hint">
            Lecture faite sur cet ordinateur : l’archive de la branche est lue en mémoire, rien n’est exécuté ni envoyé ailleurs qu’à
            GitHub. Rien n’est écrit dans le dépôt avant la pull request d’une version acceptée.
          </p>
        </div>
        <button onClick={onClose} aria-label="Fermer le dépôt">
          Fermer
        </button>
      </div>
      {phase.status === 'loading' && (
        <p className="extract-wait" role="status">
          {phase.what}
        </p>
      )}
      {phase.status === 'error' && (
        <div className="extract-error">
          <p role="alert">{phase.message}</p>
          <button onClick={() => (attached ? read('attach') : void openForm())}>Réessayer</button>
        </div>
      )}
      {phase.status === 'form' && (
        <AttachForm
          repos={phase.repos}
          reason={phase.reason}
          current={config.github?.repo ?? ''}
          onSubmit={(repo, base, subdir) => {
            setPhase({ status: 'loading', what: `Lecture de ${repo}…` });
            attachRepo(repo, base, subdir).then(
              (result) => {
                onConfig(result.config);
                setPhase({ status: 'done', result });
              },
              (e: Error) => setPhase({ status: 'error', message: e.message }),
            );
          }}
        />
      )}
      {phase.status === 'plan' && (
        <>
          {phase.plan ? (
            <>
              <p className="hint">
                Dernière lecture le {new Date(phase.plan.date).toLocaleString('fr-FR')} : branche <code>{phase.plan.ref}</code>
                {phase.plan.commit && (
                  <>
                    , commit <code>{phase.plan.commit.slice(0, 7)}</code>
                  </>
                )}
                {phase.plan.subdir && (
                  <>
                    , dossier <code>{phase.plan.subdir}/</code>
                  </>
                )}
                .
              </p>
              <Summary report={phase.plan.report} tokens={phase.plan.tokenCount} />
              {phase.plan.files.length > 0 && (
                <details className="extract-changes">
                  <summary>Fichiers avec des valeurs en dur ({phase.plan.files.length} au plus)</summary>
                  <ul aria-label="Fichiers du dépôt">
                    {phase.plan.files.map((f) => (
                      <li key={f.file}>
                        <code>{f.file}</code> · {f.count}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          ) : (
            <p className="hint">Dépôt rattaché, pas encore lu.</p>
          )}
          <p className="hint">
            Couleurs du dépôt écrites à plat (par exemple <code>--fond: #0B0B0C</code>) : DS-Studio peut proposer une palette de primitives et
            garder vos noms comme tokens sémantiques qui y renvoient. Second brouillon, relu par diff ; la PR réécrit alors vos
            variables.
          </p>
          <div className="form-actions">
            <button onClick={() => void openForm()}>Changer de dépôt</button>
            <button onClick={onSemantic}>Proposer une couche sémantique</button>
            {(phase.plan?.report.hardcoded.unmapped ?? 0) > 0 && <button onClick={askAgent}>Demander à l’agent de nommer les tokens</button>}
            <button className="primary" onClick={() => read('attach')}>
              Relire le dépôt
            </button>
          </div>
        </>
      )}
      {phase.status === 'done' && <Result result={phase.result} onDraft={onDraft} />}
      {phase.status === 'consent' && (
        <Consent preview={phase.preview} sending={phase.sending} onSend={() => sendAgent(phase.preview)} onCancel={() => void backToPlan()} />
      )}
      {phase.status === 'agent' && (
        <div className="repo-agent" aria-label="Proposition de l’agent">
          <p>{phase.reason}</p>
          {phase.dropped > 0 && (
            <p className="hint">{phase.dropped} changement(s) écarté(s) : seuls les ajouts de primitives aux valeurs envoyées sont gardés.</p>
          )}
          {phase.changes.length > 0 ? (
            <>
              <ul className="repo-files">
                {phase.changes.map((c, i) => (
                  <li key={i}>{label(c)}</li>
                ))}
              </ul>
              <p className="hint">Après validation, « Relire le dépôt » rattache ces valeurs aux nouveaux tokens pour la PR.</p>
            </>
          ) : (
            <p className="hint">Aucun token proposé.</p>
          )}
          <div className="form-actions">
            <button onClick={() => void backToPlan()}>Retour</button>
            <button className="primary" disabled={phase.changes.length === 0} onClick={() => onDraft(phase.changes, 'de l’agent (dépôt)')}>
              Mettre en brouillon
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function AttachForm({
  repos,
  reason,
  current,
  onSubmit,
}: {
  repos: GithubRepo[] | null;
  reason: string | null;
  current: string;
  onSubmit: (repo: string, base: string, subdir: string) => void;
}) {
  const [repo, setRepo] = useState(current && repos?.some((r) => r.fullName === current) ? current : (repos?.[0]?.fullName ?? ''));
  const [subdir, setSubdir] = useState('');
  if (reason) return <p className="hint">{reason}</p>;
  if (!repos?.length)
    return (
      <p className="hint">
        Aucun dépôt accessible : ajouter un dépôt à DS-Studio depuis Réglages → GitHub (« Ajouter un dépôt »).
      </p>
    );
  const chosen = repos.find((r) => r.fullName === repo);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (chosen) onSubmit(chosen.fullName, chosen.defaultBranch, subdir.trim());
  };
  return (
    <form className="repo-form" onSubmit={submit} aria-label="Rattacher un dépôt">
      <label>
        Dépôt
        <select value={repo} onChange={(e) => setRepo(e.target.value)}>
          {repos.map((r) => (
            <option key={r.fullName} value={r.fullName}>
              {r.fullName}
              {r.private ? ' (privé)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        Sous-dossier (facultatif, monorepo)
        <input value={subdir} onChange={(e) => setSubdir(e.target.value)} placeholder="apps/web" />
      </label>
      <p className="hint">
        Branche lue : <code>{chosen?.defaultBranch ?? 'main'}</code>. Les tokens du projet sont gardés : seuls ceux qui manquent
        sont proposés, à valider par le diff.
      </p>
      <div className="form-actions">
        <button type="submit" className="primary">
          Lire le dépôt
        </button>
      </div>
    </form>
  );
}

function Summary({ report, tokens }: { report: RepoReport; tokens?: number }) {
  const d = report.declared;
  const h = report.hardcoded;
  return (
    <>
      <dl className="repo-summary">
        <dt>Fichiers lus</dt>
        <dd>{report.files}</dd>
        <dt>Lecture</dt>
        <dd>{report.strategy === 'explicit' ? 'tokens déclarés dans le code' : 'valeurs en dur regroupées (dépôt peu structuré)'}</dd>
        <dt>Tokens du dépôt</dt>
        <dd>
          {d.found} déclaré(s), {d.kept} repris{tokens !== undefined ? `, ${tokens} au plan` : ''} · {d.matched} déjà dans le
          projet, {d.added} nouveau(x){d.removed ? `, ${d.removed} du gabarit retiré(s)` : ''}
        </dd>
        <dt>Valeurs en dur</dt>
        <dd>
          {h.total} · {h.mapped} rattachée(s) à un token ({h.exact} exacte(s)), {h.unmapped} sans token proche
        </dd>
        {report.classes > 0 && (
          <>
            <dt>Classes Tailwind</dt>
            <dd>{report.classes} (réécrites à la pull request)</dd>
          </>
        )}
      </dl>
      {report.gaps.length > 0 && (
        <details className="extract-changes" open>
          <summary>Plus grands écarts acceptés</summary>
          <ul aria-label="Plus grands écarts">
            {report.gaps.map((g, i) => (
              <li key={i}>
                <code>{g.value}</code> → <code>{g.token}</code> ({gap(/^#/.test(g.value) ? 'color' : 'px', g.gap)}) ·{' '}
                <small>
                  {g.file}:{g.line}
                </small>
              </li>
            ))}
          </ul>
        </details>
      )}
      {report.unmapped.length > 0 && (
        <details className="extract-changes">
          <summary>Valeurs sans token proche</summary>
          <ul aria-label="Valeurs sans token">
            {report.unmapped.map((u) => (
              <li key={u.value}>
                <code>{u.value}</code> × {u.count}
              </li>
            ))}
          </ul>
        </details>
      )}
      {report.differing.length > 0 && (
        <details className="extract-changes">
          <summary>{report.differing.length} token(s) avec une autre valeur dans le dépôt</summary>
          <ul aria-label="Écarts entre le dépôt et le projet">
            {report.differing.map((x) => (
              <li key={x.key}>
                <code>{x.key}</code> : projet <code>{x.project}</code>, dépôt <code>{x.repo}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      {report.conflicts.length > 0 && (
        <details className="extract-changes">
          <summary>{report.conflicts.length} variable(s) déclarée(s) avec plusieurs valeurs (celle du fichier principal gagne)</summary>
          <ul>
            {report.conflicts.map((c) => (
              <li key={c.name}>
                <code>{c.name}</code> : {c.values.join(' · ')}
              </li>
            ))}
          </ul>
        </details>
      )}
      {(report.composite?.length ?? 0) > 0 && (
        <details className="extract-changes" open>
          <summary>{report.composite!.length} dégradé(s) et ombre(s) gardé(s) dans le code (lecture seule)</summary>
          <ul aria-label="Dégradés et ombres du dépôt">
            {report.composite!.map((c) => (
              <li key={c.name}>
                {c.kind === 'gradient' && !/url\(|var\(/i.test(c.value) && (
                  <span className="repo-swatch" style={{ background: c.value }} aria-hidden="true" />
                )}
                <code>{c.name}</code> : {c.kind === 'gradient' ? 'dégradé' : 'ombre'}, {c.bound}/{c.colors} couleur(s) liée(s) à un token
                {c.colors > c.bound && ' (les autres restent en dur : transparence ou pas de token proche)'}
              </li>
            ))}
          </ul>
        </details>
      )}
      {report.rejected.length > 0 && (
        <details className="extract-changes">
          <summary>{report.rejected.length} déclaration(s) non reprise(s)</summary>
          <ul>
            {report.rejected.map((r) => (
              <li key={r.name}>
                <code>{r.name}</code> : {r.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      <ul className="extract-notes">
        {report.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </>
  );
}

// Écran de consentement (G6) : ce qui part, d'où, par où ; confirmé à chaque fois.
function Consent({ preview, sending, onSend, onCancel }: { preview: AgentPreview; sending: boolean; onSend: () => void; onCancel: () => void }) {
  return (
    <div className="repo-consent" role="group" aria-label="Envoi à l’agent">
      <h3>Envoyer ces extraits à l’agent ?</h3>
      <p>
        {preview.values.length} valeur(s) sans token, {preview.lines} ligne(s) de {preview.files.length} fichier(s) : la ligne et l’en-tête
        de son bloc (sélecteur) seulement, jamais un fichier entier. Fichiers <code>.env</code>, configs et lignes qui ressemblent à un secret
        écartés.
      </p>
      <ul className="repo-files">
        {preview.files.map((f) => (
          <li key={f.file}>
            <code>{f.file}</code> · {f.lines} ligne(s)
          </li>
        ))}
      </ul>
      <details>
        <summary>Voir exactement ce qui part</summary>
        <ul className="repo-excerpts">
          {preview.excerpts.map((x) => (
            <li key={`${x.file}:${x.line}`}>
              <code>
                {x.file}:{x.line}
              </code>
              {x.selector && <> · {x.selector}</>}
              <pre>{x.text}</pre>
            </li>
          ))}
        </ul>
      </details>
      <p className="hint">
        Trajet : cet ordinateur → serveur DS-Studio (rien conservé, seuls la consommation et le coût sont comptés) → OpenRouter, routé vers
        des fournisseurs sans conservation des données (ZDR) seulement → modèle. Débité de vos crédits comme Lenny ; si aucun fournisseur ZDR
        n’est disponible pour le modèle, l’envoi échoue. La réponse arrive en brouillon, relue par diff.
      </p>
      <div className="form-actions">
        <button onClick={onCancel} disabled={sending}>
          Annuler
        </button>
        <button className="primary" onClick={onSend} disabled={sending}>
          {sending ? 'Envoi…' : `Envoyer ces ${preview.lines} lignes à l’agent`}
        </button>
      </div>
    </div>
  );
}

function Result({ result, onDraft }: { result: RepoResult; onDraft: (changes: Change[]) => void }) {
  const { changes, rejected, report, source } = result;
  return (
    <>
      <p className="hint">
        Branche <code>{source.ref}</code>
        {source.commit && (
          <>
            , commit <code>{source.commit.slice(0, 7)}</code>
          </>
        )}
        {source.subdir && (
          <>
            , dossier <code>{source.subdir}/</code>
          </>
        )}
        {source.tailwind ? ` · Tailwind ${source.tailwind}` : ''}
        {source.truncated ? ' · dépôt trop grand, lecture partielle' : ''}.
      </p>
      <Summary report={report} />
      <details className="extract-changes">
        <summary>{changes.length} changement(s) proposé(s) sur le jeu du projet</summary>
        <ul aria-label="Changements proposés">
          {changes.map((c, i) => (
            <li key={i}>
              <code>{label(c)}</code>
            </li>
          ))}
        </ul>
      </details>
      {rejected.length > 0 && (
        <details className="extract-changes">
          <summary>{rejected.length} proposition(s) écartée(s)</summary>
          <ul>
            {rejected.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="form-actions">
        <button className="primary" disabled={changes.length === 0} onClick={() => onDraft(changes)}>
          {changes.length ? 'Mettre en brouillon' : 'Rien à reprendre'}
        </button>
      </div>
    </>
  );
}

import { useState } from 'react';
import { checkNames } from '../shared/rules.js';

// Vérificateur de noms : colle des noms de composants Figma (un par ligne),
// l'outil signale les écarts et propose un nom. Il ne renomme rien.
export default function Nomenclature() {
  const [text, setText] = useState('');
  const results = checkNames(text.split('\n'));
  const faulty = results.filter((r) => r.issues.length);
  return (
    <div className="naming">
      <p className="hint">
        Règle : composant en anglais et en PascalCase (<code>Button</code>,{' '}
        <code>Card/Project</code>), propriétés <code>Variant</code>,{' '}
        <code>State</code>, <code>Size</code>, valeurs en minuscules. Formats
        acceptés : <code>Nom</code>, <code>Prop=valeur</code> ou{' '}
        <code>Nom · Prop=valeur</code>.
      </p>
      <label htmlFor="names">Noms à vérifier, un par ligne</label>
      <textarea
        id="names"
        rows={5}
        value={text}
        placeholder={'card projet\nbutton · State=Hover\nProperty 1=Aucun résultat'}
        onChange={(e) => setText(e.target.value)}
      />
      {results.length > 0 && (
        <p className="summary" role="status">
          {faulty.length} nom(s) à revoir sur {results.length}.
        </p>
      )}
      <ul className="name-results">
        {results.map((r, i) => (
          <li key={`${r.name}-${i}`} className={r.issues.length ? 'bad' : 'ok'}>
            <span className="from">{r.name}</span>
            <span className="to">{r.issues.length ? `→ ${r.suggestion}` : 'conforme'}</span>
            {r.issues.length > 0 && (
              <ul>
                {r.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

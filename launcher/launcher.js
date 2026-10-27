const token = location.hash.slice(1) || sessionStorage.getItem('ds-launcher');
if (token) sessionStorage.setItem('ds-launcher', token);
history.replaceState(null, '', '/');
let pending = false;
let quitting = false;
async function request(route, body) {
  const response = await fetch('/api/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
async function refresh() {
  if (quitting) return;
  try {
    const state = await request('status');
    document.querySelector('#status').textContent =
      'État : ' + state.phase + (state.pid ? ' · PID ' + state.pid : '');
    document.querySelector('#error').textContent = state.error;
    document.querySelector('#setup').hidden = state.ready;
    document.querySelector('#output').textContent = state.output;
    document.querySelector('#address').hidden = !state.url;
    if (state.url) document.querySelector('#studio').href = state.url;
    for (const button of document.querySelectorAll('[data-action]')) {
      const name = button.dataset.action;
      button.disabled =
        pending ||
        state.busy ||
        (['open', 'stop', 'restart'].includes(name) &&
          state.phase !== 'actif' &&
          state.phase !== 'erreur') ||
        (name === 'start' && (!state.ready || state.phase === 'actif')) ||
        (name === 'prepare' && state.phase === 'actif') ||
        (name === 'restore' && (!state.backup || !!state.pid));
    }
  } catch (error) {
    document.querySelector('#error').textContent =
      error.message + ' Double-cliquez sur le lanceur pour réessayer.';
  }
}
for (const button of document.querySelectorAll('[data-action]'))
  button.addEventListener('click', async () => {
    const name = button.dataset.action;
    if (
      name === 'prepare' &&
      !confirm(
        'Autoriser npm ci (téléchargement et scripts des dépendances de ce projet) puis npm run build ? Les données DS-Studio sont conservées. Aucun droit administrateur demandé.',
      )
    )
      return;
    if (name === 'restore' && !confirm('Restaurer la révision précédente des tokens et de l’historique ? L’état actuel sera archivé dans le dossier privé, même s’il est invalide. Le brief PFE ne change pas.')) return;
    pending = true;
    try {
      await request(name, ['prepare', 'restore'].includes(name) ? { confirm: true } : {});
      if (name === 'quit') {
        quitting = true;
        document.querySelector('#feedback').textContent =
          'Arrêt en cours. Ce panneau peut être fermé lorsque DS-Studio est arrêté.';
        // Le statut reste lisible jusqu'à ce que le contrôleur ferme sa socket.
        quitting = false;
        const timer = setInterval(async () => {
          try {
            await request('status');
          } catch {
            quitting = true;
            clearInterval(timer);
            document.querySelector('#status').textContent = 'État : arrêté';
            document.querySelector('#error').textContent = '';
            document.querySelector('#feedback').textContent =
              'DS-Studio et son lanceur sont arrêtés. Vous pouvez fermer cet onglet.';
            for (const b of document.querySelectorAll('button'))
              b.disabled = true;
          }
        }, 500);
      }
    } catch (error) {
      document.querySelector('#error').textContent = error.message;
    } finally {
      pending = false;
      await refresh();
    }
  });
void refresh();
setInterval(refresh, 700);

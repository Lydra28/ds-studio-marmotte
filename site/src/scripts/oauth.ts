// Retours de la connexion avec Google ou GitHub (server/oauth.ts) : l'API
// revient sur le site avec `?oauth=<code>` en cas d'échec, et la page de
// connexion de l'app passe son code aux boutons (`?app=`).

const MESSAGES: Record<string, string> = {
  refus: 'Connexion annulée.',
  etat: 'Connexion expirée ou lancée depuis un autre navigateur : réessayer.',
  adresse: 'Adresse mail non vérifiée chez ce fournisseur : la vérifier chez lui, ou créer un compte par mail.',
  indisponible: 'Cette connexion n’est pas encore disponible : utiliser l’adresse mail.',
  trop: 'Trop d’inscriptions en ce moment : réessayer dans quelques minutes.',
  erreur: 'Le fournisseur n’a pas répondu comme prévu : réessayer.',
};

/** Message de l'échec signalé dans l'adresse (retiré de l'adresse), ou `null`. */
export function takeOAuthError(): string | null {
  const params = new URLSearchParams(location.search);
  const code = params.get('oauth');
  if (code === null) return null;
  params.delete('oauth');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  return MESSAGES[code] ?? MESSAGES.erreur;
}

/** Code de connexion de l'app lu dans l'adresse (`XXXX-XXXX`), ou `null`. */
export function appCode(param: string): string | null {
  const raw = (new URLSearchParams(location.search).get(param) ?? '').trim().toUpperCase().replace('-', '');
  return /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4)}` : null;
}

/** Les boutons Google et GitHub ramènent sur la page de connexion de l'app. */
export function carryAppCode(root: ParentNode, code: string) {
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[data-oauth]')) {
    const url = new URL(a.href);
    url.searchParams.set('app', code);
    a.href = url.toString();
  }
}

// Mises à jour automatiques : décide, sans Electron, si l'app peut se mettre à
// jour et depuis quel flux. Testé à part (tests/update-config.test.ts).
// `build` vient de desktop/build/update.json, écrit par scripts/build-desktop.mjs
// à partir de DS_STUDIO_UPDATE_URL, DS_STUDIO_UPDATE_CHANNEL et DS_STUDIO_MAC_SIGNED.

/**
 * @param {{ platform: string; packaged: boolean; build: { url?: string; channel?: string; macSigned?: boolean } | null }} input
 * @returns {{ enabled: boolean; reason: string | null; url: string | null; channel: string }}
 */
export function resolveUpdateConfig({ platform, packaged, build }) {
  const channel = typeof build?.channel === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(build.channel) ? build.channel : 'stable';
  const url = typeof build?.url === 'string' && /^https:\/\/[^\s]+$/.test(build.url) ? build.url.replace(/\/+$/, '') : null;
  if (!packaged) return { enabled: false, reason: 'Mises à jour désactivées depuis les sources.', url, channel };
  if (!url) return { enabled: false, reason: 'Aucun flux de mise à jour configuré dans cette version.', url: null, channel };
  // Squirrel.Mac refuse une app non signée : le flux resterait en erreur.
  if (platform === 'darwin' && build?.macSigned !== true)
    return { enabled: false, reason: 'Mises à jour manuelles sur Mac jusqu’à la signature de l’app.', url, channel };
  return { enabled: true, reason: null, url, channel };
}

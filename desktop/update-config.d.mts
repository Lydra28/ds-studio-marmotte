// Types de desktop/update-config.mjs pour les tests TypeScript (tsc --noEmit).
export interface UpdateBuildInfo {
  url?: string | null;
  channel?: string;
  macSigned?: boolean;
}
export interface UpdateConfig {
  enabled: boolean;
  reason: string | null;
  url: string | null;
  channel: string;
}
export function resolveUpdateConfig(input: {
  platform: string;
  packaged: boolean;
  build: UpdateBuildInfo | null;
}): UpdateConfig;

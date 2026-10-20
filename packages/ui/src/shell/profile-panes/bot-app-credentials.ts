import type { IntegrationInstallInput } from '@hq/platform';
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export interface AppCredentialConfig {
  id: string; name: string; domain: string; provider: string; mcpUrl: string;
  kind: 'key' | 'oauth' | 'none' | 'unsupported'; pullAllHistory: boolean;
  updatedAt: string; connected: boolean;
}
/** Use the persisted installation identity, never a catalog/name guess for an existing connection. */
export function credentialConfigs(payload: unknown): Record<string, AppCredentialConfig> {
  const root = record(payload);
  if (record(root.viewer).canManageIntegrations !== true) return {};
  const rows = Array.isArray(root.connections) ? root.connections.map(record) : [];
  const configs: Record<string, AppCredentialConfig> = {};
  for (const value of rows) {
    const row = record(value), installation = record(row.installation), surface = record(installation.surface);
    if (typeof row.id !== 'string' || typeof installation.provider !== 'string' || row.provider !== `factory:${installation.provider}` || installation.connectionId !== row.id || surface.kind !== 'mcp') continue;
    if (rows.filter(other => other.provider === row.provider).length !== 1) continue;
    let url: URL;
    try { url = new URL(String(surface.url)); } catch { continue; }
    // Never show or reuse credential-bearing URLs. Server performs its own SSRF validation.
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) continue;
    const ids = Array.isArray(surface.credentialIds) ? surface.credentialIds : [];
    const kind = ids.includes('direct-mcp-bearer-token') ? 'key' : ids.includes('remote-mcp-oauth') || surface.authStatus === 'oauth' ? 'oauth' : surface.authStatus === 'none' ? 'none' : 'unsupported';
    configs[row.id] = { id: row.id, name: String(installation.displayName || installation.provider), domain: String(installation.domain || url.hostname), provider: installation.provider,
      mcpUrl: url.href, kind, pullAllHistory: row.pullAllHistory !== false,
      updatedAt: typeof installation.updatedAt === 'string' ? installation.updatedAt : '', connected: row.status === 'connected' && installation.status === 'installed' };
  }
  return configs;
}
export function credentialUpdate(companyUid: string, config: AppCredentialConfig, key: string, authScheme: IntegrationInstallInput['authScheme']): IntegrationInstallInput {
  return { companyUid, provider: config.provider, mcpUrl: config.mcpUrl, displayName: config.name, domain: config.domain, authMode: 'bearer', bearerToken: key.trim(), authScheme, pullAllHistory: config.pullAllHistory };
}

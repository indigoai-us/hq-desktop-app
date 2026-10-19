import { appLogo } from '../../chat/messaging/integration-cards-model.js';
import { BRAND_MARK_DOMAINS, brandMarkFor } from '../../chat/messaging/app-brand-marks.js';
import type { IntegrationCatalogEntry } from '@hq/platform';
import type { AgentProfileView } from '../../chat/agent-detail-model.js';
import { normalizeConnectDomain } from '../../chat/messaging/richMessageContent.js';
import type { CompanyConnection } from '../../chat/messaging/integration-cards-model.js';
import { botConnectionAccessState, botConnectionIsInteractive, botConnectionIsOn, type ConnectionAccess } from '../../chat/messaging/bot-integration-access-model.js';
export interface BotApp {
  id: string; name: string; domain: string; description: string; provider?: string;
  status: 'ready' | 'available' | 'attention' | 'unknown';
  detail: string; tools: number | null; canToggle: boolean; enabled: boolean; onBot: boolean;
}
export type ConnectResult = { kind: 'connected'; id: string | null } | { kind: 'handoff' };
export interface SupportedApp { id: string; domain: string; name: string; description: string; authClass: 'oauth' | 'key' | 'none'; entryId: string | null; }
export function supportedApps(payload: unknown): SupportedApp[] {
  const entries = payload && typeof payload === 'object' && 'entries' in payload && Array.isArray(payload.entries) ? payload.entries : [];
  const seen = new Set<string>();
  return entries.flatMap((entry: IntegrationCatalogEntry) => {
    if (!entry || typeof entry !== 'object') return [];
    const domain = normalizeConnectDomain(entry.domain);
    if (!domain || entry.mcpReady !== true || !['oauth', 'key', 'none'].includes(entry.authClass ?? '')) return [];
    const id = typeof entry.entryId === 'string' && entry.entryId ? entry.entryId : domain;
    if (seen.has(id)) return []; seen.add(id);
    return [{ id, domain, name: entry.name || domain, description: entry.description || 'Connect this MCP to give your bot more tools.', authClass: entry.authClass as SupportedApp['authClass'], entryId: entry.entryId ?? null }];
  });
}
export function botHasApp(app: BotApp): boolean { return app.onBot; }
export function companyHasCatalogApp(rows: BotApp[], app: SupportedApp): boolean {
  return rows.some(row => row.id === app.id || (!!row.domain && normalizeConnectDomain(row.domain) === app.domain));
}
export function botApps(connections: CompanyConnection[], access: Record<string, ConnectionAccess | null>, profile: AgentProfileView | null, uid: string, controls: boolean): BotApp[] {
  const fresh = profile?.freshness.source === 'live';
  const normalize = (provider: string) => provider.toLowerCase().replace(/^factory:/, '');
  const ready = fresh ? profile.apps.ready.map(app => ({ ...app, provider: normalize(app.provider) })) : [];
  const attention = fresh ? profile.apps.attention.map(app => ({ ...app, provider: normalize(app.provider) })) : [];
  const rows: BotApp[] = connections.map(connection => {
    const acl = access[connection.id];
    const input = acl ? { botUid: uid, botRole: fresh ? profile.role ?? '' : '', mode: connection.mode } : null;
    const state = acl && input ? botConnectionAccessState({ ...input, access: acl }) : null;
    const grant = acl && input ? botConnectionAccessState({ ...input, access: { ...acl, canManage: true } }) : null;
    const active = ready.find(app => app.provider === connection.provider);
    const issue = attention.find(app => app.provider === connection.provider);
    const readOnly = state === 'read-only';
    const granted = grant !== null && botConnectionIsOn(grant);
    const onBot = granted || !!issue || (readOnly && !!active);
    const enabled = granted;
    const status: BotApp['status'] = issue || connection.needsAttention ? 'attention' : onBot ? 'ready' : acl ? 'available' : 'unknown';
    const detail = issue ? issue.reason
      : connection.needsAttention ? 'This connection needs attention. Open connection settings to update its credentials.'
      : !acl ? 'Could not verify this bot’s access. Refresh to try again.'
      : readOnly ? onBot ? 'This bot can use this connection. Ask the connection owner or a company admin to change its access.' : 'Ask the connection owner or a company admin to add this bot.'
      : grant === 'on-admin' ? 'Available through this bot’s company admin role.'
      : grant === 'on-everyone' ? 'Shared with everyone in the company. Company sharing controls this access.'
      : !controls ? 'Per-bot access controls are not enabled for this company.'
      : enabled ? 'This connection is available to this bot.' : 'Connected to the company. Add access to let this bot use it.';
    return { id: connection.id, provider: connection.provider, name: connection.name, domain: connection.domain ?? '', description: connection.domain ?? connection.provider, status, tools: onBot && active ? active.tools : null, enabled, onBot, canToggle: controls && fresh && !!state && botConnectionIsInteractive(state), detail };
  });
  for (const app of ready) if (!connections.some(connection => connection.provider === app.provider)) rows.push({ id: `runtime:${app.provider}:${app.name}`, provider: app.provider, name: app.name, domain: '', description: 'MCP reported by this bot', status: 'ready', detail: 'Available in the bot runtime. This connection is managed outside this panel.', tools: app.tools, canToggle: false, enabled: true, onBot: true });
  for (const app of attention) if (!connections.some(connection => connection.provider === app.provider)) rows.push({ id: `attention:${app.provider}`, provider: app.provider, name: app.name, domain: '', description: 'MCP needs attention', status: 'attention', detail: app.reason, tools: null, canToggle: false, enabled: false, onBot: true });
  return rows;
}

// Exact bundled identities only: no third-party image requests or fuzzy brand guesses.
const brandIdentity = (value: string) => value.toLowerCase().replace(/^factory:/, '').replace(/[^a-z0-9]/g, '');
const marksByName = new Map(BRAND_MARK_DOMAINS.map(domain => {
  const mark = brandMarkFor(domain)!;
  return [brandIdentity(mark.title), mark] as const;
}));
export function botAppLogo(app: { domain: string; name: string; provider?: string }) {
  const logo = appLogo(app.domain);
  return { mark: logo.mark ?? marksByName.get(brandIdentity(app.provider ?? '')) ?? marksByName.get(brandIdentity(app.name)) ?? null };
}

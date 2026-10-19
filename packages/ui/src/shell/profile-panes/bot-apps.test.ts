import { describe, expect, it } from 'vitest';
import { botApps, companyHasCatalogApp, supportedApps } from './bot-apps.js';
import { profileFromPayload } from '../../chat/agent-detail-model.js';
const connection = { id: 'c1', name: 'Linear', provider: 'linear', domain: 'linear.app', mode: 'shared', createdBy: 'person_a', createdAt: '' };
const profile = profileFromPayload({ agent: { uid: 'agt_a' }, box: {} }, { uid: 'agt_a', displayName: 'Scout' });
const acl = { mode: 'shared', canManage: true, entries: [{ granteeType: 'person', granteeId: 'agt_a', permission: 'read' }] };
describe('bot apps', () => {
  it('lists only supported MCP entries with known connection methods', () => {
    expect(supportedApps({ entries: [null, { domain: 'linear.app', name: 'Linear', mcpReady: true, authClass: 'oauth' }, { domain: 'linear.app', mcpReady: true, authClass: 'oauth' }, { domain: 'unknown.com', mcpReady: false, authClass: 'key' }, { domain: 'missing.com', mcpReady: true }] })).toHaveLength(1);
  });
  it('requires explicit bot access and preserves feature gating', () => {
    expect(botApps([connection], { c1: acl }, profile, 'agt_a', true)[0]).toMatchObject({ status: 'ready', canToggle: true, enabled: true });
    expect(botApps([connection], { c1: acl }, profile, 'agt_b', true)[0]).toMatchObject({ status: 'available', enabled: false });
    expect(botApps([connection], { c1: acl }, profile, 'agt_a', false)[0].canToggle).toBe(false);
  });
  it('does not mistake unavailable ACLs for disconnected or editable apps', () => {
    expect(botApps([connection], {}, profile, 'agt_a', true)[0]).toMatchObject({ status: 'unknown', canToggle: false });
  });
  it('company-wide and read-only connections cannot be removed by the bot panel', () => {
    expect(botApps([{ ...connection, mode: 'everyone' }], { c1: acl }, profile, 'agt_a', true)[0]).toMatchObject({ enabled: true, canToggle: false });
    expect(botApps([connection], { c1: { ...acl, canManage: false } }, profile, 'agt_a', true)[0]).toMatchObject({ status: 'ready', onBot: true, canToggle: false });
  });
  it('decides whether the bot has an app from the bot’s grant, not from what the viewer can manage', () => {
    const readOnly = { ...acl, canManage: false };
    expect(botApps([connection], { c1: readOnly }, profile, 'agt_a', true)[0]).toMatchObject({ onBot: true, enabled: true, status: 'ready' });
    expect(botApps([connection], { c1: { ...readOnly, entries: [] } }, profile, 'agt_a', true)[0]).toMatchObject({ onBot: false, status: 'available' });
    expect(botApps([{ ...connection, mode: 'everyone' }], { c1: { ...readOnly, entries: [] } }, profile, 'agt_a', true)[0]).toMatchObject({ onBot: true, status: 'ready' });
    const live = { ...profile!, apps: { ...profile!.apps, ready: [{ provider: 'factory:linear', name: 'Linear', tools: 3, featured: false }], attention: [] } };
    expect(botApps([connection], { c1: { ...readOnly, entries: [] } }, live, 'agt_a', true)[0]).toMatchObject({ onBot: true, tools: 3, canToggle: false });
    expect(botApps([connection], { c1: { ...acl, entries: [] } }, live, 'agt_a', true)[0]).toMatchObject({ onBot: false });
  });
  it('keeps apps the bot reports as needing attention on the bot', () => {
    const live = { ...profile!, apps: { ...profile!.apps, ready: [], attention: [{ provider: 'factory:linear', name: 'Linear', reason: 'The bot reported an expired connection.', fix: null }, { provider: 'figma', name: 'Figma', reason: 'Expired.', fix: null }] } };
    const rows = botApps([connection], { c1: { ...acl, entries: [] } }, live, 'agt_a', true);
    expect(rows[0]).toMatchObject({ id: 'c1', onBot: true, enabled: false, status: 'attention', detail: 'The bot reported an expired connection.' });
    expect(rows[1]).toMatchObject({ id: 'attention:figma', onBot: true, status: 'attention' });
    expect(botApps([{ ...connection, needsAttention: true }], { c1: { ...acl, entries: [] } }, profile, 'agt_a', true)[0]).toMatchObject({ onBot: false, status: 'attention' });
  });
  it('does not count an app as on the bot when its access check failed', () => {
    expect(botApps([connection], { c1: null }, profile, 'agt_a', true)[0]).toMatchObject({ onBot: false, status: 'unknown' });
  });
  it('matches catalog entries to connections the company already has', () => {
    const [row] = botApps([connection], { c1: acl }, profile, 'agt_a', true);
    expect(companyHasCatalogApp([row], { id: 'cat_linear', domain: 'linear.app', name: 'Linear', description: '', authClass: 'oauth', entryId: 'cat_linear' })).toBe(true);
    expect(companyHasCatalogApp([{ ...row, domain: 'https://mcp.linear.app/mcp' }], { id: 'x', domain: 'linear.app', name: 'Linear', description: '', authClass: 'oauth', entryId: null })).toBe(true);
    expect(companyHasCatalogApp([row], { id: 'docs', domain: 'docs.example.com', name: 'Docs', description: '', authClass: 'none', entryId: 'docs' })).toBe(false);
  });
  it('disables access edits while the bot runtime is stale', () => {
    expect(botApps([connection], { c1: acl }, profile ? { ...profile, freshness: { source: 'cache', fetchedAt: null } } : null, 'agt_a', true)[0].canToggle).toBe(false);
  });
});

it('matches factory runtime identities to their editable company connection', () => {
  const live = { ...profile!, apps: { ...profile!.apps, ready: [{ provider: 'factory:linear', name: 'Linear', tools: 3, featured: false }], attention: [] } };
  const rows = botApps([connection], { c1: acl }, live, 'agt_a', true);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: 'c1', tools: 3 });
});

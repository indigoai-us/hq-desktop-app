import { describe, expect, it } from 'vitest';
import { botApps, supportedApps } from './bot-apps.js';
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
    expect(botApps([connection], { c1: { ...acl, canManage: false } }, profile, 'agt_a', true)[0]).toMatchObject({ status: 'unknown', canToggle: false });
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

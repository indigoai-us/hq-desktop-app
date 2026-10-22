import { describe, expect, it } from 'vitest';
import { botApps, companyHasCatalogApp, supportedApps } from './bot-apps.js';
import { profileFromPayload } from '../../chat/agent-detail-model.js';
const connection = { id: 'c1', name: 'Linear', provider: 'linear', domain: 'linear.app', mode: 'shared', createdBy: 'person_a', createdAt: '' };
const profile = profileFromPayload({ agent: { uid: 'agt_a', role: 'member' }, box: {} }, { uid: 'agt_a', displayName: 'Scout' });
const noRole = profileFromPayload({ agent: { uid: 'agt_a' }, box: {} }, { uid: 'agt_a', displayName: 'Scout' });
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
    expect(botApps([connection], { c1: { ...readOnly, entries: [] } }, profile, 'agt_a', true)[0]).toMatchObject({ onBot: false, status: 'unknown' });
    expect(botApps([{ ...connection, mode: 'everyone' }], { c1: { ...readOnly, entries: [] } }, profile, 'agt_a', true)[0]).toMatchObject({ onBot: true, status: 'ready' });
    const live = { ...profile!, apps: { ...profile!.apps, ready: [{ provider: 'factory:linear', name: 'Linear', tools: 3, featured: false }], attention: [] } };
    expect(botApps([connection], { c1: { ...readOnly, entries: [] } }, live, 'agt_a', true)[0]).toMatchObject({ onBot: true, enabled: false, tools: 3, status: 'ready', canToggle: false });
    expect(botApps([connection], { c1: { ...readOnly, entries: [{ granteeType: 'person', granteeId: 'person_viewer', permission: 'read' }] } }, live, 'agt_a', true)[0]).toMatchObject({ onBot: false, tools: null, status: 'available' });
    expect(botApps([connection], { c1: readOnly }, live, 'agt_a', true)[0]).toMatchObject({ onBot: true, tools: 3, canToggle: false });
    expect(botApps([connection], { c1: { ...acl, entries: [] } }, live, 'agt_a', true)[0]).toMatchObject({ onBot: false });
  });
  it('keeps apps the bot reports as needing attention on the bot', () => {
    const live = { ...profile!, apps: { ...profile!.apps, ready: [], attention: [{ provider: 'factory:linear', name: 'Linear', reason: 'The bot reported an expired connection.', fix: null }, { provider: 'figma', name: 'Figma', reason: 'Expired.', fix: null }] } };
    const rows = botApps([connection], { c1: { ...acl, entries: [] } }, live, 'agt_a', true);
    expect(rows.map(row => [row.id, row.onBot, row.status])).toEqual([['c1', false, 'available'], ['attention:linear', true, 'attention'], ['attention:figma', true, 'attention']]);
    expect(rows[1]).toMatchObject({ description: 'MCP needs attention', detail: 'The bot reported an expired connection. The bot is not using a company connection it has access to, so this is likely its own sign-in.' });
    const granted = botApps([connection], { c1: acl }, live, 'agt_a', true);
    expect(granted[0]).toMatchObject({ id: 'c1', onBot: true, status: 'attention', detail: 'The bot reported an expired connection.' });
    expect(botApps([{ ...connection, needsAttention: true }], { c1: { ...acl, entries: [] } }, profile, 'agt_a', true)[0]).toMatchObject({ onBot: false, status: 'attention' });
  });
  it('does not credit provider-wide runtime status to a second connection for the same provider', () => {
    const second = { ...connection, id: 'c2', name: 'Linear (Ops)' };
    const readOnly = { ...acl, canManage: false };
    const ready = { ...profile!, apps: { ...profile!.apps, ready: [{ provider: 'factory:linear', name: 'Linear', tools: 3, featured: false }], attention: [] } };
    const [granted, other] = botApps([connection, second], { c1: readOnly, c2: { ...readOnly, entries: [] } }, ready, 'agt_a', true);
    expect(granted).toMatchObject({ id: 'c1', onBot: true, status: 'ready', tools: 3 });
    expect(other).toMatchObject({ id: 'c2', onBot: false, enabled: false, status: 'unknown', tools: null });
    expect(botApps([connection, second], { c1: readOnly, c2: { ...readOnly, entries: [] } }, ready, 'agt_a', true)).toHaveLength(2);
    const attention = { ...profile!, apps: { ...profile!.apps, ready: [], attention: [{ provider: 'linear', name: 'Linear', reason: 'Expired.', fix: null }] } };
    const rows = botApps([connection, second], { c1: { ...acl, entries: [] }, c2: { ...readOnly, entries: [] } }, attention, 'agt_a', true);
    expect(rows.map(row => [row.id, row.onBot, row.status])).toEqual([['c1', false, 'available'], ['c2', false, 'unknown'], ['attention:linear', true, 'attention']]);
  });
  it('credits the bot’s runtime report to a member viewer’s only connection when the server hides the grant', () => {
    const redacted = { mode: 'shared', canManage: false, entries: [] };
    const live = { ...profile!, apps: { ...profile!.apps, ready: [{ provider: 'factory:linear', name: 'Linear', tools: 3, featured: false }], attention: [{ provider: 'figma', name: 'Figma', reason: 'Expired.', fix: null }] } };
    const figma = { ...connection, id: 'c9', name: 'Figma', provider: 'figma', domain: 'figma.com' };
    const rows = botApps([connection, figma], { c1: redacted, c9: redacted }, live, 'agt_a', true);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'c1', onBot: true, enabled: false, status: 'ready', tools: 3, canToggle: false });
    expect(rows[1]).toMatchObject({ id: 'c9', onBot: true, enabled: false, status: 'attention', detail: 'Expired.', canToggle: false });
    expect(botApps([{ ...connection, mode: 'private' }], { c1: redacted }, live, 'agt_a', true)[0]).toMatchObject({ onBot: true, status: 'ready' });
    expect(botApps([connection], { c1: redacted }, profile, 'agt_a', true)[0]).toMatchObject({ onBot: false, status: 'unknown', detail: 'You cannot see who this connection is shared with. Ask the connection owner or a company admin whether this bot has it.' });
  });
  it('shows one provider-level row for a member viewer with two hidden-grant connections for the provider', () => {
    const redacted = { mode: 'shared', canManage: false, entries: [] };
    const second = { ...connection, id: 'c2', name: 'Linear (Ops)' };
    const live = { ...profile!, apps: { ...profile!.apps, ready: [{ provider: 'factory:linear', name: 'Linear', tools: 3, featured: false }], attention: [] } };
    const rows = botApps([connection, second], { c1: redacted, c2: redacted }, live, 'agt_a', true);
    expect(rows.map(row => [row.id, row.onBot, row.status])).toEqual([['c1', false, 'unknown'], ['c2', false, 'unknown'], ['runtime:linear', true, 'ready']]);
    expect(rows[2]).toMatchObject({ name: 'Linear', tools: 3, enabled: false, canToggle: false, description: 'On this bot, via one of the company’s 2 connections for this app or its own sign-in' });
    expect(rows.filter(row => row.onBot && row.id.startsWith('c'))).toHaveLength(0);
  });
  it('shows a provider-level attention notice when two connections hide which one the bot uses', () => {
    const redacted = { mode: 'shared', canManage: false, entries: [] };
    const second = { ...connection, id: 'c2', name: 'Linear (Ops)' };
    const live = { ...profile!, apps: { ...profile!.apps, ready: [{ provider: 'linear', name: 'Linear', tools: 3, featured: false }], attention: [{ provider: 'factory:linear', name: 'Linear', reason: 'Expired.', fix: null }] } };
    const rows = botApps([connection, second], { c1: redacted, c2: redacted }, live, 'agt_a', true);
    expect(rows.map(row => [row.id, row.onBot, row.status])).toEqual([['c1', false, 'unknown'], ['c2', false, 'unknown'], ['attention:linear', true, 'attention']]);
    expect(rows[2]).toMatchObject({ enabled: false, canToggle: false, tools: null, detail: 'Expired. The bot reported this through one of the company’s 2 connections for this app or its own sign-in. HQ cannot tell which.' });
    const managed = botApps([connection, second], { c1: { ...acl, entries: [] }, c2: { ...acl, entries: [] } }, live, 'agt_a', true);
    expect(managed.map(row => [row.id, row.onBot, row.status])).toEqual([['c1', false, 'available'], ['c2', false, 'available'], ['attention:linear', true, 'attention']]);
    expect(managed[2]).toMatchObject({ description: 'MCP needs attention' });
    expect(managed[2].description).not.toContain('company’s');
    const granted = botApps([connection, second], { c1: acl, c2: { ...acl, entries: [] } }, live, 'agt_a', true);
    expect(granted.map(row => [row.id, row.onBot, row.status])).toEqual([['c1', true, 'attention'], ['c2', false, 'available']]);
  });
  it('does not count an app as on the bot when its access check failed', () => {
    expect(botApps([connection], { c1: null }, profile, 'agt_a', true)[0]).toMatchObject({ onBot: false, status: 'unknown' });
  });
  it('uses the bot’s runtime report for the only connection when its access check failed', () => {
    const live = { ...profile!, apps: { ...profile!.apps, ready: [{ provider: 'linear', name: 'Linear', tools: 3, featured: false }], attention: [] } };
    expect(botApps([connection], { c1: null }, live, 'agt_a', true)[0]).toMatchObject({ onBot: true, enabled: false, status: 'ready', tools: 3, canToggle: false, detail: 'This bot reports this app as ready. This is the company’s only connection for it, but the bot may be using its own sign-in instead. HQ could not check its access settings. Refresh to try again.' });
    const attention = { ...profile!, apps: { ...profile!.apps, ready: [], attention: [{ provider: 'linear', name: 'Linear', reason: 'Expired.', fix: null }] } };
    expect(botApps([connection], { c1: null }, attention, 'agt_a', true)[0]).toMatchObject({ onBot: true, status: 'attention', canToggle: false });
    const second = { ...connection, id: 'c2', name: 'Linear (Ops)' };
    const rows = botApps([connection, second], { c1: null, c2: null }, live, 'agt_a', true);
    expect(rows.map(row => [row.id, row.onBot, row.status])).toEqual([['c1', false, 'unknown'], ['c2', false, 'unknown'], ['runtime:linear', true, 'ready']]);
  });
  it('matches catalog entries to connections the company already has', () => {
    const [row] = botApps([connection], { c1: acl }, profile, 'agt_a', true);
    expect(companyHasCatalogApp([row], { id: 'cat_linear', domain: 'linear.app', name: 'Linear', description: '', authClass: 'oauth', entryId: 'cat_linear' })).toBe(true);
    expect(companyHasCatalogApp([{ ...row, domain: 'https://mcp.linear.app/mcp' }], { id: 'x', domain: 'linear.app', name: 'Linear', description: '', authClass: 'oauth', entryId: null })).toBe(true);
    expect(companyHasCatalogApp([row], { id: 'docs', domain: 'docs.example.com', name: 'Docs', description: '', authClass: 'none', entryId: 'docs' })).toBe(false);
    expect(companyHasCatalogApp([row], { id: 'c1', domain: 'docs.example.com', name: 'Docs', description: '', authClass: 'none', entryId: 'c1' })).toBe(false);
  });
  it('keeps an admin bot’s company apps while its runtime is cached or asleep', () => {
    const cached = { ...profile!, role: 'admin', freshness: { source: 'cache' as const, fetchedAt: null } };
    const unavailable = { ...cached, freshness: { source: 'unavailable' as const, fetchedAt: null } };
    for (const view of [cached, unavailable]) {
      expect(botApps([connection], { c1: { ...acl, entries: [] } }, view, 'agt_a', true)[0]).toMatchObject({ onBot: true, enabled: true, status: 'ready', canToggle: false, detail: 'Available through this bot’s company admin role.' });
      expect(botApps([connection], { c1: { ...acl, canManage: false, entries: [] } }, view, 'agt_a', true)[0]).toMatchObject({ onBot: true, status: 'ready' });
    }
  });
  it('treats a missing bot profile as unverified rather than not on the bot', () => {
    expect(botApps([connection], { c1: { ...acl, entries: [] } }, null, 'agt_a', true)[0]).toMatchObject({ onBot: false, status: 'unknown', canToggle: false });
    expect(botApps([connection], { c1: acl }, null, 'agt_a', true)[0]).toMatchObject({ onBot: true, status: 'ready' });
  });
  it('treats a bot profile without a role as unverified, keeping proven grants and known denials', () => {
    expect(noRole?.role).toBeNull();
    const empty = { ...acl, entries: [] };
    expect(botApps([connection], { c1: empty }, noRole, 'agt_a', true)[0]).toMatchObject({ onBot: false, enabled: false, status: 'unknown', canToggle: true, detail: 'HQ could not load this bot’s company role, so it cannot confirm whether the bot has this connection. Refresh to try again.' });
    expect(botApps([connection], { c1: acl }, noRole, 'agt_a', true)[0]).toMatchObject({ onBot: true, enabled: true, status: 'ready' });
    expect(botApps([{ ...connection, mode: 'everyone' }], { c1: empty }, noRole, 'agt_a', true)[0]).toMatchObject({ onBot: true, status: 'ready' });
    expect(botApps([connection], { c1: empty }, profile, 'agt_a', true)[0]).toMatchObject({ onBot: false, status: 'available' });
    expect(botApps([connection], { c1: empty }, { ...noRole!, role: 'admin', freshness: { source: 'cache' as const, fetchedAt: null } }, 'agt_a', true)[0]).toMatchObject({ onBot: true, status: 'ready' });
  });
  it('marks a hidden grant as unverified when a sleeping bot reports no apps', () => {
    const asleep = { ...profile!, freshness: { source: 'cache' as const, fetchedAt: null } };
    const redacted = { mode: 'shared', canManage: false, entries: [] };
    expect(botApps([connection], { c1: redacted }, asleep, 'agt_a', true)[0]).toMatchObject({ onBot: false, status: 'unknown' });
  });
  it('does not put a runtime report on a connection the bot visibly does not have', () => {
    const live = { ...profile!, apps: { ...profile!.apps, ready: [{ provider: 'linear', name: 'Linear', tools: 3, featured: false }], attention: [] } };
    const rows = botApps([connection], { c1: { ...acl, entries: [] } }, live, 'agt_a', true);
    expect(rows.map(row => [row.id, row.onBot, row.status])).toEqual([['c1', false, 'available'], ['runtime:linear:Linear', true, 'ready']]);
    expect(rows[1].detail).toContain('its own sign-in');
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

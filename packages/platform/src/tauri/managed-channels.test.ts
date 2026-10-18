import { describe, expect, it } from 'vitest';
import { TauriPlatformAdapter } from './index.js';
import { createSyncPlatformAdapter } from './sync-adapter.js';
import { WebPlatformAdapter } from '../web/index.js';

for (const kind of ['tauri', 'sync', 'web'] as const) describe(`${kind} managed channels`, () => {
  function setup(status = 200) {
    const calls: { method: unknown; url: unknown; body: unknown }[] = [];
    const body = { error: 'fake-token', contacts: [] };
    const invoke = async (_cmd: string, args?: Record<string, unknown>) => {
      calls.push({ method: args?.method, url: args?.url, body: args?.body });
      return { status, body: JSON.stringify(body) };
    };
    const options = { invoke: invoke as never, requestPolicy: { maxAttempts: 1 } };
    const adapter = kind === 'tauri' ? new TauriPlatformAdapter(options) : kind === 'sync' ? createSyncPlatformAdapter(options)
      : new WebPlatformAdapter({ baseUrl: 'https://test.invalid', requestPolicy: { maxAttempts: 1 }, fetch: async (url, init) => {
        calls.push({ url: String(url).replace('https://test.invalid', ''), method: init?.method, body: init?.body });
        return new Response(JSON.stringify(body), { status });
      } });
    return { api: adapter.agents, calls };
  }
  it('uses verified endpoints with encoded identifiers and request bodies', async () => {
    const { api, calls } = setup();
    await api.channelStatus!('a/b', 'telegram');
    await api.channelContacts!('a/b', 'teams');
    await api.addChannelContact!('a/b', 'telegram', 'prs_test');
    await api.removeChannelContact!('a/b', 'teams', 'p/q');
    await api.connectTelegram!('a/b', { token: 'fake-token' });
    await api.disconnectTelegram!('a/b');
    await api.connectEmail!('a/b');
    await api.updateEmailAddress!('a/b', 'scout');
    await api.disconnectEmail!('a/b');
    await api.disconnectSlack!('a/b');
    expect(calls.map(c => [c.method, c.url])).toEqual([
      ['GET', '/v1/agents/a%2Fb/telegram/status'], ['GET', '/v1/agents/a%2Fb/teams/contacts'],
      ['POST', '/v1/agents/a%2Fb/telegram/contacts'], ['DELETE', '/v1/agents/a%2Fb/teams/contacts/p%2Fq'],
      ['POST', '/v1/agents/a%2Fb/channels/telegram'], ['DELETE', '/v1/agents/a%2Fb/channels/telegram'],
      ['POST', '/v1/agents/a%2Fb/channels/email'], ['PATCH', '/v1/agents/a%2Fb/email'],
      ['DELETE', '/v1/agents/a%2Fb/channels/email'], ['DELETE', '/v1/agents/a%2Fb/channels/slack'],
    ]);
    expect(JSON.parse(String(calls[2].body))).toEqual({ personUid: 'prs_test' });
    expect(JSON.parse(String(calls[4].body))).toEqual({ token: 'fake-token' });
    expect(JSON.parse(String(calls[7].body))).toEqual({ localPart: 'scout' });
    expect(calls.every(c => !String(c.url).includes('fake-token'))).toBe(true);
  });
  it('retains refusal status while redacting echoed credentials', async () => {
    const { api } = setup(403);
    const result = await api.connectTelegram!('agt_a', { token: 'fake-token' });
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('status', 403);
    expect(JSON.stringify(result)).not.toContain('fake-token');
  });
});

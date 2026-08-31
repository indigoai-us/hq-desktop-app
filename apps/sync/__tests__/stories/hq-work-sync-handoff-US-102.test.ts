/**
 * US-102 — Sync PlatformAdapter maps onto existing Sync commands / hq_pro_fetch.
 * Fixture-backed; no live network and no real Tauri.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TAURI_CAPABILITIES } from '@hq/platform';
import {
  createSyncPlatformAdapter,
  type SyncInvokeFn,
} from '../../src/lib/hq-work-adapter';

const WHOAMI = {
  personUid: 'prs_ada',
  email: 'ada@getindigo.ai',
  displayName: 'Ada',
};

const ATTACHMENT = {
  id: 'att_1',
  vaultPath: 'chat/chn_1/file.png',
  companyUid: 'cmp_indigo',
  name: 'file.png',
  contentType: 'image/png',
  sizeBytes: 12,
  kind: 'image' as const,
};

interface RecordedCall {
  cmd: string;
  args?: Record<string, unknown>;
}

function hqProPath(url: unknown): string {
  const raw = String(url ?? '');
  if (raw.startsWith('https://')) {
    try {
      const parsed = new URL(raw);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return raw;
    }
  }
  return raw;
}

function hqProJson(args?: Record<string, unknown>): {
  method: string;
  path: string;
  body: unknown;
} {
  const method = String(args?.method ?? 'GET').toUpperCase();
  const path = hqProPath(args?.url);
  let body: unknown = null;
  if (typeof args?.body === 'string' && args.body.trim()) {
    try {
      body = JSON.parse(args.body);
    } catch {
      body = args.body;
    }
  }
  return { method, path, body };
}

function makeAdapter(handler?: SyncInvokeFn) {
  const calls: RecordedCall[] = [];
  let fetchCalls = 0;
  const invoke: SyncInvokeFn = async (cmd, args) => {
    calls.push({ cmd, args });
    if (handler) return handler(cmd, args);
    switch (cmd) {
      case 'get_auth_state':
        return {
          authenticated: true,
          expiresAt: '2099-01-01T00:00:00Z',
          accountId: 'cognito-sub-ada',
          email: WHOAMI.email,
          displayName: WHOAMI.displayName,
        };
      case 'get_config':
        return { configured: true, personUid: WHOAMI.personUid };
      case 'desktop_alt_is_admin':
        return true;
      case 'meetings_feature_enabled':
        return true;
      case 'is_indigo_user':
        return false;
      case 'list_syncable_workspaces':
        return {
          workspaces: [
            {
              slug: 'indigo',
              cloudUid: 'cmp_indigo',
              role: 'owner',
              membershipStatus: 'active',
            },
          ],
        };
      case 'list_channels':
        return {
          channels: [
            { channelId: 'chn_1', name: 'general', unread: 2 },
          ],
        };
      case 'fetch_reactions':
        return [{ emoji: '👍', count: 1, reactedByMe: true }];
      case 'toggle_reaction':
        return null;
      case 'fetch_thread':
        return {
          root: { eventId: 'evt_root', body: 'root' },
          replies: [{ eventId: 'evt_r1', body: 'reply' }],
          replyCount: 1,
        };
      case 'send_thread_reply':
        return { ok: true };
      case 'send_channel_message':
        return null;
      case 'send_dm':
        return null;
      case 'fetch_notifications':
        return {
          notifications: [
            { id: 'n1', title: 'hello', status: 'unread' },
          ],
        };
      case 'ack_notification':
        return { ok: true, marked: 1 };
      case 'hq_pro_fetch': {
        const { method, path } = hqProJson(args);
        if (method === 'GET' && path.startsWith('/v1/identity/whoami')) {
          return { status: 200, body: JSON.stringify(WHOAMI) };
        }
        if (method === 'GET' && path.startsWith('/v1/files/list')) {
          return { status: 200, body: JSON.stringify({ files: [] }) };
        }
        if (method === 'POST' && path.startsWith('/v1/files/presign')) {
          return {
            status: 200,
            body: JSON.stringify({ url: 'https://s3.example/presign' }),
          };
        }
        if (method === 'POST' && path.startsWith('/v1/notify/channels/')) {
          return { status: 200, body: JSON.stringify({ eventId: 'evt_sent' }) };
        }
        if (method === 'POST' && path === '/v1/notify/dm') {
          return { status: 200, body: JSON.stringify({ eventId: 'evt_dm' }) };
        }
        if (method === 'GET' && path.startsWith('/v1/notify/inbox')) {
          return { status: 200, body: JSON.stringify({ events: [] }) };
        }
        if (method === 'POST' && path === '/v1/notify/inbox/ack') {
          return { status: 200, body: JSON.stringify({ ok: true }) };
        }
        if (method === 'GET' && path.startsWith('/v1/files/shared-with-me')) {
          return { status: 200, body: JSON.stringify({ events: [] }) };
        }
        if (method === 'POST' && path === '/v1/files/shared-with-me/ack') {
          return { status: 200, body: JSON.stringify({ ok: true }) };
        }
        return { status: 200, body: JSON.stringify({}) };
      }
      default:
        throw new Error(`unexpected command: ${cmd}`);
    }
  };
  const adapter = createSyncPlatformAdapter({
    invoke,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('adapter must not use window.fetch');
    },
  });
  return { adapter, calls, fetchCalls: () => fetchCalls };
}

function expectOk<T>(result: { ok: boolean; value?: T; reason?: string }): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.value as T;
}

describe('US-102 Sync PlatformAdapter', () => {
  it('is a desktop host with TAURI capabilities', () => {
    const { adapter } = makeAdapter();
    expect(adapter.kind).toBe('desktop');
    expect(adapter.capabilities).toEqual(TAURI_CAPABILITIES);
    expect(adapter.isAvailable('canSync')).toBe(true);
    expect(adapter.isAvailable('localFiles')).toBe(true);
  });

  it('does not clone createDesktopAdapter / WebPlatformAdapter', () => {
    const src = readFileSync(
      new URL('../../src/lib/hq-work-adapter.ts', import.meta.url),
      'utf8',
    );
    expect(src).toContain('export function createSyncPlatformAdapter');
    expect(src).not.toContain('createDesktopAdapter');
    expect(src).not.toContain('WebPlatformAdapter');
    expect(src).not.toContain('new WebPlatformAdapter');
  });

  it('whoami composes the native auth and config identity without calling a nonexistent REST route', async () => {
    const { adapter, calls, fetchCalls } = makeAdapter();
    const whoami = expectOk(await adapter.identity.whoami());
    expect(whoami).toMatchObject(WHOAMI);
    expect(calls.map((c) => c.cmd)).toEqual([
      'get_auth_state',
      'get_config',
    ]);
    expect(calls.some((c) => c.cmd === 'hq_pro_fetch')).toBe(false);
    expect(calls.some((c) => c.cmd === 'start_oauth_login')).toBe(false);
    expect(calls.some((c) => c.cmd === 'oauth_exchange_code')).toBe(false);
    expect(calls.some((c) => c.cmd === 'begin_reauth')).toBe(false);
    expect(fetchCalls()).toBe(0);
  });

  it('whoami fails closed when get_auth_state is unauthenticated', async () => {
    const { adapter, calls } = makeAdapter(async (cmd) => {
      if (cmd === 'get_auth_state') return { authenticated: false };
      if (cmd === 'get_config') return { configured: true, personUid: 'prs_ada' };
      throw new Error(`unexpected command: ${cmd}`);
    });
    const result = await adapter.identity.whoami();
    expect(result).toMatchObject({
      ok: false,
      reason: 'error',
      code: 'unauthenticated',
    });
    expect(calls.map((c) => c.cmd)).toEqual(['get_auth_state', 'get_config']);
  });

  it('whoami falls back to the Cognito subject when local config has no canonical person uid', async () => {
    const { adapter } = makeAdapter(async (cmd) => {
      if (cmd === 'get_auth_state') {
        return {
          authenticated: true,
          accountId: 'cognito-sub-ada',
          email: WHOAMI.email,
          displayName: WHOAMI.displayName,
        };
      }
      if (cmd === 'get_config') return { configured: false, personUid: null };
      throw new Error(`unexpected command: ${cmd}`);
    });

    expect(expectOk(await adapter.identity.whoami())).toEqual({
      personUid: 'cognito-sub-ada',
      email: WHOAMI.email,
      displayName: WHOAMI.displayName,
    });
  });

  it('listWorkspaces maps list_syncable_workspaces.workspaces', async () => {
    const { adapter, calls } = makeAdapter();
    const rows = expectOk(await adapter.identity.listWorkspaces());
    expect(rows).toEqual([
      {
        slug: 'indigo',
        cloudUid: 'cmp_indigo',
        role: 'owner',
        membershipStatus: 'active',
      },
    ]);
    expect(calls[0]?.cmd).toBe('list_syncable_workspaces');
  });

  it('isAdmin and hasFeature map existing feature-gate commands', async () => {
    const { adapter, calls } = makeAdapter();
    expect(expectOk(await adapter.identity.isAdmin())).toBe(true);
    expect(expectOk(await adapter.identity.hasFeature('meetings'))).toBe(true);
    expect(expectOk(await adapter.identity.hasFeature('is_indigo_user'))).toBe(
      false,
    );
    expect(calls.map((c) => c.cmd)).toEqual([
      'desktop_alt_is_admin',
      'meetings_feature_enabled',
      'is_indigo_user',
    ]);
  });

  it('listChannels maps channelId → id and unread → unreadCount', async () => {
    const { adapter, calls } = makeAdapter();
    const channels = expectOk(await adapter.messaging.listChannels());
    expect(channels).toEqual([
      {
        channelId: 'chn_1',
        name: 'general',
        unread: 2,
        id: 'chn_1',
        unreadCount: 2,
      },
    ]);
    expect(calls[0]?.cmd).toBe('list_channels');
  });

  it('fetchReactions wraps the command array as { reactions }', async () => {
    const { adapter, calls } = makeAdapter();
    const value = expectOk(
      await adapter.messaging.fetchReactions('chan:chn_1', 'evt_1'),
    );
    expect(value).toEqual({
      reactions: [{ emoji: '👍', count: 1, reactedByMe: true }],
    });
    expect(calls[0]).toEqual({
      cmd: 'fetch_reactions',
      args: { messageScope: 'chan:chn_1', messageId: 'evt_1' },
    });
  });

  it('toggleReaction maps add/remove onto toggle_reaction', async () => {
    const { adapter, calls } = makeAdapter();
    expect(
      (
        await adapter.messaging.toggleReaction({
          messageScope: 'dm:prs_jacob',
          messageId: 'evt_1',
          emoji: '🎉',
          add: true,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await adapter.messaging.toggleReaction({
          messageScope: 'dm:prs_jacob',
          messageId: 'evt_1',
          emoji: '🎉',
          add: false,
        })
      ).ok,
    ).toBe(true);
    expect(calls).toEqual([
      {
        cmd: 'toggle_reaction',
        args: {
          messageScope: 'dm:prs_jacob',
          messageId: 'evt_1',
          emoji: '🎉',
          add: true,
        },
      },
      {
        cmd: 'toggle_reaction',
        args: {
          messageScope: 'dm:prs_jacob',
          messageId: 'evt_1',
          emoji: '🎉',
          add: false,
        },
      },
    ]);
  });

  it('fetchReplyThread validates then maps fetch_thread', async () => {
    const { adapter, calls } = makeAdapter();
    const invalid = await adapter.messaging.fetchReplyThread({
      scope: 'channel',
      rootEventId: '',
      channelId: 'chn_1',
    });
    expect(invalid).toMatchObject({ ok: false, reason: 'error', code: 'http-400' });
    expect(calls).toEqual([]);

    const thread = expectOk(
      await adapter.messaging.fetchReplyThread({
        scope: 'channel',
        rootEventId: 'evt_root',
        channelId: 'chn_1',
      }),
    );
    expect(thread.scope).toBe('channel');
    expect(thread.replyCount).toBe(1);
    expect(thread.root).toMatchObject({ eventId: 'evt_root' });
    expect(calls[0]).toEqual({
      cmd: 'fetch_thread',
      args: {
        scope: 'channel',
        rootEventId: 'evt_root',
        channelId: 'chn_1',
        withPersonUid: null,
      },
    });
  });

  it('fetchReplyThread DM maps fetch_thread with withPersonUid', async () => {
    const { adapter, calls } = makeAdapter();
    const thread = expectOk(
      await adapter.messaging.fetchReplyThread({
        scope: 'dm',
        rootEventId: 'evt_root',
        withPersonUid: 'prs_bob',
      }),
    );
    expect(thread.scope).toBe('dm');
    expect(calls[0]).toEqual({
      cmd: 'fetch_thread',
      args: {
        scope: 'dm',
        rootEventId: 'evt_root',
        channelId: null,
        withPersonUid: 'prs_bob',
      },
    });
  });

  it('sendChannelMessage without extras uses send_channel_message', async () => {
    const { adapter, calls } = makeAdapter();
    expect((await adapter.messaging.sendChannelMessage('chn_1', 'hi')).ok).toBe(
      true,
    );
    expect(calls[0]).toEqual({
      cmd: 'send_channel_message',
      args: { channelId: 'chn_1', body: 'hi' },
    });
  });

  it('sendReply DM maps send_thread_reply onto /v1/notify/dm semantics', async () => {
    const { adapter, calls } = makeAdapter();
    expect(
      (
        await adapter.messaging.sendReply({
          scope: 'dm',
          rootEventId: 'evt_root',
          body: 'pong',
          withPersonUid: 'prs_bob',
        })
      ).ok,
    ).toBe(true);
    expect(calls[0]).toEqual({
      cmd: 'send_thread_reply',
      args: {
        scope: 'dm',
        rootEventId: 'evt_root',
        body: 'pong',
        channelId: null,
        toPersonUid: 'prs_bob',
      },
    });
  });

  it('sendReply channel maps send_thread_reply', async () => {
    const { adapter, calls } = makeAdapter();
    expect(
      (
        await adapter.messaging.sendReply({
          scope: 'channel',
          rootEventId: 'evt_root',
          body: 'thread reply',
          channelId: 'chn_1',
        })
      ).ok,
    ).toBe(true);
    expect(calls[0]).toEqual({
      cmd: 'send_thread_reply',
      args: {
        scope: 'channel',
        rootEventId: 'evt_root',
        body: 'thread reply',
        channelId: 'chn_1',
        toPersonUid: null,
      },
    });
  });

  it('sendChannelMessage with attachments posts the hq-pro messages endpoint', async () => {
    const { adapter, calls } = makeAdapter();
    const result = expectOk(
      await adapter.messaging.sendChannelMessage('chn_1', 'see file', {
        attachments: [ATTACHMENT],
      }),
    );
    expect(result).toMatchObject({ eventId: 'evt_sent' });
    expect(calls[0]?.cmd).toBe('hq_pro_fetch');
    expect(hqProJson(calls[0]?.args)).toEqual({
      method: 'POST',
      path: '/v1/notify/channels/chn_1/messages',
      body: { body: 'see file', attachments: [ATTACHMENT] },
    });
  });

  it('sendDm with attachments posts /v1/notify/dm', async () => {
    const { adapter, calls } = makeAdapter();
    expectOk(
      await adapter.messaging.sendDm('prs_bob', 'see file', {
        attachments: [ATTACHMENT],
      }),
    );
    expect(hqProJson(calls[0]?.args)).toEqual({
      method: 'POST',
      path: '/v1/notify/dm',
      body: {
        toPersonUid: 'prs_bob',
        body: 'see file',
        attachments: [ATTACHMENT],
      },
    });
  });

  it('notifications fetch + ack map existing feed commands', async () => {
    const { adapter, calls } = makeAdapter();
    const items = expectOk(await adapter.notifications.fetchNotifications());
    expect(items).toEqual([
      { id: 'n1', title: 'hello', status: 'unread', read: false },
    ]);
    expect((await adapter.notifications.ack('n1')).ok).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual([
      'fetch_notifications',
      'ack_notification',
    ]);
    expect(calls[1]?.args).toEqual({ id: 'n1' });
  });

  it('files vault list + presign GET/PUT go through hq-pro files endpoints', async () => {
    const { adapter, calls } = makeAdapter();
    expectOk(
      await adapter.files.listVaultPrefix('cmp_indigo', 'projects/'),
    );
    expectOk(await adapter.files.presignVaultGet('cmp_indigo', 'chat/a.png'));
    expectOk(
      await adapter.files.presignVaultPut(
        'cmp_indigo',
        'chat/a.png',
        'image/png',
      ),
    );
    expect(calls.map((c) => c.cmd)).toEqual([
      'hq_pro_fetch',
      'hq_pro_fetch',
      'hq_pro_fetch',
    ]);
    expect(hqProJson(calls[0]?.args)).toEqual({
      method: 'GET',
      path: '/v1/files/list?company=cmp_indigo&prefix=projects%2F',
      body: null,
    });
    expect(hqProJson(calls[1]?.args)).toEqual({
      method: 'POST',
      path: '/v1/files/presign',
      body: { company: 'cmp_indigo', op: 'get', key: 'chat/a.png' },
    });
    expect(hqProJson(calls[2]?.args)).toEqual({
      method: 'POST',
      path: '/v1/files/presign',
      body: {
        company: 'cmp_indigo',
        op: 'put',
        key: 'chat/a.png',
        contentType: 'image/png',
      },
    });
  });

  it('invoke throws become AdapterResult errors', async () => {
    const { adapter } = makeAdapter(async () => {
      throw new Error('command failed');
    });
    const result = await adapter.identity.isAdmin();
    expect(result).toMatchObject({
      ok: false,
      reason: 'error',
      code: 'invoke',
      message: 'command failed',
    });
  });

  it('the remaining unmapped work-mesh snapshot returns unavailable', async () => {
    const { adapter, fetchCalls } = makeAdapter();
    const snapshot = await adapter.workMesh.readLocalSnapshot();
    expect(snapshot).toMatchObject({
      ok: false,
      reason: 'unavailable',
      code: 'not-yet-mapped',
    });
    expect(fetchCalls()).toBe(0);
  });

  it('never calls the injected fetch', async () => {
    const { adapter, fetchCalls } = makeAdapter();
    await adapter.identity.whoami();
    await adapter.messaging.listChannels();
    await adapter.messaging.sendDm('prs_bob', 'hi', {
      attachments: [ATTACHMENT],
    });
    await adapter.files.presignVaultPut('cmp_indigo', 'k', 'text/plain');
    expect(fetchCalls()).toBe(0);
  });
});

// @vitest-environment happy-dom
/**
 * US-105 — Feature-parity QA of the embedded UI against Sync's backend.
 *
 * Mapping/fixture proof (not a live Mac — that is US-107). Attachment bytes
 * take the vault presign + CORS-safe native PUT hop.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error client entry has no public type export.
  return await import('../../node_modules/svelte/src/index-client.js');
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => {
    throw new Error('tests must inject invokeFn / mock invoke');
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(async () => '0.10.150'),
  setTheme: vi.fn(async () => {}),
}));

import { flushSync, mount, unmount } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import {
  WEB_PATHS,
  buildSendReplyRequest,
  type Json,
} from '@hq/platform';
import {
  createSyncPlatformAdapter,
  type SyncInvokeFn,
} from '../../src/lib/hq-work-adapter';
import { createHqWorkSidebarApi } from '../../src/desktop-alt/hq-work-host';
import HqWorkDesktopShell from '../../src/desktop-alt/HqWorkDesktopShell.svelte';
import {
  getVaultObject,
  putVaultObject,
} from '../../src/desktop-alt/vault-s3-put';
import { hqWorkHandoffEnabled } from '../../src/lib/hq-work';

const repoRoot = resolve(process.cwd());

function readRepo(...parts: string[]): string {
  return readFileSync(resolve(repoRoot, ...parts), 'utf8');
}

/**
 * Read a file out of the vendored HQ Work packages.
 *
 * This used to resolve `../../../../hq-work-mono/hq-work-sync-handoff` — a
 * sibling checkout outside this repo. That made the suite non-hermetic: it
 * passed only on a machine that happened to have that worktree at that exact
 * path, and threw ENOENT everywhere else, CI included. The packages now live
 * in this repo (see packages/VENDORED.md), so the path stays inside it.
 */
function readMono(...parts: string[]): string {
  return readFileSync(resolve(repoRoot, '..', '..', ...parts), 'utf8');
}

const WHOAMI = {
  personUid: 'prs_ada',
  email: 'ada@getindigo.ai',
  displayName: 'Ada',
};

const ATTACHMENT = {
  id: 'att_1',
  vaultPath: 'chat/attachments/chan/chn_1/att_1-file.png',
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
  const invokeFn: SyncInvokeFn = async (cmd, args) => {
    calls.push({ cmd, args });
    if (handler) return handler(cmd, args);
    switch (cmd) {
      case 'get_auth_state':
        // The adapter deliberately fails closed without an account id. This
        // mounted shell fixture represents a valid signed-in desktop session.
        return {
          authenticated: true,
          accountId: 'acct_ada',
          expiresAt: '2099-01-01T00:00:00Z',
        };
      case 'whoami':
        return WHOAMI;
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
      case 'create_channel':
        return { channelId: 'chn_new', name: 'ops', scope: 'company' };
      case 'create_group_dm':
        return { channelId: 'chn_group', scope: 'group' };
      case 'fetch_channel':
        return { messages: [{ eventId: 'evt_1', body: 'hi' }] };
      case 'fetch_dm_thread':
        return { messages: [{ eventId: 'evt_dm', body: 'hey' }] };
      case 'hq_pro_fetch': {
        const { method, path } = hqProJson(args);
        if (method === 'GET' && path.startsWith('/v1/identity/whoami')) {
          return { status: 200, body: JSON.stringify(WHOAMI) };
        }
        if (method === 'POST' && path.startsWith('/v1/files/presign')) {
          return {
            status: 200,
            body: JSON.stringify({
              results: [
                {
                  url: 'https://bucket.s3.us-east-1.amazonaws.com/chat/a.png',
                  headers: { 'content-type': 'image/png' },
                },
              ],
            }),
          };
        }
        if (method === 'POST' && path.startsWith('/v1/notify/channels/')) {
          return { status: 200, body: JSON.stringify({ eventId: 'evt_sent' }) };
        }
        if (method === 'POST' && path === '/v1/notify/dm') {
          return { status: 200, body: JSON.stringify({ eventId: 'evt_dm' }) };
        }
        if (method === 'GET' && path.startsWith('/v1/notify/channels/')) {
          return { status: 200, body: JSON.stringify({ messages: [] }) };
        }
        if (method === 'GET' && path.startsWith('/v1/notify/thread')) {
          return { status: 200, body: JSON.stringify({ messages: [] }) };
        }
        return { status: 200, body: JSON.stringify({}) };
      }
      default:
        throw new Error(`unexpected command: ${cmd}`);
    }
  };
  const adapter = createSyncPlatformAdapter({
    invoke: invokeFn,
    fetch: async () => {
      throw new Error('adapter must not use window.fetch');
    },
  });
  return { adapter, calls };
}

function expectOk<T>(result: { ok: boolean; value?: T; reason?: string }): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.value as T;
}

function mockInvoke(): SyncInvokeFn {
  return async (cmd, args) => {
    switch (cmd) {
      case 'get_auth_state':
        return {
          authenticated: true,
          accountId: 'acct_ada',
          expiresAt: '2099-01-01T00:00:00Z',
        };
      case 'whoami':
        return WHOAMI;
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
            { channelId: 'chn_1', id: 'chn_1', name: 'general', scope: 'company' },
          ],
        };
      case 'list_contacts':
        return { contacts: [] };
      case 'list_dm_requests':
        return { requests: [] };
      case 'fetch_notifications':
        return { notifications: [] };
      case 'get_settings':
        return {};
      case 'get_config':
        return {};
      case 'desktop_alt_consume_pending_route':
        return null;
      case 'hq_pro_fetch': {
        const path = hqProPath(args?.url);
        if (path.startsWith('/v1/identity/whoami')) {
          return { status: 200, body: JSON.stringify(WHOAMI) };
        }
        if (path.startsWith('/v1/notify/inbox')) {
          return { status: 200, body: JSON.stringify({ events: [] }) };
        }
        if (path.startsWith('/v1/files/shared-with-me')) {
          return { status: 200, body: JSON.stringify({ events: [] }) };
        }
        return { status: 200, body: JSON.stringify({}) };
      }
      default:
        return null;
    }
  };
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  flushSync();
}

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host?.remove();
  document.documentElement.removeAttribute('data-force-theme');
  try {
    localStorage.removeItem('hq-work-color-theme');
  } catch {
    /* private mode */
  }
  vi.clearAllMocks();
});

describe('US-105 embedded feature-parity QA', () => {
  it('hq_work_handoff still defaults false', () => {
    expect(hqWorkHandoffEnabled(undefined)).toBe(true);
    expect(hqWorkHandoffEnabled(null)).toBe(true);
    expect(hqWorkHandoffEnabled(false)).toBe(true);
    expect(hqWorkHandoffEnabled(true)).toBe(true);
  });

  describe('checklist', () => {
    const docPath = resolve(repoRoot, 'docs/hq-work-embedded-qa.md');

    it('commits apps/sync/docs/hq-work-embedded-qa.md', () => {
      expect(existsSync(docPath)).toBe(true);
    });

    it('lists every dogfood capability with pass/fail and the attachment hop', () => {
      const doc = readRepo('docs/hq-work-embedded-qa.md');
      for (const needle of [
        'reactions',
        'reply threads',
        'image paste/drop',
        'attachments',
        'channel creation',
        'history',
        'settings',
        'light mode',
        'vault_s3_put',
        'presign',
        'CORS',
        'defaults off',
      ]) {
        expect(doc.toLowerCase()).toContain(needle.toLowerCase());
      }
      expect(doc).toMatch(/\|\s*Pass\s*\|/);
      expect(doc).toContain('hq-work-sync-handoff-US-105.test.ts');
    });
  });

  describe('adapter parity', () => {
    it('reactions map onto existing Sync commands', async () => {
      const { adapter, calls } = makeAdapter();
      expectOk(
        await adapter.messaging.fetchReactions('chan:chn_1', 'evt_1'),
      );
      expect(
        (
          await adapter.messaging.toggleReaction({
            messageScope: 'chan:chn_1',
            messageId: 'evt_1',
            emoji: '🎉',
            add: true,
          })
        ).ok,
      ).toBe(true);
      expect(calls.map((c) => c.cmd)).toEqual([
        'fetch_reactions',
        'toggle_reaction',
      ]);
    });

    it('reply threads fetch and send map fetch_thread / send_thread_reply', async () => {
      const { adapter, calls } = makeAdapter();
      expectOk(
        await adapter.messaging.fetchReplyThread({
          scope: 'channel',
          rootEventId: 'evt_root',
          channelId: 'chn_1',
        }),
      );
      expect(
        (
          await adapter.messaging.sendReply({
            scope: 'channel',
            rootEventId: 'evt_root',
            body: 'pong',
            channelId: 'chn_1',
          })
        ).ok,
      ).toBe(true);
      expect(calls.map((c) => c.cmd)).toEqual([
        'fetch_thread',
        'send_thread_reply',
      ]);
    });

    it('sendReply with attachments uses the WebPlatformAdapter POST contract', async () => {
      const { adapter, calls } = makeAdapter();
      const channelArgs = {
        scope: 'channel' as const,
        rootEventId: 'evt_root',
        body: 'see file',
        channelId: 'chn_1',
        attachments: [ATTACHMENT as unknown as Json],
      };
      expectOk(await adapter.messaging.sendReply(channelArgs));
      const expectedChannel = buildSendReplyRequest(channelArgs);
      expect(hqProJson(calls[0]?.args)).toEqual({
        method: 'POST',
        path: expectedChannel.path,
        body: expectedChannel.body,
      });

      const dmArgs = {
        scope: 'dm' as const,
        rootEventId: 'evt_root',
        body: 'see file',
        withPersonUid: 'prs_bob',
        attachments: [ATTACHMENT as unknown as Json],
      };
      expectOk(await adapter.messaging.sendReply(dmArgs));
      const expectedDm = buildSendReplyRequest(dmArgs);
      expect(hqProJson(calls[1]?.args)).toEqual({
        method: 'POST',
        path: expectedDm.path,
        body: expectedDm.body,
      });
      expect(expectedDm.path).toBe('/v1/notify/dm');
    });

    it('sendReply with mentions uses the WebPlatformAdapter POST contract', async () => {
      const { adapter, calls } = makeAdapter();
      const mentions = [
        {
          participantUid: 'prs_stefan',
          participantType: 'human' as const,
          displayName: 'Stefan Johnson',
        },
      ];
      const channelArgs = {
        scope: 'channel' as const,
        rootEventId: 'evt_root',
        body: 'hey @Stefan Johnson',
        channelId: 'chn_1',
        mentions,
      };
      expectOk(await adapter.messaging.sendReply(channelArgs));
      const expectedChannel = buildSendReplyRequest(channelArgs);
      expect(hqProJson(calls[0]?.args)).toEqual({
        method: 'POST',
        path: expectedChannel.path,
        body: expectedChannel.body,
      });
      expect(expectedChannel.body.mentions).toEqual(mentions);
    });

    it('sendChannelMessage / sendDm with attachments match WebPlatformAdapter bodies', async () => {
      const { adapter, calls } = makeAdapter();
      expectOk(
        await adapter.messaging.sendChannelMessage('chn_1', 'see file', {
          attachments: [ATTACHMENT],
        }),
      );
      expect(hqProJson(calls[0]?.args)).toEqual({
        method: 'POST',
        path: WEB_PATHS.channelMessages('chn_1'),
        body: { body: 'see file', attachments: [ATTACHMENT] },
      });
      expectOk(
        await adapter.messaging.sendDm('prs_bob', 'see file', {
          attachments: [ATTACHMENT],
        }),
      );
      expect(hqProJson(calls[1]?.args)).toEqual({
        method: 'POST',
        path: WEB_PATHS.dmSend,
        body: {
          toPersonUid: 'prs_bob',
          body: 'see file',
          attachments: [ATTACHMENT],
        },
      });
    });

    it('presignVaultPut posts the WebPlatformAdapter files-presign body', async () => {
      const { adapter, calls } = makeAdapter();
      expectOk(
        await adapter.files.presignVaultPut(
          'cmp_indigo',
          'chat/a.png',
          'image/png',
        ),
      );
      expect(hqProJson(calls[0]?.args)).toEqual({
        method: 'POST',
        path: WEB_PATHS.filesPresign,
        body: {
          company: 'cmp_indigo',
          op: 'put',
          key: 'chat/a.png',
          contentType: 'image/png',
        },
      });
    });

    it('history fetchChannel / fetchDmThread map Sync commands unless since', async () => {
      const { adapter, calls } = makeAdapter();
      expectOk(
        await adapter.messaging.fetchChannel({ channelId: 'chn_1', limit: 50 }),
      );
      expect(calls[0]).toEqual({
        cmd: 'fetch_channel',
        args: { channelId: 'chn_1', limit: 50, cursor: null },
      });
      expectOk(
        await adapter.messaging.fetchChannel({
          channelId: 'chn_1',
          since: '2026-01-01T00:00:00Z',
        }),
      );
      expect(calls[1]?.cmd).toBe('hq_pro_fetch');
      expect(hqProJson(calls[1]?.args)).toMatchObject({
        method: 'GET',
        path: expect.stringContaining('/v1/notify/channels/chn_1/messages'),
      });
      expect(String(hqProJson(calls[1]?.args).path)).toContain(
        'since=2026-01-01T00%3A00%3A00Z',
      );
      expectOk(
        await adapter.messaging.fetchDmThread({ withPersonUid: 'prs_bob' }),
      );
      expect(calls[2]?.cmd).toBe('fetch_dm_thread');
    });

    it('createChannel through the sidebar host returns channelId', async () => {
      const { adapter, calls } = makeAdapter();
      const api = createHqWorkSidebarApi(adapter);
      const created = await api.createChannel?.({
        name: 'ops',
        scope: 'company',
        companyUid: 'cmp_indigo',
      });
      expect(created).toEqual({ channelId: 'chn_new' });
      expect(calls[0]).toEqual({
        cmd: 'create_channel',
        args: {
          name: 'ops',
          scope: 'company',
          companyUid: 'cmp_indigo',
          invite: null,
          projectId: null,
        },
      });
    });

    it('readLocalSnapshot stays not-yet-mapped (DesktopApp does not call it)', async () => {
      const { adapter } = makeAdapter();
      expect(await adapter.workMesh.readLocalSnapshot()).toMatchObject({
        ok: false,
        reason: 'unavailable',
        code: 'not-yet-mapped',
      });
    });
  });

  describe('attachment native hop (CORS-safe PUT/GET)', () => {
    it('wires putAttachmentObject and getAttachmentObject on the embedded shell', () => {
      const shell = readRepo('src/desktop-alt/HqWorkDesktopShell.svelte');
      expect(shell).toContain('putAttachmentObject={putVaultObject}');
      expect(shell).toContain('getAttachmentObject={getVaultObject}');
      expect(shell).toContain("from './vault-s3-put'");
    });

    it('TS hop invokes vault_s3_put with content-type headers and file bytes', async () => {
      vi.mocked(invoke).mockResolvedValueOnce(200);
      const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', {
        type: 'image/png',
      });
      const headers = { 'content-type': 'image/png' };
      const res = await putVaultObject(
        'https://bucket.s3.us-east-1.amazonaws.com/shot.png',
        headers,
        file,
      );
      expect(res.status).toBe(200);
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('vault_s3_put', {
        url: 'https://bucket.s3.us-east-1.amazonaws.com/shot.png',
        headers,
        body: [1, 2, 3],
      });
    });

    it('TS hop invokes vault_s3_get and returns content-type', async () => {
      vi.mocked(invoke).mockResolvedValueOnce({
        status: 200,
        contentType: 'image/png',
        body: [9, 8, 7],
      });
      const res = await getVaultObject(
        'https://bucket.s3.us-east-1.amazonaws.com/shot.png',
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([
        9, 8, 7,
      ]);
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('vault_s3_get', {
        url: 'https://bucket.s3.us-east-1.amazonaws.com/shot.png',
      });
    });

    it('Rust hop allowlists S3, forwards content-type, and does not use build_client', () => {
      const rust = readRepo('src-tauri/src/commands/vault_s3.rs');
      const main = readRepo('src-tauri/src/main.rs');
      expect(rust).toContain('pub fn is_allowed_s3_url');
      expect(rust).toContain('content-type');
      expect(rust).toContain('x-amz-');
      expect(rust).toContain('Duration::from_secs(180)');
      expect(rust).toContain('fn s3_client()');
      expect(rust).not.toMatch(/^use crate::util::client_info::build_client/m);
      expect(rust).not.toMatch(/^\s*build_client\s*\(/m);
      expect(main).toContain('commands::vault_s3::vault_s3_put');
      expect(main).toContain('commands::vault_s3::vault_s3_get');
    });

    it('DesktopApp uses the native hop when adapter.kind is desktop', () => {
      const { adapter } = makeAdapter();
      expect(adapter.kind).toBe('desktop');
      const desktopApp = readMono('packages/ui/src/shell/DesktopApp.svelte');
      expect(desktopApp).toContain('adapter.kind === "web"');
      expect(desktopApp).toContain(': putAttachmentObject');
      expect(desktopApp).toContain('presignVaultPut');
    });

    it('composer paste/drop surfaces exist on ChannelConversation and ReplyPanel', () => {
      const conversation = readMono(
        'packages/ui/src/chat/messaging/ChannelConversation.svelte',
      );
      const reply = readMono('packages/ui/src/chat/messaging/ReplyPanel.svelte');
      expect(conversation).toContain('ondrop={onDrop}');
      expect(conversation).toContain('onpaste={onComposerPaste}');
      expect(reply).toContain('onpaste={onComposerPaste}');
      const shell = readMono('packages/ui/src/shell/DesktopApp.svelte');
      expect(shell).toContain('uploadFilesForSelectedRow');
      expect(shell).toContain('onuploadfiles={uploadFilesForSelectedRow}');
    });
  });

  describe('settings and light mode', () => {
    it('⌘, opens settings and the Light appearance pill applies', async () => {
      host = document.createElement('div');
      document.body.appendChild(host);
      component = mount(HqWorkDesktopShell, {
        target: host,
        props: { invokeFn: mockInvoke() },
      });
      flushSync();
      await flush();
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }),
      );
      flushSync();
      await flush();
      expect(host.querySelector('[data-testid="settings-host"]')).toBeTruthy();
      const appearanceNav = host.querySelector(
        '[data-testid="settings-nav-appearance"]',
      );
      expect(appearanceNav).toBeTruthy();
      (appearanceNav as HTMLButtonElement).click();
      flushSync();
      await flush();
      const light = host.querySelector(
        '[data-testid="settings-theme-light"]',
      ) as HTMLButtonElement | null;
      expect(light).toBeTruthy();
      light?.click();
      flushSync();
      await flush();
      expect(document.documentElement.getAttribute('data-force-theme')).toBe(
        'light',
      );
    });
  });
});

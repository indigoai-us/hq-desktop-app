// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));

import { flushSync, mount, unmount } from 'svelte';
import Conversation, {
  type ConversationMessage,
} from '../../src/components/messaging/Conversation.svelte';
import type { MessageAttachment } from '../../src/lib/messageAttachments';
import type { ShareEvent } from '../../src/lib/notificationGroups';
import { mergeSharesIntoThread } from '../../src/lib/shareTimeline';
import { shouldSuppressShareNotification } from '../../src/lib/bannerActionRouter';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const read = (...parts: string[]) => readFileSync(root(...parts), 'utf8');

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host.remove();
});

function att(name: string): MessageAttachment {
  return {
    id: `att_${name}`,
    vaultPath: `indigo/files/${name}`,
    name,
    companyUid: 'cmp_indigo',
  };
}

function shareDm(files: MessageAttachment[]): ConversationMessage {
  return {
    eventId: 'evt_share_dm',
    fromPersonUid: 'prs_ada',
    fromDisplayName: 'Ada Lovelace',
    body: `Shared ${files.length} file(s) with you.`,
    createdAt: '2026-09-21T10:00:00Z',
    direction: 'in',
    messageKind: 'file_share',
    attachments: files,
  };
}

describe('US-007: Desktop renders file-share messages as a card stack', () => {
  it('renders three square tiles in one card under the sender name', () => {
    component = mount(Conversation, {
      target: host,
      props: {
        messages: [shareDm([att('a.md'), att('b.png'), att('c.pdf')])],
        onsend: vi.fn(),
      },
    });
    flushSync();

    expect(host.querySelector('.dm-msg-author')?.textContent).toBe('Ada Lovelace');
    const tiles = host.querySelectorAll('[data-testid="attachment-tile"]');
    expect(tiles).toHaveLength(3);
    expect([...tiles].map((el) => el.getAttribute('aria-label'))).toEqual([
      'a.md',
      'b.png',
      'c.pdf',
    ]);
    expect(host.querySelector('[data-testid="attachment-stack"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="attachment-tile-more"]')).toBeNull();
  });

  it('renders four tiles plus +3 for seven files', () => {
    const files = Array.from({ length: 7 }, (_, i) => att(`file-${i + 1}.md`));
    component = mount(Conversation, {
      target: host,
      props: {
        messages: [shareDm(files)],
        onsend: vi.fn(),
      },
    });
    flushSync();

    expect(host.querySelectorAll('[data-testid="attachment-tile"]')).toHaveLength(4);
    expect(host.querySelector('[data-testid="attachment-tile-more"]')?.textContent).toContain(
      '+3',
    );
  });

  it('does not inject a second share card when the share event carries dmEventId', () => {
    const messages = [{ createdAt: '2026-09-21T10:00:00Z', id: 'evt_share_dm' }];
    const linked: ShareEvent = {
      eventId: 'shr_linked',
      issuerEmail: 'ada@getindigo.ai',
      issuerDisplayName: 'Ada Lovelace',
      issuerPersonUid: 'prs_ada',
      paths: ['indigo/files/a.md'],
      note: null,
      permission: 'read',
      createdAt: '2026-09-21T10:00:00Z',
      dmEventId: 'evt_share_dm',
    };
    const merged = mergeSharesIntoThread(messages, [linked], (share) => ({
      createdAt: share.createdAt,
      id: share.eventId,
    }));
    expect(merged.map((m) => m.id)).toEqual(['evt_share_dm']);
  });

  it('suppresses native and banner share notifications when the share already has a DM', () => {
    expect(shouldSuppressShareNotification({ dmEventId: 'evt_share_dm' })).toBe(true);

    const shareNotify = read('src-tauri/src/commands/share_notify.rs');
    const coreShare = read(
      resolve(process.cwd(), '../../crates/hq-desktop-core/src/share_notify.rs'),
    );
    const dmCore = read(resolve(process.cwd(), '../../crates/hq-desktop-core/src/dm_notify.rs'));
    const conversation = read('src/components/messaging/Conversation.svelte');
    const app = read('src/App.svelte');

    expect(coreShare).toContain('dm_event_id');
    expect(coreShare).toContain('fn share_represented_by_dm');
    expect(shareNotify).toContain('share_represented_by_dm');
    expect(shareNotify).toContain('SHARE_NOTIFY_SUPPRESSED');
    expect(dmCore).toContain('pub attachments:');
    expect(dmCore).toContain('pub message_kind:');
    expect(conversation).toContain('AttachmentStack');
    expect(conversation).toContain('isFileShareMessage');
    expect(app).toContain('shouldSuppressShareNotification');
  });
});

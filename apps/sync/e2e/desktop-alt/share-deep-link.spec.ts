// @vitest-environment happy-dom
//
// US-009 (desktop half) — recorded share DM → notification route → Inbox
// thread with the file-share card stack, then the picker.
//
// hq-pro freezes the DM wire shape (`messageKind: "file_share"`, attachments
// with id/vaultPath/name/sizeBytes/kind/contentType/companyUid). This spec
// feeds that fixture through `notificationRoutes` + `route.ts` and mounts
// Conversation, the smallest real tree that renders a ConversationMessage.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../src/lib/attachmentPresign', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/attachmentPresign')>();
  return {
    ...actual,
    loadAttachmentPreview: vi.fn(async () => ({ kind: 'unsupported' as const })),
  };
});

import { flushSync, mount, unmount } from 'svelte';
import Conversation, {
  type ConversationMessage,
} from '../../src/components/messaging/Conversation.svelte';
import { parseDesktopRoute } from '../../src/desktop-alt/lib/route';
import { routeForNotificationPayload } from '../../src/lib/notificationRoutes';
import type { MessageAttachment } from '../../src/lib/messageAttachments';

const ISSUER_UID = 'prs_ada';
const EVENT_ID = 'evt_share_dm_001';

/** Frozen hq-pro share-DM attachment keys. */
const ATTACHMENT_KEYS = [
  'id',
  'vaultPath',
  'name',
  'sizeBytes',
  'kind',
  'contentType',
  'companyUid',
] as const;

function attachment(
  name: string,
  extras: Pick<MessageAttachment, 'sizeBytes' | 'kind' | 'contentType'>,
): MessageAttachment {
  return {
    id: `att_${name.replace(/\W/g, '_')}`,
    vaultPath: `indigo/files/${name}`,
    name,
    sizeBytes: extras.sizeBytes,
    kind: extras.kind,
    contentType: extras.contentType,
    companyUid: 'cmp_indigo',
  };
}

/** Recorded share DM in the frozen wire shape (three files, file_share). */
const RECORDED_SHARE_DM: ConversationMessage = {
  eventId: EVENT_ID,
  fromPersonUid: ISSUER_UID,
  fromDisplayName: 'Ada Lovelace',
  body: 'Shared 3 file(s) with you.',
  createdAt: '2026-09-21T10:00:00Z',
  direction: 'in',
  messageKind: 'file_share',
  attachments: [
    attachment('shot.png', {
      sizeBytes: 2048,
      kind: 'image',
      contentType: 'image/png',
    }),
    attachment('notes.md', {
      sizeBytes: 128,
      kind: 'file',
      contentType: 'text/markdown',
    }),
    attachment('archive.zip', {
      sizeBytes: 4096,
      kind: 'file',
      contentType: 'application/zip',
    }),
  ],
};

/** Native share notification that the OS body-click path delivers. */
const SHARE_NOTIFICATION = {
  issuerUid: ISSUER_UID,
  eventId: EVENT_ID,
};

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

async function settle(): Promise<void> {
  flushSync();
  await Promise.resolve();
  flushSync();
}

describe('US-009: share notification deep-link lands on the file-share thread', () => {
  it('keeps the recorded DM in the frozen hq-pro wire shape', () => {
    expect(RECORDED_SHARE_DM.messageKind).toBe('file_share');
    expect(RECORDED_SHARE_DM.fromPersonUid).toBe(ISSUER_UID);
    expect(RECORDED_SHARE_DM.attachments).toHaveLength(3);
    for (const item of RECORDED_SHARE_DM.attachments ?? []) {
      expect(Object.keys(item).sort()).toEqual([...ATTACHMENT_KEYS].sort());
    }
    expect(SHARE_NOTIFICATION).toEqual({
      issuerUid: ISSUER_UID,
      eventId: EVENT_ID,
    });
  });

  it('maps the native share payload to inbox:dm:<issuerUid> and the inbox variant', () => {
    const route = routeForNotificationPayload(SHARE_NOTIFICATION);
    expect(route).toBe(`inbox:dm:${ISSUER_UID}`);

    const parsed = parseDesktopRoute(route);
    expect(parsed).toEqual({ kind: 'inbox', dm: ISSUER_UID });
  });

  it('selects that peer thread, renders one three-tile share card, and opens the picker', async () => {
    const route = routeForNotificationPayload(SHARE_NOTIFICATION);
    const parsed = parseDesktopRoute(route);
    expect(parsed?.kind).toBe('inbox');
    expect(parsed && parsed.kind === 'inbox' ? parsed.dm : undefined).toBe(
      RECORDED_SHARE_DM.fromPersonUid,
    );

    component = mount(Conversation, {
      target: host,
      props: {
        messages: [RECORDED_SHARE_DM],
        onsend: vi.fn(),
      },
    });
    await settle();

    expect(host.querySelector('.dm-msg-author')?.textContent).toBe('Ada Lovelace');
    expect(host.querySelectorAll('.dm-bubble-share')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="attachment-stack"]')).toHaveLength(1);

    const tiles = host.querySelectorAll('[data-testid="attachment-tile"]');
    expect(tiles).toHaveLength(3);
    expect([...tiles].map((el) => el.getAttribute('aria-label'))).toEqual([
      'shot.png',
      'notes.md',
      'archive.zip',
    ]);
    for (const tile of tiles) {
      expect(tile.tagName).toBe('BUTTON');
      expect(tile.classList.contains('attachment-tile')).toBe(true);
    }

    (tiles[0] as HTMLButtonElement).click();
    await settle();

    const items = document.querySelectorAll('[data-testid="attachment-picker-item"]');
    expect(items).toHaveLength(3);
    expect([...items].map((el) => el.getAttribute('aria-label'))).toEqual([
      'shot.png',
      'notes.md',
      'archive.zip',
    ]);

    const dialog = document.querySelector('[data-testid="attachment-picker"] [role="dialog"]');
    expect(dialog).not.toBeNull();
    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(document.querySelector('[data-testid="attachment-picker"]')).toBeNull();
  });
});

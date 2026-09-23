// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { flushSync, mount, unmount } from 'svelte';
import Conversation, { type ConversationMessage } from './Conversation.svelte';
import { ATTACHMENT_MISSING_COMPANY } from '../../lib/attachmentPresign';
import type { MessageAttachment } from '../../lib/messageAttachments';

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

const COMPANIES = [{ uid: 'cmp_indigo', slug: 'indigo' }];

function folderAtt(over: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: 'att_briefs',
    vaultPath: 'indigo/briefs/',
    name: 'briefs',
    kind: 'folder',
    companyUid: 'cmp_indigo',
    ...over,
  };
}

function shareDm(files: MessageAttachment[]): ConversationMessage {
  return {
    eventId: 'evt_share_folder',
    fromPersonUid: 'prs_ada',
    fromDisplayName: 'Ada Lovelace',
    body: 'Shared a folder with you.',
    createdAt: '2026-09-23T10:00:00Z',
    direction: 'in',
    messageKind: 'file_share',
    attachments: files,
  };
}

describe('US-004: folder tiles open Files', () => {
  it('clicking a folder tile navigates to the Files route and skips the picker', async () => {
    const onnavigatefiles = vi.fn();
    component = mount(Conversation, {
      target: host,
      props: {
        messages: [shareDm([folderAtt()])],
        onsend: vi.fn(),
        onnavigatefiles,
        companies: COMPANIES,
      },
    });
    flushSync();

    (host.querySelector('[data-testid="attachment-tile"]') as HTMLButtonElement).click();
    flushSync();

    expect(onnavigatefiles).toHaveBeenCalledWith('files:indigo:indigo/briefs/');
    expect(document.querySelector('[data-testid="attachment-picker"]')).toBeNull();
    expect(document.querySelector('[data-testid="attachment-preview"]')).toBeNull();
  });

  it('shows an in-app notice and does not navigate for missing company, unknown company, or parent path', async () => {
    const cases: MessageAttachment[] = [
      folderAtt({ companyUid: undefined }),
      folderAtt({ companyUid: 'cmp_unknown' }),
      folderAtt({ vaultPath: 'indigo/../secret/' }),
    ];
    for (const attachment of cases) {
      if (component) {
        await unmount(component);
        component = null;
        host.replaceChildren();
      }
      const onnavigatefiles = vi.fn();
      component = mount(Conversation, {
        target: host,
        props: {
          messages: [shareDm([attachment])],
          onsend: vi.fn(),
          onnavigatefiles,
          companies: COMPANIES,
        },
      });
      flushSync();
      (host.querySelector('[data-testid="attachment-tile"]') as HTMLButtonElement).click();
      flushSync();
      expect(onnavigatefiles).not.toHaveBeenCalled();
      expect(host.querySelector('[data-testid="attachment-files-notice"]')?.textContent).toBe(
        ATTACHMENT_MISSING_COMPANY,
      );
    }
  });
});

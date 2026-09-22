// @vitest-environment happy-dom

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
    loadAttachmentPreview: vi.fn(async (attachment: { name: string }) => {
      if (attachment.name.endsWith('.png')) {
        return { kind: 'image', objectUrl: 'blob:test-png', contentType: 'image/png' };
      }
      if (attachment.name.endsWith('.md')) {
        return { kind: 'markdown', text: '# Notes' };
      }
      return { kind: 'unsupported' };
    }),
  };
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { flushSync, mount, unmount } from 'svelte';
import Conversation, {
  type ConversationMessage,
} from '../../src/components/messaging/Conversation.svelte';
import type { MessageAttachment } from '../../src/lib/messageAttachments';

const read = (...parts: string[]) =>
  readFileSync(resolve(process.cwd(), ...parts), 'utf8');

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

function att(name: string, sizeBytes?: number): MessageAttachment {
  return {
    id: `att_${name}`,
    vaultPath: `indigo/files/${name}`,
    name,
    sizeBytes,
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

const threeFiles = [att('shot.png', 2048), att('notes.md', 128), att('archive.zip', 4096)];

async function settle(): Promise<void> {
  flushSync();
  await Promise.resolve();
  flushSync();
}

describe('US-008: File picker grid and preview pane', () => {
  it('opens a grid of three items when the share card stack is clicked', async () => {
    component = mount(Conversation, {
      target: host,
      props: {
        messages: [shareDm(threeFiles)],
        onsend: vi.fn(),
      },
    });
    await settle();

    const tile = host.querySelector('[data-testid="attachment-tile"]') as HTMLButtonElement;
    tile.click();
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

  it('renders a PNG inline and moves next/previous between files', async () => {
    component = mount(Conversation, {
      target: host,
      props: {
        messages: [shareDm(threeFiles)],
        onsend: vi.fn(),
      },
    });
    await settle();

    (host.querySelector('[data-testid="attachment-tile"]') as HTMLButtonElement).click();
    await settle();
    (
      document.querySelector('[data-testid="attachment-picker-item"]') as HTMLButtonElement
    ).click();
    await settle();

    expect(document.querySelector('[data-testid="attachment-preview-image"]')).not.toBeNull();
    expect(document.getElementById('attachment-preview-title')?.textContent).toContain('shot.png');

    (document.querySelector('[data-testid="attachment-preview-next"]') as HTMLButtonElement).click();
    await settle();
    expect(document.getElementById('attachment-preview-title')?.textContent).toContain('notes.md');

    (document.querySelector('[data-testid="attachment-preview-prev"]') as HTMLButtonElement).click();
    await settle();
    expect(document.querySelector('[data-testid="attachment-preview-image"]')).not.toBeNull();
    expect(document.getElementById('attachment-preview-title')?.textContent).toContain('shot.png');
  });

  it('shows zip metadata and Open in Files navigates to the Files route', async () => {
    const onnavigatefiles = vi.fn();
    component = mount(Conversation, {
      target: host,
      props: {
        messages: [shareDm(threeFiles)],
        onsend: vi.fn(),
        onnavigatefiles,
      },
    });
    await settle();

    (host.querySelector('[data-testid="attachment-tile"]') as HTMLButtonElement).click();
    await settle();
    const items = document.querySelectorAll('[data-testid="attachment-picker-item"]');
    (items[2] as HTMLButtonElement).click();
    await settle();

    const fallback = document.querySelector('[data-testid="attachment-preview-fallback"]');
    expect(fallback?.textContent).toContain('archive.zip');
    expect(fallback?.textContent).toContain('ZIP');
    (
      document.querySelector(
        '[data-testid="attachment-preview-open-in-files"]',
      ) as HTMLButtonElement
    ).click();
    expect(onnavigatefiles).toHaveBeenCalledWith('files:indigo:indigo/files/archive.zip');
  });

  it('uses in-app dialogs and never native browser prompts', () => {
    const picker = read('src/components/messaging/AttachmentPicker.svelte');
    const preview = read('src/components/messaging/AttachmentPreview.svelte');
    const conversation = read('src/components/messaging/Conversation.svelte');
    const presign = read('src/lib/attachmentPresign.ts');
    for (const src of [picker, preview, conversation, presign]) {
      expect(src).not.toMatch(/window\.(alert|confirm|prompt)\s*\(/);
    }
    expect(picker).toContain('role="dialog"');
    expect(preview).toContain('role="dialog"');
    expect(presign).toContain('/v1/files/presign');
    expect(presign).toContain('vault_s3_get');
  });
});

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import type { MessageAttachment } from '../../lib/messageAttachments';
import type { AttachmentPreviewView } from '../../lib/attachmentPresign';
import AttachmentPreview from './AttachmentPreview.svelte';

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

const files: MessageAttachment[] = [
  att('shot.png', 2048),
  att('notes.md', 128),
  att('archive.zip', 4096),
];

async function loadPreview(attachment: MessageAttachment): Promise<AttachmentPreviewView> {
  if (attachment.name.endsWith('.png')) {
    return { kind: 'image', objectUrl: 'blob:test-png', contentType: 'image/png' };
  }
  if (attachment.name.endsWith('.md')) {
    return { kind: 'markdown', text: '# Notes' };
  }
  return { kind: 'unsupported' };
}

describe('AttachmentPreview', () => {
  it('renders an inline image and moves previous/next across three files', async () => {
    const onindex = vi.fn();
    component = mount(AttachmentPreview, {
      target: host,
      props: {
        attachments: files,
        index: 0,
        onclose: vi.fn(),
        onindex,
        onopeninfiles: vi.fn(),
        loadPreview,
      },
    });
    flushSync();
    await Promise.resolve();
    flushSync();

    const dialog = document.querySelector('[data-testid="attachment-preview"] [role="dialog"]');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('attachment-preview-title');
    expect(document.querySelector('[data-testid="attachment-preview-image"]')).not.toBeNull();
    expect(document.getElementById('attachment-preview-title')?.textContent).toContain('shot.png');

    const next = document.querySelector(
      '[data-testid="attachment-preview-next"]',
    ) as HTMLButtonElement;
    const prev = document.querySelector(
      '[data-testid="attachment-preview-prev"]',
    ) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    next.click();
    expect(onindex).toHaveBeenCalledWith(1);

    await unmount(component);
    component = mount(AttachmentPreview, {
      target: host,
      props: {
        attachments: files,
        index: 1,
        onclose: vi.fn(),
        onindex,
        onopeninfiles: vi.fn(),
        loadPreview,
      },
    });
    flushSync();
    await Promise.resolve();
    flushSync();
    expect(document.getElementById('attachment-preview-title')?.textContent).toContain('notes.md');
    (
      document.querySelector('[data-testid="attachment-preview-prev"]') as HTMLButtonElement
    ).click();
    expect(onindex).toHaveBeenCalledWith(0);
  });

  it('shows metadata and Open in Files for an unsupported zip', async () => {
    const onopeninfiles = vi.fn();
    component = mount(AttachmentPreview, {
      target: host,
      props: {
        attachments: files,
        index: 2,
        onclose: vi.fn(),
        onindex: vi.fn(),
        onopeninfiles,
        loadPreview,
      },
    });
    flushSync();
    await Promise.resolve();
    flushSync();

    const fallback = document.querySelector('[data-testid="attachment-preview-fallback"]');
    expect(fallback?.textContent).toContain('archive.zip');
    expect(fallback?.textContent).toContain('ZIP');
    expect(document.querySelector('[data-testid="attachment-preview-image"]')).toBeNull();
    const open = document.querySelector(
      '[data-testid="attachment-preview-open-in-files"]',
    ) as HTMLButtonElement;
    expect(open).not.toBeNull();
    open.click();
    expect(onopeninfiles).toHaveBeenCalledWith(files[2]);
  });
});

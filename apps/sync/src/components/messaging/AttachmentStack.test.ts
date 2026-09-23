// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { mount, unmount } from 'svelte';
import type { MessageAttachment } from '../../lib/messageAttachments';
import AttachmentStack from './AttachmentStack.svelte';

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

function names(count: number): MessageAttachment[] {
  return Array.from({ length: count }, (_, i) => att(`file-${i + 1}.md`));
}

describe('AttachmentStack', () => {
  it('renders one accessible tile for a single attachment', () => {
    component = mount(AttachmentStack, {
      target: host,
      props: { attachments: [att('q1.md')], senderName: 'Ada Lovelace' },
    });

    const tiles = host.querySelectorAll('[data-testid="attachment-tile"]');
    expect(tiles).toHaveLength(1);
    expect(tiles[0]?.getAttribute('aria-label')).toBe('q1.md');
    expect(tiles[0]?.textContent).toContain('q1.md');
    expect(host.querySelector('[data-testid="attachment-tile-more"]')).toBeNull();
    expect(host.querySelector('[data-testid="attachment-stack"]')?.getAttribute('aria-label')).toBe(
      'Ada Lovelace shared q1.md',
    );
  });

  it('renders four tiles and no overflow for four attachments', () => {
    component = mount(AttachmentStack, {
      target: host,
      props: { attachments: names(4), senderName: 'Ada Lovelace' },
    });

    expect(host.querySelectorAll('[data-testid="attachment-tile"]')).toHaveLength(4);
    expect(host.querySelector('[data-testid="attachment-tile-more"]')).toBeNull();
  });

  it('renders four tiles plus a +3 overflow tile for seven attachments', () => {
    const onopen = vi.fn();
    component = mount(AttachmentStack, {
      target: host,
      props: { attachments: names(7), senderName: 'Ada Lovelace', onopen },
    });

    expect(host.querySelectorAll('[data-testid="attachment-tile"]')).toHaveLength(4);
    const more = host.querySelector('[data-testid="attachment-tile-more"]');
    expect(more?.textContent).toContain('+3');
    expect(more?.getAttribute('aria-label')).toBe('+3 more files');
    (more as HTMLButtonElement).click();
    expect(onopen).toHaveBeenCalledOnce();
  });

  it('renders a folder tile with a FOLDER badge', () => {
    component = mount(AttachmentStack, {
      target: host,
      props: {
        attachments: [
          {
            id: 'att_folder',
            vaultPath: 'indigo/briefs/',
            name: 'briefs',
            kind: 'folder',
            companyUid: 'cmp_indigo',
          },
        ],
        senderName: 'Ada Lovelace',
      },
    });

    const tile = host.querySelector('[data-testid="attachment-tile"]');
    expect(tile?.getAttribute('data-kind')).toBe('folder');
    expect(tile?.textContent).toContain('FOLDER');
    expect(tile?.textContent).toContain('briefs');
  });

  it('renders a mixed stack with one folder badge and one file badge', () => {
    component = mount(AttachmentStack, {
      target: host,
      props: {
        attachments: [
          {
            id: 'att_folder',
            vaultPath: 'indigo/briefs/',
            name: 'briefs',
            kind: 'folder',
            companyUid: 'cmp_indigo',
          },
          att('q1.md'),
        ],
        senderName: 'Ada Lovelace',
      },
    });

    const tiles = host.querySelectorAll('[data-testid="attachment-tile"]');
    expect(tiles).toHaveLength(2);
    expect(tiles[0]?.getAttribute('data-kind')).toBe('folder');
    expect(tiles[0]?.textContent).toContain('FOLDER');
    expect(tiles[1]?.getAttribute('data-kind')).toBe('file');
    expect(tiles[1]?.textContent).toContain('MD');
  });

  it('opens Files for a folder tile instead of the picker', () => {
    const onopen = vi.fn();
    const onfolder = vi.fn();
    component = mount(AttachmentStack, {
      target: host,
      props: {
        attachments: [
          {
            id: 'att_folder',
            vaultPath: 'indigo/briefs/',
            name: 'briefs',
            kind: 'folder',
            companyUid: 'cmp_indigo',
          },
        ],
        senderName: 'Ada Lovelace',
        onopen,
        onfolder,
      },
    });

    (host.querySelector('[data-testid="attachment-tile"]') as HTMLButtonElement).click();
    expect(onfolder).toHaveBeenCalledOnce();
    expect(onfolder.mock.calls[0]?.[0]?.kind).toBe('folder');
    expect(onopen).not.toHaveBeenCalled();
  });
});

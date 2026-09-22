// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import type { MessageAttachment } from '../../lib/messageAttachments';
import AttachmentPicker from './AttachmentPicker.svelte';

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

describe('AttachmentPicker', () => {
  it('renders a labelled dialog grid of every attachment', () => {
    const onclose = vi.fn();
    component = mount(AttachmentPicker, {
      target: host,
      props: {
        attachments: [att('a.md', 128), att('b.png', 2048), att('c.zip', 4096)],
        onclose,
        onselect: vi.fn(),
      },
    });
    flushSync();

    const dialog = document.querySelector('[data-testid="attachment-picker"] [role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-label') ?? dialog?.getAttribute('aria-labelledby')).toBeTruthy();
    const items = document.querySelectorAll('[data-testid="attachment-picker-item"]');
    expect(items).toHaveLength(3);
    expect([...items].map((el) => el.getAttribute('aria-label'))).toEqual([
      'a.md',
      'b.png',
      'c.zip',
    ]);
    expect(items[0]?.textContent).toContain('a.md');
    expect(items[0]?.textContent).toContain('128 B');
    expect(items[0]?.textContent).toContain('MD');
  });

  it('closes on Escape and the close button', () => {
    const onclose = vi.fn();
    component = mount(AttachmentPicker, {
      target: host,
      props: {
        attachments: [att('a.md')],
        onclose,
        onselect: vi.fn(),
      },
    });
    flushSync();

    const dialog = document.querySelector('[data-testid="attachment-picker"] [role="dialog"]');
    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onclose).toHaveBeenCalledOnce();

    onclose.mockClear();
    const close = document.querySelector('[data-testid="attachment-picker-close"]');
    (close as HTMLButtonElement).click();
    expect(onclose).toHaveBeenCalledOnce();
  });
});

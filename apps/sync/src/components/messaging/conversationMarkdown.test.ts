// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));

import { flushSync, mount, unmount } from 'svelte';
import Conversation from './Conversation.svelte';

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

describe('conversation block Markdown', () => {
  it('renders block content in a valid responsive message container', () => {
    component = mount(Conversation, {
      target: host,
      props: {
        messages: [
          {
            eventId: 'message-with-table',
            fromPersonUid: 'person-1',
            fromDisplayName: 'Maya',
            body: `## Comparison

| Plan | Owner |
| --- | --- |
| Beta | Maya |

> Ready to test.

\`\`\`sh
pnpm test
\`\`\``,
            createdAt: '2026-07-28T15:00:00.000Z',
            direction: 'in' as const,
          },
        ],
        onsend: vi.fn(),
      },
    });
    flushSync();

    const body = host.querySelector<HTMLElement>('.dm-bubble-body');
    expect(body?.tagName).toBe('DIV');
    expect(body?.querySelector('h2')?.textContent).toBe('Comparison');
    expect(body?.querySelector('table')).not.toBeNull();
    expect(body?.querySelector('th')?.getAttribute('scope')).toBe('col');
    expect(body?.querySelector('.markdown-table-scroll')?.getAttribute('tabindex')).toBe('0');
    expect(body?.querySelector('blockquote')?.textContent).toContain('Ready to test.');
    expect(body?.querySelector('pre code')?.textContent).toBe('pnpm test');
  });

  it('keeps complete neutral Markdown styling in both message consumers', () => {
    const conversation = readFileSync(
      resolve(process.cwd(), 'src/components/messaging/Conversation.svelte'),
      'utf8',
    );
    const threadPanel = readFileSync(
      resolve(process.cwd(), 'src/components/messaging/ThreadPanel.svelte'),
      'utf8',
    );

    expect(conversation).toContain(':global(.markdown-table-scroll)');
    expect(conversation).toContain(':global(table)');
    expect(conversation).toContain(':global(th)');
    expect(conversation).toContain(':global(td)');
    expect(conversation).toContain(':global(blockquote)');
    expect(conversation).toContain(':global(pre)');
    expect(conversation).toContain(':global(ul)');
    expect(conversation).toContain(':global(ol)');
    expect(conversation).toContain(':global(img)');
    expect(conversation).toContain(':global(hr)');
    expect(conversation).toContain(
      'font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif);',
    );
    expect(conversation).toContain(
      'font-family: var(--font-display, var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif));',
    );
    expect(conversation).toContain('border-radius: 0;');
    expect(conversation).toContain('overflow-x: auto;');

    expect(conversation).toContain('class="dm-bubble-body selectable-text"');
    expect(conversation).toContain('{@html renderMessageBodyMarkdown(msg.body)}');
    expect(conversation).toContain(
      'onclick={(event) => void onBodyLinkActivate(event)}',
    );
    expect(threadPanel).toContain('composer={false}');
    expect(threadPanel).not.toContain('thread-root-bubble');
    expect(threadPanel).toMatch(
      /\.thread-root\s*\{[\s\S]*?background:\s*transparent/,
    );
  });

  it('keeps a failed clipboard action recoverable without duplicating writes', async () => {
    const writeText = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('clipboard unavailable'))
      .mockResolvedValueOnce();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    component = mount(Conversation, {
      target: host,
      props: {
        messages: [
          {
            eventId: 'copy-recovery',
            fromPersonUid: 'person-1',
            fromDisplayName: 'Maya',
            body: 'Copy this safely',
            createdAt: '2026-07-28T15:00:00.000Z',
            direction: 'in' as const,
          },
        ],
        onsend: vi.fn(),
      },
    });
    flushSync();

    host.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        'Couldn’t copy this message.',
      );
    });
    expect(writeText).toHaveBeenCalledTimes(1);

    const retry = host.querySelector<HTMLButtonElement>('.dm-action-retry')!;
    retry.click();
    retry.click();

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('.dm-action-error')).toBeNull();
    });
    expect(writeText).toHaveBeenCalledTimes(2);
  });
});

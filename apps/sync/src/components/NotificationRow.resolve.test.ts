// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import NotificationRow, { type NotificationRowType } from './NotificationRow.svelte';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = null;
});

afterEach(async () => {
  if (component) await unmount(component);
  host.remove();
});

const OPTIONS = [
  { value: 'cmp_indigo', label: 'Indigo' },
  { value: 'cmp_amass', label: 'Amass' },
];

function mountResolvable(overrides: Record<string, unknown> = {}) {
  const props = {
    type: 'meeting' as NotificationRowType,
    sourceLabel: 'Meeting',
    text: 'Weekly sync · Tue, Sep 1, 2:30 PM',
    ts: Date.now(),
    onopen: vi.fn(),
    ondismiss: vi.fn(),
    resolvePrompt: 'File to company',
    resolveOptions: OPTIONS,
    onresolveopen: vi.fn(async () => {}),
    onresolve: vi.fn(async () => {}),
    onholdchange: vi.fn(),
    ...overrides,
  };
  component = mount(NotificationRow, { target: host, props });
  flushSync();
  return props;
}

const q = <T extends HTMLElement>(testid: string) =>
  host.querySelector<T>(`[data-testid="${testid}"]`);

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

describe('NotificationRow — needs-action (File to company) rows', () => {
  it('shows the resolve trigger, no duplicate Open chip, and no source label', () => {
    mountResolvable();
    expect(q('notification-resolve-trigger')?.textContent?.trim()).toBe('File to company');
    expect(host.querySelector('.nr-open')).toBeNull();
    expect(q('notification-source')).toBeNull();
    expect(host.querySelector('.nr')?.classList.contains('nr-resolvable')).toBe(true);
    // Full title survives truncation as a tooltip.
    expect(host.querySelector<HTMLElement>('.nr-text')?.title).toContain('Weekly sync');
  });

  it('body click opens the meeting (onopen), not the picker', async () => {
    const props = mountResolvable();
    host.querySelector<HTMLButtonElement>('.nr-primary-action')?.click();
    await settle();
    expect(props.onopen).toHaveBeenCalledTimes(1);
    expect(q('notification-resolve-sheet')).toBeNull();
  });

  it('opening the picker loads options, takes over the row, holds it, and Cancel closes', async () => {
    const props = mountResolvable();
    q<HTMLButtonElement>('notification-resolve-trigger')?.click();
    await settle();
    expect(props.onresolveopen).toHaveBeenCalledTimes(1);
    expect(props.onholdchange).toHaveBeenLastCalledWith(true);
    expect(host.querySelector('.nr')?.classList.contains('nr-resolving')).toBe(true);
    const options = [
      ...host.querySelectorAll<HTMLButtonElement>('[data-testid="notification-resolve-option"]'),
    ];
    expect(options.map((o) => o.dataset.value)).toEqual(['cmp_indigo', 'cmp_amass']);
    expect(options.map((o) => o.textContent?.trim())).toEqual(['Indigo', 'Amass']);

    q<HTMLButtonElement>('notification-resolve-cancel')?.click();
    await settle();
    expect(q('notification-resolve-sheet')).toBeNull();
    expect(props.onholdchange).toHaveBeenLastCalledWith(false);
    expect(props.onresolve).not.toHaveBeenCalled();
  });

  it('clicking a company chip files it and closes the picker on success', async () => {
    const props = mountResolvable();
    q<HTMLButtonElement>('notification-resolve-trigger')?.click();
    await settle();
    host
      .querySelector<HTMLButtonElement>(
        '[data-testid="notification-resolve-option"][data-value="cmp_amass"]',
      )
      ?.click();
    await settle();
    expect(props.onresolve).toHaveBeenCalledWith('cmp_amass');
    expect(q('notification-resolve-sheet')).toBeNull();
    expect(q('notification-resolve-error')).toBeNull();
  });

  it('a failed filing keeps the row and the picker open and shows the error', async () => {
    const props = mountResolvable({
      onresolve: vi.fn(async () => {
        throw new Error("You don't have access to that company.");
      }),
    });
    q<HTMLButtonElement>('notification-resolve-trigger')?.click();
    await settle();
    host
      .querySelector<HTMLButtonElement>(
        '[data-testid="notification-resolve-option"][data-value="cmp_indigo"]',
      )
      ?.click();
    await settle();
    expect(props.onresolve).toHaveBeenCalledWith('cmp_indigo');
    expect(q('notification-row')).not.toBeNull();
    expect(q('notification-resolve-sheet')).not.toBeNull();
    expect(q('notification-resolve-error')?.textContent).toContain('Couldn’t save that');
  });

  it('non-resolvable rows keep the source label and hover Open chip', () => {
    mountResolvable({ resolvePrompt: undefined, onresolve: undefined, onresolveopen: undefined });
    expect(q('notification-resolve-trigger')).toBeNull();
    expect(q('notification-source')?.textContent).toBe('Meeting');
    expect(host.querySelector('.nr-open')).not.toBeNull();
  });
});

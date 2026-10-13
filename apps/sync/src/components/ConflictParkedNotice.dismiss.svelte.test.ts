// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import ConflictParkedNotice from './ConflictParkedNotice.svelte';
import {
  CONFLICT_DISMISSED_BATCH_KEY,
  type ConflictBatchStorage,
  type ConflictParkedNotice as Notice,
} from '../lib/conflictNotices';

const notice = (index: number): Notice => ({
  id: String(index % 10).repeat(64),
  scope: 'company',
  companySlug: 'acme',
  relativePath: `docs/file-${index}.md`,
  backupPath: `.hq/conflict-backups/docs/file-${index}.md.backup`,
  winnerReason: 'local-newer',
  sideKept: 'local',
  parkedAt: '2026-10-10T12:00:00.000Z',
});

const batch = (...indexes: number[]): Notice[] => indexes.map(notice);

function memoryStorage(): ConflictBatchStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

type Props = {
  notices: Notice[];
  reviewRequested?: boolean;
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function render(storage: ConflictBatchStorage, initial: Props) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const onShowInFinder = vi.fn();
  const onAcknowledge = vi.fn();
  const onReviewHandled = vi.fn();
  const props = {
    notices: initial.notices,
    busyIds: new Set<string>(),
    onShowInFinder,
    onAcknowledge,
    storage,
    reviewRequested: initial.reviewRequested ?? false,
    onReviewHandled,
  };
  component = mount(ConflictParkedNotice, { target: host, props });
  flushSync();
  return { props, onShowInFinder, onAcknowledge, onReviewHandled };
}

const card = () => host.querySelector('[data-testid="conflict-parked-notices"]');
const closeButton = () =>
  host.querySelector<HTMLButtonElement>('[data-testid="conflict-parked-notices-dismiss"]');

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
});

describe('ConflictParkedNotice X dismiss', () => {
  it('renders an icon-only close control labelled Dismiss', () => {
    const storage = memoryStorage();
    render(storage, { notices: batch(1, 2, 3) });
    const close = closeButton();
    expect(close).not.toBeNull();
    expect(close?.getAttribute('aria-label')).toBe('Dismiss');
    expect(close?.textContent?.trim()).toBe('');
    expect(close?.querySelector('svg')).not.toBeNull();
  });

  it('closes the card without opening Review or acknowledging anything', () => {
    const storage = memoryStorage();
    const { onAcknowledge, onShowInFinder } = render(storage, { notices: batch(1, 2, 3) });
    expect(card()).not.toBeNull();
    expect(host.querySelector('[data-testid="conflict-parked-notice"]')).toBeNull();

    closeButton()?.click();
    flushSync();

    expect(card()).toBeNull();
    expect(host.querySelector('[data-testid="conflict-parked-notice"]')).toBeNull();
    expect(onAcknowledge).not.toHaveBeenCalled();
    expect(onShowInFinder).not.toHaveBeenCalled();
    expect(JSON.parse(storage.data.get(CONFLICT_DISMISSED_BATCH_KEY) ?? '[]')).toHaveLength(3);
  });

  it('stays dismissed for the same batch after a window reload and when part of it is acknowledged', () => {
    const storage = memoryStorage();
    render(storage, { notices: batch(1, 2, 3) });
    closeButton()?.click();
    flushSync();
    unmount(component!);
    host.remove();

    // Reload: a fresh mount reads the dismissed batch back from storage.
    render(storage, { notices: batch(1, 2, 3) });
    expect(card()).toBeNull();
    unmount(component!);
    host.remove();

    // Acknowledging one copy only shrinks the batch; it stays closed.
    render(storage, { notices: batch(2, 3) });
    expect(card()).toBeNull();
  });

  it('reappears when a new conflict copy is parked', () => {
    const storage = memoryStorage();
    render(storage, { notices: batch(1, 2, 3) });
    closeButton()?.click();
    flushSync();
    unmount(component!);
    host.remove();

    render(storage, { notices: batch(1, 2, 3, 4) });
    expect(card()).not.toBeNull();
    expect(card()?.textContent).toContain('4 conflict copies parked');
  });

  it('opens the Review list when a notification click requests it, even for a dismissed batch', () => {
    const storage = memoryStorage();
    render(storage, { notices: batch(1, 2, 3) });
    closeButton()?.click();
    flushSync();
    unmount(component!);
    host.remove();

    const { onReviewHandled } = render(storage, {
      notices: batch(1, 2, 3),
      reviewRequested: true,
    });
    expect(card()).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="conflict-parked-notice"]')).toHaveLength(3);
    expect(host.querySelector('.toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(onReviewHandled).toHaveBeenCalledTimes(1);
    expect(storage.data.has(CONFLICT_DISMISSED_BATCH_KEY)).toBe(false);
  });

  it('holds a review request until the pending notices have loaded', () => {
    const storage = memoryStorage();
    const { onReviewHandled } = render(storage, { notices: [], reviewRequested: true });
    expect(card()).toBeNull();
    expect(onReviewHandled).not.toHaveBeenCalled();
  });
});

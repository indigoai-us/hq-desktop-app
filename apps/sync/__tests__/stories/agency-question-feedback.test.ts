// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const agency = vi.hoisted(() => ({
  submitAnswer: vi.fn(),
  question: {
    company: 'indigo',
    team: 'desktop',
    id: 'q-1',
    question: 'Ship this beta?',
    ts: '2026-07-28T12:00:00Z',
    options: ['Approve', 'Hold'],
  },
}));

vi.mock('../../src/desktop-alt/lib/agency-store.svelte', () => ({
  agencyStore: { questions: [agency.question] },
  submitAnswer: agency.submitAnswer,
}));

import { flushSync, mount, unmount } from 'svelte';
import AgencyQuestionsPanel from '../../src/desktop-alt/panels/AgencyQuestionsPanel.svelte';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.clearAllMocks();
});

describe('agency suggested-answer feedback', () => {
  it('identifies the selected pending answer while locking sibling actions', async () => {
    const request = deferred<string>();
    agency.submitAnswer.mockReturnValueOnce(request.promise);
    component = mount(AgencyQuestionsPanel, { target: host });
    flushSync();

    const options = [...host.querySelectorAll<HTMLButtonElement>('.qopts .opt')];
    expect(options.map((button) => button.textContent?.trim())).toEqual([
      'Approve',
      'Hold',
    ]);

    options[0].click();
    flushSync();

    expect(options[0].textContent?.trim()).toBe('Sending…');
    expect(options[0].getAttribute('aria-busy')).toBe('true');
    expect(options[0].disabled).toBe(true);
    expect(options[1].textContent?.trim()).toBe('Hold');
    expect(options[1].getAttribute('aria-busy')).toBe('false');
    expect(options[1].disabled).toBe(true);
    const customSend = host.querySelector<HTMLButtonElement>('.send');
    expect(customSend?.textContent?.trim()).toBe('Send');
    expect(customSend?.getAttribute('aria-busy')).toBe('false');
    expect(customSend?.disabled).toBe(true);

    request.resolve('delivered');
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[role="status"]')?.textContent).toContain('Sent ✓');
    });
    expect(options[0].textContent?.trim()).toBe('Approve');
    expect(options[0].getAttribute('aria-busy')).toBe('false');
  });

  it('announces a failed custom answer without assigning busy state to options', async () => {
    agency.submitAnswer.mockRejectedValueOnce(new Error('offline'));
    component = mount(AgencyQuestionsPanel, { target: host });
    flushSync();

    const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
    const customSend = host.querySelector<HTMLButtonElement>('.send');
    expect(textarea).toBeTruthy();
    expect(customSend).toBeTruthy();
    textarea!.value = 'Wait for the native gate';
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    customSend!.click();
    flushSync();

    expect(customSend!.textContent?.trim()).toBe('Sending…');
    expect(customSend!.getAttribute('aria-busy')).toBe('true');
    expect(
      [...host.querySelectorAll<HTMLButtonElement>('.qopts .opt')].every(
        (button) => button.getAttribute('aria-busy') === 'false',
      ),
    ).toBe(true);

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        'Failed to send',
      );
    });
  });
});

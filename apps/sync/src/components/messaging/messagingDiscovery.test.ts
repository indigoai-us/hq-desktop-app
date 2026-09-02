// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import CreateChannel from './CreateChannel.svelte';
import RecipientPicker from './RecipientPicker.svelte';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

let host: HTMLElement;
let component: Record<string, unknown> | null = null;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  invokeMock.mockReset();
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  consoleErrorSpy.mockRestore();
  host.remove();
});

describe('RecipientPicker discovery recovery', () => {
  it('announces a failed lookup, retries in place, and preserves keyboard selection', async () => {
    const retryContacts = deferred<{
      contacts: Array<{
        personUid: string;
        email: string;
        displayName: string;
        connectionState: 'active';
      }>;
    }>();
    let contactAttempts = 0;
    const onselect = vi.fn();

    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_contacts') {
        contactAttempts += 1;
        return contactAttempts === 1
          ? Promise.reject(new Error('directory offline'))
          : retryContacts.promise;
      }
      if (command === 'meetings_list_memberships') return Promise.resolve([]);
      throw new Error(`Unexpected command: ${command}`);
    });

    component = mount(RecipientPicker, {
      target: host,
      props: { selected: null, onselect },
    });
    flushSync();

    const input = host.querySelector<HTMLInputElement>('.recipient-input')!;
    typeInto(input, 'maya');

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        'People couldn’t be loaded.',
      );
    });
    expect(host.querySelector('.recipient-picker')?.getAttribute('aria-busy')).toBe('false');

    host.querySelector<HTMLButtonElement>('.discovery-retry')!.click();
    flushSync();

    expect(host.querySelector('.recipient-picker')?.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Looking up people…');

    retryContacts.resolve({
      contacts: [
        {
          personUid: 'person-maya',
          email: 'maya@example.com',
          displayName: 'Maya',
          connectionState: 'active',
        },
      ],
    });

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('.suggestion-primary')?.textContent).toBe('Maya');
    });

    const activeId = input.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    expect(host.querySelector(`#${activeId}`)?.getAttribute('aria-selected')).toBe('true');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    flushSync();

    expect(onselect).toHaveBeenCalledWith(
      expect.objectContaining({ personUid: 'person-maya', email: 'maya@example.com' }),
    );
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps trusted contact results visible when a company-member lookup fails', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_contacts') {
        return Promise.resolve({
          contacts: [
            {
              personUid: 'person-maya',
              email: 'maya@example.com',
              displayName: 'Maya',
              connectionState: 'active',
            },
          ],
        });
      }
      if (command === 'meetings_list_memberships') {
        return Promise.resolve([
          {
            companyUid: 'cmp_indigo',
            companyName: 'Indigo',
            role: 'member',
            status: 'active',
          },
        ]);
      }
      if (command === 'list_company_members') {
        return Promise.reject(new Error('company directory offline'));
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    component = mount(RecipientPicker, {
      target: host,
      props: { selected: null, onselect: vi.fn() },
    });
    flushSync();

    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('meetings_list_memberships');
    });

    typeInto(host.querySelector<HTMLInputElement>('.recipient-input')!, 'maya');

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        'Showing saved results.',
      );
    });
    expect(host.querySelector('.suggestion-primary')?.textContent).toBe('Maya');
  });
});

describe('CreateChannel scope discovery recovery', () => {
  it('does not present membership failure as Personal-only and keeps retry/create pending states explicit', async () => {
    const retryMemberships = deferred<
      Array<{
        companyUid: string;
        companyName: string;
        role: string;
        status: string;
      }>
    >();
    const createChannel = deferred<Record<string, unknown>>();
    const oncreated = vi.fn();
    let membershipAttempts = 0;

    invokeMock.mockImplementation((command: string) => {
      if (command === 'meetings_list_memberships') {
        membershipAttempts += 1;
        return membershipAttempts <= 2
          ? Promise.reject(new Error('memberships offline'))
          : retryMemberships.promise;
      }
      if (command === 'list_contacts') return Promise.resolve({ contacts: [] });
      if (command === 'create_channel') return createChannel.promise;
      throw new Error(`Unexpected command: ${command}`);
    });

    component = mount(CreateChannel, {
      target: host,
      props: {
        onclose: vi.fn(),
        oncreated,
      },
    });
    flushSync();

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('#channel-scope-status')?.textContent).toContain(
        'Company scopes couldn’t be loaded.',
      );
    });

    expect(host.querySelector('.scope-select')).toBeNull();
    expect(host.textContent).not.toContain(
      'A personal channel — only people you invite can see it.',
    );

    typeInto(host.querySelector<HTMLInputElement>('.name-input')!, 'launch');
    expect(host.querySelector<HTMLButtonElement>('.btn-send')?.disabled).toBe(true);

    host.querySelector<HTMLButtonElement>('.scope-retry')!.click();
    flushSync();

    expect(host.querySelector('.scope-control')?.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('#channel-scope-status')?.textContent).toContain(
      'Loading available scopes…',
    );

    retryMemberships.resolve([
      {
        companyUid: 'cmp_indigo',
        companyName: 'Indigo',
        role: 'member',
        status: 'active',
      },
    ]);

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelectorAll('.scope-select option')).toHaveLength(2);
    });

    const scope = host.querySelector<HTMLSelectElement>('.scope-select')!;
    expect([...scope.options].map((option) => option.textContent)).toEqual([
      'Personal',
      'Indigo',
    ]);

    const createButton = host.querySelector<HTMLButtonElement>('.btn-send')!;
    expect(createButton.disabled).toBe(false);
    createButton.click();
    flushSync();

    expect(createButton.getAttribute('aria-busy')).toBe('true');
    expect(createButton.textContent?.trim()).toBe('Creating…');
    expect(invokeMock).toHaveBeenCalledWith('create_channel', {
      name: 'launch',
      scope: 'personal',
      companyUid: null,
      invite: [],
    });

    createChannel.resolve({ channelUid: 'channel-launch' });
    await vi.waitFor(() => expect(oncreated).toHaveBeenCalledTimes(1));
  });
});

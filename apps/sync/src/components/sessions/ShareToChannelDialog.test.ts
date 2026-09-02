// @vitest-environment happy-dom
/**
 * The share dialog, mounted for real against a mocked backend.
 *
 * What is pinned: opening runs ONLY the two read-only loads; the target
 * switches between an existing channel and a new one; invites become chips;
 * Share stays off until the draft is sendable; and the confirm click is the
 * one and only call to `session_share_to_channel`, with the exact payload.
 * A backend error lands inline; a success shows the result line, per-invite
 * failures, and an "open channel" action that hands the id to the shell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { flushSync, mount, unmount } from 'svelte';
import ShareToChannelDialog from './ShareToChannelDialog.svelte';
import type { ShareToChannelResult } from './share-channel';

const PREFLIGHT = {
  channels: [
    { channelId: 'ch_general', name: 'general', kind: 'company' },
    { channelId: 'ch_launch', name: 'p-launch', kind: 'project' },
  ],
  members: [
    { uid: 'usr_ann', displayName: 'Ann Lee', kind: 'human' },
    { uid: 'usr_bob', displayName: 'Bob Ray', kind: 'human' },
    { uid: 'agt_scout', displayName: 'Scout', kind: 'agent' },
  ],
};

const PROJECTS = [
  {
    name: 'Launch Week',
    description: 'Ship it',
    branchName: 'feat/launch',
    path: '/hq/companies/indigo/projects/launch-week',
    storyCounts: { total: 8, done: 3 },
    updatedAt: '2026-09-01T00:00:00Z',
  },
];

const RESULT: ShareToChannelResult = {
  channelId: 'ch_general',
  channelName: 'general',
  created: false,
  invited: [
    { uid: 'usr_ann', ok: true },
    { uid: 'agt_scout', ok: false, error: 'agent is not in indigo' },
  ],
  postedEventId: 'evt_9',
  digestChars: 2400,
};

let host: HTMLElement;
let component: Record<string, unknown> | null = null;
let shareImpl: () => Promise<ShareToChannelResult>;

function backend() {
  invoke.mockImplementation((command: string) => {
    if (command === 'hq_share_to_channel_preflight') return Promise.resolve(PREFLIGHT);
    if (command === 'hq_company_projects') return Promise.resolve(PROJECTS);
    if (command === 'session_share_to_channel') return shareImpl();
    return Promise.reject(new Error(`unexpected invoke ${command}`));
  });
}

async function settle() {
  // A macrotask turn drains every pending microtask (the Promise.all of the
  // loads, its `.then`, its `.finally`) before the DOM is inspected.
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
}

async function render(props: Record<string, unknown> = {}) {
  if (component) unmount(component);
  component = mount(ShareToChannelDialog, {
    target: host,
    props: { sessionId: 'sess-1', company: 'indigo', ...props },
  }) as Record<string, unknown>;
  flushSync();
  await settle();
}

const at = (testid: string): HTMLElement | null =>
  host.querySelector(`[data-testid="${testid}"]`);

const must = (testid: string): HTMLElement => {
  const found = at(testid);
  if (!found) throw new Error(`missing [data-testid="${testid}"]`);
  return found;
};

const all = (testid: string): HTMLElement[] =>
  Array.from(host.querySelectorAll(`[data-testid="${testid}"]`));

const click = (element: HTMLElement) => {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  flushSync();
};

const type = (element: HTMLElement, value: string) => {
  (element as HTMLInputElement).value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};

const confirm = () => must('share-confirm') as HTMLButtonElement;

const shareCalls = () => invoke.mock.calls.filter(([command]) => command === 'session_share_to_channel');

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  invoke.mockReset();
  shareImpl = () => Promise.resolve(RESULT);
  backend();
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host.remove();
});

describe('ShareToChannelDialog', () => {
  it('opens with only the two read-only loads — nothing outward', async () => {
    await render();
    const commands = invoke.mock.calls.map(([command]) => command).sort();
    expect(commands).toEqual(['hq_company_projects', 'hq_share_to_channel_preflight']);
    expect(invoke).toHaveBeenCalledWith('hq_share_to_channel_preflight', { company: 'indigo' });
    expect(invoke).toHaveBeenCalledWith('hq_company_projects', { company: 'indigo' });
    expect(must('share-dialog').getAttribute('role')).toBe('dialog');
    expect(at('share-loading')).toBeNull();
    expect(all('share-channel-option')).toHaveLength(2);
  });

  it('keeps Share off until a channel is picked, then previews the post', async () => {
    await render();
    expect(confirm().disabled).toBe(true);
    expect(must('share-preview').textContent).toBe('Pick a channel.');

    type(must('share-channel-search'), 'gen');
    expect(all('share-channel-option')).toHaveLength(1);
    click(all('share-channel-option')[0]!);
    expect(confirm().disabled).toBe(false);
    expect(must('share-preview').textContent).toBe('Will post to #general');
    expect(all('share-channel-option')[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('switches to a new channel, prefills #p-<slug> from a project, and never clobbers a typed name', async () => {
    await render();
    click(must('share-target-new'));
    expect(at('share-channel-list')).toBeNull();
    expect(confirm().disabled).toBe(true);
    expect(must('share-preview').textContent).toBe('Name the new channel.');

    const select = must('share-project') as HTMLSelectElement;
    select.value = PROJECTS[0]!.path;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect((must('share-new-name') as HTMLInputElement).value).toBe('p-launch-week');
    expect(confirm().disabled).toBe(false);
    expect(must('share-preview').textContent).toBe('Will create #p-launch-week');

    type(must('share-new-name'), 'my own name');
    select.value = '';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.value = PROJECTS[0]!.path;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect((must('share-new-name') as HTMLInputElement).value).toBe('my own name');
  });

  it('turns picked members into removable chips and counts them in the preview', async () => {
    await render();
    click(all('share-channel-option')[0]!);
    type(must('share-invite-search'), 'ann');
    expect(all('share-invite-option')).toHaveLength(1);
    click(all('share-invite-option')[0]!);
    expect(all('share-invite-chip').map((chip) => chip.getAttribute('data-uid'))).toEqual(['usr_ann']);
    expect((must('share-invite-search') as HTMLInputElement).value).toBe('');

    type(must('share-invite-search'), 'scout');
    click(all('share-invite-option')[0]!);
    expect(all('share-invite-chip')).toHaveLength(2);
    expect(must('share-preview').textContent).toBe(
      'Will post to #general and invite 1 person and 1 agent',
    );
    // A picked member leaves the suggestion list.
    type(must('share-invite-search'), '');
    expect(all('share-invite-option').map((el) => el.getAttribute('data-uid'))).toEqual(['usr_bob']);

    click(all('share-invite-chip')[0]!.querySelector('button')!);
    expect(all('share-invite-chip').map((chip) => chip.getAttribute('data-uid'))).toEqual(['agt_scout']);
  });

  it('shares ONLY on the confirm click, with the exact payload', async () => {
    await render();
    click(all('share-channel-option')[0]!);
    type(must('share-invite-search'), 'ann');
    click(all('share-invite-option')[0]!);
    type(must('share-invite-search'), 'scout');
    click(all('share-invite-option')[0]!);
    click(must('share-include-transcript'));
    type(must('share-note'), '  Digest for the launch thread ');
    expect(shareCalls()).toHaveLength(0);

    click(confirm());
    expect(shareCalls()).toHaveLength(1);
    expect(shareCalls()[0]![1]).toEqual({
      sessionId: 'sess-1',
      company: 'indigo',
      target: { kind: 'existing', channelId: 'ch_general' },
      inviteUids: ['usr_ann', 'agt_scout'],
      includeTranscript: false,
      note: 'Digest for the launch thread',
    });
    expect(confirm().getAttribute('aria-busy')).toBe('true');

    await settle();
    expect(at('share-confirm')).toBeNull();
    expect(must('share-result-text').textContent).toBe(
      'Shared to #general · 1 invited · 1 invite failed',
    );
    expect(must('share-invite-failures').textContent).toContain('Scout');
    expect(must('share-invite-failures').textContent).toContain('agent is not in indigo');
  });

  it('sends a new-channel payload with the project path and no note', async () => {
    shareImpl = () =>
      Promise.resolve({ ...RESULT, channelId: 'ch_new', channelName: 'p-launch-week', created: true, invited: [] });
    await render();
    click(must('share-target-new'));
    const select = must('share-project') as HTMLSelectElement;
    select.value = PROJECTS[0]!.path;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    click(confirm());
    expect(shareCalls()[0]![1]).toEqual({
      sessionId: 'sess-1',
      company: 'indigo',
      target: { kind: 'new', name: 'p-launch-week', projectPath: PROJECTS[0]!.path },
      inviteUids: [],
      includeTranscript: true,
    });
    await settle();
    expect(must('share-result-text').textContent).toBe('Created and shared to #p-launch-week');
  });

  it('hands "open channel" to the shell with the channel id', async () => {
    const onopenchannel = vi.fn();
    await render({ onopenchannel });
    click(all('share-channel-option')[0]!);
    click(confirm());
    await settle();
    click(must('share-open-channel'));
    expect(onopenchannel).toHaveBeenCalledWith('ch_general');
  });

  it('surfaces a backend error inline and keeps the draft', async () => {
    shareImpl = () => Promise.reject(new Error('Command session_share_to_channel not found'));
    await render();
    click(all('share-channel-option')[0]!);
    click(confirm());
    await settle();
    expect(must('share-error').textContent).toContain('session_share_to_channel not found');
    expect(at('share-result')).toBeNull();
    expect(confirm().disabled).toBe(false);
    expect(all('share-channel-option')[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('cannot share a company-less session and says so', async () => {
    await render({ company: null });
    expect(invoke).not.toHaveBeenCalled();
    expect(confirm().disabled).toBe(true);
    expect(must('share-preview').textContent).toBe('Bind this session to a company first.');
  });

  it('cancels without sharing, and Escape closes too', async () => {
    const onclose = vi.fn();
    await render({ onclose });
    click(all('share-channel-option')[0]!);
    click(must('share-cancel'));
    expect(onclose).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(onclose).toHaveBeenCalledTimes(2);
    expect(shareCalls()).toHaveLength(0);
  });
});

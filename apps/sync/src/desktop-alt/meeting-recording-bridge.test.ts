// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('svelte', async () => {
  // @ts-expect-error Svelte's client entry has no public declaration export.
  return import('../../node_modules/svelte/src/index-client.js');
});
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, Set<(event: { payload: unknown }) => void>>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    const set = mocks.handlers.get(name) ?? new Set();
    set.add(handler);
    mocks.handlers.set(name, set);
    return () => { set.delete(handler); };
  }),
}));
import { mount, unmount, flushSync } from 'svelte';
import { meetings } from '@hq/ui';
import { createSyncPlatformAdapter } from '@hq/platform';
import { startMeetingRecordingBridge } from './meeting-recording-bridge';

const detection = { windowId: 'window-1', platform: 'zoom', meetingUrl: 'recall-window:window-1' };
const membership = { companyUid: 'cmp_test', companyName: 'Test company', status: 'active' };
let detections: typeof detection[];
let recordings: unknown[];
let stop: (() => void) | undefined;
let component: ReturnType<typeof mount> | undefined;
let host: HTMLDivElement;
const emit = (name: string, payload: unknown) => mocks.handlers.get(name)?.forEach((h) => h({ payload }));
async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
  flushSync();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
beforeEach(() => {
  detections = [];
  recordings = [];
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    switch (command) {
      case 'meetings_list_active_detections': return detections;
      case 'meetings_list_active_recordings': return recordings;
      case 'meetings_list_memberships': return [membership];
      case 'get_settings': return { defaultRecordingCompanyUid: membership.companyUid };
      case 'start_recording': return 'recording-1';
      case 'meetings_list_upcoming': case 'meetings_list_scheduled_bots': case 'google_list_accounts': return [];
      default: return null;
    }
  });
});
afterEach(async () => {
  stop?.();
  if (component) await unmount(component);
  component = undefined;
  host?.remove();
  meetings.stopMeetingsStore();
  mocks.handlers.clear();
});

describe('desktop recording bridge to the shared Meetings page', () => {
  it('renders a pre-existing detection and drives recording from the actual page buttons', async () => {
    detections = [detection];
    stop = startMeetingRecordingBridge();
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(meetings.MeetingsPage, {
      target: host,
      props: { adapter: createSyncPlatformAdapter({ invoke: mocks.invoke }), accountId: 'account-test' },
    });
    await settle();
    const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
    expect(button('Start recording')).toBeDefined();
    expect(get(meetings.recordingMemberships)).toEqual([membership]);
    meetings.setRecordingCompany('window-1', null);
    window.dispatchEvent(new Event('focus'));
    await settle();
    button('Start recording')!.click();
    await settle();
    expect(mocks.invoke).toHaveBeenCalledWith('start_recording', { windowId: 'window-1', companyUid: null });
    expect(get(meetings.activeMeetings)[0].state).toBe('starting');
    emit('recording:started', { windowId: 'window-1' });
    await settle();
    expect(button('Stop recording')).toBeDefined();
    button('Stop recording')!.click();
    await settle();
    expect(mocks.invoke).toHaveBeenCalledWith('stop_recording', { windowId: 'window-1' });
    emit('recording:ended', { windowId: 'window-1' });
    await settle();
    expect(get(meetings.activeMeetings)).toEqual([]);
    expect(button('Stop recording')).toBeUndefined();
  });

  it('forwards live detection and errors without handling the controller-owned notification twice', async () => {
    stop = startMeetingRecordingBridge();
    await settle();
    emit('meeting:detected', detection);
    emit('notification:meeting-action', { action: 'record', windowId: 'window-1' });
    await settle();
    expect(get(meetings.activeMeetings)[0].state).toBe('detected');
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'start_recording')).toHaveLength(0);
    await meetings.startRecording('window-1');
    emit('recording:error', { windowId: 'window-1', cmd: 'start', message: 'Permission denied' });
    expect(get(meetings.activeMeetings)[0]).toMatchObject({ state: 'error', error: 'start: Permission denied' });
  });

  it('shows a recording started before the window opened', async () => {
    detections = [detection];
    recordings = [{ windowId: 'window-1', recordingId: 'existing', companyUid: membership.companyUid }];
    stop = startMeetingRecordingBridge();
    await settle();
    expect(get(meetings.activeMeetings)[0]).toMatchObject({ state: 'recording', recordingId: 'existing' });
  });

  it.each([
    ['settings first', 'cmp_original'],
    ['settings first', null],
    ['recording first', 'cmp_original'],
    ['recording first', null],
  ])('preserves ledger attribution with %s and destination %s', async (order, companyUid) => {
    detections = [detection];
    const settings = deferred<{ defaultRecordingCompanyUid: string }>();
    const ledger = deferred<unknown[]>();
    const originalInvoke = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, ...args: unknown[]) => {
      if (command === 'get_settings') return settings.promise;
      if (command === 'meetings_list_active_recordings') return ledger.promise;
      return originalInvoke(command, ...args);
    });
    stop = startMeetingRecordingBridge();
    await settle();
    const resolveSettings = () => settings.resolve({ defaultRecordingCompanyUid: membership.companyUid });
    const resolveLedger = () => ledger.resolve([{ windowId: 'window-1', recordingId: 'existing', companyUid }]);
    if (order === 'settings first') resolveSettings();
    else resolveLedger();
    await settle();
    if (order === 'settings first') resolveLedger();
    else resolveSettings();
    await settle();
    expect(get(meetings.activeMeetings)[0]).toMatchObject({ state: 'recording', companyUid });
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(get(meetings.activeMeetings)[0]).toMatchObject({ state: 'recording', companyUid });
  });

  it('discards late hydration after an account change and disposes listeners', async () => {
    const pending = deferred<typeof detection[]>();
    mocks.invoke.mockImplementationOnce(() => pending.promise);
    stop = startMeetingRecordingBridge();
    await settle();
    stop();
    stop = startMeetingRecordingBridge();
    await settle();
    pending.resolve([detection]);
    await settle();
    expect(get(meetings.activeMeetings)).toEqual([]);
    stop();
    expect([...mocks.handlers.values()].every((set) => set.size === 0)).toBe(true);
    expect(get(meetings.recordingMemberships)).toEqual([]);
  });

  it('keeps a live recording event that arrives before the detection snapshot', async () => {
    const pending = deferred<typeof detection[]>();
    mocks.invoke.mockImplementationOnce(() => pending.promise);
    stop = startMeetingRecordingBridge();
    await settle();
    emit('recording:started', { windowId: 'window-1', platform: 'zoom' });
    pending.resolve([detection]);
    await settle();
    expect(get(meetings.activeMeetings)[0]).toMatchObject({ windowId: 'window-1', state: 'recording' });
  });

  it('disposes registrations that resolve after the host closes', async () => {
    stop = startMeetingRecordingBridge();
    stop();
    await settle();
    expect([...mocks.handlers.values()].every((set) => set.size === 0)).toBe(true);
    expect(get(meetings.activeMeetings)).toEqual([]);
  });

  it('does not resurrect a meeting closed while hydration was pending', async () => {
    const pending = deferred<typeof detection[]>();
    mocks.invoke.mockImplementationOnce(() => pending.promise);
    stop = startMeetingRecordingBridge();
    await settle();
    emit('meeting:closed', { windowId: 'window-1' });
    pending.resolve([detection]);
    await settle();
    expect(get(meetings.activeMeetings)).toEqual([]);
  });
});

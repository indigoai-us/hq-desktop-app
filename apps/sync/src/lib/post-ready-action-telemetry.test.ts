import { describe, expect, it, vi } from 'vitest';
import * as postReadyTelemetryModule from './post-ready-action-telemetry';
import {
  POST_READY_ACTIONS,
  createPostReadyActionTelemetry,
  isPostReadyActionReady,
  markPostReadyActionReady,
  type PostReadyActionEvent,
  type PostReadyActionStorage,
} from './post-ready-action-telemetry';

const closeWindowApi = vi.hoisted(() => ({ getCurrentWindow: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: closeWindowApi.getCurrentWindow,
}));

class MemoryStorage implements PostReadyActionStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function makeTracker(storage = new MemoryStorage(), flagEnabled = true) {
  const emit = vi.fn<(event: PostReadyActionEvent) => Promise<void>>(async () => {});
  const tracker = createPostReadyActionTelemetry({
    storage,
    isFlagEnabled: async () => flagEnabled,
    getIdentity: async () => ({ personUid: 'prs_person', companyUid: 'cmp_company' }),
    appVersion: '0.10.322',
    os: 'macos',
    emit,
    newSessionId: () => 'session-1',
  });
  return { storage, emit, tracker };
}

describe('post-ready action telemetry', () => {
  it('prevents Tauri from destroying the main window and still records close telemetry', async () => {
    type CloseTelemetry = { record: (action: 'close_window') => Promise<boolean> };
    const register = (
      postReadyTelemetryModule as unknown as {
        registerPostReadyCloseTelemetry?: (
          telemetry: Promise<CloseTelemetry>,
        ) => Promise<() => void>;
      }
    ).registerPostReadyCloseTelemetry;
    expect(register).toBeTypeOf('function');

    let closeHandler: ((event: { preventDefault: () => void }) => void) | undefined;
    const unlisten = vi.fn();
    const onCloseRequested = vi.fn((handler: (event: { preventDefault: () => void }) => void) => {
      closeHandler = handler;
      return Promise.resolve(unlisten);
    });
    closeWindowApi.getCurrentWindow.mockReturnValue({ onCloseRequested } as never);
    const record = vi.fn(async () => true);
    await register!(Promise.resolve({ record }));

    const event = { preventDefault: vi.fn() };
    closeHandler?.(event);
    await vi.waitFor(() => expect(record).toHaveBeenCalledWith('close_window'));
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('sends at most one event for each fixed action type in the first post-ready session', async () => {
    const setup = makeTracker();
    expect(isPostReadyActionReady(setup.storage)).toBe(false);
    markPostReadyActionReady(setup.storage);
    expect(isPostReadyActionReady(setup.storage)).toBe(true);

    for (const action of POST_READY_ACTIONS) {
      expect(await setup.tracker.record(action)).toBe(true);
      expect(await setup.tracker.record(action)).toBe(false);
    }

    expect(setup.emit).toHaveBeenCalledTimes(POST_READY_ACTIONS.length);
    expect(await setup.tracker.record('start_sync')).toBe(false);
    expect(setup.emit.mock.calls.map(([event]) => event.properties.action)).toEqual(
      [...POST_READY_ACTIONS],
    );
  });

  it('sends no event while the hq-flags key is off', async () => {
    const setup = makeTracker(new MemoryStorage(), false);
    markPostReadyActionReady(setup.storage);

    expect(await setup.tracker.record('close_window')).toBe(false);
    expect(await setup.tracker.record('start_sync')).toBe(false);
    expect(await setup.tracker.recordReturnNudge('shown', { companyUid: 'cmp_company' })).toBe(false);
    expect(setup.emit).not.toHaveBeenCalled();
  });

  it('records a return nudge after the first setup session was closed', async () => {
    const setup = makeTracker();
    markPostReadyActionReady(setup.storage);

    expect(await setup.tracker.record('close_window')).toBe(true);
    expect(await setup.tracker.recordReturnNudge('shown', { companyUid: 'cmp_company' })).toBe(true);
    expect(await setup.tracker.record('open_folder')).toBe(false);
    expect(setup.emit.mock.calls.map(([event]) => event.properties.action)).toEqual([
      'close_window', 'start_sync',
    ]);
    expect(setup.emit.mock.calls[1][0].properties.returnNudge).toBe('shown');
  });

  it('records only the bounded return nudge outcome on the existing post-ready event', async () => {
    const setup = makeTracker();
    markPostReadyActionReady(setup.storage);

    for (const value of ['shown', 'clicked', 'dismissed'] as const) {
      expect(await setup.tracker.recordReturnNudge(value, { companyUid: 'cmp_company' })).toBe(true);
    }
    expect(setup.emit).toHaveBeenCalledTimes(3);
    expect(setup.emit.mock.calls.map(([event]) => event.properties.returnNudge)).toEqual([
      'shown', 'clicked', 'dismissed',
    ]);
    for (const [event] of setup.emit.mock.calls) {
      expect(event.eventName).toBe('desktop_post_ready_action');
      expect(event.idempotencyKey).toMatch(/return-nudge\.cmp_company\.\d{4}-\d{2}-\d{2}\.(shown|clicked|dismissed)$/);
    }
  });

  it('sends only the allow-listed identity and environment fields, never folder names or paths', async () => {
    const setup = makeTracker();
    markPostReadyActionReady(setup.storage);

    await Reflect.apply(setup.tracker.record, setup.tracker, [
      'open_folder',
      { companySlug: '/Users/ada/Private Project' },
    ]);

    expect(setup.emit).toHaveBeenCalledWith(expect.objectContaining({
      eventName: 'desktop_post_ready_action',
      properties: {
        action: 'open_folder',
        personUid: 'prs_person',
        companyUid: 'cmp_company',
        appVersion: '0.10.322',
        os: 'macos',
      },
    }));
    expect(JSON.stringify(setup.emit.mock.calls)).not.toContain('Private Project');
    expect(JSON.stringify(setup.emit.mock.calls)).not.toContain('/Users/ada');
  });
});

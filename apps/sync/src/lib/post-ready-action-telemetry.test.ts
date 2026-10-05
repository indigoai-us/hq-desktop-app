import { describe, expect, it, vi } from 'vitest';
import * as postReadyTelemetryModule from './post-ready-action-telemetry';
import {
  POST_READY_ACTIONS,
  createPostReadyActionTelemetry,
  isPostReadyActionReady,
  markPostReadyActionReady,
  type PostReadyActionEvent,
  type PostReadyActionDroppedEvent,
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

function makeTracker(
  storage = new MemoryStorage(),
  flagEnabled = true,
  dropReasonEnabled = false,
  identity: { personUid: string; companyUid: string | null } | null = {
    personUid: 'prs_person',
    companyUid: 'cmp_company',
  },
) {
  const gate = { flagEnabled, dropReasonEnabled, identity, flagThrows: false, identityThrows: false };
  const emit = vi.fn<((event: PostReadyActionEvent | PostReadyActionDroppedEvent) => Promise<void>)>(async () => {});
  const tracker = createPostReadyActionTelemetry({
    storage,
    isFlagEnabled: async () => {
      if (gate.flagThrows) throw new Error('flag lookup failed');
      return gate.flagEnabled;
    },
    isDropReasonFlagEnabled: async () => gate.dropReasonEnabled,
    getIdentity: async () => {
      if (gate.identityThrows) throw new Error('identity lookup failed');
      return gate.identity;
    },
    appVersion: '0.10.322',
    os: 'macos',
    emit,
    newSessionId: () => 'session-1',
  });
  return { storage, emit, tracker, gate };
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
    const actionEvents = setup.emit.mock.calls
      .map(([event]) => event)
      .filter((event): event is PostReadyActionEvent => event.eventName === 'desktop_post_ready_action');
    expect(actionEvents.map((event) => event.properties.action)).toEqual([
      'close_window', 'start_sync',
    ]);
    expect(actionEvents[1].properties.returnNudge).toBe('shown');
  });

  it('records only the bounded return nudge outcome on the existing post-ready event', async () => {
    const setup = makeTracker();
    markPostReadyActionReady(setup.storage);

    for (const value of ['shown', 'clicked', 'dismissed'] as const) {
      expect(await setup.tracker.recordReturnNudge(value, { companyUid: 'cmp_company' })).toBe(true);
    }
    expect(setup.emit).toHaveBeenCalledTimes(3);
    const actionEvents = setup.emit.mock.calls
      .map(([event]) => event)
      .filter((event): event is PostReadyActionEvent => event.eventName === 'desktop_post_ready_action');
    expect(actionEvents.map((event) => event.properties.returnNudge)).toEqual([
      'shown', 'clicked', 'dismissed',
    ]);
    for (const event of actionEvents) {
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

  it('emits each bounded drop reason through the opt-in diagnostic event', async () => {
    const cases = [
      ['not_ready', async () => {}],
      ['already_sent', async (setup: ReturnType<typeof makeTracker>) => {
        markPostReadyActionReady(setup.storage);
        expect(await setup.tracker.record('open_folder')).toBe(true);
      }],
      ['flag_off', async (setup: ReturnType<typeof makeTracker>) => {
        setup.gate.flagEnabled = false;
        markPostReadyActionReady(setup.storage);
      }],
      ['flag_error', async (setup: ReturnType<typeof makeTracker>) => {
        setup.gate.flagThrows = true;
        markPostReadyActionReady(setup.storage);
      }],
      ['identity_error', async (setup: ReturnType<typeof makeTracker>) => {
        setup.gate.identityThrows = true;
        markPostReadyActionReady(setup.storage);
      }],
      ['identity_missing', async (setup: ReturnType<typeof makeTracker>) => {
        setup.gate.identity = null;
        markPostReadyActionReady(setup.storage);
      }],
    ] as const;

    for (const [reason, prepare] of cases) {
      const setup = makeTracker(new MemoryStorage(), true, true);
      await prepare(setup as ReturnType<typeof makeTracker>);
      expect(await setup.tracker.record('open_folder')).toBe(false);
      const dropped = setup.emit.mock.calls
        .map(([event]) => event)
        .filter((event): event is PostReadyActionDroppedEvent =>
          event.eventName === 'desktop_post_ready_action_dropped');
      expect(dropped).toHaveLength(1);
      expect(dropped[0].properties).toEqual({ reason, action: 'open_folder' });
    }
  });

  it('caps drop-reason telemetry at one event per app session', async () => {
    const setup = makeTracker(new MemoryStorage(), false, true);
    markPostReadyActionReady(setup.storage);

    expect(await setup.tracker.record('open_folder')).toBe(false);
    setup.gate.flagEnabled = true;
    setup.gate.identity = null;
    expect(await setup.tracker.record('start_sync')).toBe(false);

    const dropped = setup.emit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.eventName === 'desktop_post_ready_action_dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0].properties).toEqual({ reason: 'flag_off', action: 'open_folder' });

    const resumed = makeTracker(setup.storage, true, true, null);
    expect(await resumed.tracker.record('invite')).toBe(false);
    expect(resumed.emit).not.toHaveBeenCalled();
  });

  it('does not emit a drop reason when its diagnostic flag is off', async () => {
    const setup = makeTracker(new MemoryStorage(), false, false);
    markPostReadyActionReady(setup.storage);

    expect(await setup.tracker.record('open_folder')).toBe(false);
    expect(setup.emit).not.toHaveBeenCalled();
  });
});

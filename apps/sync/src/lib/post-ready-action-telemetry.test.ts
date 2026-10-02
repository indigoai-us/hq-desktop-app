import { describe, expect, it, vi } from 'vitest';
import {
  POST_READY_ACTIONS,
  createPostReadyActionTelemetry,
  markPostReadyActionReady,
  type PostReadyActionStorage,
} from './post-ready-action-telemetry';

class MemoryStorage implements PostReadyActionStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function makeTracker(storage = new MemoryStorage(), flagEnabled = true) {
  const emit = vi.fn(async () => {});
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
  it('sends at most one event for each fixed action type in the first post-ready session', async () => {
    const setup = makeTracker();
    markPostReadyActionReady(setup.storage);

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
    expect(setup.emit).not.toHaveBeenCalled();
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

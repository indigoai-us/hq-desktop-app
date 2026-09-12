// @vitest-environment happy-dom
//
// hq-idea-board US-012: the Ideas settings section. Defaults are the safe
// ones (on-device extraction, sync on, 2000px), the model disclosure is
// readable before any interaction, a failed chord rebind is reported inline
// and leaves the old chord on screen, and no auto-delete control exists.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, listenMock, emitMock, updateSettingsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  listenMock: vi.fn(async (..._args: unknown[]): Promise<() => void> => () => {}),
  emitMock: vi.fn(async (..._args: unknown[]): Promise<void> => {}),
  updateSettingsMock: vi.fn(async (..._args: unknown[]): Promise<void> => {}),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
  emit: (...args: unknown[]) => emitMock(...args),
  once: (...args: unknown[]) => listenMock(...args),
  TauriEvent: {},
}));

vi.mock('../lib/settings-mutations', () => ({
  updateSettings: (...args: unknown[]) => updateSettingsMock(...args),
}));

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import IdeasSettings from './IdeasSettings.svelte';

type Mounted = ReturnType<typeof mount>;
let mounted: Mounted | null = null;

const BASE_STATE = {
  extractionMode: 'local',
  syncEnabled: true,
  defaultCompany: null,
  activeCompany: 'indigo',
  imageMaxEdge: 2000,
  imageMaxEdgeChoices: [1200, 2000, 4000],
  captureChord: 'Alt+Shift+KeyC',
  captureChordDisplay: '⌥⇧C',
  modelDisclosure:
    'Model extraction sends each capture’s image and its recognized text to a vision model through HQ. The image leaves this device, and every capture processed this way adds a small per-capture cost to your account.',
  localOnly: false,
  capturesRoot: '/tmp/HQ/companies/indigo/ideas',
};

function routeInvoke(overrides: Record<string, unknown> = {}) {
  invokeMock.mockImplementation(async (command: unknown) => {
    if (command === 'ideas_get_settings') return { ...BASE_STATE, ...overrides };
    if (command === 'ideas_list_companies') return ['indigo', 'liverecover'];
    return undefined;
  });
}

async function mountPanel(): Promise<HTMLElement> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  mounted = mount(IdeasSettings, { target });
  flushSync();
  await settle();
  return target;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
    flushSync();
  }
}

function testid(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  listenMock.mockResolvedValue(() => {});
  emitMock.mockReset();
  updateSettingsMock.mockReset();
  updateSettingsMock.mockResolvedValue(undefined);
  routeInvoke();
});

afterEach(() => {
  if (mounted) {
    void unmount(mounted);
    mounted = null;
  }
  document.body.innerHTML = '';
});

describe('defaults', () => {
  it('renders on-device extraction, sync on, active company, and 2000px', async () => {
    const root = await mountPanel();
    expect(testid(root, 'ideas-extraction-chip')?.textContent?.trim()).toBe('On device');
    expect(testid(root, 'ideas-extraction-local')?.getAttribute('aria-checked')).toBe('true');
    expect(testid(root, 'ideas-extraction-model')?.getAttribute('aria-checked')).toBe('false');
    expect(testid(root, 'ideas-sync-chip')?.textContent?.trim()).toBe('Vault · synced');
    expect(testid(root, 'ideas-sync-on')?.getAttribute('aria-checked')).toBe('true');
    expect(testid(root, 'ideas-company-chip')?.textContent?.trim()).toBe('Active company');
    expect(testid(root, 'ideas-retention-chip')?.textContent?.trim()).toBe('2000 px');
    expect(testid(root, 'ideas-chord-chip')?.textContent?.trim()).toBe('⌥⇧C');
  });

  it('offers exactly the three retention choices and lists the membership companies', async () => {
    const root = await mountPanel();
    const retention = testid(root, 'ideas-retention-picker') as HTMLSelectElement;
    expect([...retention.options].map((o) => o.value)).toEqual(['1200', '2000', '4000']);
    const company = testid(root, 'ideas-company-picker') as HTMLSelectElement;
    expect([...company.options].map((o) => o.value)).toEqual(['', 'indigo', 'liverecover']);
    expect(company.options[0].textContent?.trim()).toBe('Active company (indigo)');
  });

  it('states that nothing is auto-deleted and offers no auto-delete control', async () => {
    const root = await mountPanel();
    expect(root.textContent).toContain('Nothing is ever auto-deleted.');
    expect(root.textContent?.toLowerCase()).not.toContain('delete after');
    // No control anywhere offers deletion.
    const controls = [...root.querySelectorAll('button, select, input')];
    for (const control of controls) {
      const label = `${control.textContent ?? ''} ${control.getAttribute('aria-label') ?? ''}`;
      expect(label.toLowerCase()).not.toContain('delete');
    }
  });
});

describe('extraction', () => {
  it('shows the data-leaves-device and cost disclosure before any interaction', async () => {
    const root = await mountPanel();
    const disclosure = testid(root, 'ideas-model-disclosure');
    expect(disclosure).not.toBeNull();
    expect(disclosure?.textContent).toContain('leaves this device');
    expect(disclosure?.textContent).toContain('per-capture cost');
    // Nothing has been clicked, and model is still unselected.
    expect(updateSettingsMock).not.toHaveBeenCalled();
    expect(testid(root, 'ideas-extraction-model')?.getAttribute('aria-checked')).toBe('false');
    // The disclosure precedes the control in document order.
    const control = testid(root, 'ideas-extraction-local');
    expect(
      disclosure!.compareDocumentPosition(control!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('switching to model persists ideasExtractionMode: model — only on an explicit click', async () => {
    const root = await mountPanel();
    (testid(root, 'ideas-extraction-model') as HTMLButtonElement).click();
    await settle();
    expect(updateSettingsMock).toHaveBeenCalledTimes(1);
    expect(updateSettingsMock).toHaveBeenCalledWith({ ideasExtractionMode: 'model' });
    expect(testid(root, 'ideas-extraction-chip')?.textContent?.trim()).toBe('Model');
  });

  it('reverts and reports inline when the save fails', async () => {
    const root = await mountPanel();
    updateSettingsMock.mockRejectedValueOnce('disk full');
    (testid(root, 'ideas-extraction-model') as HTMLButtonElement).click();
    await settle();
    expect(testid(root, 'ideas-extraction-chip')?.textContent?.trim()).toBe('On device');
    expect(testid(root, 'ideas-setting-error')?.textContent).toContain('disk full');
  });
});

describe('sync', () => {
  it('turning sync off persists the preference and shows the local-only note', async () => {
    const root = await mountPanel();
    expect(testid(root, 'ideas-local-only-note')).toBeNull();

    routeInvoke({
      syncEnabled: false,
      localOnly: true,
      capturesRoot: '/tmp/HQ/workspace/ideas-local/indigo',
    });
    (testid(root, 'ideas-sync-off') as HTMLButtonElement).click();
    await settle();

    expect(updateSettingsMock).toHaveBeenCalledWith({ ideasSyncEnabled: false });
    const note = testid(root, 'ideas-local-only-note');
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain('/tmp/HQ/workspace/ideas-local/indigo');
    expect(note?.textContent).toContain('outside the company vault');
    expect(testid(root, 'ideas-sync-chip')?.textContent?.trim()).toBe('Local only');
  });

  it('claims privacy for NEW captures only, never retroactively', async () => {
    // REGRESSION GUARD, retargeted. `capture.rs` now builds its write target
    // from `ideas_root(hq_root, company, sync_enabled)`, so with sync off a new
    // capture really is written outside the vault sync scope — present tense is
    // earned. What is still FALSE is any claim covering captures already taken:
    // nothing moves them, so they remain in the vault and keep syncing. The row
    // has to say that, or the user reads "local only" as retroactive.
    routeInvoke({
      syncEnabled: false,
      localOnly: true,
      capturesRoot: '/tmp/HQ/workspace/ideas-local/indigo',
    });
    const root = await mountPanel();

    const note = testid(root, 'ideas-local-only-note');
    expect(note).not.toBeNull();
    // Markup line wrapping is not meaning: collapse runs of whitespace so the
    // assertions below are about the sentence, not the column width.
    const text = (note?.textContent ?? '').replace(/\s+/g, ' ').trim();

    // What is true, stated in plain words and scoped to new captures.
    expect(text).toContain('New captures are saved to');
    expect(text).toContain('/tmp/HQ/workspace/ideas-local/indigo');
    expect(text).toContain('not synced to your team');
    // ...and the limit of the promise is stated in the same breath.
    expect(text).toContain('still in the vault and still sync');

    // None of the unqualified promises may appear.
    for (const overclaim of [
      'Captures stay on this machine',
      'Your captures are not synced',
      'nothing syncs to your team',
    ]) {
      expect(text, `the sync-off note must not claim: ${overclaim}`).not.toContain(overclaim);
    }
  });
});

describe('capture chord', () => {
  function pressChord(button: HTMLElement, init: KeyboardEventInit): void {
    button.click();
    flushSync();
    button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  }

  it('rebinds and shows the new chord when the OS accepts it', async () => {
    const root = await mountPanel();
    invokeMock.mockImplementation(async (command: unknown) => {
      if (command === 'ideas_set_capture_chord') {
        return { chord: 'Ctrl+Alt+KeyS', display: '⌃⌥S' };
      }
      return undefined;
    });
    const button = testid(root, 'ideas-chord-rebind')!;
    pressChord(button, { code: 'KeyS', key: 's', ctrlKey: true, altKey: true });
    await settle();

    expect(invokeMock).toHaveBeenCalledWith('ideas_set_capture_chord', {
      chord: 'Ctrl+Alt+KeyS',
    });
    expect(testid(root, 'ideas-chord-chip')?.textContent?.trim()).toBe('⌃⌥S');
    expect(testid(root, 'ideas-chord-error')).toBeNull();
  });

  it('reports a conflict inline and keeps the previous chord displayed', async () => {
    const root = await mountPanel();
    invokeMock.mockImplementation(async (command: unknown) => {
      if (command === 'ideas_set_capture_chord') {
        throw 'That chord is already in use by another app. The previous chord is still active — try a different combination.';
      }
      return undefined;
    });
    const button = testid(root, 'ideas-chord-rebind')!;
    pressChord(button, { code: 'KeyS', key: 's', ctrlKey: true, altKey: true });
    await settle();

    const error = testid(root, 'ideas-chord-error');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain('already in use by another app');
    // The old chord is still what the user sees — a failed rebind changes nothing.
    expect(testid(root, 'ideas-chord-chip')?.textContent?.trim()).toBe('⌥⇧C');
  });

  it('refuses a key it cannot bind, says so inline, and never calls the host', async () => {
    const root = await mountPanel();
    invokeMock.mockClear();
    const button = testid(root, 'ideas-chord-rebind')!;
    pressChord(button, { code: 'Escape', key: 'F13', ctrlKey: true });
    await settle();
    expect(invokeMock).not.toHaveBeenCalledWith('ideas_set_capture_chord', expect.anything());
    expect(testid(root, 'ideas-chord-chip')?.textContent?.trim()).toBe('⌥⇧C');
    // A refusal the user cannot see is indistinguishable from a dead button.
    const error = testid(root, 'ideas-chord-error');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain('can’t be used in a chord');
  });

  it('reports HQ\u2019s own reserved chord in the host\u2019s own words', async () => {
    // CRITICAL-6: the host refuses ⌥⇧H because HQ holds it. The panel must
    // pass that message through rather than inventing an "another app" story.
    const root = await mountPanel();
    invokeMock.mockImplementation(async (command: unknown) => {
      if (command === 'ideas_set_capture_chord') {
        throw '⌥⇧H is already used by HQ to show the popover. Pick a different combination.';
      }
      return undefined;
    });
    const button = testid(root, 'ideas-chord-rebind')!;
    pressChord(button, { code: 'KeyH', key: 'h', altKey: true, shiftKey: true });
    await settle();
    const error = testid(root, 'ideas-chord-error');
    expect(error?.textContent).toContain('already used by HQ');
    expect(error?.textContent).not.toContain('another app');
    expect(testid(root, 'ideas-chord-chip')?.textContent?.trim()).toBe('⌥⇧C');
  });

  it('surfaces a stale-previous-chord warning inline when the rebind succeeded anyway', async () => {
    // CRITICAL-4: a previous chord the OS would not release stays grabbed
    // system-wide. It used to reach a log file and nothing else.
    const root = await mountPanel();
    invokeMock.mockImplementation(async (command: unknown) => {
      if (command === 'ideas_set_capture_chord') {
        return {
          chord: 'Ctrl+Alt+KeyS',
          display: '⌃⌥S',
          staleChordWarning:
            'Your previous chord may stay reserved until HQ restarts, so other apps might not see it yet.',
        };
      }
      return undefined;
    });
    const button = testid(root, 'ideas-chord-rebind')!;
    pressChord(button, { code: 'KeyS', key: 's', ctrlKey: true, altKey: true });
    await settle();
    // The rebind DID work — the new chord is on screen…
    expect(testid(root, 'ideas-chord-chip')?.textContent?.trim()).toBe('⌃⌥S');
    // …and the caveat is visible, as a warning rather than an error.
    const warning = testid(root, 'ideas-chord-stale-warning');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain('previous chord');
    expect(testid(root, 'ideas-chord-error')).toBeNull();
  });

  it('shows no warning on a clean rebind', async () => {
    const root = await mountPanel();
    invokeMock.mockImplementation(async (command: unknown) => {
      if (command === 'ideas_set_capture_chord') {
        return { chord: 'Ctrl+Alt+KeyS', display: '⌃⌥S', staleChordWarning: null };
      }
      return undefined;
    });
    const button = testid(root, 'ideas-chord-rebind')!;
    pressChord(button, { code: 'KeyS', key: 's', ctrlKey: true, altKey: true });
    await settle();
    expect(testid(root, 'ideas-chord-stale-warning')).toBeNull();
  });
});

describe('load failure', () => {
  it('shows the error and refuses to present fallback defaults as saved settings', async () => {
    // CRITICAL-5: `ideas_get_settings` fails for real reasons (an unconfigured
    // vault target, for one). The panel used to swallow it and render
    // local/on/2000px/⌥⇧C as though the user had chosen them.
    invokeMock.mockImplementation(async (command: unknown) => {
      if (command === 'ideas_get_settings') throw 'vault target is not configured';
      if (command === 'ideas_list_companies') return [];
      return undefined;
    });
    const root = await mountPanel();

    const error = testid(root, 'ideas-load-error');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain('vault target is not configured');
    // The banner used to say "nothing below is showing your saved choices",
    // which is stale now that a failed load hides the rows outright.
    expect(error?.textContent).not.toContain('nothing below');
    expect(error?.textContent).toContain('hidden rather than shown wrong');

    // None of the fallback-valued controls are on screen claiming to be state.
    for (const id of [
      'ideas-extraction-chip',
      'ideas-sync-chip',
      'ideas-company-chip',
      'ideas-retention-chip',
      'ideas-chord-chip',
      'ideas-extraction-local',
      'ideas-retention-picker',
      'ideas-chord-rebind',
    ]) {
      expect(testid(root, id), `${id} must not render after a failed load`).toBeNull();
    }
  });
});

describe('default company', () => {
  it('names a stored company that is no longer in the membership list', async () => {
    // Otherwise the <select> renders blank while the chip shows the slug — the
    // control and its label disagree, and the user cannot tell what is set.
    routeInvoke({ defaultCompany: 'oldco' });
    invokeMock.mockImplementation(async (command: unknown) => {
      if (command === 'ideas_get_settings') return { ...BASE_STATE, defaultCompany: 'oldco' };
      if (command === 'ideas_list_companies') return ['indigo', 'liverecover'];
      return undefined;
    });
    const root = await mountPanel();
    const picker = testid(root, 'ideas-company-picker') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toContain('oldco');
    expect(picker.value).toBe('oldco');
    const missing = testid(root, 'ideas-company-missing');
    expect(missing?.textContent).toContain('oldco');
    expect(missing?.textContent).toContain('not in your current membership list');
    expect(testid(root, 'ideas-company-chip')?.textContent?.trim()).toBe('oldco');
  });

  it('adds no phantom option when the stored company is a real member', async () => {
    invokeMock.mockImplementation(async (command: unknown) => {
      if (command === 'ideas_get_settings') return { ...BASE_STATE, defaultCompany: 'liverecover' };
      if (command === 'ideas_list_companies') return ['indigo', 'liverecover'];
      return undefined;
    });
    const root = await mountPanel();
    expect(testid(root, 'ideas-company-missing')).toBeNull();
    const picker = testid(root, 'ideas-company-picker') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(['', 'indigo', 'liverecover']);
  });
});

describe('extraction mode from the host', () => {
  it('never renders Model for an absent, unknown, or malformed extractionMode', async () => {
    // The host resolves this (`parse_mode` defaults to local), but the panel's
    // own fallback must agree: model extraction costs money and sends the
    // image off-device, so it can only ever be shown when explicitly chosen.
    for (const hostile of [undefined, null, '', 'MODEL', 'Model ', 'modelx', 'ocr', 42, {}]) {
      invokeMock.mockImplementation(async (command: unknown) => {
        if (command === 'ideas_get_settings') return { ...BASE_STATE, extractionMode: hostile };
        if (command === 'ideas_list_companies') return [];
        return undefined;
      });
      const root = await mountPanel();
      expect(
        testid(root, 'ideas-extraction-chip')?.textContent?.trim(),
        `extractionMode ${JSON.stringify(hostile)} must not select Model`,
      ).toBe('On device');
      expect(testid(root, 'ideas-extraction-model')?.getAttribute('aria-checked')).toBe('false');
      if (mounted) {
        void unmount(mounted);
        mounted = null;
      }
      document.body.innerHTML = '';
    }
  });
});

describe('no native dialogs', () => {
  it('never reaches for confirm/alert/prompt', async () => {
    // happy-dom does not implement these, so install spies the component
    // would hit if it ever reached for a native dialog.
    const confirmSpy = vi.fn(() => true);
    const alertSpy = vi.fn();
    const promptSpy = vi.fn(() => null);
    Object.assign(window, { confirm: confirmSpy, alert: alertSpy, prompt: promptSpy });
    const root = await mountPanel();
    updateSettingsMock.mockRejectedValueOnce('nope');
    (testid(root, 'ideas-sync-off') as HTMLButtonElement).click();
    await settle();
    expect(testid(root, 'ideas-setting-error')?.textContent).toContain('nope');
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
  });
});

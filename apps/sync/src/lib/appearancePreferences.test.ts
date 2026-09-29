// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import {
  APPEARANCE_CHANGE_EVENT,
  APPEARANCE_REQUEST_EVENT,
  APPEARANCE_STORAGE_KEY,
  applyAppearancePreferences,
  effectiveWindowTransparency,
  installAppearancePreferences,
  normalizeAppearancePreferences,
  readAppearancePreferences,
  requestAppearancePreferenceChange,
  windowOpacityFromTransparency,
  windowTransparencyFromOpacity,
} from './appearancePreferences';
import {
  readAppearanceState,
  setAppearanceColorTheme,
  setAppearanceWindowOpacity,
} from '@hq/ui/appearance-store';

function memoryStorage(seed?: string): Storage {
  const values = new Map<string, string>();
  if (seed) values.set(APPEARANCE_STORAGE_KEY, seed);
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function fakeTarget(): Window {
  return new EventTarget() as Window;
}

function fakeRoot() {
  const values = new Map<string, string>();
  return {
    root: {
      dataset: {} as DOMStringMap,
      style: {
        setProperty: (key: string, value: string) => {
          values.set(key, value);
        },
        removeProperty: (key: string) => {
          const previous = values.get(key) ?? '';
          values.delete(key);
          return previous;
        },
      },
    },
    value: (key: string) => values.get(key) ?? '',
  };
}

describe('appearance preferences', () => {
  it('defaults to system, fully solid, and clamps malformed values', () => {
    expect(readAppearancePreferences(memoryStorage())).toEqual({
      colorTheme: 'system',
      windowTransparency: 0,
    });
    expect(
      normalizeAppearancePreferences({
        colorTheme: 'sepia' as never,
        windowTransparency: 500,
      }),
    ).toEqual({
      colorTheme: 'system',
      windowTransparency: 65,
    });
  });

  it('exposes the slider 35–100 opacity scale with a true solid endpoint', () => {
    expect(windowOpacityFromTransparency(0)).toBe(100);
    expect(windowTransparencyFromOpacity(100)).toBe(0);
    expect(windowOpacityFromTransparency(100)).toBe(35);
    expect(windowTransparencyFromOpacity(0)).toBe(65);
    expect(windowTransparencyFromOpacity(500)).toBe(0);
    expect(windowTransparencyFromOpacity(-500)).toBe(65);
    expect(windowTransparencyFromOpacity('not-a-number')).toBe(0);
  });

  it('uses safe defaults when appearance storage is absent', () => {
    expect(readAppearancePreferences(null)).toEqual({
      colorTheme: 'system',
      windowTransparency: 0,
    });
    expect(() =>
      requestAppearancePreferenceChange(
        { colorTheme: 'light' },
        { target: fakeTarget(), storage: null },
      ),
    ).not.toThrow();
  });

  it('applies forced themes and neutral material alpha without disabling glass', () => {
    const { root, value } = fakeRoot();
    applyAppearancePreferences(root, {
      colorTheme: 'dark',
      windowTransparency: 60,
    });

    expect(root.dataset.forceTheme).toBe('dark');
    expect(root.dataset.windowTransparency).toBe('60');
    expect(value('--hq-window-transparency-factor')).toBe('0.60');
    expect(value('--hq-window-alpha-light')).toBe('0.40');
    expect(value('--hq-window-alpha-dark')).toBe('0.53');

    applyAppearancePreferences(root, {
      colorTheme: 'system',
      windowTransparency: 0,
    });
    expect(root.dataset.forceTheme).toBeUndefined();
    expect(value('--hq-window-transparency-factor')).toBe('0.00');
    expect(value('--hq-window-alpha-light')).toBe('1.00');
  });

  it('persists and applies same-window requests immediately', () => {
    const storage = memoryStorage();
    const target = fakeTarget();
    const { root } = fakeRoot();
    const changes: unknown[] = [];
    const listener = (event: Event) => {
      changes.push((event as CustomEvent).detail);
    };
    target.addEventListener(APPEARANCE_CHANGE_EVENT, listener);
    const cleanup = installAppearancePreferences({
      target,
      storage,
      root,
    });

    const next = requestAppearancePreferenceChange(
      { colorTheme: 'light', windowTransparency: 42 },
      { target, storage },
    );

    expect(next).toEqual({ colorTheme: 'light', windowTransparency: 42 });
    expect(JSON.parse(storage.getItem(APPEARANCE_STORAGE_KEY) ?? '{}')).toEqual({
      v: 2,
      ...next,
      windowTransparencySet: true,
    });
    expect(root.dataset.forceTheme).toBe('light');
    expect(changes.at(-1)).toEqual(next);

    cleanup();
    target.removeEventListener(APPEARANCE_CHANGE_EVENT, listener);
  });

  it('persists raw request events from packages/ui so the slider survives a restart', () => {
    const storage = memoryStorage();
    const target = fakeTarget();
    const { root } = fakeRoot();
    const cleanup = installAppearancePreferences({ target, storage, root });

    // packages/ui's applyWindowOpacity dispatches the event directly; it
    // cannot call requestAppearancePreferenceChange (which writes storage).
    target.dispatchEvent(
      new CustomEvent(APPEARANCE_REQUEST_EVENT, {
        detail: { colorTheme: 'system', windowTransparency: 12 },
      }),
    );
    cleanup();

    expect(JSON.parse(storage.getItem(APPEARANCE_STORAGE_KEY) ?? '{}')).toEqual({
      v: 2,
      colorTheme: 'system',
      windowTransparency: 12,
      windowTransparencySet: true,
    });
    // A fresh install (next launch) reads the persisted value.
    const { root: nextRoot } = fakeRoot();
    const cleanupNext = installAppearancePreferences({ target: fakeTarget(), storage, root: nextRoot });
    expect(nextRoot.dataset.windowTransparency).toBe('12');
    cleanupNext();
  });

  it('drives the native backdrop with each distinct transparency value', async () => {
    const storage = memoryStorage();
    const target = fakeTarget();
    const { root } = fakeRoot();
    const applyNativeTransparency = vi.fn();
    const cleanup = installAppearancePreferences({
      target,
      storage,
      root,
      applyNativeTransparency,
    });
    requestAppearancePreferenceChange({ windowTransparency: 40 }, { target, storage });
    requestAppearancePreferenceChange({ windowTransparency: 40 }, { target, storage });
    requestAppearancePreferenceChange({ windowTransparency: 0 }, { target, storage });
    await Promise.resolve();
    await Promise.resolve();

    // Boot applies the solid default (0) before anything else.
    expect(applyNativeTransparency.mock.calls.map(([value]) => value)).toEqual([0, 40, 0]);
    cleanup();
  });

  it('serializes native theme updates so the newest request wins', async () => {
    const storage = memoryStorage();
    const target = fakeTarget();
    const { root } = fakeRoot();
    const release: Array<() => void> = [];
    const applied: Array<'light' | 'dark' | null> = [];
    const applyNativeTheme = vi.fn(async (theme: 'light' | 'dark' | null) => {
      applied.push(theme);
      await new Promise<void>((resolve) => release.push(resolve));
    });
    const cleanup = installAppearancePreferences({
      target,
      storage,
      root,
      applyNativeTheme,
    });

    requestAppearancePreferenceChange({ colorTheme: 'light' }, { target, storage });
    requestAppearancePreferenceChange({ colorTheme: 'dark' }, { target, storage });
    expect(applied).toEqual([null]);

    release.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual([null, 'dark']);
    release.shift()?.();
    await Promise.resolve();

    cleanup();
    expect(applyNativeTheme).toHaveBeenCalledTimes(2);
  });

  it('does not retry a rejected native theme until a new preference request arrives', async () => {
    const storage = memoryStorage();
    const target = fakeTarget();
    const { root } = fakeRoot();
    const failure = new Error('native theme unavailable');
    const applyNativeTheme = vi
      .fn<(theme: 'light' | 'dark' | null) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockReturnValue(new Promise<void>(() => {}));
    const onError = vi.fn();
    const cleanup = installAppearancePreferences({
      target,
      storage,
      root,
      applyNativeTheme,
      onError,
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(applyNativeTheme).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);

    requestAppearancePreferenceChange(
      { colorTheme: 'dark' },
      { target, storage },
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(applyNativeTheme).toHaveBeenCalledTimes(2);
    expect(applyNativeTheme).toHaveBeenLastCalledWith('dark');
    expect(onError).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('retains earlier partial changes when appearance storage throws', () => {
    const target = fakeTarget();
    const { root } = fakeRoot();
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('storage read blocked');
      }),
      setItem: vi.fn(() => {
        throw new Error('storage write blocked');
      }),
    };
    const cleanup = installAppearancePreferences({
      target,
      storage,
      root,
    });

    expect(
      requestAppearancePreferenceChange(
        { colorTheme: 'dark' },
        { target, storage },
      ),
    ).toEqual({
      colorTheme: 'dark',
      windowTransparency: 0,
    });
    expect(
      requestAppearancePreferenceChange(
        { windowTransparency: 20 },
        { target, storage },
      ),
    ).toEqual({
      colorTheme: 'dark',
      windowTransparency: 20,
    });
    expect(root.dataset.forceTheme).toBe('dark');
    expect(root.dataset.windowTransparency).toBe('20');

    cleanup();
  });

  it('ignores unrelated storage events and follows appearance changes from another window', () => {
    const target = fakeTarget();
    const storage = memoryStorage();
    const { root } = fakeRoot();
    const cleanup = installAppearancePreferences({
      target,
      storage,
      root,
    });

    storage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        colorTheme: 'dark',
        windowTransparency: 30,
      }),
    );
    target.dispatchEvent(
      Object.assign(new Event('storage'), { key: 'unrelated.preference' }),
    );
    expect(root.dataset.forceTheme).toBeUndefined();

    target.dispatchEvent(
      Object.assign(new Event('storage'), { key: APPEARANCE_STORAGE_KEY }),
    );
    expect(root.dataset.forceTheme).toBe('dark');
    expect(root.dataset.windowTransparency).toBe('30');

    cleanup();
  });

  it('uses a dedicated request event rather than relying on same-window storage events', () => {
    expect(APPEARANCE_REQUEST_EVENT).toBe('hq:appearance-request');
  });
});

describe('window material without real glass', () => {
  it('preserves the reference alpha over glass and vibrancy, with an absent-material fallback', () => {
    expect(effectiveWindowTransparency(65, 'glass')).toBe(65);
    expect(effectiveWindowTransparency(65, null)).toBe(65);
    expect(effectiveWindowTransparency(65, 'vibrancy')).toBe(65);
    expect(effectiveWindowTransparency(65, 'none')).toBe(15);
    expect(effectiveWindowTransparency(5, 'vibrancy')).toBe(5);
  });

  it('re-applies once the native material is known, keeping the stored preference', async () => {
    const root = { dataset: {} as Record<string, string>, style: { setProperty: vi.fn(), removeProperty: vi.fn() } };
    const storage = new Map<string, string>();
    const store = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
    store.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ colorTheme: 'system', windowTransparency: 40 }));
    const dispose = installAppearancePreferences({
      target: new EventTarget() as unknown as Window,
      storage: store as unknown as Storage,
      root: root as never,
      readMaterial: async () => 'vibrancy',
    });
    await new Promise((r) => setTimeout(r, 0));
    const factor = (root.style.setProperty as ReturnType<typeof vi.fn>).mock.calls
      .filter(([name]) => name === '--hq-window-transparency-factor')
      .map(([, v]) => v);
    expect(factor[0]).toBe('0.40');
    expect(factor.at(-1)).toBe('0.40');
    expect(root.dataset.material).toBe('vibrancy');
    expect(root.dataset.windowTransparency).toBe('40');
    dispose();
  });
});

describe('one Appearance source of truth (default 100% opacity)', () => {
  it('boots a fresh profile fully solid in the window, the native backdrop, and the slider', async () => {
    const storage = memoryStorage();
    const target = fakeTarget();
    const root = document.createElement('html');
    const applyNativeTransparency = vi.fn();
    const cleanup = installAppearancePreferences({
      target,
      storage,
      root,
      applyNativeTransparency,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(root.dataset.windowTransparency).toBe('0');
    expect(root.style.getPropertyValue('--hq-window-alpha-light')).toBe('1.00');
    expect(applyNativeTransparency).toHaveBeenCalledWith(0);
    // The value every slider renders comes from the same applied marker.
    expect(readAppearanceState({ root, storage }).windowOpacity).toBe(100);
    // Nothing chosen, nothing persisted.
    expect(storage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull();
    cleanup();
  });

  it.each([
    // [legacy stored transparency, applied transparency, slider opacity]
    [65, 0, 100], // old app-written default: reset to solid
    [20, 20, 80], // chosen with the slider: kept
    [90, 65, 35], // chosen but out of range: clamped for both window and slider
  ])(
    'on upgrade, legacy %i applies %i and the slider shows %i',
    async (legacy, applied, opacity) => {
      const storage = memoryStorage(
        JSON.stringify({ colorTheme: 'dark', windowTransparency: legacy }),
      );
      // The retired second store must not influence the slider any more.
      storage.setItem('hq-work-settings-prefs', JSON.stringify({ windowOpacity: 100 }));
      const target = fakeTarget();
      const root = document.createElement('html');
      const applyNativeTransparency = vi.fn();
      const cleanup = installAppearancePreferences({
        target,
        storage,
        root,
        applyNativeTransparency,
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(root.dataset.windowTransparency).toBe(String(applied));
      expect(applyNativeTransparency).toHaveBeenCalledWith(applied);
      expect(readAppearanceState({ root, storage })).toEqual({
        colorTheme: 'dark',
        windowOpacity: opacity,
      });
      // The upgrade is written back once, so every window agrees.
      expect(JSON.parse(storage.getItem(APPEARANCE_STORAGE_KEY) ?? '{}')).toMatchObject({
        v: 2,
        windowTransparency: applied,
        windowTransparencySet: legacy !== 65,
      });
      cleanup();
    },
  );

  it('a theme-only change does not mark the default transparency as chosen', () => {
    const storage = memoryStorage();
    const target = fakeTarget();
    const root = document.createElement('html');
    const cleanup = installAppearancePreferences({ target, storage, root });
    setAppearanceColorTheme('light', { root, target, storage });
    expect(root.dataset.forceTheme).toBe('light');
    expect(JSON.parse(storage.getItem(APPEARANCE_STORAGE_KEY) ?? '{}')).toMatchObject({
      colorTheme: 'light',
      windowTransparency: 0,
      windowTransparencySet: false,
    });
    cleanup();
  });

  it('the shared store drives the host: opacity reaches the window and the native backdrop', async () => {
    const storage = memoryStorage();
    const target = fakeTarget();
    const root = document.createElement('html');
    const applyNativeTransparency = vi.fn();
    const cleanup = installAppearancePreferences({
      target,
      storage,
      root,
      applyNativeTransparency,
    });
    const state = setAppearanceWindowOpacity(70, { root, target, storage });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.windowOpacity).toBe(70);
    expect(root.dataset.windowTransparency).toBe('30');
    expect(applyNativeTransparency).toHaveBeenLastCalledWith(30);
    expect(readAppearancePreferences(storage).windowTransparency).toBe(30);
    cleanup();
  });
});

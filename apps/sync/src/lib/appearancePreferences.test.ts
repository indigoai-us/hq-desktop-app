import { describe, expect, it, vi } from 'vitest';
import {
  APPEARANCE_CHANGE_EVENT,
  APPEARANCE_REQUEST_EVENT,
  APPEARANCE_STORAGE_KEY,
  applyAppearancePreferences,
  installAppearancePreferences,
  normalizeAppearancePreferences,
  readAppearancePreferences,
  requestAppearancePreferenceChange,
} from './appearancePreferences';

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
  it('defaults to system and clamps malformed values', () => {
    expect(readAppearancePreferences(memoryStorage())).toEqual({
      colorTheme: 'system',
    });
    expect(
      normalizeAppearancePreferences({ colorTheme: 'sepia' as never }),
    ).toEqual({ colorTheme: 'system' });
  });

  it('uses safe defaults when appearance storage is absent', () => {
    expect(readAppearancePreferences(null)).toEqual({
      colorTheme: 'system',
    });
    expect(() =>
      requestAppearancePreferenceChange(
        { colorTheme: 'light' },
        { target: fakeTarget(), storage: null },
      ),
    ).not.toThrow();
  });

  it('applies forced themes and leaves surface alpha to the tokens', () => {
    const { root, value } = fakeRoot();
    applyAppearancePreferences(root, { colorTheme: 'dark' });

    expect(root.dataset.forceTheme).toBe('dark');
    // Surface alpha is fixed in tokens.css at the design's values. Nothing
    // here may write it back onto <html> — that is how it became adjustable.
    expect(root.dataset.windowTransparency).toBeUndefined();
    expect(value('--hq-window-transparency-factor')).toBe('');
    expect(value('--hq-window-alpha-light')).toBe('');

    applyAppearancePreferences(root, { colorTheme: 'system' });
    expect(root.dataset.forceTheme).toBeUndefined();
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
      { colorTheme: 'light' },
      { target, storage },
    );

    expect(next).toEqual({ colorTheme: 'light' });
    expect(JSON.parse(storage.getItem(APPEARANCE_STORAGE_KEY) ?? '{}')).toEqual(next);
    expect(root.dataset.forceTheme).toBe('light');
    expect(changes.at(-1)).toEqual(next);

    cleanup();
    target.removeEventListener(APPEARANCE_CHANGE_EVENT, listener);
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
    ).toEqual({ colorTheme: 'dark' });
    // A second request still applies in-window even though nothing persisted.
    expect(
      requestAppearancePreferenceChange(
        { colorTheme: 'light' },
        { target, storage },
      ),
    ).toEqual({ colorTheme: 'light' });
    expect(root.dataset.forceTheme).toBe('light');

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
      JSON.stringify({ colorTheme: 'dark' }),
    );
    target.dispatchEvent(
      Object.assign(new Event('storage'), { key: 'unrelated.preference' }),
    );
    expect(root.dataset.forceTheme).toBeUndefined();

    target.dispatchEvent(
      Object.assign(new Event('storage'), { key: APPEARANCE_STORAGE_KEY }),
    );
    expect(root.dataset.forceTheme).toBe('dark');

    cleanup();
  });

  it('uses a dedicated request event rather than relying on same-window storage events', () => {
    expect(APPEARANCE_REQUEST_EVENT).toBe('hq:appearance-request');
  });
});

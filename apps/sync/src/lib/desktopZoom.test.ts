import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DESKTOP_ZOOM,
  DESKTOP_ZOOM_STORAGE_KEY,
  DESKTOP_ZOOM_CHANGE_EVENT,
  DESKTOP_ZOOM_REQUEST_EVENT,
  desktopZoomActionForKey,
  installDesktopZoom,
  MAX_DESKTOP_ZOOM,
  MIN_DESKTOP_ZOOM,
  nextDesktopZoom,
  normalizeDesktopZoom,
  readDesktopZoom,
  requestDesktopZoom,
  scaleDesktopWindowSize,
  writeDesktopZoom,
} from './desktopZoom';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('desktop zoom', () => {
  it('recognizes macOS and Windows zoom shortcuts', () => {
    expect(desktopZoomActionForKey({ key: '=', code: 'Equal', metaKey: true })).toBe('in');
    expect(desktopZoomActionForKey({ key: '+', code: 'Equal', metaKey: true })).toBe('in');
    expect(desktopZoomActionForKey({ key: '-', code: 'Minus', metaKey: true })).toBe('out');
    expect(desktopZoomActionForKey({ key: '0', code: 'Digit0', metaKey: true })).toBe('reset');
    expect(
      desktopZoomActionForKey({
        key: '=',
        code: 'Equal',
        metaKey: false,
        ctrlKey: true,
      }),
    ).toBe('in');
    expect(
      desktopZoomActionForKey({
        key: '-',
        code: 'Minus',
        metaKey: false,
        ctrlKey: true,
      }),
    ).toBe('out');
  });

  it('does not steal unmodified, double-modified, Alt, composed, or handled input', () => {
    expect(desktopZoomActionForKey({ key: '=', metaKey: false })).toBeNull();
    expect(desktopZoomActionForKey({ key: '=', metaKey: true, ctrlKey: true })).toBeNull();
    expect(desktopZoomActionForKey({ key: '-', metaKey: true, altKey: true })).toBeNull();
    expect(desktopZoomActionForKey({ key: '0', metaKey: true, isComposing: true })).toBeNull();
    expect(desktopZoomActionForKey({ key: '+', metaKey: true, defaultPrevented: true })).toBeNull();
  });

  it('steps by ten percent, resets, and clamps to the accessible range', () => {
    expect(nextDesktopZoom(1, 'in')).toBe(1.1);
    expect(nextDesktopZoom(1, 'out')).toBe(0.9);
    expect(nextDesktopZoom(1.4, 'reset')).toBe(DEFAULT_DESKTOP_ZOOM);
    expect(nextDesktopZoom(MAX_DESKTOP_ZOOM, 'in')).toBe(MAX_DESKTOP_ZOOM);
    expect(nextDesktopZoom(MIN_DESKTOP_ZOOM, 'out')).toBe(MIN_DESKTOP_ZOOM);
  });

  it('normalizes tampered or obsolete persisted values', () => {
    expect(normalizeDesktopZoom('1.399999')).toBe(1.4);
    expect(normalizeDesktopZoom('99')).toBe(MAX_DESKTOP_ZOOM);
    expect(normalizeDesktopZoom('-2')).toBe(MIN_DESKTOP_ZOOM);
    expect(normalizeDesktopZoom('not-a-number')).toBe(DEFAULT_DESKTOP_ZOOM);
  });

  it.each([
    { zoom: 0.8, expected: { width: 53, height: 35 } },
    { zoom: 1, expected: { width: 66, height: 43 } },
    { zoom: 1.6, expected: { width: 106, height: 69 } },
  ])(
    'scales fixed-window geometry at $zoom without rounding below its content',
    ({ zoom, expected }) => {
      expect(scaleDesktopWindowSize({ width: 66, height: 43 }, zoom)).toEqual(
        expected,
      );
    },
  );

  it('persists and restores the zoom preference without requiring storage', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    writeDesktopZoom(storage, 1.3);
    expect(values.get(DESKTOP_ZOOM_STORAGE_KEY)).toBe('1.3');
    expect(readDesktopZoom(storage)).toBe(1.3);
    expect(readDesktopZoom(null)).toBe(DEFAULT_DESKTOP_ZOOM);
  });

  it('persists and dispatches same-window requests from Appearance settings', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const dispatchEvent = vi.fn<(event: Event) => boolean>(() => true);
    const target = { dispatchEvent } as unknown as Window;

    expect(requestDesktopZoom(1.3, { target, storage })).toBe(1.3);
    expect(values.get(DESKTOP_ZOOM_STORAGE_KEY)).toBe('1.3');
    const event = dispatchEvent.mock.calls[0]![0] as CustomEvent<{
      zoom: number;
    }>;
    expect(event.type).toBe(DESKTOP_ZOOM_REQUEST_EVENT);
    expect(event.detail).toEqual({ zoom: 1.3 });
  });

  it('applies the persisted value immediately and cleans up both global listeners', () => {
    const listeners = new Map<string, EventListener>();
    const target = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string) => {
        listeners.delete(type);
      }),
    } as unknown as Window;
    const storage = {
      getItem: () => '1.2',
      setItem: vi.fn(),
    };
    const applyZoom = vi.fn();

    const cleanup = installDesktopZoom({ target, storage, applyZoom });

    expect(applyZoom).toHaveBeenCalledWith(1.2);
    expect(listeners.has('keydown')).toBe(true);
    expect(listeners.has('storage')).toBe(true);
    expect(listeners.has(DESKTOP_ZOOM_REQUEST_EVENT)).toBe(true);

    cleanup();
    expect(listeners.size).toBe(0);
  });

  it('announces applied zoom so fixed native windows can resize with their content', () => {
    const listeners = new Map<string, EventListener>();
    const dispatchEvent = vi.fn((_event: Event) => true);
    const target = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent,
    } as unknown as Window;

    installDesktopZoom({
      target,
      storage: null,
      applyZoom: vi.fn(),
    });

    expect(dispatchEvent).toHaveBeenCalledOnce();
    const event = dispatchEvent.mock.calls[0]![0] as CustomEvent<{
      zoom: number;
    }>;
    expect(event.type).toBe(DESKTOP_ZOOM_CHANGE_EVENT);
    expect(event.detail).toEqual({ zoom: 1 });
  });

  it('persists accepted shortcuts and follows the shared preference from another window', () => {
    const listeners = new Map<string, EventListener>();
    const target = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string) => {
        listeners.delete(type);
      }),
    } as unknown as Window;
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const applyZoom = vi.fn();
    const preventDefault = vi.fn();

    const cleanup = installDesktopZoom({ target, storage, applyZoom });
    listeners.get('keydown')?.({
      key: '=',
      code: 'Equal',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(values.get(DESKTOP_ZOOM_STORAGE_KEY)).toBe('1.1');
    expect(applyZoom).toHaveBeenLastCalledWith(1.1);

    values.set(DESKTOP_ZOOM_STORAGE_KEY, '1.4');
    listeners.get('storage')?.({
      key: DESKTOP_ZOOM_STORAGE_KEY,
    } as StorageEvent);
    expect(applyZoom).toHaveBeenLastCalledWith(1.4);

    cleanup();
  });

  it('reports a rejected native zoom request without dropping the handlers', async () => {
    const listeners = new Map<string, EventListener>();
    const target = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    const failure = new Error('native zoom unavailable');
    const applyZoom = vi.fn().mockRejectedValue(failure);
    const onError = vi.fn();

    const cleanup = installDesktopZoom({
      target,
      storage: null,
      applyZoom,
      onError,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(listeners.has('keydown')).toBe(true);
    expect(listeners.has('storage')).toBe(true);
    cleanup();
  });

  it('serializes native zoom writes and coalesces pending shortcuts to the latest value', async () => {
    const listeners = new Map<string, EventListener>();
    const target = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    } as unknown as Window;
    const firstApply = deferred<void>();
    const applyZoom = vi
      .fn<(value: number) => Promise<void>>()
      .mockReturnValueOnce(firstApply.promise)
      .mockResolvedValue(undefined);

    const cleanup = installDesktopZoom({
      target,
      storage: null,
      applyZoom,
    });
    const zoomIn = {
      key: '=',
      code: 'Equal',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;

    listeners.get('keydown')?.(zoomIn);
    listeners.get('keydown')?.(zoomIn);

    expect(applyZoom.mock.calls).toEqual([[1]]);

    firstApply.resolve();
    await firstApply.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(applyZoom.mock.calls).toEqual([[1], [1.2]]);
    cleanup();
  });

  it('wires every HQ WebView and grants each window the zoom capability', () => {
    const desktopMain = source('../desktop-alt/main.ts');
    const appMain = source('../main.ts');
    const capabilityFiles = [
      'activity-log.json',
      'default.json',
      'desktop-alt.json',
      'dm-banner.json',
      'dm-detail.json',
      'drift-detail.json',
      'meeting-permissions.json',
      'meetings-window.json',
      'messages.json',
      'new-files-detail.json',
      'share-detail.json',
      'widget.json',
    ];

    expect(desktopMain).toContain('installDesktopZoom()');
    expect(appMain).toContain('installDesktopZoom()');
    expect(appMain).not.toContain("windowLabel === 'messages') {\n  installDesktopZoom()");
    for (const capabilityFile of capabilityFiles) {
      expect(
        source(`../../src-tauri/capabilities/${capabilityFile}`),
        capabilityFile,
      ).toContain('core:webview:allow-set-webview-zoom');
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

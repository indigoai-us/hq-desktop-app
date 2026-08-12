import { getCurrentWebview } from '@tauri-apps/api/webview';

export const DESKTOP_ZOOM_STORAGE_KEY = 'hq-sync.desktop.zoom.v1';
export const DESKTOP_ZOOM_CHANGE_EVENT = 'hq:desktop-zoom-change';
export const DESKTOP_ZOOM_REQUEST_EVENT = 'hq:desktop-zoom-request';
export const DEFAULT_DESKTOP_ZOOM = 1;
export const MIN_DESKTOP_ZOOM = 0.8;
export const MAX_DESKTOP_ZOOM = 1.6;
export const DESKTOP_ZOOM_STEP = 0.1;

export type DesktopZoomAction = 'in' | 'out' | 'reset';

export interface DesktopWindowSize {
  width: number;
  height: number;
}

type ZoomStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface DesktopZoomKeyEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
}

interface DesktopZoomOptions {
  applyZoom?: (value: number) => Promise<void> | void;
  storage?: ZoomStorage | null;
  target?: Window;
  onError?: (error: unknown) => void;
}

type DesktopZoomRequestOptions = Pick<DesktopZoomOptions, 'storage' | 'target'>;

function roundZoom(value: number): number {
  return Math.round(value * 10) / 10;
}

export function normalizeDesktopZoom(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_DESKTOP_ZOOM;
  return roundZoom(Math.min(MAX_DESKTOP_ZOOM, Math.max(MIN_DESKTOP_ZOOM, numeric)));
}

export function readDesktopZoom(storage: ZoomStorage | null): number {
  if (!storage) return DEFAULT_DESKTOP_ZOOM;

  try {
    const stored = storage.getItem(DESKTOP_ZOOM_STORAGE_KEY);
    return stored === null ? DEFAULT_DESKTOP_ZOOM : normalizeDesktopZoom(stored);
  } catch {
    return DEFAULT_DESKTOP_ZOOM;
  }
}

export function readBrowserDesktopZoom(): number {
  return readDesktopZoom(getBrowserStorage());
}

export function writeDesktopZoom(storage: ZoomStorage | null, value: number): void {
  if (!storage) return;

  try {
    storage.setItem(DESKTOP_ZOOM_STORAGE_KEY, String(normalizeDesktopZoom(value)));
  } catch {
    // Zoom still works for this session when storage is unavailable or full.
  }
}

export function desktopZoomActionForKey(
  event: DesktopZoomKeyEvent,
): DesktopZoomAction | null {
  const hasOnePlatformModifier =
    Boolean(event.metaKey) !== Boolean(event.ctrlKey);
  if (
    !hasOnePlatformModifier ||
    event.altKey ||
    event.defaultPrevented ||
    event.isComposing
  ) {
    return null;
  }

  if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') {
    return 'in';
  }
  if (event.key === '-' || event.code === 'NumpadSubtract') return 'out';
  if (event.key === '0') return 'reset';
  return null;
}

export function requestDesktopZoom(
  value: number,
  options: DesktopZoomRequestOptions = {},
): number {
  const target = options.target ?? window;
  const storage =
    options.storage === undefined ? getBrowserStorage() : options.storage;
  const zoom = normalizeDesktopZoom(value);
  writeDesktopZoom(storage, zoom);
  target.dispatchEvent(
    new CustomEvent<{ zoom: number }>(DESKTOP_ZOOM_REQUEST_EVENT, {
      detail: { zoom },
    }),
  );
  return zoom;
}

export function nextDesktopZoom(current: number, action: DesktopZoomAction): number {
  if (action === 'reset') return DEFAULT_DESKTOP_ZOOM;
  const delta = action === 'in' ? DESKTOP_ZOOM_STEP : -DESKTOP_ZOOM_STEP;
  return normalizeDesktopZoom(current + delta);
}

/**
 * Grow a fixed native viewport alongside WebView zoom. Ceil each dimension so
 * fractional scaling can never leave the final device pixel clipped.
 */
export function scaleDesktopWindowSize(
  size: DesktopWindowSize,
  zoom: unknown,
): DesktopWindowSize {
  const factor = normalizeDesktopZoom(zoom);
  return {
    width: Math.ceil(size.width * factor),
    height: Math.ceil(size.height * factor),
  };
}

function getBrowserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

async function applyCurrentWebviewZoom(value: number): Promise<void> {
  await getCurrentWebview().setZoom(value);
}

/**
 * Installs native-feeling desktop zoom shortcuts for one WebView.
 *
 * The persisted preference is shared by every HQ WebView. Native WebView zoom
 * scales all web content without affecting the host window's native title bar
 * or traffic-light controls.
 */
export function installDesktopZoom(options: DesktopZoomOptions = {}): () => void {
  const target = options.target ?? window;
  const storage = options.storage === undefined ? getBrowserStorage() : options.storage;
  const applyZoom = options.applyZoom ?? applyCurrentWebviewZoom;
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.warn('desktop zoom failed:', error);
    });
  let current = readDesktopZoom(storage);
  let nativeApplyInFlight = false;
  let queuedNativeZoom: number | null = null;
  let disposed = false;

  const runNativeApply = (value: number): void => {
    if (disposed) return;
    try {
      const result = applyZoom(value);
      if (!result || typeof result.then !== 'function') {
        const next = queuedNativeZoom;
        queuedNativeZoom = null;
        if (next !== null) runNativeApply(next);
        return;
      }

      nativeApplyInFlight = true;
      void Promise.resolve(result)
        .catch(onError)
        .finally(() => {
          nativeApplyInFlight = false;
          if (disposed) {
            queuedNativeZoom = null;
            return;
          }
          const next = queuedNativeZoom;
          queuedNativeZoom = null;
          if (next !== null) runNativeApply(next);
        });
    } catch (error) {
      onError(error);
    }
  };

  const scheduleNativeApply = (value: number): void => {
    if (nativeApplyInFlight) {
      // Coalesce rapid Cmd+/Cmd- input so only the final desired native zoom is
      // applied after the current WebView call settles. This prevents older
      // asynchronous setZoom calls from finishing last.
      queuedNativeZoom = value;
      return;
    }
    runNativeApply(value);
  };

  const apply = (value: number) => {
    current = normalizeDesktopZoom(value);
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.desktopZoom = String(Math.round(current * 100));
    }
    if (
      typeof CustomEvent !== 'undefined' &&
      typeof target.dispatchEvent === 'function'
    ) {
      target.dispatchEvent(
        new CustomEvent(DESKTOP_ZOOM_CHANGE_EVENT, {
          detail: { zoom: current },
        }),
      );
    }
    scheduleNativeApply(current);
  };

  const onKeydown = (event: KeyboardEvent) => {
    const action = desktopZoomActionForKey(event);
    if (!action) return;

    event.preventDefault();
    const next = nextDesktopZoom(current, action);
    if (next === current) return;
    writeDesktopZoom(storage, next);
    apply(next);
  };

  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== DESKTOP_ZOOM_STORAGE_KEY) return;
    const next = readDesktopZoom(storage);
    if (next !== current) apply(next);
  };

  const onRequest = (event: Event) => {
    const next = normalizeDesktopZoom(
      (event as CustomEvent<{ zoom?: unknown }>).detail?.zoom,
    );
    if (next !== current) apply(next);
  };

  apply(current);
  target.addEventListener('keydown', onKeydown);
  target.addEventListener('storage', onStorage);
  target.addEventListener(DESKTOP_ZOOM_REQUEST_EVENT, onRequest);

  return () => {
    disposed = true;
    queuedNativeZoom = null;
    target.removeEventListener('keydown', onKeydown);
    target.removeEventListener('storage', onStorage);
    target.removeEventListener(DESKTOP_ZOOM_REQUEST_EVENT, onRequest);
  };
}

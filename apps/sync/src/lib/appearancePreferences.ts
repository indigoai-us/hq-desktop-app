export const APPEARANCE_STORAGE_KEY = 'hq-sync.appearance.v1';
export const APPEARANCE_CHANGE_EVENT = 'hq:appearance-change';
export const APPEARANCE_REQUEST_EVENT = 'hq:appearance-request';

export const DEFAULT_WINDOW_TRANSPARENCY = 65;
export const MIN_WINDOW_TRANSPARENCY = 0;
export const MAX_WINDOW_TRANSPARENCY = 100;
export const MIN_WINDOW_OPACITY = 0;
export const MAX_WINDOW_OPACITY = 100;

export type ColorTheme = 'system' | 'light' | 'dark';

export interface AppearancePreferences {
  colorTheme: ColorTheme;
  windowTransparency: number;
}

type AppearanceStorage = Pick<Storage, 'getItem' | 'setItem'>;
type NativeTheme = 'light' | 'dark' | null;

interface AppearanceRoot {
  dataset: DOMStringMap;
  style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>;
}

interface AppearancePreferenceOptions {
  target?: Window;
  storage?: AppearanceStorage | null;
  root?: AppearanceRoot;
  applyNativeTheme?: (theme: NativeTheme) => Promise<void> | void;
  onError?: (error: unknown) => void;
}

const currentAppearanceByTarget = new WeakMap<
  Window,
  AppearancePreferences
>();

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function normalizeColorTheme(value: unknown): ColorTheme {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function normalizeWindowTransparency(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_WINDOW_TRANSPARENCY;
  return Math.round(
    Math.min(
      MAX_WINDOW_TRANSPARENCY,
      Math.max(MIN_WINDOW_TRANSPARENCY, numeric),
    ),
  );
}

export function windowOpacityFromTransparency(value: unknown): number {
  return MAX_WINDOW_OPACITY - normalizeWindowTransparency(value);
}

export function windowTransparencyFromOpacity(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  const opacity = Number.isFinite(numeric)
    ? Math.round(
        Math.min(MAX_WINDOW_OPACITY, Math.max(MIN_WINDOW_OPACITY, numeric)),
      )
    : windowOpacityFromTransparency(DEFAULT_WINDOW_TRANSPARENCY);
  return normalizeWindowTransparency(MAX_WINDOW_OPACITY - opacity);
}

export function normalizeAppearancePreferences(
  value: Partial<AppearancePreferences> | null | undefined,
): AppearancePreferences {
  return {
    colorTheme: normalizeColorTheme(value?.colorTheme),
    windowTransparency: normalizeWindowTransparency(value?.windowTransparency),
  };
}

export function readAppearancePreferences(
  storage: AppearanceStorage | null,
): AppearancePreferences {
  if (!storage) return normalizeAppearancePreferences(null);
  try {
    const raw = storage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) return normalizeAppearancePreferences(null);
    return normalizeAppearancePreferences(JSON.parse(raw));
  } catch {
    return normalizeAppearancePreferences(null);
  }
}

export function readBrowserAppearancePreferences(): AppearancePreferences {
  return readAppearancePreferences(browserStorage());
}

export function writeAppearancePreferences(
  storage: AppearanceStorage | null,
  preferences: AppearancePreferences,
): void {
  if (!storage) return;
  try {
    storage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify(normalizeAppearancePreferences(preferences)),
    );
  } catch {
    // The current window still applies the preference when storage is blocked.
  }
}

/**
 * Applies the visual half of Appearance immediately.
 *
 * The persisted value is the inverse of the user-facing opacity control:
 * transparency 0 is the explicit 100% solid endpoint, while higher values
 * reveal more native Liquid Glass/Mica. System Reduce Transparency still wins.
 */
export function applyAppearancePreferences(
  root: AppearanceRoot,
  preferences: AppearancePreferences,
): void {
  const normalized = normalizeAppearancePreferences(preferences);
  if (normalized.colorTheme === 'system') {
    delete root.dataset.forceTheme;
  } else {
    root.dataset.forceTheme = normalized.colorTheme;
  }

  const lightAlpha = Math.max(
    0.15,
    1 - normalized.windowTransparency / 100,
  );
  const darkAlpha = Math.min(1, lightAlpha + 0.13);
  root.style.setProperty(
    '--hq-window-transparency-factor',
    (normalized.windowTransparency / 100).toFixed(2),
  );
  root.style.setProperty('--hq-window-alpha-light', lightAlpha.toFixed(2));
  root.style.setProperty('--hq-window-alpha-dark', darkAlpha.toFixed(2));
  root.dataset.windowTransparency = String(normalized.windowTransparency);
}

export function requestAppearancePreferenceChange(
  patch: Partial<AppearancePreferences>,
  options: Pick<AppearancePreferenceOptions, 'target' | 'storage'> = {},
): AppearancePreferences {
  const target = options.target ?? window;
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const current =
    currentAppearanceByTarget.get(target) ??
    readAppearancePreferences(storage);
  const next = normalizeAppearancePreferences({
    ...current,
    ...patch,
  });
  currentAppearanceByTarget.set(target, next);
  writeAppearancePreferences(storage, next);
  target.dispatchEvent(
    new CustomEvent<AppearancePreferences>(APPEARANCE_REQUEST_EVENT, {
      detail: next,
    }),
  );
  return next;
}

/**
 * Installs one shared Appearance preference for a WebView.
 *
 * `data-force-theme` gives every tokenized surface an immediate first frame;
 * the main/desktop host also supplies `applyNativeTheme` so direct
 * `prefers-color-scheme` rules, native controls, title bars, and Mica follow.
 */
export function installAppearancePreferences(
  options: AppearancePreferenceOptions = {},
): () => void {
  const target = options.target ?? window;
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const root = options.root ?? document.documentElement;
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.warn('appearance preference failed:', error);
    });
  let current = readAppearancePreferences(storage);
  let desiredNativeTheme: NativeTheme =
    current.colorTheme === 'system' ? null : current.colorTheme;
  let appliedNativeTheme: NativeTheme | undefined;
  let nativeDrain: Promise<void> | null = null;
  let nativeRequestRevision = 0;
  let failedNativeRevision: number | null = null;
  let disposed = false;

  const drainNativeTheme = (): void => {
    if (
      disposed ||
      !options.applyNativeTheme ||
      nativeDrain !== null ||
      failedNativeRevision === nativeRequestRevision ||
      appliedNativeTheme === desiredNativeTheme
    ) {
      return;
    }
    nativeDrain = (async () => {
      while (!disposed && appliedNativeTheme !== desiredNativeTheme) {
        const snapshot = desiredNativeTheme;
        const snapshotRevision = nativeRequestRevision;
        try {
          await options.applyNativeTheme?.(snapshot);
          appliedNativeTheme = snapshot;
          failedNativeRevision = null;
        } catch (error) {
          failedNativeRevision = snapshotRevision;
          onError(error);
          return;
        }
      }
    })().finally(() => {
      nativeDrain = null;
      drainNativeTheme();
    });
  };

  const apply = (preferences: AppearancePreferences): void => {
    current = normalizeAppearancePreferences(preferences);
    currentAppearanceByTarget.set(target, current);
    applyAppearancePreferences(root, current);
    desiredNativeTheme = current.colorTheme === 'system' ? null : current.colorTheme;
    nativeRequestRevision += 1;
    drainNativeTheme();
    target.dispatchEvent(
      new CustomEvent<AppearancePreferences>(APPEARANCE_CHANGE_EVENT, {
        detail: current,
      }),
    );
  };

  const onRequest = (event: Event): void => {
    apply((event as CustomEvent<AppearancePreferences>).detail);
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== APPEARANCE_STORAGE_KEY) return;
    apply(readAppearancePreferences(storage));
  };

  apply(current);
  target.addEventListener(APPEARANCE_REQUEST_EVENT, onRequest);
  target.addEventListener('storage', onStorage);

  return () => {
    disposed = true;
    currentAppearanceByTarget.delete(target);
    target.removeEventListener(APPEARANCE_REQUEST_EVENT, onRequest);
    target.removeEventListener('storage', onStorage);
  };
}

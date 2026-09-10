export const APPEARANCE_STORAGE_KEY = 'hq-sync.appearance.v1';
export const APPEARANCE_CHANGE_EVENT = 'hq:appearance-change';
export const APPEARANCE_REQUEST_EVENT = 'hq:appearance-request';

export type ColorTheme = 'system' | 'light' | 'dark';

export interface AppearancePreferences {
  colorTheme: ColorTheme;
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

export function normalizeAppearancePreferences(
  value: Partial<AppearancePreferences> | null | undefined,
): AppearancePreferences {
  return {
    colorTheme: normalizeColorTheme(value?.colorTheme),
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
 * Surface alpha used to be computed here from a user-adjustable transparency
 * value. It is now fixed in tokens.css at the values the design specifies, so
 * theme is all this has left to do. System Reduce Transparency still wins.
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

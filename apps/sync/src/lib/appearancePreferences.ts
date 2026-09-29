/**
 * Desktop host for the ONE Appearance store (theme + window transparency).
 *
 * Value contract, defaults, storage key, and the legacy-upgrade rule live in
 * `@hq/ui/appearance` so the Settings slider, the title-bar Appearance menu,
 * and this host can never disagree about a default or a range again.
 */
import {
  APPEARANCE_CHANGE_EVENT,
  APPEARANCE_REQUEST_EVENT,
  APPEARANCE_STORAGE_KEY,
  DEFAULT_STORED_APPEARANCE,
  normalizeColorTheme,
  normalizeWindowTransparency,
  parseStoredAppearance,
  serializeStoredAppearance,
  type AppearancePreferences,
  type ColorTheme,
  type StoredAppearance,
} from '@hq/ui/appearance';

export {
  APPEARANCE_CHANGE_EVENT,
  APPEARANCE_REQUEST_EVENT,
  APPEARANCE_STORAGE_KEY,
  DEFAULT_WINDOW_TRANSPARENCY,
  LEGACY_DEFAULT_WINDOW_TRANSPARENCY,
  MAX_WINDOW_OPACITY,
  MAX_WINDOW_TRANSPARENCY,
  MIN_WINDOW_OPACITY,
  MIN_WINDOW_TRANSPARENCY,
  normalizeColorTheme,
  normalizeWindowTransparency,
  windowOpacityFromTransparency,
  windowTransparencyFromOpacity,
} from '@hq/ui/appearance';
export type { AppearancePreferences, ColorTheme } from '@hq/ui/appearance';

type AppearanceStorage = Pick<Storage, 'getItem' | 'setItem'>;
type NativeTheme = 'light' | 'dark' | null;

interface AppearanceRoot {
  dataset: DOMStringMap;
  style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>;
}

/** What backs the window natively — see `window_material_capability` (Rust). */
export type WindowMaterial = 'glass' | 'vibrancy' | 'none';

/** The PR772 surfaces are designed over either native material. Only an
 * absent material needs the opaque fallback; vibrancy must not change the
 * requested alpha and turn the reference's white 2% dark ground grey.
 */
export const MAX_WINDOW_TRANSPARENCY_WITHOUT_GLASS = 15;

export function effectiveWindowTransparency(
  requested: number,
  material: WindowMaterial | null | undefined,
): number {
  if (material !== 'none') return requested;
  return Math.min(requested, MAX_WINDOW_TRANSPARENCY_WITHOUT_GLASS);
}

interface AppearancePreferenceOptions {
  target?: Window;
  storage?: AppearanceStorage | null;
  root?: AppearanceRoot;
  applyNativeTheme?: (theme: NativeTheme) => Promise<void> | void;
  /** Resolve the native window material; re-applies the preference once known. */
  readMaterial?: () => Promise<WindowMaterial | string | null | undefined>;
  /**
   * Drive the native backdrop (Liquid Glass / vibrancy) from the persisted
   * transparency. Called once per distinct value; 0 means fully solid.
   */
  applyNativeTransparency?: (transparency: number) => Promise<void> | void;
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

export function normalizeAppearancePreferences(
  value: Partial<AppearancePreferences> | null | undefined,
): AppearancePreferences {
  return {
    colorTheme: normalizeColorTheme(value?.colorTheme),
    windowTransparency: normalizeWindowTransparency(value?.windowTransparency),
  };
}

function readStoredRecord(storage: AppearanceStorage | null): {
  record: StoredAppearance;
  migrated: boolean;
} {
  if (!storage) return { record: { ...DEFAULT_STORED_APPEARANCE }, migrated: false };
  try {
    return parseStoredAppearance(storage.getItem(APPEARANCE_STORAGE_KEY));
  } catch {
    return { record: { ...DEFAULT_STORED_APPEARANCE }, migrated: false };
  }
}

function writeStoredRecord(storage: AppearanceStorage | null, record: StoredAppearance): void {
  if (!storage) return;
  try {
    storage.setItem(APPEARANCE_STORAGE_KEY, serializeStoredAppearance(record));
  } catch {
    // The current window still applies the preference when storage is blocked.
  }
}

function toPreferences(record: StoredAppearance): AppearancePreferences {
  return normalizeAppearancePreferences(record);
}

export function readAppearancePreferences(
  storage: AppearanceStorage | null,
): AppearancePreferences {
  return toPreferences(readStoredRecord(storage).record);
}

export function readBrowserAppearancePreferences(): AppearancePreferences {
  return readAppearancePreferences(browserStorage());
}

/**
 * Persist a preference. `windowTransparencySet` stays true once the user has
 * chosen a transparency, and becomes true when this write changes it.
 */
export function writeAppearancePreferences(
  storage: AppearanceStorage | null,
  preferences: AppearancePreferences,
): void {
  const previous = readStoredRecord(storage).record;
  const next = normalizeAppearancePreferences(preferences);
  writeStoredRecord(storage, {
    ...next,
    windowTransparencySet:
      previous.windowTransparencySet ||
      next.windowTransparency !== previous.windowTransparency,
  });
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
  material: WindowMaterial | null | undefined = normalizeWindowMaterial(root.dataset.material),
): void {
  const normalized = normalizeAppearancePreferences(preferences);
  if (normalized.colorTheme === 'system') {
    delete root.dataset.forceTheme;
  } else {
    root.dataset.forceTheme = normalized.colorTheme;
  }

  const transparency = effectiveWindowTransparency(normalized.windowTransparency, material);
  const lightAlpha = Math.max(0.15, 1 - transparency / 100);
  const darkAlpha = Math.min(1, lightAlpha + 0.13);
  root.style.setProperty(
    '--hq-window-transparency-factor',
    (transparency / 100).toFixed(2),
  );
  root.style.setProperty('--hq-window-alpha-light', lightAlpha.toFixed(2));
  root.style.setProperty('--hq-window-alpha-dark', darkAlpha.toFixed(2));
  root.dataset.windowTransparency = String(normalized.windowTransparency);
  if (material) root.dataset.material = material;
}

export function normalizeWindowMaterial(value: unknown): WindowMaterial | null {
  return value === 'glass' || value === 'vibrancy' || value === 'none' ? value : null;
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
  const initial = readStoredRecord(storage);
  // Upgrade a legacy record once (see parseStoredAppearance), so the reset of
  // an app-written default is durable and every window reads the same value.
  if (initial.migrated) writeStoredRecord(storage, initial.record);
  let current = toPreferences(initial.record);
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

  let material: WindowMaterial | null = normalizeWindowMaterial(root.dataset.material);
  let appliedNativeTransparency: number | null = null;
  const applyNativeTransparency = (transparency: number): void => {
    if (disposed || !options.applyNativeTransparency) return;
    if (appliedNativeTransparency === transparency) return;
    appliedNativeTransparency = transparency;
    void Promise.resolve()
      .then(() => options.applyNativeTransparency?.(transparency))
      .catch((error: unknown) => {
        // Allow a retry on the next request for the same value.
        if (appliedNativeTransparency === transparency) appliedNativeTransparency = null;
        onError(error);
      });
  };
  const apply = (preferences: AppearancePreferences): void => {
    current = normalizeAppearancePreferences(preferences);
    currentAppearanceByTarget.set(target, current);
    applyAppearancePreferences(root, current, material);
    applyNativeTransparency(current.windowTransparency);
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
    // Requests may come straight from packages/ui (Settings slider), which
    // cannot reach this module's storage helper — persist here so the value
    // survives a restart.
    writeAppearancePreferences(storage, current);
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== APPEARANCE_STORAGE_KEY) return;
    apply(readAppearancePreferences(storage));
  };

  apply(current);
  target.addEventListener(APPEARANCE_REQUEST_EVENT, onRequest);
  target.addEventListener('storage', onStorage);
  if (options.readMaterial && material === null) {
    void Promise.resolve()
      .then(() => options.readMaterial!())
      .then((value) => {
        if (disposed) return;
        const next = normalizeWindowMaterial(value);
        if (!next || next === material) return;
        material = next;
        apply(current);
      })
      .catch(onError);
  }

  return () => {
    disposed = true;
    currentAppearanceByTarget.delete(target);
    target.removeEventListener(APPEARANCE_REQUEST_EVENT, onRequest);
    target.removeEventListener('storage', onStorage);
  };
}

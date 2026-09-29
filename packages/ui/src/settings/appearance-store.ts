/**
 * The single Appearance state used by every control that shows or changes the
 * colour theme or window opacity: Settings > Appearance, the Settings seam,
 * and the title-bar Appearance menu.
 *
 * Source of truth:
 * - desktop: the host installer (`apps/sync/src/lib/appearancePreferences.ts`)
 *   owns the persisted record and marks what it APPLIED on `<html>`
 *   (`data-window-transparency`, `data-force-theme`). Reads come from those
 *   markers, writes go through `hq:appearance-request`, and the host announces
 *   every apply with `hq:appearance-change`. A control can therefore only show
 *   the value the window is actually using.
 * - web (no host): this module applies the same CSS vars itself and persists
 *   the same record (`APPEARANCE_STORAGE_KEY`), then announces the change with
 *   the same event so every open control updates live.
 */
import {
  APPEARANCE_CHANGE_EVENT,
  APPEARANCE_REQUEST_EVENT,
  APPEARANCE_STORAGE_KEY,
  DEFAULT_STORED_APPEARANCE,
  normalizeColorTheme,
  parseStoredAppearance,
  serializeStoredAppearance,
  windowOpacityFromTransparency,
  type AppearancePreferences,
  type ColorTheme,
  type StoredAppearance,
} from "./appearance-seam.js";
import {
  THEME_STORAGE_KEY,
  applyWindowOpacity,
  clampSliderOpacity,
  currentColorTheme,
  hasAppearanceHost,
  readHostWindowOpacity,
} from "./shell-settings-model.js";

export interface AppearanceState {
  colorTheme: ColorTheme;
  /** User-facing opacity, MIN_SLIDER_WINDOW_OPACITY..100. */
  windowOpacity: number;
}

type StoreStorage = Pick<Storage, "getItem" | "setItem">;

export interface AppearanceStoreOptions {
  root?: HTMLElement | null;
  target?: EventTarget | null;
  storage?: StoreStorage | null;
}

function defaultRoot(): HTMLElement | null {
  return globalThis.document?.documentElement ?? null;
}

function defaultTarget(): EventTarget | null {
  return typeof window === "undefined" ? null : window;
}

function defaultStorage(): StoreStorage | null {
  try {
    return (
      (globalThis as { window?: { localStorage?: Storage } }).window
        ?.localStorage ??
      (globalThis.localStorage as Storage | undefined) ??
      null
    );
  } catch {
    return null;
  }
}

function resolve(options: AppearanceStoreOptions) {
  return {
    root: options.root === undefined ? defaultRoot() : options.root,
    target: options.target === undefined ? defaultTarget() : options.target,
    storage: options.storage === undefined ? defaultStorage() : options.storage,
  };
}

function readRecord(storage: StoreStorage | null): StoredAppearance {
  try {
    return parseStoredAppearance(storage?.getItem(APPEARANCE_STORAGE_KEY))
      .record;
  } catch {
    return { ...DEFAULT_STORED_APPEARANCE };
  }
}

function writeRecord(storage: StoreStorage | null, record: StoredAppearance) {
  try {
    storage?.setItem(APPEARANCE_STORAGE_KEY, serializeStoredAppearance(record));
  } catch {
    /* private mode */
  }
}

/** The theme + opacity currently in force (what the window shows). */
export function readAppearanceState(
  options: AppearanceStoreOptions = {},
): AppearanceState {
  const { root, storage } = resolve(options);
  const hostOpacity = readHostWindowOpacity(root);
  if (hostOpacity != null) {
    return { colorTheme: currentColorTheme(root), windowOpacity: hostOpacity };
  }
  const record = readRecord(storage);
  return {
    colorTheme: record.colorTheme,
    windowOpacity: clampSliderOpacity(
      windowOpacityFromTransparency(record.windowTransparency),
    ),
  };
}

function toPreferences(state: AppearanceState): AppearancePreferences {
  return {
    colorTheme: state.colorTheme,
    windowTransparency: 100 - state.windowOpacity,
  };
}

function applyThemeAttribute(root: HTMLElement | null, theme: ColorTheme) {
  if (!root) return;
  if (theme === "system") root.removeAttribute("data-force-theme");
  else root.setAttribute("data-force-theme", theme);
}

function announce(target: EventTarget | null, state: AppearanceState) {
  target?.dispatchEvent(
    new CustomEvent<AppearancePreferences>(APPEARANCE_CHANGE_EVENT, {
      detail: toPreferences(state),
    }),
  );
}

/** Set the colour theme through the shared store. Returns the applied state. */
export function setAppearanceColorTheme(
  theme: ColorTheme,
  options: AppearanceStoreOptions = {},
): AppearanceState {
  const { root, target, storage } = resolve(options);
  const colorTheme = normalizeColorTheme(theme);
  const current = readAppearanceState({ root, storage });
  const next: AppearanceState = { ...current, colorTheme };
  if (hasAppearanceHost(root)) {
    // Whole preference, never a partial: the host applies `detail` raw.
    target?.dispatchEvent(
      new CustomEvent<AppearancePreferences>(APPEARANCE_REQUEST_EVENT, {
        detail: toPreferences(next),
      }),
    );
    return readAppearanceState({ root, storage });
  }
  applyThemeAttribute(root, colorTheme);
  writeRecord(storage, { ...readRecord(storage), colorTheme });
  announce(target, next);
  return next;
}

/** Set the window opacity through the shared store. Returns the applied state. */
export function setAppearanceWindowOpacity(
  opacity: number,
  options: AppearanceStoreOptions = {},
): AppearanceState {
  const { root, target, storage } = resolve(options);
  const windowOpacity = clampSliderOpacity(opacity);
  if (hasAppearanceHost(root)) {
    applyWindowOpacity(windowOpacity, root, target);
    return readAppearanceState({ root, storage });
  }
  applyWindowOpacity(windowOpacity, root, null);
  const record = readRecord(storage);
  const windowTransparency = 100 - windowOpacity;
  writeRecord(storage, {
    ...record,
    windowTransparency,
    windowTransparencySet:
      record.windowTransparencySet ||
      windowTransparency !== record.windowTransparency,
  });
  const next = { ...readAppearanceState({ root, storage }), windowOpacity };
  announce(target, next);
  return next;
}

/** Follow every applied change (host or web). */
export function subscribeAppearance(
  cb: (state: AppearanceState) => void,
  options: AppearanceStoreOptions = {},
): () => void {
  const { root, target, storage } = resolve(options);
  if (!target) return () => {};
  const onChange = (): void => cb(readAppearanceState({ root, storage }));
  const onStorage = (event: Event): void => {
    const key = (event as StorageEvent).key;
    if (key === null || key === APPEARANCE_STORAGE_KEY) onChange();
  };
  target.addEventListener(APPEARANCE_CHANGE_EVENT, onChange);
  target.addEventListener("storage", onStorage);
  return () => {
    target.removeEventListener(APPEARANCE_CHANGE_EVENT, onChange);
    target.removeEventListener("storage", onStorage);
  };
}

/**
 * Boot the shared Appearance state for the Work shell.
 *
 * - Adopts the retired Work-only theme key (`hq-work-color-theme`) once, so a
 *   theme chosen before the stores were unified survives the upgrade, then
 *   deletes it.
 * - Without a host, applies the stored record (with a host, the host already
 *   applied it before first paint; re-applying would round-trip a copy).
 */
export function bootAppearance(
  options: AppearanceStoreOptions & {
    legacyStorage?: Pick<Storage, "getItem" | "removeItem"> | null;
  } = {},
): AppearanceState {
  const { root, target, storage } = resolve(options);
  const legacyStorage =
    options.legacyStorage === undefined
      ? (storage as Pick<Storage, "getItem" | "removeItem"> | null)
      : options.legacyStorage;
  let legacyTheme: string | null = null;
  try {
    legacyTheme = legacyStorage?.getItem(THEME_STORAGE_KEY) ?? null;
  } catch {
    legacyTheme = null;
  }
  if (!hasAppearanceHost(root)) {
    const state = readAppearanceState({ root, storage });
    applyThemeAttribute(root, state.colorTheme);
    applyWindowOpacity(state.windowOpacity, root, null);
  }
  if (legacyTheme !== null) {
    const theme = legacyTheme === "light" || legacyTheme === "dark" || legacyTheme === "system"
      ? legacyTheme
      : null;
    if (theme && theme !== readAppearanceState({ root, storage }).colorTheme) {
      setAppearanceColorTheme(theme, { root, target, storage });
    }
    try {
      legacyStorage?.removeItem(THEME_STORAGE_KEY);
    } catch {
      /* private mode */
    }
  }
  return readAppearanceState({ root, storage });
}

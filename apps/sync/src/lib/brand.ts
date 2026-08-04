/**
 * White-label brand runtime (US-005).
 *
 * Brand values + `brandingEnabled` ride the existing membership enrichment on
 * `list_syncable_workspaces` (hq-pro stamps both on `/membership/me` and
 * `/membership/person/{uid}`). This module:
 *
 *   1. Resolves an effective brand from workspace rows (hard rule: absent
 *      brand / absent brandingEnabled → no branding, never an error).
 *   2. Derives accent CSS variables (shared contract with the console).
 *   3. Applies / clears chrome tokens on `document.documentElement`.
 *   4. Caches brand + logo assets with the entitlement stamp so offline
 *      launches still render; a live cloud response with entitlement lost
 *      clears the cache and resets to HQ defaults.
 */

/** Frozen shape of hq-pro `CompanyBrand` / e2e `CompanyBrandSettings`. */
export interface CompanyBrandSettings {
  logoUrlLight?: string;
  logoUrlDark?: string;
  accentColor?: string;
}

/** A workspace (or membership) row that may carry brand + entitlement. */
export interface BrandSource {
  slug?: string | null;
  kind?: string | null;
  brandingEnabled?: boolean | null;
  brand?: CompanyBrandSettings | null;
  cloudUid?: string | null;
}

export type ColorScheme = 'light' | 'dark';

export interface CachedBrand {
  brandingEnabled: true;
  brand: CompanyBrandSettings;
  companySlug?: string;
  companyUid?: string;
  /** data: URLs for offline logo render (best-effort). */
  logoDataLight?: string | null;
  logoDataDark?: string | null;
  cachedAt: string;
}

export interface DerivedAccentTokens {
  accent: string;
  accentSoft: string;
  accentHover: string;
  onAccent: string;
}

export const BRAND_CACHE_KEY = 'hq-sync.brand.v1';

/** Soft tint alpha for selection / active-row (matches storyboard 16%). */
const ACCENT_SOFT_ALPHA = 0.16;
/** Slight darken for hover — multiply channels. */
const ACCENT_HOVER_FACTOR = 0.88;

// ── Resolve ──────────────────────────────────────────────────────────────────

/**
 * True only when entitlement is explicitly true AND at least one brand field
 * is a non-empty string. Absent/false entitlement → unbranded (safe deploy
 * order either way).
 */
export function isEntitledBrand(
  brandingEnabled: boolean | null | undefined,
  brand: CompanyBrandSettings | null | undefined,
): brand is CompanyBrandSettings {
  if (brandingEnabled !== true) return false;
  if (!brand || typeof brand !== 'object') return false;
  return (
    nonEmpty(brand.logoUrlLight) ||
    nonEmpty(brand.logoUrlDark) ||
    nonEmpty(brand.accentColor)
  );
}

/**
 * Pick the effective brand from workspace/membership rows.
 *
 * Preference order:
 *   1. `preferSlug` when that row is entitled + branded
 *   2. first company row that is entitled + branded
 *
 * Personal vault never brands. Empty / missing sources → null (no branding).
 */
export function resolveBrandFromSources(
  sources: ReadonlyArray<BrandSource> | null | undefined,
  preferSlug?: string | null,
): CachedBrand | null {
  if (!sources || sources.length === 0) return null;

  const candidates = sources.filter(
    (s) => s.kind !== 'personal' && s.slug !== 'personal' && isEntitledBrand(s.brandingEnabled, s.brand),
  );
  if (candidates.length === 0) return null;

  const preferred =
    preferSlug && preferSlug !== 'personal'
      ? candidates.find((s) => s.slug === preferSlug)
      : undefined;
  const pick = preferred ?? candidates[0];
  if (!pick?.brand) return null;

  return {
    brandingEnabled: true,
    brand: {
      logoUrlLight: nonEmpty(pick.brand.logoUrlLight) ? pick.brand.logoUrlLight : undefined,
      logoUrlDark: nonEmpty(pick.brand.logoUrlDark) ? pick.brand.logoUrlDark : undefined,
      accentColor: nonEmpty(pick.brand.accentColor) ? pick.brand.accentColor : undefined,
    },
    companySlug: pick.slug ?? undefined,
    companyUid: pick.cloudUid ?? undefined,
    cachedAt: new Date().toISOString(),
  };
}

// ── Logo variant ─────────────────────────────────────────────────────────────

/**
 * Choose light/dark logo URL for the current appearance. Falls back to the
 * other variant when one is absent; returns null when neither is set (caller
 * renders the default HQ mark).
 */
export function selectLogoUrl(
  brand: CompanyBrandSettings | null | undefined,
  scheme: ColorScheme,
  cached?: Pick<CachedBrand, 'logoDataLight' | 'logoDataDark'> | null,
): string | null {
  if (!brand) return null;

  const lightRemote = isSafeLogoUrl(brand.logoUrlLight) ? brand.logoUrlLight! : null;
  const darkRemote = isSafeLogoUrl(brand.logoUrlDark) ? brand.logoUrlDark! : null;
  const lightData = isSafeLogoUrl(cached?.logoDataLight) ? cached!.logoDataLight! : null;
  const darkData = isSafeLogoUrl(cached?.logoDataDark) ? cached!.logoDataDark! : null;

  const light = lightData ?? lightRemote;
  const dark = darkData ?? darkRemote;

  if (scheme === 'light') return light ?? dark;
  return dark ?? light;
}

// ── Accent tokens ────────────────────────────────────────────────────────────

/**
 * Derive accent + soft/hover/on-accent tokens from a CSS color string.
 * Returns null when the accent is absent or unparseable — caller keeps HQ defaults.
 *
 * Soft = 16% alpha of the accent (active-tab / selection tint).
 * Hover = channel-darkened accent for solid primary CTAs.
 * On-accent = white (palette accents are mid-luminance and pass contrast).
 */
export function deriveAccentTokens(accentColor: string | null | undefined): DerivedAccentTokens | null {
  if (!nonEmpty(accentColor)) return null;
  const rgb = parseCssColor(accentColor!);
  if (!rgb) return null;

  const accent = toHex(rgb);
  return {
    accent,
    accentSoft: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${ACCENT_SOFT_ALPHA})`,
    accentHover: toHex({
      r: Math.round(rgb.r * ACCENT_HOVER_FACTOR),
      g: Math.round(rgb.g * ACCENT_HOVER_FACTOR),
      b: Math.round(rgb.b * ACCENT_HOVER_FACTOR),
    }),
    onAccent: '#ffffff',
  };
}

// ── Document apply / clear ───────────────────────────────────────────────────

const BRAND_CSS_VARS = [
  '--v4-brand-accent',
  '--v4-brand-accent-soft',
  '--v4-brand-accent-hover',
  '--v4-brand-on-accent',
  '--popover-brand-accent',
  '--popover-brand-accent-soft',
  '--popover-brand-accent-hover',
  '--popover-brand-on-accent',
] as const;

/**
 * Apply branded accent tokens to the document root. Status colors, text grays,
 * and surface tokens are intentionally left alone.
 *
 * Pass `null` / unbranded to clear (HQ defaults).
 */
function documentRoot(): HTMLElement | null {
  return typeof document !== 'undefined' ? document.documentElement : null;
}

export function applyBrandToDocument(
  cached: CachedBrand | null | undefined,
  root: HTMLElement | null = documentRoot(),
): void {
  if (!root) return;
  if (!cached || !isEntitledBrand(true, cached.brand)) {
    clearBrandFromDocument(root);
    return;
  }

  const tokens = deriveAccentTokens(cached.brand.accentColor);
  if (!tokens) {
    // Logo-only brand: mark branded for lockup/logo, leave accent neutrals.
    root.dataset.branded = 'true';
    for (const name of BRAND_CSS_VARS) root.style.removeProperty(name);
    return;
  }

  root.dataset.branded = 'true';
  root.style.setProperty('--v4-brand-accent', tokens.accent);
  root.style.setProperty('--v4-brand-accent-soft', tokens.accentSoft);
  root.style.setProperty('--v4-brand-accent-hover', tokens.accentHover);
  root.style.setProperty('--v4-brand-on-accent', tokens.onAccent);
  // Popover mirrors the same derivation (shared contract with console).
  root.style.setProperty('--popover-brand-accent', tokens.accent);
  root.style.setProperty('--popover-brand-accent-soft', tokens.accentSoft);
  root.style.setProperty('--popover-brand-accent-hover', tokens.accentHover);
  root.style.setProperty('--popover-brand-on-accent', tokens.onAccent);
}

export function clearBrandFromDocument(root: HTMLElement | null = documentRoot()): void {
  if (!root) return;
  delete root.dataset.branded;
  for (const name of BRAND_CSS_VARS) root.style.removeProperty(name);
}

// ── Cache ────────────────────────────────────────────────────────────────────

export function readBrandCache(storage: Storage = localStorage): CachedBrand | null {
  try {
    const raw = storage.getItem(BRAND_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedBrand>;
    if (parsed.brandingEnabled !== true) return null;
    if (!parsed.brand || typeof parsed.brand !== 'object') return null;
    if (!isEntitledBrand(true, parsed.brand)) return null;
    return {
      brandingEnabled: true,
      brand: {
        logoUrlLight: nonEmpty(parsed.brand.logoUrlLight) ? parsed.brand.logoUrlLight : undefined,
        logoUrlDark: nonEmpty(parsed.brand.logoUrlDark) ? parsed.brand.logoUrlDark : undefined,
        accentColor: nonEmpty(parsed.brand.accentColor) ? parsed.brand.accentColor : undefined,
      },
      companySlug: typeof parsed.companySlug === 'string' ? parsed.companySlug : undefined,
      companyUid: typeof parsed.companyUid === 'string' ? parsed.companyUid : undefined,
      logoDataLight: nonEmpty(parsed.logoDataLight) ? parsed.logoDataLight : null,
      logoDataDark: nonEmpty(parsed.logoDataDark) ? parsed.logoDataDark : null,
      cachedAt: typeof parsed.cachedAt === 'string' ? parsed.cachedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function writeBrandCache(
  cached: CachedBrand,
  storage: Storage = localStorage,
): void {
  try {
    storage.setItem(BRAND_CACHE_KEY, JSON.stringify(cached));
  } catch {
    // Quota / private mode — chrome still applies in-session without cache.
  }
}

export function clearBrandCache(storage: Storage = localStorage): void {
  try {
    storage.removeItem(BRAND_CACHE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Sync brand state from a fresh workspaces payload.
 *
 * - Cloud reachable + no entitled brand → clear cache (entitlement lost / brand removed).
 * - Entitled brand found → write cache (preserve prior logo data URLs when URLs match).
 * - Cloud unreachable → keep existing cache (offline render).
 *
 * Returns the brand that should be applied (live or cached offline), or null.
 */
export function syncBrandFromWorkspaces(
  sources: ReadonlyArray<BrandSource> | null | undefined,
  options: {
    cloudReachable?: boolean | null;
    preferSlug?: string | null;
    storage?: Storage;
  } = {},
): CachedBrand | null {
  const storage = options.storage ?? localStorage;
  const live = resolveBrandFromSources(sources, options.preferSlug);

  if (live) {
    const prior = readBrandCache(storage);
    const merged: CachedBrand = {
      ...live,
      // prior may be null (no cache yet) — optional-chain so TS never treats
      // logoData* reads as possibly-null without a guard.
      logoDataLight:
        prior?.brand.logoUrlLight === live.brand.logoUrlLight
          ? (prior?.logoDataLight ?? null)
          : null,
      logoDataDark:
        prior?.brand.logoUrlDark === live.brand.logoUrlDark
          ? (prior?.logoDataDark ?? null)
          : null,
    };
    writeBrandCache(merged, storage);
    return merged;
  }

  // No live brand. If cloud is unreachable, fall back to cache (offline).
  if (options.cloudReachable === false) {
    return readBrandCache(storage);
  }

  // Cloud reachable (or unknown with empty sources after a successful empty
  // memberships list): entitlement lost / brand removed → clear.
  clearBrandCache(storage);
  return null;
}

/**
 * Best-effort: fetch logo assets and store as data URLs for offline render.
 * Failures are silent — remote URLs remain the online path.
 */
export async function cacheLogoAssets(
  cached: CachedBrand,
  storage: Storage = localStorage,
  fetchImpl: typeof fetch = fetch,
): Promise<CachedBrand> {
  const next = { ...cached };
  if (nonEmpty(cached.brand.logoUrlLight) && !nonEmpty(cached.logoDataLight)) {
    next.logoDataLight = await fetchAsDataUrl(cached.brand.logoUrlLight!, fetchImpl);
  }
  if (nonEmpty(cached.brand.logoUrlDark) && !nonEmpty(cached.logoDataDark)) {
    next.logoDataDark = await fetchAsDataUrl(cached.brand.logoUrlDark!, fetchImpl);
  }
  writeBrandCache(next, storage);
  return next;
}

/**
 * Resolve prefers-color-scheme for logo variant selection.
 * Accepts an optional matchMedia for tests.
 */
export function currentColorScheme(
  matchMediaFn: (query: string) => MediaQueryList = (q) => window.matchMedia(q),
): ColorScheme {
  try {
    return matchMediaFn('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Scheme allowlist for tenant logo assets (defense-in-depth against a
 * poisoned localStorage cache or a hostile brand record): only https remote
 * URLs and data:image/* payloads may reach an <img src>. Anything else
 * (javascript:, file:, http:, data:text/html, …) is treated as absent.
 */
export function isSafeLogoUrl(value: string | null | undefined): value is string {
  if (!nonEmpty(value)) return false;
  const v = value.trim();
  if (/^https:\/\//i.test(v)) return true;
  if (/^data:image\//i.test(v)) return true;
  return false;
}

function parseCssColor(value: string): { r: number; g: number; b: number } | null {
  const trimmed = value.trim();
  // #RGB / #RRGGBB
  const hex = trimmed.replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    const n = parseInt(hex, 16);
    return {
      r: (n >> 16) & 0xff,
      g: (n >> 8) & 0xff,
      b: n & 0xff,
    };
  }
  // rgb(r,g,b) / rgba(r,g,b,a)
  const m = trimmed.match(
    /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*[0-9.]+\s*)?\)$/i,
  );
  if (m) {
    return {
      r: Math.max(0, Math.min(255, Math.round(Number(m[1])))),
      g: Math.max(0, Math.min(255, Math.round(Number(m[2])))),
      b: Math.max(0, Math.min(255, Math.round(Number(m[3])))),
    };
  }
  return null;
}

function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const h = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

async function fetchAsDataUrl(
  url: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    // data:image URLs are already offline-ready; other schemes never fetch.
    if (/^data:/i.test(url)) return isSafeLogoUrl(url) ? url : null;
    if (!/^https:\/\//i.test(url)) return null;
    const res = await fetchImpl(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) return null;
    const blob = await res.blob();
    // Only image payloads become data URLs (an <img> would not execute
    // text/html, but a poisoned cache should still never store it).
    if (!/^image\//i.test(blob.type)) return null;
    // Cap ~256 KB so localStorage stays healthy.
    if (blob.size > 256 * 1024) return null;
    const dataUrl = await blobToDataUrl(blob);
    return isSafeLogoUrl(dataUrl) ? dataUrl : null;
  } catch {
    return null;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

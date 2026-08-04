// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyBrandToDocument,
  BRAND_CACHE_KEY,
  clearBrandCache,
  clearBrandFromDocument,
  deriveAccentTokens,
  isEntitledBrand,
  readBrandCache,
  resolveBrandFromSources,
  selectLogoUrl,
  syncBrandFromWorkspaces,
  writeBrandCache,
  type BrandSource,
  type CachedBrand,
} from './brand';

const BRAND = {
  logoUrlLight: 'https://fixtures.test/logo-light.svg',
  logoUrlDark: 'https://fixtures.test/logo-dark.svg',
  accentColor: '#6633cc',
};

function entitledSource(overrides: Partial<BrandSource> = {}): BrandSource {
  return {
    slug: 'northwind',
    kind: 'company',
    brandingEnabled: true,
    brand: { ...BRAND },
    cloudUid: 'cmp_nw',
    ...overrides,
  };
}

describe('isEntitledBrand', () => {
  it('rejects absent entitlement or empty brand', () => {
    expect(isEntitledBrand(undefined, BRAND)).toBe(false);
    expect(isEntitledBrand(false, BRAND)).toBe(false);
    expect(isEntitledBrand(true, undefined)).toBe(false);
    expect(isEntitledBrand(true, {})).toBe(false);
  });

  it('accepts entitlement with any non-empty brand field', () => {
    expect(isEntitledBrand(true, { accentColor: '#6633cc' })).toBe(true);
    expect(isEntitledBrand(true, { logoUrlLight: 'https://x/l.svg' })).toBe(true);
  });
});

describe('resolveBrandFromSources', () => {
  it('returns null for empty / unbranded sources (safe deploy order)', () => {
    expect(resolveBrandFromSources([])).toBeNull();
    expect(resolveBrandFromSources(null)).toBeNull();
    expect(
      resolveBrandFromSources([
        { slug: 'acme', kind: 'company', brandingEnabled: false, brand: BRAND },
      ]),
    ).toBeNull();
  });

  it('skips personal vault rows', () => {
    expect(
      resolveBrandFromSources([
        { slug: 'personal', kind: 'personal', brandingEnabled: true, brand: BRAND },
      ]),
    ).toBeNull();
  });

  it('prefers preferSlug when that company is entitled', () => {
    const sources = [
      entitledSource({ slug: 'acme', brand: { accentColor: '#2563EB' } }),
      entitledSource({ slug: 'northwind' }),
    ];
    const resolved = resolveBrandFromSources(sources, 'northwind');
    expect(resolved?.companySlug).toBe('northwind');
    expect(resolved?.brand.accentColor).toBe('#6633cc');
  });

  it('falls back to first entitled company', () => {
    const resolved = resolveBrandFromSources([
      { slug: 'free-co', kind: 'company', brandingEnabled: false },
      entitledSource({ slug: 'northwind' }),
    ]);
    expect(resolved?.companySlug).toBe('northwind');
    expect(resolved?.brandingEnabled).toBe(true);
  });
});

describe('selectLogoUrl', () => {
  it('picks the matching scheme variant and falls back to the other', () => {
    expect(selectLogoUrl(BRAND, 'light')).toBe(BRAND.logoUrlLight);
    expect(selectLogoUrl(BRAND, 'dark')).toBe(BRAND.logoUrlDark);
    expect(selectLogoUrl({ logoUrlLight: BRAND.logoUrlLight }, 'dark')).toBe(BRAND.logoUrlLight);
    expect(selectLogoUrl({ logoUrlDark: BRAND.logoUrlDark }, 'light')).toBe(BRAND.logoUrlDark);
    expect(selectLogoUrl({}, 'light')).toBeNull();
  });

  it('prefers cached data URLs over remote URLs', () => {
    expect(
      selectLogoUrl(BRAND, 'light', {
        logoDataLight: 'data:image/svg+xml,light',
        logoDataDark: 'data:image/svg+xml,dark',
      }),
    ).toBe('data:image/svg+xml,light');
  });
});

describe('deriveAccentTokens', () => {
  it('derives soft/hover/on-accent from a hex color', () => {
    const tokens = deriveAccentTokens('#6633cc');
    expect(tokens).not.toBeNull();
    expect(tokens!.accent).toBe('#6633cc');
    expect(tokens!.accentSoft).toBe('rgba(102, 51, 204, 0.16)');
    expect(tokens!.onAccent).toBe('#ffffff');
    expect(tokens!.accentHover).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('returns null for unparseable accents', () => {
    expect(deriveAccentTokens(undefined)).toBeNull();
    expect(deriveAccentTokens('not-a-color')).toBeNull();
  });
});

describe('document apply / clear', () => {
  afterEach(() => {
    clearBrandFromDocument();
  });

  it('sets data-branded and brand CSS vars when entitled', () => {
    const root = document.documentElement;
    applyBrandToDocument({
      brandingEnabled: true,
      brand: BRAND,
      cachedAt: new Date().toISOString(),
    });
    expect(root.dataset.branded).toBe('true');
    expect(root.style.getPropertyValue('--v4-brand-accent').trim()).toBe('#6633cc');
    expect(root.style.getPropertyValue('--popover-brand-accent').trim()).toBe('#6633cc');
  });

  it('clears branding when null', () => {
    applyBrandToDocument({
      brandingEnabled: true,
      brand: BRAND,
      cachedAt: new Date().toISOString(),
    });
    clearBrandFromDocument();
    expect(document.documentElement.dataset.branded).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue('--v4-brand-accent')).toBe('');
  });
});

describe('cache + syncBrandFromWorkspaces', () => {
  const memory = new Map<string, string>();
  const storage = {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => {
      memory.set(k, v);
    },
    removeItem: (k: string) => {
      memory.delete(k);
    },
  } as Storage;

  afterEach(() => {
    memory.clear();
  });

  it('writes cache on entitled sync and clears on entitlement lost', () => {
    const live = syncBrandFromWorkspaces([entitledSource()], {
      cloudReachable: true,
      storage,
    });
    expect(live?.brand.accentColor).toBe('#6633cc');
    expect(readBrandCache(storage)?.brand.logoUrlLight).toBe(BRAND.logoUrlLight);

    const cleared = syncBrandFromWorkspaces(
      [{ slug: 'northwind', kind: 'company', brandingEnabled: false, brand: BRAND }],
      { cloudReachable: true, storage },
    );
    expect(cleared).toBeNull();
    expect(readBrandCache(storage)).toBeNull();
  });

  it('keeps cache when cloud is unreachable (offline render)', () => {
    writeBrandCache(
      {
        brandingEnabled: true,
        brand: BRAND,
        cachedAt: '2026-01-01T00:00:00.000Z',
      },
      storage,
    );
    const offline = syncBrandFromWorkspaces([], {
      cloudReachable: false,
      storage,
    });
    expect(offline?.brand.accentColor).toBe('#6633cc');
    expect(storage.getItem(BRAND_CACHE_KEY)).not.toBeNull();
  });

  it('clearBrandCache removes the stamp', () => {
    writeBrandCache(
      {
        brandingEnabled: true,
        brand: BRAND,
        cachedAt: new Date().toISOString(),
      } satisfies CachedBrand,
      storage,
    );
    clearBrandCache(storage);
    expect(readBrandCache(storage)).toBeNull();
  });
});

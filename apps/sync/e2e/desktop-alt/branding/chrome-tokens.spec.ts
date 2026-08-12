// @vitest-environment happy-dom
//
// US-007 — Desktop UI chrome test harness for white-label branding.
// US-005 — Branded chrome assertions (accent tokens, logo, lockup, cache).
//
// Component harness (Vitest + happy-dom), not tauri-driver: macOS WKWebView has
// no WebDriver support, so live-driver E2E cannot assert CSS custom properties
// inside the real desktop window. This suite:
//
//   1. Injects the real `src/desktop-alt/v4/tokens.css` into a happy-dom document
//      and asserts --v4-* token values under both prefers-color-scheme modes.
//   2. Mounts a real V4 chrome component (V4TitleBar) with HQ defaults to prove
//      the app shell renders against those tokens.
//   3. Applies brand fixtures (loadBrandFixture / TEST_BRAND) and asserts
//      branded accent tokens, logo variant selection + fallback, powered-by
//      lockup, offline cache render, and entitlement-lost reset.
//
// Brand fixtures live in ./fixtures.ts (TEST_BRAND / loadBrandFixture). No live
// hq-pro backend is required.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { loadBrandFixture, TEST_BRAND, TEST_ENTITLEMENT } from './fixtures';
import {
  applyBrandToDocument,
  BRAND_CACHE_KEY,
  clearBrandFromDocument,
  deriveAccentTokens,
  readBrandCache,
  selectLogoUrl,
  syncBrandFromWorkspaces,
  type CachedBrand,
} from '../../../src/lib/brand';

// Tauri bridge mocks — V4TitleBar itself does not invoke Tauri, but matching
// the mission-control mount pattern keeps the harness consistent if chrome
// components gain bridge deps later.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

const TOKENS_CSS_PATH = resolve(process.cwd(), 'src/desktop-alt/v4/tokens.css');
const TOKENS_CSS = readFileSync(TOKENS_CSS_PATH, 'utf8');
const STYLE_ID = 'v4-tokens-fixture';

// Dark defaults from :root in tokens.css
// Monorepo (DESKTOP-012) achromatic-glass palette. happy-dom does not support
// backdrop-filter, so --v4-ground resolves through the @supports-not fallback
// block (near-solid material alpha) with vars substituted textually.
const DARK = {
  ground: 'rgb(17 17 17 / clamp(0.92, calc(1 - 0.65 * 0.03), 1))',
  text1: '#f2f2f2',
  ok: '#41d870',
} as const;

// Light is the default scheme in the monorepo tokens.css; dark comes from the
// prefers-color-scheme media block. Status hues resolve via popover fallbacks.
const LIGHT = {
  ground: 'rgb(242 242 242 / clamp(0.92, calc(1 - 0.65 * 0.03), 1))',
  text1: '#111111',
  ok: '#1f9d4d',
} as const;

type ColorScheme = 'light' | 'dark';

function happyDomSettings(): { device: { prefersColorScheme: string } } {
  // happy-dom attaches settings on window.happyDOM (vitest happy-dom env).
  return (window as unknown as { happyDOM: { settings: { device: { prefersColorScheme: string } } } })
    .happyDOM.settings;
}

function setPrefersColorScheme(scheme: ColorScheme): void {
  happyDomSettings().device.prefersColorScheme = scheme;
}

function injectTokensCss(): void {
  document.getElementById(STYLE_ID)?.remove();
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = TOKENS_CSS;
  document.head.appendChild(style);
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function applySchemeAndTokens(scheme: ColorScheme): void {
  // Set scheme BEFORE injecting (or re-inject after) so media-query rules resolve.
  setPrefersColorScheme(scheme);
  injectTokensCss();
}

function entitledCached(brand = loadBrandFixture()): CachedBrand {
  return {
    brandingEnabled: true,
    brand: {
      logoUrlLight: brand.logoUrlLight,
      logoUrlDark: brand.logoUrlDark,
      accentColor: brand.accentColor,
    },
    companySlug: 'northwind',
    cachedAt: new Date().toISOString(),
  };
}

// ── Token assertions ────────────────────────────────────────────────────────

describe('US-007 — V4 chrome tokens (HQ defaults, both color schemes)', () => {
  afterEach(() => {
    document.getElementById(STYLE_ID)?.remove();
    clearBrandFromDocument();
  });

  it('exposes dark-mode --v4-* defaults when prefers-color-scheme is dark', () => {
    applySchemeAndTokens('dark');

    expect(window.matchMedia('(prefers-color-scheme: dark)').matches).toBe(true);
    expect(cssVar('--v4-ground')).toBe(DARK.ground);
    expect(cssVar('--v4-text-1')).toBe(DARK.text1);
    expect(cssVar('--v4-ok')).toBe(DARK.ok);
  });

  it('switches --v4-ground and --v4-text-1 under light prefers-color-scheme', () => {
    applySchemeAndTokens('light');

    expect(window.matchMedia('(prefers-color-scheme: light)').matches).toBe(true);
    expect(cssVar('--v4-ground')).toBe(LIGHT.ground);
    expect(cssVar('--v4-text-1')).toBe(LIGHT.text1);
    // Status hues darken for contrast on light surfaces (tokens.css light block).
    expect(cssVar('--v4-ok')).toBe(LIGHT.ok);

    // Explicit "CHANGED from dark" contract for the two surface/text tokens.
    expect(cssVar('--v4-ground')).not.toBe(DARK.ground);
    expect(cssVar('--v4-text-1')).not.toBe(DARK.text1);
  });

  it('can re-resolve tokens after flipping the scheme mid-suite', () => {
    applySchemeAndTokens('dark');
    expect(cssVar('--v4-ground')).toBe(DARK.ground);

    applySchemeAndTokens('light');
    expect(cssVar('--v4-ground')).toBe(LIGHT.ground);
    expect(cssVar('--v4-text-1')).toBe(LIGHT.text1);
  });
});

// ── App-shell smoke: real V4 chrome mounts with HQ defaults ─────────────────

describe('US-007 — app shell mounts with HQ defaults', () => {
  let host: HTMLElement;
  let component: Record<string, unknown> | null = null;

  beforeEach(() => {
    applySchemeAndTokens('dark');
    clearBrandFromDocument();
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(async () => {
    if (component) {
      await unmount(component);
      component = null;
    }
    host?.remove();
    document.getElementById(STYLE_ID)?.remove();
    clearBrandFromDocument();
    vi.restoreAllMocks();
  });

  it('mounts V4TitleBar chrome and produces DOM under HQ default tokens', async () => {
    // Import after mocks so the Svelte module sees the bridge stubs.
    const { default: V4TitleBar } = await import('../../../src/desktop-alt/v4/V4TitleBar.svelte');

    component = mount(V4TitleBar, {
      target: host,
      props: {
        syncState: 'idle',
        watchedCount: 1,
        lastSyncLabel: 'just now',
      },
    });
    flushSync();

    const titlebar = host.querySelector('.v4-titlebar');
    expect(titlebar).not.toBeNull();
    expect(host.querySelector('[data-testid="titlebar-wordmark"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="titlebar-core-pill"]')).not.toBeNull();
    expect(host.querySelector('[data-tauri-drag-region]')).not.toBeNull();

    // Tokens still resolve on :root while chrome is mounted.
    expect(cssVar('--v4-ground')).toBe(DARK.ground);
    expect(cssVar('--v4-text-1')).toBe(DARK.text1);
    expect(cssVar('--v4-ok')).toBe(DARK.ok);

    // Fixture loader is wired (default path = TEST_BRAND).
    expect(loadBrandFixture()).toEqual(TEST_BRAND);
    expect(TEST_ENTITLEMENT).toBe('not_entitled');

    // Unbranded logo slot: HQ mark present, no powered-by lockup.
    const { default: BrandLogoSlot } = await import('../../../src/lib/BrandLogoSlot.svelte');
    const logoHost = document.createElement('div');
    host.appendChild(logoHost);
    const logo = mount(BrandLogoSlot, {
      target: logoHost,
      props: { brand: null, brandingEnabled: false, size: 'desktop' },
    });
    flushSync();
    expect(logoHost.querySelector('[data-testid="brand-hq-mark"]')).not.toBeNull();
    expect(logoHost.querySelector('[data-testid="powered-by-hq"]')).toBeNull();
    await unmount(logo);
  });
});

// ── Branded chrome (US-005) ─────────────────────────────────────────────────

describe('branded chrome (US-005)', () => {
  let host: HTMLElement;
  let component: Record<string, unknown> | null = null;
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

  beforeEach(() => {
    memory.clear();
    clearBrandFromDocument();
    applySchemeAndTokens('dark');
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(async () => {
    if (component) {
      await unmount(component);
      component = null;
    }
    host?.remove();
    document.getElementById(STYLE_ID)?.remove();
    clearBrandFromDocument();
    memory.clear();
    vi.restoreAllMocks();
  });

  it('applies branded accent tokens in dark and light appearance', () => {
    const brand = loadBrandFixture();
    const expected = deriveAccentTokens(brand.accentColor)!;
    expect(brand.accentColor).toBe(TEST_BRAND.accentColor);
    // Soft tint is fixed at 16% alpha (shared contract with console).
    expect(expected.accentSoft).toMatch(/,\s*0\.16\s*\)$/);

    const reservedInline = [
      '--v4-ok',
      '--v4-warn',
      '--v4-error',
      '--v4-unread',
      '--v4-idle',
      '--v4-text-1',
      '--v4-text-2',
      '--v4-text-3',
    ] as const;

    for (const scheme of ['dark', 'light'] as const) {
      applySchemeAndTokens(scheme);
      applyBrandToDocument(entitledCached(brand));

      const root = document.documentElement;
      expect(root.dataset.branded).toBe('true');
      // Inline style from applyBrandToDocument (source of truth for the hex).
      expect(root.style.getPropertyValue('--v4-brand-accent').trim()).toBe(expected.accent);
      expect(root.style.getPropertyValue('--v4-brand-accent-soft').trim()).toBe(expected.accentSoft);
      // Popover mirrors the same derivation.
      expect(root.style.getPropertyValue('--popover-brand-accent').trim()).toBe(expected.accent);
      expect(root.style.getPropertyValue('--popover-brand-accent-soft').trim()).toBe(
        expected.accentSoft,
      );

      // Reserved status + text tokens must not be overridden inline.
      for (const name of reservedInline) {
        expect(root.style.getPropertyValue(name).trim()).toBe('');
      }
      // And they still resolve to scheme defaults from tokens.css.
      expect(cssVar('--v4-ok')).toBe(scheme === 'dark' ? DARK.ok : LIGHT.ok);
      expect(cssVar('--v4-text-1')).toBe(scheme === 'dark' ? DARK.text1 : LIGHT.text1);
      expect(cssVar('--v4-ground')).toBe(scheme === 'dark' ? DARK.ground : LIGHT.ground);

      // Branded remaps for selection / CTA (via :root[data-branded='true']).
      expect(cssVar('--v4-active-row')).toBe(expected.accentSoft);
      expect(cssVar('--v4-cta-bg')).toBe(expected.accent);
    }
  });

  it('selects logo light/dark variants with cross-variant fallback', () => {
    const brand = loadBrandFixture();
    expect(selectLogoUrl(brand, 'light')).toBe(brand.logoUrlLight);
    expect(selectLogoUrl(brand, 'dark')).toBe(brand.logoUrlDark);
    expect(selectLogoUrl({ logoUrlLight: brand.logoUrlLight }, 'dark')).toBe(brand.logoUrlLight);
    expect(selectLogoUrl({ logoUrlDark: brand.logoUrlDark }, 'light')).toBe(brand.logoUrlDark);
  });

  it('renders tenant logo + powered-by lockup when entitled', async () => {
    const brand = loadBrandFixture();
    applyBrandToDocument(entitledCached(brand));

    const { default: BrandLogoSlot } = await import('../../../src/lib/BrandLogoSlot.svelte');
    component = mount(BrandLogoSlot, {
      target: host,
      props: {
        brand: entitledCached(brand),
        brandingEnabled: true,
        size: 'desktop',
        companyName: 'Northwind',
        scheme: 'dark',
      },
    });
    flushSync();

    const img = host.querySelector<HTMLImageElement>('[data-testid="brand-tenant-logo"]');
    expect(img).not.toBeNull();
    expect(img!.src).toContain(brand.logoUrlDark);
    expect(img!.getAttribute('data-scheme')).toBe('dark');
    expect(host.querySelector('[data-testid="powered-by-hq"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="powered-by-hq"]')?.textContent).toMatch(/powered by/);
    // Lettermark SVG is present; the word "HQ" must not appear as text.
    const lockupText = host.querySelector('.powered-by-text')?.textContent?.trim();
    expect(lockupText).toBe('powered by');
  });

  it('falls back to HQ mark on tenant logo load failure', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const brand = loadBrandFixture();
    const { default: BrandLogoSlot } = await import('../../../src/lib/BrandLogoSlot.svelte');
    component = mount(BrandLogoSlot, {
      target: host,
      props: {
        brand: entitledCached(brand),
        brandingEnabled: true,
        size: 'desktop',
        scheme: 'light',
      },
    });
    flushSync();

    const img = host.querySelector<HTMLImageElement>('[data-testid="brand-tenant-logo"]');
    expect(img).not.toBeNull();
    // Simulate asset failure.
    img!.dispatchEvent(new Event('error'));
    flushSync();

    expect(host.querySelector('[data-testid="brand-hq-mark"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="brand-tenant-logo"]')).toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('[brand] tenant logo failed to load'),
      expect.anything(),
    );
  });

  it('renders cached branding offline and clears on entitlement lost', () => {
    const brand = loadBrandFixture();
    const cached = syncBrandFromWorkspaces(
      [
        {
          slug: 'northwind',
          kind: 'company',
          brandingEnabled: true,
          brand: {
            logoUrlLight: brand.logoUrlLight,
            logoUrlDark: brand.logoUrlDark,
            accentColor: brand.accentColor,
          },
        },
      ],
      { cloudReachable: true, storage },
    );
    expect(cached).not.toBeNull();
    expect(readBrandCache(storage)?.brand.accentColor).toBe(brand.accentColor);
    expect(storage.getItem(BRAND_CACHE_KEY)).not.toBeNull();

    // Offline launch: empty sources + cloud unreachable keeps cache + applies it.
    const offline = syncBrandFromWorkspaces([], {
      cloudReachable: false,
      storage,
    });
    expect(offline?.brand.accentColor).toBe(brand.accentColor);
    applyBrandToDocument(offline);
    expect(document.documentElement.dataset.branded).toBe('true');
    expect(
      document.documentElement.style.getPropertyValue('--v4-brand-accent').trim().toLowerCase(),
    ).toBe(brand.accentColor.toLowerCase());

    // Entitlement lost on a live cloud response clears cache.
    const cleared = syncBrandFromWorkspaces(
      [
        {
          slug: 'northwind',
          kind: 'company',
          brandingEnabled: false,
          brand: {
            logoUrlLight: brand.logoUrlLight,
            logoUrlDark: brand.logoUrlDark,
            accentColor: brand.accentColor,
          },
        },
      ],
      { cloudReachable: true, storage },
    );
    expect(cleared).toBeNull();
    expect(readBrandCache(storage)).toBeNull();
    expect(storage.getItem(BRAND_CACHE_KEY)).toBeNull();

    // clearBrandFromDocument leaves no data-branded and no brand vars.
    applyBrandToDocument(offline); // re-apply so clear is meaningful
    expect(document.documentElement.dataset.branded).toBe('true');
    clearBrandFromDocument();
    expect(document.documentElement.dataset.branded).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue('--v4-brand-accent').trim()).toBe('');
    expect(
      document.documentElement.style.getPropertyValue('--popover-brand-accent').trim(),
    ).toBe('');

    // Empty entitled sources (cloud reachable) also resets chrome when applied.
    applyBrandToDocument(cleared);
    expect(document.documentElement.dataset.branded).toBeUndefined();
  });

  it('omits powered-by lockup when unbranded', async () => {
    clearBrandFromDocument();
    const { default: BrandLogoSlot } = await import('../../../src/lib/BrandLogoSlot.svelte');
    component = mount(BrandLogoSlot, {
      target: host,
      props: {
        brand: null,
        brandingEnabled: false,
        size: 'desktop',
      },
    });
    flushSync();

    expect(host.querySelector('[data-testid="powered-by-hq"]')).toBeNull();
    expect(host.querySelector('[data-testid="brand-hq-mark"]')).not.toBeNull();
  });

  it('mounts V4 sidebar logo slot under branded chrome without breaking status tokens', async () => {
    const brand = loadBrandFixture();
    applyBrandToDocument(entitledCached(brand));
    const { default: BrandLogoSlot } = await import('../../../src/lib/BrandLogoSlot.svelte');
    component = mount(BrandLogoSlot, {
      target: host,
      props: {
        brand: entitledCached(brand),
        brandingEnabled: true,
        size: 'desktop',
        scheme: 'dark',
      },
    });
    flushSync();

    expect(host.querySelector('[data-testid="brand-logo-slot"]')?.getAttribute('data-branded')).toBe(
      'true',
    );
    expect(cssVar('--v4-ok')).toBe(DARK.ok);
    expect(cssVar('--v4-text-1')).toBe(DARK.text1);
  });
});

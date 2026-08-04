// @vitest-environment happy-dom
//
// US-007 — Desktop UI chrome test harness for white-label branding.
//
// Component harness (Vitest + happy-dom), not tauri-driver: macOS WKWebView has
// no WebDriver support, so live-driver E2E cannot assert CSS custom properties
// inside the real desktop window. This suite:
//
//   1. Injects the real `src/desktop-alt/v4/tokens.css` into a happy-dom document
//      and asserts --v4-* token values under both prefers-color-scheme modes.
//   2. Mounts a real V4 chrome component (V4TitleBar) with HQ defaults to prove
//      the app shell renders against those tokens.
//   3. Leaves a describe.todo placeholder for branded chrome once US-005 lands.
//
// Brand fixtures live in ./fixtures.ts (TEST_BRAND / loadBrandFixture). No live
// hq-pro backend is required.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { loadBrandFixture, TEST_BRAND, TEST_ENTITLEMENT } from './fixtures';

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
const DARK = {
  ground: '#161618',
  text1: '#f2f2f3',
  ok: '#30d158',
} as const;

// Light overrides from @media (prefers-color-scheme: light) in tokens.css
const LIGHT = {
  ground: '#f6f6f8',
  text1: '#111113',
  ok: '#1a8f3c',
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

// ── Token assertions ────────────────────────────────────────────────────────

describe('US-007 — V4 chrome tokens (HQ defaults, both color schemes)', () => {
  afterEach(() => {
    document.getElementById(STYLE_ID)?.remove();
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
    expect(host.querySelector('.v4-status')).not.toBeNull();
    expect(host.querySelector('.v4-action')).not.toBeNull();
    expect(host.querySelector('[data-tauri-drag-region]')).not.toBeNull();

    // Tokens still resolve on :root while chrome is mounted.
    expect(cssVar('--v4-ground')).toBe(DARK.ground);
    expect(cssVar('--v4-text-1')).toBe(DARK.text1);
    expect(cssVar('--v4-ok')).toBe(DARK.ok);

    // Fixture loader is wired for future branded cases (default path = TEST_BRAND).
    expect(loadBrandFixture()).toEqual(TEST_BRAND);
    expect(TEST_ENTITLEMENT).toBe('not_entitled');
  });
});

// ── Branded chrome placeholder (US-005 product work not landed) ─────────────
//
// When US-005 ships white-label chrome, fill this block with real assertions:
// load brand via loadBrandFixture() / TEST_BRAND, set entitlement to 'entitled',
// mount the branded shell, and assert logo URLs + accent overrides. Until then
// keep this as a visible gap so the harness stays discoverable.

describe.todo('branded chrome (US-005)', () => {
  // Placeholder — do not assert yet.
  //
  // Planned shape once product lands:
  //   const brand = loadBrandFixture(); // or TEST_BRAND
  //   // entitle + apply brand to chrome
  //   // expect logo light/dark URLs and accentColor (#6633cc in TEST_BRAND)
  //   // expect --v4-* (or brand override vars) reflect the fixture
  //
  // Fixture reference: TEST_BRAND =
  //   logoUrlLight: https://fixtures.test/logo-light.svg
  //   logoUrlDark:  https://fixtures.test/logo-dark.svg
  //   accentColor:  #6633cc
  // Entitlement: BrandEntitlement = 'entitled' | 'not_entitled'
});

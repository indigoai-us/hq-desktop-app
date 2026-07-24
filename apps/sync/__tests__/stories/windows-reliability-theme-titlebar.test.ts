/**
 * US-003 — Windows theme, notification, and native title-bar policy
 *
 * Source-contract + appearance-matrix checks for Mica/Acrylic theme mapping,
 * no forced-dark backdrop, banner solid fallback, native Windows title bar,
 * and light/dark/reduced-motion/reduced-transparency surfaces.
 *
 * Note: apps/sync/__tests__/stories/US-003.test.ts is a legacy story — do not
 * overwrite it. This file is the acceptance suite for
 * hq-desktop-windows-reliability / US-003.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(process.cwd());

function readRepo(...parts: string[]): string {
  const path = join(repoRoot, ...parts);
  expect(existsSync(path), `missing ${parts.join('/')}`).toBe(true);
  return readFileSync(path, 'utf8');
}

/** Prefer monorepo-relative paths when tests run from apps/sync. */
function readPlatformWindowEffects(): string {
  const candidates = [
    join(repoRoot, '../../crates/hq-platform/src/window_effects.rs'),
    join(repoRoot, 'crates/hq-platform/src/window_effects.rs'),
    join(repoRoot, '../../../crates/hq-platform/src/window_effects.rs'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  // Last resort: walk up from cwd looking for the crate.
  let dir = repoRoot;
  for (let i = 0; i < 6; i++) {
    const p = join(dir, 'crates/hq-platform/src/window_effects.rs');
    if (existsSync(p)) return readFileSync(p, 'utf8');
    dir = join(dir, '..');
  }
  throw new Error('window_effects.rs not found relative to cwd');
}

function readMainRs(): string {
  return readRepo('src-tauri/src/main.rs');
}

function readDesktopAltRs(): string {
  return readRepo('src-tauri/src/commands/desktop_alt.rs');
}

describe('US-003: Windows theme, notification, and native title-bar policy', () => {
  describe('centralized Windows window-style helper', () => {
    it('maps live theme to matching Mica/Acrylic fallback colors (not forced dark)', () => {
      const src = readPlatformWindowEffects();

      // Central helper surface.
      expect(src).toMatch(/enum\s+WindowAppearance/);
      expect(src).toMatch(/fn\s+apply_windows_window_style/);
      expect(src).toMatch(/fn\s+resolve_windows_appearance/);
      expect(src).toMatch(/fn\s+mica_dark/);
      expect(src).toMatch(/fn\s+acrylic_rgba/);

      // Light and dark acrylic tints both exist.
      expect(src).toMatch(/248,\s*248,\s*250,\s*200/);
      expect(src).toMatch(/18,\s*18,\s*18,\s*180/);

      // Must NOT hard-code dark Mica via apply_mica(..., Some(true)).
      expect(src).not.toMatch(/apply_mica\s*\(\s*window\s*,\s*Some\s*\(\s*true\s*\)\s*\)/);
      expect(src).not.toMatch(/apply_mica:\s*success\s*\(dark variant\)/);

      // Mica dark flag is derived from appearance.
      expect(src).toMatch(/apply_mica\s*\(\s*window\s*,\s*dark\s*\)/);
    });

    it('reapplies window style on ThemeChanged', () => {
      const main = readMainRs();
      expect(main).toMatch(/WindowEvent::ThemeChanged/);
      expect(main).toMatch(/apply_windows_window_style/);
      expect(main).toMatch(/Theme::Dark/);
    });

    it('desktop-alt applies themed style from the live Tauri theme', () => {
      const src = readDesktopAltRs();
      expect(src).toMatch(/apply_windows_window_style/);
      expect(src).toMatch(/Theme::Dark/);
      expect(src).toMatch(/Theme::Light/);
      expect(src).toMatch(/\.theme\s*\(\s*\)/);
      // macOS Overlay branch stays macOS-only.
      expect(src).toMatch(/#\[cfg\(target_os\s*=\s*"macos"\)\][\s\S]*title_bar_style/);
      expect(src).toMatch(/\.decorations\s*\(\s*true\s*\)/);
    });
  });

  describe('no forced-dark Windows surfaces', () => {
    it('rejects hard-coded dark Mica / locked dark color-scheme / forced dark popover bg', () => {
      const effects = readPlatformWindowEffects();
      expect(effects).not.toContain('apply_mica(window, Some(true))');

      const popover = readRepo('src/components/Popover.svelte');
      // Old forced-dark opaque surface must be gone.
      expect(popover).not.toMatch(
        /data-platform=['"]windows['"][\s\S]{0,200}background:\s*#18181b/,
      );
      expect(popover).toMatch(/data-platform=['"]windows['"][\s\S]{0,120}var\(--pop-bg/);

      const banner = readRepo('src/components/BannerNotification.svelte');
      expect(banner).toMatch(/color-scheme:\s*light dark/);
      expect(banner).not.toMatch(/color-scheme:\s*dark\s*;/);

      const settings = readRepo('src/desktop-alt/pages/SettingsPage.svelte');
      expect(settings).not.toMatch(/select\s*\{[^}]*color-scheme:\s*dark/);
      expect(settings).toMatch(/color-scheme:\s*light dark/);
    });
  });

  describe('banner notification fallback', () => {
    it('has deterministic legible fallback when transparency is unavailable', () => {
      const banner = readRepo('src/components/BannerNotification.svelte');

      // Solid base color under glass layers.
      expect(banner).toMatch(/background-color:\s*#f7f7f8/);
      expect(banner).toMatch(/prefers-color-scheme:\s*dark[\s\S]{0,80}#262628/);

      // Reduced-transparency solid path.
      expect(banner).toMatch(/prefers-reduced-transparency:\s*reduce/);
      expect(banner).toMatch(/background-image:\s*none/);

      // Light-mode action chip remains readable.
      expect(banner).toMatch(/prefers-color-scheme:\s*light[\s\S]{0,120}#1c3d80/);

      // Reduced motion respected.
      expect(banner).toMatch(/prefers-reduced-motion:\s*reduce/);
    });
  });

  describe('native Windows title bar / no traffic-light inset', () => {
    it('V4TitleBar drops the macOS traffic-light inset on Windows', () => {
      const titlebar = readRepo('src/desktop-alt/v4/V4TitleBar.svelte');
      // macOS default still has the 78px inset.
      expect(titlebar).toMatch(/padding-left:\s*78px/);
      // Windows override removes it.
      expect(titlebar).toMatch(
        /data-platform=['"]windows['"][\s\S]{0,80}padding-left:\s*12px/,
      );
      expect(titlebar).toMatch(
        /data-platform=['"]windows['"][\s\S]{0,120}v4-drag-lights[\s\S]{0,40}display:\s*none/,
      );
    });

    it('desktop entry sets data-platform before mount', () => {
      const desktopMain = readRepo('src/desktop-alt/main.ts');
      expect(desktopMain).toContain("dataset.platform = isWindows ? 'windows' : 'other'");

      const popoverMain = readRepo('src/main.ts');
      expect(popoverMain).toContain("dataset.platform = isWindows ? 'windows' : 'other'");
    });

    it('activity and drift drop macOS traffic-light gutters on Windows', () => {
      const activity = readRepo('src/components/ActivityLog.svelte');
      expect(activity).toMatch(
        /data-platform=['"]windows['"][\s\S]{0,60}detail-header[\s\S]{0,40}padding-top/,
      );

      const drift = readRepo('src/components/DriftDetail.svelte');
      expect(drift).toMatch(
        /data-platform=['"]windows['"][\s\S]{0,60}drift-header[\s\S]{0,40}padding-left:\s*1rem/,
      );
    });
  });

  describe('appearance matrix (light / dark / reduced motion / reduced transparency)', () => {
    const surfaces: Array<{ name: string; path: string; checks: RegExp[] }> = [
      {
        name: 'popover tokens',
        path: 'src/styles/popover.css',
        checks: [
          /prefers-color-scheme:\s*dark/,
          /prefers-reduced-transparency:\s*reduce/,
        ],
      },
      {
        name: 'design system',
        path: 'src/styles/design-system.css',
        checks: [/prefers-color-scheme:\s*dark/, /--pop-bg/],
      },
      {
        name: 'desktop v4 tokens',
        path: 'src/desktop-alt/v4/tokens.css',
        checks: [
          /prefers-color-scheme:\s*dark/,
          /prefers-reduced-transparency:\s*reduce/,
        ],
      },
      {
        name: 'banner',
        path: 'src/components/BannerNotification.svelte',
        checks: [
          /prefers-color-scheme:\s*light/,
          /prefers-color-scheme:\s*dark/,
          /prefers-reduced-transparency/,
          /prefers-reduced-motion/,
        ],
      },
      {
        name: 'titlebar',
        path: 'src/desktop-alt/v4/V4TitleBar.svelte',
        checks: [
          /prefers-reduced-motion:\s*reduce/,
          /prefers-reduced-transparency:\s*reduce/,
        ],
      },
      {
        name: 'activity',
        path: 'src/components/ActivityLog.svelte',
        checks: [/prefers-reduced-transparency:\s*reduce/],
      },
      {
        name: 'drift',
        path: 'src/components/DriftDetail.svelte',
        checks: [/--popover-bg|--pop-bg|prefers-color-scheme/],
      },
    ];

    for (const surface of surfaces) {
      it(`${surface.name} participates in the appearance matrix`, () => {
        const src = readRepo(surface.path);
        for (const re of surface.checks) {
          expect(src, `${surface.name} should match ${re}`).toMatch(re);
        }
      });
    }

    it('desktop-alt reduced-transparency path keeps solid chrome', () => {
      const css = readRepo('src/desktop-alt/styles/desktop-alt.css');
      expect(css).toMatch(/prefers-reduced-transparency:\s*reduce/);
    });
  });
});

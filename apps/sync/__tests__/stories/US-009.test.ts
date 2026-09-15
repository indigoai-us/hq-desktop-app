import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * US-009 (hq-pack-porter) — Unify the Packages surface into the Marketplace /
 * Library area.
 *
 * The standalone Packages window (a separate Tauri window opened from Settings)
 * is removed as a distinct destination, and its function is merged into the
 * desktop-alt **Library** area as a new **Installed** tab — so installed packs
 * AND browsable/marketplace packs now live in ONE coherent surface, with no
 * duplicate package UIs. This consolidates (does NOT regress) the proj-119
 * Library/Marketplace work; the attribution byline + creator-profile link still
 * work (covered by US-019), and the install / scope-select flows are untouched.
 *
 * This repo has no DOM/component harness (vitest `environment: "node"`), so —
 * like the other US-0xx story tests — these are SOURCE-CONTRACT tests over the
 * relevant sources plus on-disk presence/absence checks.
 */

const root = process.cwd();
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8');
const normalize = (s: string): string => s.replace(/\s+/g, ' ');

describe('US-009: the standalone Packages destination is removed', () => {
  it('no longer ships the standalone Packages window app or its HTML entry', () => {
    // The dedicated window's Svelte app, its mount entry, and its HTML are gone.
    expect(existsSync(resolve(root, 'packages.html'))).toBe(false);
    expect(existsSync(resolve(root, 'src/packages/PackagesApp.svelte'))).toBe(false);
    expect(existsSync(resolve(root, 'src/packages/main.ts'))).toBe(false);
    // And its capability file (windows: ["packages"]) is removed too.
    expect(existsSync(resolve(root, 'src-tauri/capabilities/packages.json'))).toBe(false);
  });

  it('drops the packages window from the Vite build inputs and the Tauri window config', () => {
    const vite = read('vite.config.ts');
    expect(vite).not.toContain('packages.html');

    const conf = read('src-tauri/tauri.conf.json');
    expect(conf).not.toContain('packages.html');
    // No window labelled "packages" remains in the app window list.
    const windows = JSON.parse(conf).app.windows as Array<{ label?: string }>;
    expect(windows.some((w) => w.label === 'packages')).toBe(false);
  });

  it('keeps only compatibility shims for the retired window lifecycle', () => {
    const rust = read('src-tauri/src/commands/packages.rs');
    // The standalone window and ready-handshake state are still gone.
    expect(rust).not.toContain('pub struct PendingPackages');
    // The legacy command names exist only as thin shims to the unified Library
    // surface, so older automation does not hit an unknown IPC command.
    expect(rust).toContain('pub async fn open_packages_window');
    expect(rust).toContain('DesktopDestination::LibraryInstalled');
    expect(rust).toContain('pub fn packages_window_ready');
    expect(rust).toContain('None');

    const main = read('src-tauri/src/main.rs');
    // They are registered as compatibility commands, but no managed
    // PendingPackages state or packages window is reintroduced.
    expect(main).toContain('commands::packages::open_packages_window');
    expect(main).toContain('commands::packages::packages_window_ready');
    expect(main).not.toContain('PendingPackages');
    // The data commands that now back the Library tab are still registered.
    expect(main).toContain('commands::packages::list_packages');
    expect(main).toContain('commands::packages::uninstall_package');
  });
});

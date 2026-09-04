import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-016 Atlas v0 — source contracts for the Sync desktop-alt shell.
 * Behavioural three-state + offline-within-30s coverage lives in
 * packages/ui/src/atlas (happy-dom mounts; no DISPLAY required).
 */
describe('US-016 Atlas v0 desktop-alt wiring', () => {
  const route = readRepoFile('src/desktop-alt/route.ts');
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const atlasPage = readRepoFile('src/desktop-alt/pages/AtlasPage.svelte');
  const host = readRepoFile('src/desktop-alt/hq-work-host.ts');
  const mesh = readRepoFile('src/desktop-alt/mesh-presence.ts');

  it('adds atlas to DesktopRoute + pending path parsing', () => {
    expect(route).toContain("'atlas'");
    expect(route).toContain("case 'atlas':");
    expect(route).toContain("return { kind: 'atlas' }");
  });

  it('renders AtlasPage and registers hotkey g a + palette entry', () => {
    expect(desktopApp).toContain("import AtlasPage from './pages/AtlasPage.svelte'");
    expect(desktopApp).toContain("route.kind === 'atlas'");
    expect(desktopApp).toContain("<AtlasPage");
    expect(desktopApp).toContain("id: 'command-go-atlas'");
    expect(desktopApp).toContain("createGoChord");
    expect(desktopApp).toContain("letter !== 'a'");
    expect(desktopApp).toContain("navigate({ kind: 'atlas' })");
    expect(desktopApp).toContain("shortcut: 'g a'");
  });

  it('gates Atlas like other desktop-alt surfaces', () => {
    expect(atlasPage).toContain("desktop_alt_enabled");
    expect(atlasPage).toContain('AtlasPage as SharedAtlasPage');
  });

  it('maps atlas through the embedded host routeTarget', () => {
    expect(host).toContain("case 'atlas':");
    expect(host).toContain("return { kind: 'atlas' }");
  });

  it('binds Atlas open refresh to MeshClient (no polling)', () => {
    expect(mesh).toContain('bindLiveRefresh');
    expect(mesh).toContain('client.refreshLive');
    expect(atlasPage).not.toMatch(/setInterval\s*\(/);
  });
});

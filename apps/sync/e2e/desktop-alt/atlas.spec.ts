import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * Atlas is console-only. Desktop must not mount the map, palette entry, or g a.
 */
describe('desktop Atlas removal', () => {
  const route = readRepoFile('src/desktop-alt/route.ts');
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const host = readRepoFile('src/desktop-alt/hq-work-host.ts');

  it('remaps leftover atlas deep-links to Home', () => {
    expect(route).toContain("case 'atlas':");
    expect(route).toContain("return { kind: 'home' }");
    expect(host).toContain("case 'atlas':");
    expect(host).toContain("return { kind: 'home' }");
  });

  it('does not render AtlasPage or register g a', () => {
    expect(desktopApp).not.toContain("import AtlasPage from './pages/AtlasPage.svelte'");
    expect(desktopApp).not.toContain("<AtlasPage");
    expect(desktopApp).not.toContain("id: 'command-go-atlas'");
    expect(desktopApp).not.toContain("createGoChord");
    expect(desktopApp).not.toContain("shortcut: 'g a'");
  });
});

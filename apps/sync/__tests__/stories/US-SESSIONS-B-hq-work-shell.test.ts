// @vitest-environment happy-dom
/**
 * US-SESSIONS-B — Sessions reaches the HQ Work shell, not just the classic one.
 *
 * `hqWorkHandoff` makes `HqWorkDesktopShell` the product surface, so a Sessions
 * page that only the classic shell can mount is a page most users cannot open.
 * The shell mounts it through `@hq/ui`'s generic `extraPages` seam (a vendored
 * local divergence — see `packages/VENDORED.md`), which keeps `packages/ui`
 * free of any Sync/Tauri import.
 *
 * The sync suite runs in a node environment, so Svelte components cannot be
 * mounted here: the router is imported and CALLED for real, and the wiring that
 * exists only as markup is pinned at the source level.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import {
  EMBEDDED_NAVIGATION_EVENT,
  OPEN_SETTINGS_EVENT,
  takePendingChannelOpen,
  takePendingConversation,
} from '@hq/ui';

import {
  applyDesktopAltRoute,
  createEmbeddedNavigationController,
} from '../../src/desktop-alt/hq-work-host';

// happy-dom's `URL` resolves a relative path against a `file:` base wrongly, so
// this suite joins with `node:path` instead of the `new URL(...)` form the
// node-environment story tests use.
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string =>
  readFileSync(resolve(HERE, '../../', relative), 'utf8');

const SHELL = read('src/desktop-alt/HqWorkDesktopShell.svelte');
const WRAPPER = read('src/desktop-alt/pages/SessionsExtraPage.svelte');
const HOST = read('src/desktop-alt/hq-work-host.ts');

/** Route through a controller so nothing is dispatched at the window. */
function target(route: string) {
  return applyDesktopAltRoute(route, createEmbeddedNavigationController());
}

afterEach(() => {
  takePendingChannelOpen();
  takePendingConversation();
});

describe('US-SESSIONS-B — the embedded route', () => {
  it('routes `sessions` to the host-registered destination', () => {
    expect(target('sessions')).toEqual({
      kind: 'extra',
      page: 'sessions',
      param: null,
    });
  });

  it('carries a deep-linked session id as the page param', () => {
    expect(target('sessions:abc')).toEqual({
      kind: 'extra',
      page: 'sessions',
      param: 'abc',
    });
    // The native pending-route grammar also accepts the slash form.
    expect(target('sessions/abc')).toEqual({
      kind: 'extra',
      page: 'sessions',
      param: 'abc',
    });
  });

  it('refuses a route with extra segments instead of guessing an id', () => {
    expect(target('sessions:a:b')).toEqual({
      kind: 'unsupported',
      route: 'sessions:a:b',
      reason: 'Unsupported embedded destination',
    });
    expect(target('sessions/a/b')).toEqual({
      kind: 'unsupported',
      route: 'sessions/a/b',
      reason: 'Unsupported embedded destination',
    });
  });

  it('leaves every previously routed destination exactly as it was', () => {
    const seen: string[] = [];
    const targets: unknown[] = [];
    const onSettings = () => {
      seen.push('settings');
    };
    const onEmbedded = (event: Event) => {
      targets.push((event as CustomEvent).detail);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, onSettings);
    window.addEventListener(EMBEDDED_NAVIGATION_EVENT, onEmbedded);
    applyDesktopAltRoute(null);
    applyDesktopAltRoute('meetings');
    applyDesktopAltRoute('inbox');
    applyDesktopAltRoute('messages');
    applyDesktopAltRoute('settings');
    applyDesktopAltRoute('settings:updates');
    applyDesktopAltRoute('settings/general');
    applyDesktopAltRoute('library:marketplace');
    applyDesktopAltRoute('home');
    window.removeEventListener(OPEN_SETTINGS_EVENT, onSettings);
    window.removeEventListener(EMBEDDED_NAVIGATION_EVENT, onEmbedded);
    expect(seen).toEqual(['settings']);
    expect(targets).toEqual([
      { kind: 'meetings' },
      { kind: 'inbox' },
      { kind: 'messages' },
      { kind: 'settings', section: 'updates' },
      { kind: 'settings', section: 'general' },
      { kind: 'library', tab: 'marketplace' },
      { kind: 'home' },
    ]);
    expect(takePendingChannelOpen()).toBeNull();
  });

  it('routes sessions from the same switch the other destinations use', () => {
    expect(HOST).toContain("case 'sessions':");
    expect(HOST).toContain("return { kind: 'extra', page: 'sessions', param: detail || null };");
  });
});

describe('US-SESSIONS-B — the shell registers the destination', () => {
  it('gates it on inAppSessions exactly like the classic shell', () => {
    expect(SHELL).toContain('inAppSessionsOn');
    expect(SHELL).toContain('inAppSessionsOn || import.meta.env.DEV');
    expect(SHELL).toContain('sessionsEnabled');
    // Read from the shared adapter's settings seam, not a bespoke invoke.
    expect(SHELL).toContain('adapter.settings.getSettings()');
    expect(SHELL).toContain("inAppSessions === true");
  });

  it('registers it under the `sessions` page id and hands it to DesktopApp', () => {
    expect(SHELL).toContain("import SessionsExtraPage from './pages/SessionsExtraPage.svelte'");
    expect(SHELL).toContain('const extraPages = $derived');
    expect(SHELL).toContain('sessions: {');
    expect(SHELL).toContain("label: 'Sessions'");
    expect(SHELL).toContain('component: SessionsExtraPage');
    expect(SHELL).toContain('{extraPages}');
  });

  it('registers nothing when the flag is off', () => {
    // The false arm of the gate is an empty registry, so the palette row and
    // the route both disappear rather than mounting a disabled surface.
    const gate = SHELL.slice(SHELL.indexOf('const extraPages = $derived'));
    expect(gate.slice(0, gate.indexOf(');'))).toContain(': {}');
  });

  it('hydrates the preference under the shell request/generation lease', () => {
    expect(SHELL).toContain('refreshSessionsPreference');
    expect(SHELL).toContain('void refreshSessionsPreference(request, expectedGeneration)');
    const fn = SHELL.slice(
      SHELL.indexOf('async function refreshSessionsPreference'),
      SHELL.indexOf('async function hydrateSession'),
    );
    expect(fn).toContain('if (request !== hydration || generation !== authGeneration) return;');
  });
});

describe('US-SESSIONS-B — the wrapper adapts the shell contract', () => {
  it('translates the shell param into the page props and back', () => {
    expect(WRAPPER).toContain("import SessionsPage from './SessionsPage.svelte'");
    expect(WRAPPER).toContain('sessionId={param ?? undefined}');
    expect(WRAPPER).toContain('onopensession={(id) => onnavigate?.(id || null)}');
  });

  it('keeps Tauri out of the shared UI package', () => {
    const desktopApp = read('../../packages/ui/src/shell/DesktopApp.svelte');
    expect(desktopApp).not.toContain('@tauri-apps/');
    expect(desktopApp).not.toContain('SessionsPage');
    expect(desktopApp).not.toContain('SessionsExtraPage');
    // The shell only knows the generic seam.
    expect(desktopApp).toContain('extraPages');
  });
});

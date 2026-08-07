import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Non-recurrence guard for Sentry HQ-DESKTOP-39.
 *
 * Most `@tauri-apps/api` window helpers (`onResized`, `onMoved`,
 * `onCloseRequested`, `onThemeChanged`, `onScaleChanged`) hand back the raw
 * `listen()` handle — `async () => _unlisten(event, id)` — which RETURNS its
 * rejection, so `safeUnlisten` can contain it. Those stay allowed.
 *
 * Exactly two helpers are different. `onFocusChanged` and `onDragDropEvent`
 * await two registrations each and return a synchronous composite:
 *
 *   () => { unlistenA(); unlistenB(); }
 *
 * That arrow evaluates to `undefined` and drops both inner promises inside the
 * framework closure, where no app-side wrapper can reach them. A stale-map
 * teardown then escapes as an unhandled rejection no matter how the call site
 * wraps the handle — which is exactly how HQ-DESKTOP-39 survived two shipped
 * "containment" fixes.
 *
 * `src/lib/listener-registry.ts` replaces the focus composite with
 * `subscribeWindowFocus`, which registers the two window events itself. This
 * test keeps any surface from quietly reaching for the framework composites
 * again.
 *
 * Verified against @tauri-apps/api 2.11.1. Re-check this list when that
 * dependency is upgraded: a new composite helper needs a new entry here and a
 * decomposed wrapper in `listener-registry.ts`.
 */
const COMPOSITE_HELPERS = ['onFocusChanged', 'onDragDropEvent'] as const;

const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const srcRoot = root('src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.(?:ts|svelte)$/.test(entry.name)) return [];
    // Test doubles are allowed — and required — to model the real framework
    // shapes, including the composite ones.
    if (/\.test\.ts$/.test(entry.name)) return [];
    return [path];
  });
}

/**
 * Drop comments so prose describing the bug does not trip its own guard (and a
 * commented-out call cannot hide from it either).
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function compositeCallsIn(source: string): string[] {
  const code = stripComments(source);
  return COMPOSITE_HELPERS.filter((helper) => code.includes(`.${helper}(`));
}

describe('HQ-DESKTOP-39: framework composite listener handles', () => {
  it('never calls a composite window helper from application source', () => {
    const offenders = sourceFiles(srcRoot)
      .map((path) => ({ path, helpers: compositeCallsIn(readFileSync(path, 'utf8')) }))
      .filter((entry) => entry.helpers.length > 0)
      .map((entry) => `${relative(srcRoot, entry.path)} -> ${entry.helpers.join(', ')}`);

    expect(
      offenders,
      'These helpers discard their inner unlisten promises, so a stale teardown ' +
        'escapes as an unhandled rejection (Sentry HQ-DESKTOP-39). Use ' +
        'subscribeWindowFocus from src/lib/listener-registry.ts, or add an ' +
        'equivalent decomposed wrapper there.',
    ).toEqual([]);
  });

  it('is not vacuous: it flags the exact shape it is meant to catch', () => {
    // Guard the guard — a broken matcher would otherwise pass forever.
    expect(compositeCallsIn('await getCurrentWindow().onFocusChanged(fn);')).toEqual([
      'onFocusChanged',
    ]);
    expect(compositeCallsIn('void win.onDragDropEvent(fn);')).toEqual([
      'onDragDropEvent',
    ]);
    // ...and that comments really are exempt, so the module docstrings that
    // explain the bug do not fail the build.
    expect(compositeCallsIn('// see win.onFocusChanged(fn)')).toEqual([]);
    expect(compositeCallsIn('/* win.onFocusChanged(fn) */')).toEqual([]);
    // A URL is not a comment.
    expect(stripComments('const u = "https://example.com/x";')).toContain(
      'https://example.com/x',
    );
  });

  it('scans a real, non-empty set of source files', () => {
    // A resolver typo that silently walked an empty directory would make every
    // assertion above trivially true.
    const files = sourceFiles(srcRoot);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((path) => path.endsWith('App.svelte'))).toBe(true);
  });

  it('offers the decomposed replacement the guard points at', () => {
    const registry = readFileSync(root('src/lib/listener-registry.ts'), 'utf8');
    expect(registry).toContain('export async function subscribeWindowFocus(');
    // It must register the two window events itself rather than delegate back
    // to the composite it exists to replace.
    expect(registry).toContain("'tauri://focus'");
    expect(registry).toContain("'tauri://blur'");
    expect(stripComments(registry)).not.toContain('.onFocusChanged(');
  });

  it('routes every focus surface through the decomposed subscription', () => {
    // Every production surface that used to call `onFocusChanged`. Named
    // explicitly so dropping one back to the composite — or deleting its
    // subscription outright — fails here rather than silently reopening the
    // Sentry lane. `DesktopApp.svelte` is covered by source contract because no
    // spec in this repo mounts it; the runtime proof for the shared mechanism
    // is `e2e/desktop-alt/popover-listener-teardown.spec.ts` (real Popover) and
    // `src/desktop-alt/lib/library-refresh.test.ts` (real desktop-alt Library
    // consumer), both against faithful @tauri-apps/api doubles.
    const migrated = [
      'App.svelte',
      'components/Popover.svelte',
      'components/MeetingsWindow.svelte',
      'desktop-alt/DesktopApp.svelte',
      'desktop-alt/lib/library-refresh.ts',
    ];

    for (const rel of migrated) {
      const source = stripComments(readFileSync(join(srcRoot, rel), 'utf8'));
      expect(
        source.includes('subscribeWindowFocus('),
        `${rel} no longer subscribes to window focus through the decomposed helper`,
      ).toBe(true);
    }
  });
});

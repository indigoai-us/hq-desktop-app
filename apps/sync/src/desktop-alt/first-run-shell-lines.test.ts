import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// PR 1670: the window went back to #welcome mid first run and the log could
// not say whether the shell remounted, reloaded or the app relaunched. Each
// remount and reload site writes a `[first-run] kind=shell` line right next
// to the change that causes it.
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(HERE, path), 'utf8');
const shell = read('HqWorkWorkShell.svelte');
const boundary = read('../components/GlobalErrorBoundary.svelte');
const workShell = read('../../../work/src/lib/WorkShell.svelte');

/** The text from `start` up to (not including) `end`, both of which must be present. */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from);
  expect(to, `missing ${end} after ${start}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('[first-run] shell lines at each remount and reload site', () => {
  it('logs a remount when a new auth session generation remounts the keyed shell', () => {
    const accept = between(shell, 'function acceptAuthSession(', 'authGeneration = next.generation;');
    expect(accept).toContain("if (next.generation !== authGeneration) logShellRemount('auth-session');");
  });

  it('logs a remount when sign-out bumps the generation', () => {
    const signOut = between(shell, 'async function signOut(', 'authGeneration += 1;');
    expect(signOut).toContain("logShellRemount('sign-out');");
  });

  it('writes the remount line through frontend_log under the first-run tag', () => {
    const helper = between(shell, 'function logShellRemount(', 'let authAccountId');
    expect(helper).toContain("invokeFn('frontend_log', { tag: FIRST_RUN_TIMING_TAG, message: formatShell('remount', reason) })");
    expect(shell).toContain('{#key authGeneration}');
  });

  it('logs a remount when a tenant switch bumps the shell epoch', () => {
    const accept = between(workShell, 'shellEpoch += 1;', 'clearTenantState();');
    expect(accept).toContain('formatShell("remount", "tenant-switch")');
    expect(workShell).toContain('{#key shellEpoch}');
  });

  it('logs a reload before Start over reloads the page', () => {
    const startOver = between(boundary, 'function handleStartOver(', 'window.location.reload();');
    expect(startOver).toContain("formatShell('reload', 'error-boundary')");
    expect(startOver).toContain('tag: FIRST_RUN_TIMING_TAG');
  });
});

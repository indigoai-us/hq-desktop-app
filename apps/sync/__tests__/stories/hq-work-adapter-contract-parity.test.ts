/**
 * Regression: the Sync PlatformAdapter must implement every member the
 * @hq/platform contract declares.
 *
 * The branch shipped US-102 with `appShell` missing `setDesktopWidget` and
 * `showOsNotification`. Only `svelte-check` caught it — the US-102 story test
 * built the adapter and exercised individual commands, so vitest stayed green
 * while the app could not build. This test reads the contract source and
 * asserts group-by-group parity at runtime, so a future contract addition
 * fails the fast gate instead of the bundle.
 *
 * Source-contract style (same shape as the other story tests): the required
 * member list is derived from @hq/platform's own `adapter.ts`, never restated
 * here, so it cannot drift.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSyncPlatformAdapter,
  type SyncInvokeFn,
} from '@hq/platform';

const require = createRequire(import.meta.url);

function platformAdapterSource(): string {
  const entry = require.resolve('@hq/platform');
  return readFileSync(resolve(dirname(entry), 'adapter.ts'), 'utf8');
}

/** Body of `export interface <name> { ... }`, brace-balanced. */
function interfaceBody(src: string, name: string): string {
  const header = src.indexOf(`export interface ${name} {`);
  if (header === -1) throw new Error(`interface ${name} not found`);
  const open = src.indexOf('{', header);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`interface ${name} is unbalanced`);
}

interface Member {
  name: string;
  method: boolean;
}

/**
 * Top-level declared members of an interface body. Nested object literals
 * (`showOsNotification(args: { title: string })`) are skipped by brace depth,
 * optional members are dropped — an adapter may legally omit those.
 */
function requiredMembers(body: string): Member[] {
  const members: Member[] = [];
  let depth = 0;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    const before = depth;
    for (const ch of rawLine) {
      if (ch === '{' || ch === '(' || ch === '<' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ')' || ch === '>' || ch === ']') depth -= 1;
    }
    if (before !== 0) continue;
    if (!line || line.startsWith('*') || line.startsWith('/')) continue;
    const match = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)(\??)\s*([(<:])/.exec(line);
    if (!match) continue;
    const [, name, optional, delimiter] = match;
    if (optional === '?') continue;
    members.push({ name, method: delimiter !== ':' });
  }
  return members;
}

/** `readonly <key>: <Name>Api;` pairs off the PlatformAdapter interface. */
function apiGroups(src: string): Array<{ key: string; iface: string }> {
  const groups: Array<{ key: string; iface: string }> = [];
  for (const line of interfaceBody(src, 'PlatformAdapter').split('\n')) {
    const match = /^\s*readonly\s+([A-Za-z_$][\w$]*):\s*([A-Za-z_$][\w$]*Api);/.exec(
      line,
    );
    if (match) groups.push({ key: match[1], iface: match[2] });
  }
  return groups;
}

const invoke: SyncInvokeFn = async () => null;

function makeAdapter() {
  return createSyncPlatformAdapter({
    invoke,
    fetch: () => {
      throw new Error('adapter must not use window.fetch');
    },
  });
}

describe('Sync PlatformAdapter contract parity', () => {
  const src = platformAdapterSource();
  const groups = apiGroups(src);

  it('reads a non-trivial contract (guards the parser itself)', () => {
    expect(groups.length).toBeGreaterThan(10);
    expect(groups.map((g) => g.key)).toContain('appShell');
    const appShell = requiredMembers(interfaceBody(src, 'AppShellApi')).map(
      (m) => m.name,
    );
    // The two members whose absence broke the build.
    expect(appShell).toContain('setDesktopWidget');
    expect(appShell).toContain('showOsNotification');
  });

  it.each(groups)('implements every $iface member on $key', ({ key, iface }) => {
    const adapter = makeAdapter() as unknown as Record<
      string,
      Record<string, unknown>
    >;
    const group = adapter[key];
    expect(group, `adapter.${key} is missing`).toBeTruthy();
    const missing = requiredMembers(interfaceBody(src, iface))
      .filter(({ name, method }) =>
        method ? typeof group[name] !== 'function' : !(name in group),
      )
      .map(({ name }) => name);
    expect(missing, `adapter.${key} is missing ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('reports only OS notifications as host-owned, not silently ok', async () => {
    const adapter = makeAdapter();
    const result = await adapter.appShell.showOsNotification({
      title: 'a',
      body: 'b',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('unavailable');
    expect(result.code).toBe('host-owned');
  });
});

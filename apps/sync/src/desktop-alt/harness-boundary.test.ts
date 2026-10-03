import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// AUDIT-3: the preview switches (?auth=, ?reads=, ?toast=, ?gates=, ?atlas=)
// live in apps/sync/dev-harness and must never reach the app bundle. Walk the
// import graph from every production entry (vite.config.ts inputs) through
// relative imports and the workspace packages, and assert no file under
// dev-harness is reachable.
const HERE = dirname(fileURLToPath(import.meta.url));
const SYNC = resolve(HERE, '../..');
const ROOT = resolve(SYNC, '../..');
const HARNESS = join(SYNC, 'dev-harness');
const PACKAGES: Record<string, string> = {
  '@hq/ui': join(ROOT, 'packages/ui/src/index.ts'),
  '@hq/platform': join(ROOT, 'packages/platform/src/index.ts'),
};

function resolveSpec(from: string, spec: string): string | null {
  let base: string | null = null;
  if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else if (PACKAGES[spec]) return PACKAGES[spec];
  else if (spec.startsWith('@hq/ui/')) base = join(ROOT, 'packages/ui/src', spec.slice('@hq/ui/'.length));
  else if (spec.startsWith('@hq/platform/')) base = join(ROOT, 'packages/platform/src', spec.slice('@hq/platform/'.length));
  if (!base) return null;
  const candidates = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}.svelte.ts`, `${base}.svelte`, join(base, 'index.ts')];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

function graph(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !/\.(ts|svelte|js|mjs)$/.test(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:import|export)[^'"`]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g)) {
      const next = resolveSpec(file, m[1] ?? m[2] ?? m[3]);
      if (next) queue.push(next);
    }
  }
  return seen;
}

function productionEntries(): string[] {
  const htmls = readdirSync(SYNC).filter((f) => f.endsWith('.html'));
  const config = readFileSync(join(SYNC, 'vite.config.ts'), 'utf8');
  const inputs = htmls.filter((h) => config.includes(h));
  const scripts: string[] = [];
  for (const html of inputs) {
    for (const m of readFileSync(join(SYNC, html), 'utf8').matchAll(/<script[^>]+src="\/?([^"]+)"/g)) {
      const file = join(SYNC, m[1]);
      if (existsSync(file)) scripts.push(file);
    }
  }
  return scripts;
}

describe('preview harness stays out of the app bundle (AUDIT-3)', () => {
  it('finds the production entries', () => {
    const entries = productionEntries();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.endsWith('src/main.ts') || e.endsWith('desktop-alt/main.ts'))).toBe(true);
  });

  it('reaches no dev-harness file from any production entry', () => {
    const reached = [...graph(productionEntries())];
    expect(reached.length).toBeGreaterThan(50);
    expect(reached.filter((f) => f.startsWith(HARNESS))).toEqual([]);
  });
});

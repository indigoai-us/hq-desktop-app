import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
const syncRs = read('src-tauri/src/commands/sync.rs');

describe('company-scoped sync', () => {

  it('builds mutually exclusive all-company and single-company runner selectors', () => {
    const start = syncRs.indexOf('pub fn build_sync_spawn_args(');
    const end = syncRs.indexOf('// ─────────────────────────────────────────────────', start);
    const builder = syncRs.slice(start, end);
    const selectorMatch = builder.indexOf('match scope {');
    const baseArgs = builder.slice(0, selectorMatch);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(selectorMatch).toBeGreaterThan(-1);
    expect(baseArgs).not.toContain('"--companies"');
    expect(baseArgs).not.toContain('"--company"');
    expect(builder.match(/"--companies"/g) ?? []).toHaveLength(1);
    expect(builder.match(/"--company"/g) ?? []).toHaveLength(1);
    expect(builder).toMatch(
      /match scope \{\s*SyncRunScope::All => args\.push\("--companies"\.to_string\(\)\),\s*SyncRunScope::Company\(slug\) => \{\s*args\.push\("--company"\.to_string\(\)\);\s*args\.push\(slug\.clone\(\)\);\s*\}\s*\}/,
    );
  });
});

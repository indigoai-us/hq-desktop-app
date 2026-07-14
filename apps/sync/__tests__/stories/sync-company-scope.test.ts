import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const companyPage = read('src/desktop-alt/pages/CompanyPage.svelte');
const syncRs = read('src-tauri/src/commands/sync.rs');

describe('company-scoped sync', () => {
  it('scopes the post-claim sync to the company whose invite was accepted', () => {
    const start = companyPage.indexOf('async function handleAcceptPendingInvite()');
    const end = companyPage.indexOf('async function startNewProject()', start);
    const postClaimPath = companyPage.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(postClaimPath).toContain(
      "void invoke('start_sync', { companySlug: company.slug })",
    );
  });

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

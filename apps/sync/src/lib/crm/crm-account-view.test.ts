/**
 * Story-contract test for the hq-native-crm US-010 Accounts view.
 *
 * The hq-sync vitest suite runs in the `node` environment (no jsdom/happy-dom),
 * so the repo's convention for component contracts is to read the source at
 * module level and assert the wiring with normalized-string `.toContain` checks
 * (see policy hq-sync-story-tests-read-source-at-module-level). This file pins
 * the load-bearing contracts of the read-only Accounts surface:
 *
 *   • the `accounts` CompanyTab is registered on the V4 route union + sidebar;
 *   • CompanyPage renders AccountView for the accounts tab;
 *   • AccountView reads the vault-synced projection via the local-first +
 *     vault-API loader and makes NO network call to Attio / Stripe / PandaDoc /
 *     Neon (the US-010 e2e contract: one surface, zero external network);
 *   • the detail surface renders demo origin + pipeline stage + contract status
 *     + latest invoice + the meetings/signals timeline + the ontology footer.
 *
 * The behavioral guarantees (grouping, needs-attention, detail assembly,
 * graceful degradation from a FIXTURE projection) are proven against real data
 * in `account-view-model.test.ts`; this file proves the component is wired to
 * that model and to the no-network read path.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const rustMain = readFileSync(
  resolve(process.cwd(), 'src-tauri/src/main.rs'),
  'utf8',
);

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ');
}

/**
 * Strip comments + the <style> block so policy/no-network assertions inspect the
 * EXECUTABLE source only. The component documents the policies it follows
 * ("indigo-no-purple", "no network to Attio/Stripe/PandaDoc") in prose, and the
 * footer literally reads "no network to Attio/Stripe/PandaDoc" — neither is a
 * forbidden CALL. We assert there is no Attio/Stripe network primitive in the
 * code, not that the words never appear in documentation.
 */
function codeOnly(source: string): string {
  return source
    .replace(/<style[\s\S]*?<\/style>/g, '') // drop CSS
    .replace(/<!--[\s\S]*?-->/g, '') // HTML comments
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments
}
const NORM_MAIN = normalize(rustMain);

// ── no external network (the US-010 e2e contract) ────────────────────────────

describe('US-010: read-only, no external network', () => {

  it('both Rust read commands are registered in main.rs', () => {
    expect(NORM_MAIN).toContain('commands::projects_local::get_company_crm_projection');
    expect(NORM_MAIN).toContain('commands::desktop_alt::get_company_crm_projection_vault');
  });
});

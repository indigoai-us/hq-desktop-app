import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const notesPath = resolve(process.cwd(), 'docs/design/v4/IMPLEMENTATION-NOTES.md');
const notes = readFileSync(notesPath, 'utf8');
const safetyFlows = readFileSync(
  resolve(process.cwd(), 'e2e/desktop-alt/safety-flows.spec.ts'),
  'utf8',
);
const secretsSpec = readFileSync(
  resolve(process.cwd(), 'e2e/desktop-alt/secrets-never-leak.spec.ts'),
  'utf8',
);
const desktopStyle = readFileSync(
  resolve(process.cwd(), 'src/desktop-alt/styles/desktop-alt.css'),
  'utf8',
);

describe('US-017: full-suite verification release guard', () => {
  it('documents the current audit and marks the older PNG inventory as historical', () => {
    expect(existsSync(notesPath)).toBe(true);
    expect(notes).toContain('src/desktop-alt/route.ts` is authoritative');
    expect(notes).toContain('older Paper exports');
    expect(notes).toContain('29 primary routes');
    expect(notes).toContain('9 nested screens and popouts');
    expect(notes).toContain('10 minimum-width checks');
    expect(notes).toContain('saved screenshots');
    expect(notes).toContain('tauri-driver');
  });

  it('names the required full-suite commands in the release notes', () => {
    for (const command of [
      'pnpm --filter hq-sync typecheck',
      'pnpm --filter hq-sync lint',
      'pnpm --filter hq-sync test',
      'pnpm --filter hq-sync test:e2e:desktop-alt',
      'pnpm --filter hq-sync build',
      'cargo test --workspace --quiet',
    ]) {
      expect(notes).toContain(command);
    }
  });

  it('keeps the critical safety and secrets specs wired', () => {
    expect(secretsSpec).toContain('desktop-alt secrets never leak');
    // US-021: strengthened — no company-secrets request at all.
    expect(secretsSpec).toContain('never requests company secrets');
    expect(secretsSpec).toContain('get_company_secrets');
    // V4 safety flows are handled inline (NeedsYouCard) rather than by dedicated
    // pages; the spec asserts the real conflict/drift wiring and the abort-only
    // guard (hard policy hq-sync-bulk-asymmetry-breaker-means-abort).
    expect(safetyFlows).toContain('resolve_conflict');
    expect(safetyFlows).toContain('restore_from_upstream');
    expect(safetyFlows).toContain('hq-sync-bulk-asymmetry-breaker-means-abort');
    expect(safetyFlows).toContain('Sync stopped because a conflict needs attention.');
  });

  it('keeps V4 styling isolated to desktop-alt while reusing popover tokens', () => {
    const normalizedNotes = notes.replace(/\s+/g, ' ');
    expect(desktopStyle).toContain("@import '../../styles/popover.css'");
    expect(desktopStyle).toContain('--desktop-titlebar-height');
    expect(normalizedNotes).toContain('separate Messages window remains native and independent');
    expect(normalizedNotes).toContain('titlebar owns live sync verdicts');
  });
});

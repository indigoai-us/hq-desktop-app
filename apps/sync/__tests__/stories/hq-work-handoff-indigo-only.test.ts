/**
 * The embedded HQ Work window is limited to the `@getindigo.ai` cohort.
 *
 * `~/.hq/menubar.json` is a plain user-writable file, so `hqWorkHandoff: true`
 * is an opt-in and never an authorisation — anyone can type it. The effective
 * answer has to be `flag AND is_indigo_user()`.
 *
 * The composition itself is unit-tested in Rust
 * (`commands/config.rs::hq_work_handoff_tests`), which is where the domain
 * matching and look-alike cases live. What cannot be proved there is that the
 * real command is wired onto that composition, and that no other reader
 * bypasses it — a second call site parsing `hqWorkHandoff` straight off disk
 * would reopen the hole without failing a single Rust test. That is this
 * file's job.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd());

function readRepo(...parts: string[]): string {
  return readFileSync(resolve(repoRoot, ...parts), 'utf8');
}

function rustSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...rustSources(full));
    else if (entry.endsWith('.rs')) out.push(full);
  }
  return out;
}

describe('embedded HQ Work window is Indigo-only', () => {
  const config = readRepo('src-tauri/src/commands/config.rs');

  it('gates the flag read on is_indigo_user, not on the file alone', () => {
    expect(config).toContain('pub async fn get_hq_work_handoff()');
    expect(config).toContain('hq_work_handoff_visible(');
    expect(config).toMatch(
      /hq_desktop_core::feature_gate::is_indigo_user\(\)\s*\.await/,
    );
  });

  it('makes cohort membership a hard AND, with the choice defaulting on', () => {
    const body = config.slice(
      config.indexOf('pub fn hq_work_handoff_visible('),
      config.indexOf('/// On by default for'),
    );
    // `is_indigo &&` first: default-on applies INSIDE the cohort only. An
    // `||` here would hand the embed to everyone.
    expect(body).toContain('is_indigo && choice.unwrap_or(true)');
    expect(body).not.toContain('||');
  });

  it('keeps an explicit opt-out for cohort members', () => {
    // Default-on without a way back would leave no route to the legacy
    // window short of signing out, and the US-107 rollback scenario would
    // have nothing to exercise.
    expect(config).toContain('choice == Some(false)');
    expect(config).toContain('pub fn hq_work_handoff_choice(');
  });

  it('refuses to persist the flag for a non-Indigo account', () => {
    expect(config).toContain('pub async fn set_hq_work_handoff(');
    const body = config.slice(config.indexOf('pub async fn set_hq_work_handoff('));
    expect(body).toMatch(
      /if enabled && !hq_desktop_core::feature_gate::is_indigo_user\(\)\s*\.await/,
    );
    expect(body).toMatch(/@getindigo\.ai/);
  });

  it('uses the canonical feature gate rather than its own domain literal', () => {
    // One definition of "who is Indigo". A hand-rolled `ends_with("@…")` here
    // would drift from the updater's cohort and miss the look-alike guard.
    expect(config).not.toMatch(/ends_with\(\s*"@getindigo\.ai"/);
  });

  it('has no reader that parses hqWorkHandoff outside config.rs', () => {
    const offenders = rustSources(resolve(repoRoot, 'src-tauri/src'))
      .filter((path) => !path.endsWith('commands/config.rs'))
      .filter((path) => /"hqWorkHandoff"/.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(repoRoot.length + 1));
    expect(
      offenders,
      `these read the raw flag and would bypass the cohort gate: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('documents the cohort limit in the operator checklist', () => {
    const smoke = readRepo('docs/hq-work-embedded-smoke.md');
    expect(smoke).toMatch(/@getindigo\.ai/);
    expect(smoke).toMatch(/is_indigo_user/);
  });
});

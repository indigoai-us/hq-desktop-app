/**
 * The desktop workspace is the only UI. The retired email-domain cohort and
 * `hqWorkHandoff` menubar key must not select a shell.
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

describe('desktop workspace is the only UI', () => {
  const featureGate = readRepo('../../crates/hq-desktop-core/src/feature_gate.rs');
  const boot = readRepo('src/desktop-alt/boot.ts');

  it('feature gate no longer has an HQ Work email-domain cohort', () => {
    expect(featureGate).not.toContain('HQ_WORK_ALLOWED_DOMAINS');
    expect(featureGate).not.toContain('is_hq_work_allowed_email');
    expect(featureGate).not.toContain('is_hq_work_cohort_user');
    expect(featureGate).toContain('is_allowed_email');
  });

  it('boot always mounts the hq-work shell', () => {
    expect(boot).not.toContain('mountLegacy');
    expect(boot).toContain('await deps.mountHqWork()');
  });

  it('no command module besides config.rs writes the retired hqWorkHandoff key', () => {
    const offenders = rustSources(resolve(repoRoot, 'src-tauri/src'))
      .filter((path) => !path.endsWith('commands/config.rs'))
      .filter((path) => /"hqWorkHandoff"\s*,/.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(repoRoot.length + 1));
    expect(
      offenders,
      `these still write the retired flag: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});

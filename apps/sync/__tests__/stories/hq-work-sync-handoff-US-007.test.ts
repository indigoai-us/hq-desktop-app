/**
 * US-007 — Cross-app E2E smoke suite for the HQ Work handoff.
 *
 * Source-contract: the committed checklist exists and names the five
 * scenarios. Live GUI Results stay blank until an operator run.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd());

function readRepo(...parts: string[]): string {
  return readFileSync(resolve(repoRoot, ...parts), 'utf8');
}

describe('US-007 HQ Work handoff QA smoke checklist', () => {
  const qaPath = resolve(repoRoot, 'docs/hq-work-handoff-qa.md');

  it('commits apps/sync/docs/hq-work-handoff-qa.md', () => {
    expect(existsSync(qaPath)).toBe(true);
  });

  it('contains the five scenario headings', () => {
    const qa = readRepo('docs/hq-work-handoff-qa.md');
    expect(qa).toContain(
      '## Scenario 1: Fresh machine (no HQ Work) → card → install → open',
    );
    expect(qa).toContain('## Scenario 2: Upgrade path co-install');
    expect(qa).toContain(
      '## Scenario 3: Notification → correct channel including reply threads',
    );
    expect(qa).toContain('## Scenario 4: Flag-off rollback');
    expect(qa).toContain(
      '## Scenario 5: Both-apps-signed-in Cognito sanity',
    );
  });

  it('has pass boxes, log/flag notes, Results blanks, and a handoff-doc link', () => {
    const qa = readRepo('docs/hq-work-handoff-qa.md');
    expect(qa).toContain('[hq-work-handoff.md](hq-work-handoff.md)');
    expect(qa).toContain('~/.hq/menubar.json');
    expect(qa).toContain('hqWorkHandoff');
    expect(qa).toContain("grep '\\[handoff\\]' ~/.hq/logs/hq-sync.log");
    expect(qa).toContain('- [ ] Pass — Scenario 1:');
    expect(qa).toContain('- [ ] Pass — Scenario 2:');
    expect(qa).toContain('- [ ] Pass — Scenario 3:');
    expect(qa).toContain('- [ ] Pass — Scenario 4:');
    expect(qa).toContain('- [ ] Pass — Scenario 5:');
    expect(qa).toContain('## Results (live machine)');
    expect(qa).toContain('**not executed**');
    expect(qa).not.toMatch(/- \[x\] Pass — Scenario/);
  });

  it('repo docs/ pointer names the canonical apps/sync path', () => {
    const pointer = readRepo('../../docs/hq-work-handoff-qa.md');
    expect(pointer).toContain('apps/sync/docs/hq-work-handoff-qa.md');
    const index = readRepo('../../docs/README.md');
    expect(index).toContain('hq-work-handoff-qa.md');
  });
});

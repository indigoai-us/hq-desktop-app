/**
 * Source contract: project-scan Git probes never flash a Windows console.
 *
 * Overview / Projects / Goals refresh `scan_local_projects*`, which walks Git
 * history for creator fallbacks. Those spawns must go through
 * `paths::git_command()` (CREATE_NO_WINDOW on Windows). Bare
 * `Command::new("git")` in production helpers reintroduces idle CMD flicker.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(process.cwd());
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

const PATHS = '../../crates/hq-desktop-core/src/paths.rs';
const PROJECTS = '../../crates/hq-desktop-core/src/projects_local.rs';

function functionBody(src: string, signature: RegExp): string {
  const match = signature.exec(src);
  expect(match, `expected ${signature}`).toBeTruthy();
  const start = match!.index;
  const afterSig = src.slice(start);
  const open = afterSig.indexOf('{');
  expect(open).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = open; i < afterSig.length; i++) {
    const ch = afterSig[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return afterSig.slice(0, i + 1);
    }
  }
  throw new Error(`unterminated function for ${signature}`);
}

describe('windows: project-scan git spawns stay windowless', () => {
  it('exposes paths::git_command that applies no_window and GIT_OPTIONAL_LOCKS', () => {
    const src = read(PATHS);
    const body = functionBody(src, /pub fn\s+git_command\(\)\s*->\s*Command/);
    expect(body).toContain('Command::new("git")');
    expect(body).toContain('no_window(&mut cmd)');
    expect(body).toContain('GIT_OPTIONAL_LOCKS');
  });

  it('routes production project-scan git helpers through git_command', () => {
    const src = read(PROJECTS);
    for (const signature of [
      /fn\s+apply_modified_rename_commit\s*\(/,
      /fn\s+git_head\s*\(/,
      /fn\s+load_git_first_add_creators\s*\(/,
    ]) {
      const body = functionBody(src, signature);
      expect(body).toContain('crate::paths::git_command()');
      expect(body).not.toMatch(/Command::new\(\s*"git"\s*\)/);
    }
  });
});

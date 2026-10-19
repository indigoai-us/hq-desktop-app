// Source contract: first-run setup never asks macOS to install Apple's
// Command Line Tools and never runs the /usr/bin tool shims.
//
// On a Mac without the tools, /usr/bin/git, python3, make and clang are shims
// that open Apple's install prompt (a 19.18 GB download on a full disk). HQ
// installs its own git and Node instead, so nothing in the app may spawn
// xcode-select or one of those shims.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

const SCAN_ROOTS = ['apps/sync/src', 'apps/sync/src-tauri/src', 'apps/sync/dev-harness', 'crates', 'packages'];
const SOURCE_EXTENSIONS = ['.rs', '.ts', '.svelte', '.js', '.mjs', '.cjs'];
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', '.svelte-kit']);
const THIS_FILE = 'apps/sync/src/lib/no-apple-tools-install.contract.test.ts';

// hq_cli_update.rs only reads "xcode-select" out of a failed npm install log
// and names the command in advice text. It never spawns it.
const XCODE_SELECT_ALLOWED_FILES = new Set(['crates/hq-desktop-core/src/hq_cli_update.rs']);

// The wizard behaviour test answers the old tools commands as "missing" and
// asserts the wizard never calls them, so it has to name them.
const GATE_NAME_ALLOWED_FILES = new Set(['apps/sync/src/components/onboarding/OnboardingWizard.welcome-flow.test.ts']);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) out.push(full);
    }
  };
  for (const root of SCAN_ROOTS) walk(join(repoRoot, root));
  return out.map((file) => relative(repoRoot, file).split('\\').join('/'));
}

function hits(pattern: RegExp, allowed: Set<string> = new Set()): string[] {
  const found: string[] = [];
  for (const file of sourceFiles()) {
    if (file === THIS_FILE || allowed.has(file)) continue;
    const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (pattern.test(line)) found.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
}

describe('no Apple developer tools install in the app', () => {
  it('scans the app source', () => {
    const files = sourceFiles();
    expect(files).toContain('apps/sync/src-tauri/src/commands/install_deps.rs');
    expect(files).toContain('crates/hq-desktop-core/src/paths.rs');
    expect(files).toContain('apps/sync/src/components/onboarding/OnboardingWizard.svelte');
  });

  it('never mentions xcode-select outside the npm failure classifier', () => {
    expect(hits(/xcode-select/, XCODE_SELECT_ALLOWED_FILES)).toEqual([]);
  });

  it('has no Command Line Tools gate, commands or test hooks', () => {
    expect(
      hits(/command_line_tools|command-line-tools-gate|CLT_GATED_STAGES|HQ_FAKE_CLT_MISSING|clt-mocks/, GATE_NAME_ALLOWED_FILES),
    ).toEqual([]);
  });

  it('never spawns the /usr/bin git, python3, make or clang shims', () => {
    expect(hits(/Command::new\(\s*"\/usr\/bin\/(git|python3|make|clang|xcrun|cc|gcc)"/)).toEqual([]);
  });
});

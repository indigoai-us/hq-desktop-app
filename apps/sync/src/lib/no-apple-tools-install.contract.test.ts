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
// and names the command in advice text. It never spawns it. Its unit tests
// (hq_cli_update_tests.rs) feed that classifier sample logs.
const XCODE_SELECT_ALLOWED_FILES = new Set([
  'crates/hq-desktop-core/src/hq_cli_update.rs',
  'crates/hq-desktop-core/src/hq_cli_update_tests.rs',
]);

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

// A git spawn by bare name is looked up on the PATH HQ inherited. Under
// launchd that PATH starts with /usr/bin, where git is Apple's prompt stub on a
// Mac without the developer tools. Every git spawn goes through the resolver in
// paths.rs instead. Windows has no stub, so Windows-only code may use a bare name.
const BARE_GIT_SPAWN = [
  /Command::new\(\s*"git"\s*\)/,
  /spawn\(\s*"git"/,
  /"git"\.into\(\)/,
  /(OsString|OsStr|PathBuf|Path)::(from|new)\(\s*"git"\s*\)/,
  /\[\s*"-l?c"\s*,\s*"(?:[^"]*[;&|(]\s*)?git\s/,
];
const WINDOWS_ONLY = /#\[cfg\((target_os = "windows"|windows)\)\]/;

// Production Rust only: the test module at the end of a file and files under
// tests/ build their own git fixtures with a clean environment.
function bareGitSpawns(source: string): number[] {
  const lines = source.split('\n');
  const testModule = lines.findIndex(
    (line, index) => /^\s*#\[cfg\(test\)\]\s*$/.test(line) && /^\s*(pub\s+)?mod\s+\w+/.test(lines[index + 1] ?? ''),
  );
  const production = testModule === -1 ? lines : lines.slice(0, testModule);
  const found: number[] = [];
  production.forEach((line, index) => {
    if (line.trim().startsWith('//')) return;
    if (!BARE_GIT_SPAWN.some((pattern) => pattern.test(line))) return;
    const before = production.slice(Math.max(0, index - 6), index);
    if (before.some((prior) => WINDOWS_ONLY.test(prior))) return;
    found.push(index + 1);
  });
  return found;
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

  it('spawns git only through the resolver, never by bare name on the inherited PATH', () => {
    const found: string[] = [];
    for (const file of sourceFiles()) {
      if (!file.endsWith('.rs') || file.includes('/tests/')) continue;
      for (const line of bareGitSpawns(readFileSync(join(repoRoot, file), 'utf8'))) found.push(`${file}:${line}`);
    }
    expect(found).toEqual([]);
  });

  it('catches the bare git spawns that let the first sync open the Apple prompt', () => {
    // The mirror's old program lookup (Gate-2 finding) and its shell forms.
    const oldMirror = ['fn git_program() -> std::ffi::OsString {', '    "git".into()', '}'].join('\n');
    expect(bareGitSpawns(oldMirror)).toEqual([2]);
    expect(bareGitSpawns('let out = Command::new("git").args(["status"]).output();')).toEqual([1]);
    expect(bareGitSpawns('Command::new("/bin/sh").args(["-c", "git --version"])')).toEqual([1]);
    expect(bareGitSpawns('cmd.args(["-lc", "cd ~/hq && git pull"])')).toEqual([1]);

    // Windows-only code, resolver output and test modules are allowed.
    expect(bareGitSpawns(['#[cfg(target_os = "windows")]', 'let mut cmd = Command::new("git");'].join('\n'))).toEqual([]);
    expect(bareGitSpawns('let mut cmd = Command::new(program);')).toEqual([]);
    expect(bareGitSpawns(['fn a() {}', '#[cfg(test)]', 'mod tests {', '    Command::new("git");', '}'].join('\n'))).toEqual([]);
  });

  it('never spawns the /usr/bin git, python3, make or clang shims', () => {
    expect(hits(/Command::new\(\s*"\/usr\/bin\/(git|python3|make|clang|xcrun|cc|gcc)"/)).toEqual([]);
  });
});

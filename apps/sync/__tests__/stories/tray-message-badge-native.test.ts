import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const nativeIt = process.platform === 'darwin' ? it : it.skip;

/**
 * Both cases shell out to a compiler (`rustc`, and `xcrun swiftc` on macOS).
 * Vitest's default 5s per-test budget is not appropriate for that: the compile
 * itself is fast (~0.3s measured) but it runs on a shared CI runner alongside
 * ~200 other test files, and process spawn + toolchain resolution under that
 * contention regularly blew past 5s. It timed out on at least two unrelated
 * branches (`fix/desktop-visual-hierarchy-origin` run 30484093669, and
 * `wt/dock-icon-shape`) while passing on main — a coin-flip, not a signal.
 *
 * The assertions are untouched; only the budget is. Still bounded, so a genuine
 * hang fails rather than hanging CI forever.
 */
const COMPILE_TIMEOUT_MS = 120_000;

describe('native HQ menu-bar badge verification', () => {
  it('passes the portable helper-build planning and metadata tests', () => {
    const support = resolve(
      process.cwd(),
      'src-tauri/build_support/tray_helper.rs',
    );
    const outputDirectory = mkdtempSync(
      join(tmpdir(), 'hq-tray-helper-build-tests-'),
    );
    const executable = join(
      outputDirectory,
      process.platform === 'win32'
        ? 'tray-helper-build-tests.exe'
        : 'tray-helper-build-tests',
    );

    try {
      const compile = spawnSync(
        'rustc',
        ['--edition=2021', '--test', support, '-o', executable],
        { encoding: 'utf8' },
      );
      expect(compile.status, compile.stderr || compile.stdout).toBe(0);

      const run = spawnSync(executable, [], { encoding: 'utf8' });
      expect(run.status, run.stderr || run.stdout).toBe(0);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  }, COMPILE_TIMEOUT_MS);

  nativeIt('typechecks the production helper and passes its deterministic AppKit harness', () => {
    const helper = resolve(
      process.cwd(),
      'src-tauri/helper/hq-tray-helper.swift',
    );
    const harness = resolve(
      process.cwd(),
      'src-tauri/helper/tests/main.swift',
    );
    const outputDirectory = mkdtempSync(
      join(tmpdir(), 'hq-tray-badge-native-'),
    );
    const executable = join(outputDirectory, 'tray-badge-harness');

    try {
      const typecheck = spawnSync(
        'xcrun',
        ['swiftc', '-parse-as-library', '-typecheck', helper],
        { encoding: 'utf8' },
      );
      expect(typecheck.status, typecheck.stderr || typecheck.stdout).toBe(0);

      const compile = spawnSync(
        'xcrun',
        [
          'swiftc',
          '-D',
          'HQ_TRAY_BADGE_HARNESS',
          helper,
          harness,
          '-o',
          executable,
        ],
        { encoding: 'utf8' },
      );
      expect(compile.status, compile.stderr || compile.stdout).toBe(0);

      const run = spawnSync(executable, [], { encoding: 'utf8' });
      expect(run.status, run.stderr || run.stdout).toBe(0);
      expect(run.stdout).toContain(
        'tray badge native verification passed (12 scenarios)',
      );
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  }, COMPILE_TIMEOUT_MS);

  nativeIt(
    'builds a universal macOS 13 helper through the production build support',
    () => {
      const support = resolve(
        process.cwd(),
        'src-tauri/build_support/tray_helper.rs',
      );
      const helper = resolve(
        process.cwd(),
        'src-tauri/helper/hq-tray-helper.swift',
      );
      const outputDirectory = mkdtempSync(
        join(tmpdir(), 'hq-tray-helper-universal-'),
      );
      const driverSource = join(outputDirectory, 'driver.rs');
      const driver = join(outputDirectory, 'driver');
      const universalHelper = join(outputDirectory, 'hq-tray-helper');
      const escapedSupport = support
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"');
      writeFileSync(
        driverSource,
        `#[path = "${escapedSupport}"]\nmod tray_helper_build;\nuse std::path::Path;\nfn main() {\n  let args: Vec<String> = std::env::args().collect();\n  tray_helper_build::build_universal_helper(Path::new(&args[1]), Path::new(&args[2]), Path::new(&args[3])).unwrap();\n}\n`,
      );

      try {
        const compileDriver = spawnSync(
          'rustc',
          ['--edition=2021', driverSource, '-o', driver],
          { encoding: 'utf8' },
        );
        expect(
          compileDriver.status,
          compileDriver.stderr || compileDriver.stdout,
        ).toBe(0);

        const build = spawnSync(
          driver,
          [helper, outputDirectory, universalHelper],
          { encoding: 'utf8' },
        );
        expect(build.status, build.stderr || build.stdout).toBe(0);

        const architectures = spawnSync(
          'xcrun',
          ['lipo', '-archs', universalHelper],
          { encoding: 'utf8' },
        );
        expect(
          architectures.status,
          architectures.stderr || architectures.stdout,
        ).toBe(0);
        expect(architectures.stdout.trim().split(/\s+/).sort()).toEqual([
          'arm64',
          'x86_64',
        ]);

        const metadata = spawnSync(
          'xcrun',
          ['vtool', '-show-build', universalHelper],
          { encoding: 'utf8' },
        );
        expect(metadata.status, metadata.stderr || metadata.stdout).toBe(0);
        expect(metadata.stdout.match(/\bminos\s+13\.0\b/g)).toHaveLength(2);
      } finally {
        rmSync(outputDirectory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

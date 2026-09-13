import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BENCH_BUNDLE_IDENTIFIER,
  BENCH_PRODUCT_NAME,
  DEFAULT_BENCH_APP,
  assertScreenRecordingGranted,
  ensureBenchBundle,
} from '../../scripts/idea-board-bench.mjs';

const SHIPPING_IDENTIFIER = 'ai.indigo.hq-sync-menubar';
const BUILD_SCRIPT = resolve(__dirname, '../../scripts/build-bench-bundle.sh');

/**
 * Regression guard: --drive must target the PINNED benchmark bundle, never the
 * raw debug binary. macOS keys the Screen Recording grant on the bundle
 * identifier + signature; the raw binary has no bundle identity, so the grant
 * cannot match and every benchmark run silently records zero samples.
 */
describe('idea-board bench: pinned benchmark bundle', () => {
  it('uses an identifier distinct from the shipping app', () => {
    expect(BENCH_BUNDLE_IDENTIFIER).toBe('ai.indigo.hq-idea-board-bench');
    expect(BENCH_BUNDLE_IDENTIFIER).not.toBe(SHIPPING_IDENTIFIER);
  });

  it('points --drive at a .app bundle, not target/debug/hq-sync-menubar', () => {
    expect(DEFAULT_BENCH_APP.endsWith(`${BENCH_PRODUCT_NAME}.app`)).toBe(true);
    expect(DEFAULT_BENCH_APP).not.toMatch(/hq-sync-menubar$/);
  });

  it('fails loudly when the bundle is missing rather than benching nothing', async () => {
    await expect(ensureBenchBundle('/nonexistent/Nope.app')).rejects.toThrow(
      /bundle:bench/,
    );
  });

  it('fails loudly when Screen Recording is denied', () => {
    expect(() => assertScreenRecordingGranted(false, DEFAULT_BENCH_APP)).toThrow(
      /Screen Recording permission is DENIED/,
    );
    expect(() => assertScreenRecordingGranted(true, DEFAULT_BENCH_APP)).not.toThrow();
  });

  it('builds that identifier from the committed build script', () => {
    expect(existsSync(BUILD_SCRIPT)).toBe(true);
    const src = readFileSync(BUILD_SCRIPT, 'utf8');
    expect(src).toContain(BENCH_BUNDLE_IDENTIFIER);
    expect(src).toContain(BENCH_PRODUCT_NAME);
  });
});

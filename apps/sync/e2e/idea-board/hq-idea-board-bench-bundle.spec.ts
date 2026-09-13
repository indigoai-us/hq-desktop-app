import { execFileSync } from 'node:child_process';
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
/** Mandated by company policy indigo-hq-desktop-app-signing-release-identity. */
const SIGNING_IDENTITY = 'Developer ID Application: Stefan Johnson (FSZQ97X3V6)';
const TEAM_ID = 'FSZQ97X3V6';

/**
 * `codesign -d…` prints its metadata on STDERR, not stdout — reading stdout
 * alone silently yields '' and every assertion below would vacuously "pass".
 */
function codesignOutput(args: string[]): string {
  const shellArgs = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  return execFileSync('/bin/sh', ['-c', `codesign ${shellArgs} 2>&1`], {
    encoding: 'utf8',
  });
}

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

  /**
   * The identifier guard above passed happily while the bundle was AD-HOC
   * signed — and ad-hoc signing is precisely what voided the owner's Screen
   * Recording grant, twice. TCC has no certificate to key an ad-hoc signature
   * on, so it falls back to the cdhash, which changes on every build. Only a
   * real certificate gives a designated requirement that survives rebuilds.
   */
  it('signs with the stable Developer ID identity, never ad-hoc', () => {
    const src = readFileSync(BUILD_SCRIPT, 'utf8');
    expect(src).toContain(SIGNING_IDENTITY);
    // No ad-hoc identity passed to tauri's signingIdentity or sign-bundle.sh.
    expect(src).not.toMatch(/"signingIdentity"\s*:\s*\\?"-\\?"/);
    expect(src).not.toMatch(/sign-bundle\.sh"?\s+"\$APP_PATH"\s+"-"/);
  });

  it('produces a bundle that is NOT ad-hoc signed', () => {
    if (!existsSync(DEFAULT_BENCH_APP)) {
      // Nothing built yet on this machine — the build-script guard above still
      // covers the regression; `npm run bundle:bench` produces the bundle.
      return;
    }
    const out = codesignOutput(['-dvvv', DEFAULT_BENCH_APP]);
    expect(out).not.toContain('Signature=adhoc');
    expect(out).toContain(`TeamIdentifier=${TEAM_ID}`);
    expect(out).toContain(SIGNING_IDENTITY);
    expect(out).toContain(`Identifier=${BENCH_BUNDLE_IDENTIFIER}`);
  });

  /**
   * The designated requirement — not the cdhash — is what TCC matches for
   * certificate-signed code, and it is the thing that must be identical across
   * rebuilds for the grant to survive one.
   */
  it('has a designated requirement pinned to identifier + team, not a cdhash', () => {
    if (!existsSync(DEFAULT_BENCH_APP)) return;
    const dr = codesignOutput(['-d', '-r-', DEFAULT_BENCH_APP]);
    expect(dr).toContain(`identifier "${BENCH_BUNDLE_IDENTIFIER}"`);
    expect(dr).toContain('anchor apple generic');
    expect(dr).toContain(`certificate leaf[subject.OU] = ${TEAM_ID}`);
    expect(dr).not.toMatch(/cdhash/i);
  });
});

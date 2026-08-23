import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-contract regression guard for the Recall SDK sidecar bundle.
 *
 * `bundle.resources` in src-tauri/tauri.conf.json hand-lists which sidecar files
 * get copied into the .app. When `recording-tracker.mjs` was split out of
 * `bridge.mjs` it was NOT added to that list, so the shipped bundle imported a
 * file that wasn't there → the recall sidecar died on every launch with
 * `ERR_MODULE_NOT_FOUND` (meeting recording silently broken in 0.6.4/0.6.5).
 *
 * This test fails the build if `bridge.mjs` imports a relative `.mjs` (non-test)
 * that isn't bundled — so a future refactor that adds another sidecar module
 * can't ship the same broken bundle.
 */

const repoUrl = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const conf = JSON.parse(readFileSync(repoUrl('src-tauri/tauri.conf.json'), 'utf8'));
const bridgeSrc = readFileSync(repoUrl('sidecar/recall-sdk-bridge/bridge.mjs'), 'utf8');

/** Source paths the bundler copies into the .app (the keys of bundle.resources). */
const resourceSources: string[] = Object.keys(conf.bundle?.resources ?? {});

/** Relative `./foo.mjs` specifiers imported by bridge.mjs (the bundle entrypoint). */
function relativeMjsImports(source: string): string[] {
  const out = new Set<string>();
  // Matches both `import … from './x.mjs'` and `import('./x.mjs')`, single/double quotes.
  const re = /(?:from|import)\s*\(?\s*['"](\.\/[^'"]+\.mjs)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1].replace(/^\.\//, '');
    if (!spec.includes('.test.')) out.add(spec);
  }
  return [...out];
}

describe('recall-sdk-bridge bundle resources', () => {
  it('bundles every relative .mjs that bridge.mjs imports', () => {
    const imports = relativeMjsImports(bridgeSrc);
    // Sanity: the refactor that motivated this guard means there is at least one.
    expect(imports.length).toBeGreaterThan(0);

    for (const spec of imports) {
      const bundled = resourceSources.some((src) =>
        src.endsWith(`sidecar/recall-sdk-bridge/${spec}`),
      );
      expect(
        bundled,
        `bridge.mjs imports "./${spec}" but it is not in tauri.conf.json bundle.resources — ` +
          `the shipped .app will crash with ERR_MODULE_NOT_FOUND. Add ` +
          `"../sidecar/recall-sdk-bridge/${spec}": "recall-sdk-bridge/${spec}".`,
      ).toBe(true);
    }
  });

  it('explicitly bundles recording-tracker.mjs (the regression)', () => {
    const bundled = resourceSources.some((src) =>
      src.endsWith('sidecar/recall-sdk-bridge/recording-tracker.mjs'),
    );
    expect(bundled).toBe(true);
  });
});

/**
 * Signature-survives-auto-update guard.
 *
 * Tauri's `bundle.externalBin` places its entries in `HQ.app/Contents/MacOS/`,
 * which makes them NESTED CODE OBJECTS. `codesign` can only embed a signature
 * inside a Mach-O; for anything else (a bash script, a `.mjs`, a `.py`) it
 * stores the signature in extended attributes instead — `com.apple.cs.
 * CodeDirectory`, `com.apple.cs.CodeSignature`, `com.apple.cs.CodeRequirements`,
 * …
 *
 * The Tauri auto-updater downloads `HQ_x.y.z_universal.app.tar.gz` and extracts
 * it with a tar implementation that does NOT preserve extended attributes. So a
 * script sidecar signs, notarizes, and verifies perfectly on the *published*
 * artifact, then arrives byte-identical but signature-less on every
 * auto-updated machine. There, `codesign --verify --deep --strict` fails with
 * "code object is not signed at all / In subcomponent: …/Contents/MacOS/
 * recall-desktop-sdk" and `spctl` reports "rejected, no usable signature".
 * macOS will not persist TCC privacy grants against an invalid bundle, so
 * Accessibility / Screen Recording never stick, `meetings_permissions_state`
 * stays `all_required=false`, and meeting detection can never start.
 *
 * We shipped exactly that from the sidecar restore in #482. The bridge now runs
 * as `node Contents/Resources/recall-sdk-bridge/bridge.mjs` — a plain resource
 * sealed by content hash in `_CodeSignature/CodeResources`, with no xattrs to
 * lose. Windows is unaffected: its launcher is a real compiled PE.
 *
 * This is checkable in CI without signing keys, which is the point.
 */

/** macOS-applicable Tauri config overlays (base + the macOS overlay). */
const MACOS_CONFS = ['src-tauri/tauri.conf.json', 'src-tauri/tauri.macos.conf.json'];

/** `externalBin` stems declared by the macOS-applicable configs. */
function macosExternalBins(): string[] {
  const out: string[] = [];
  for (const rel of MACOS_CONFS) {
    const c = JSON.parse(readFileSync(repoUrl(rel), 'utf8'));
    out.push(...(c.bundle?.externalBin ?? []));
  }
  return out;
}

/** True when `path` starts with one of the four Mach-O / fat-binary magics. */
function isMachO(path: string): boolean {
  const buf = Buffer.alloc(4);
  const fd = openSync(path, 'r');
  try {
    if (readSync(fd, buf, 0, 4, 0) < 4) return false;
  } finally {
    closeSync(fd);
  }
  const be = buf.readUInt32BE(0);
  return (
    be === 0xfeedface || // Mach-O 32
    be === 0xfeedfacf || // Mach-O 64
    be === 0xcefaedfe || // Mach-O 32, byte-swapped
    be === 0xcffaedfe || // Mach-O 64, byte-swapped
    be === 0xcafebabe || // fat / universal
    be === 0xbebafeca // fat, byte-swapped
  );
}

describe('macOS bundle ships no non-Mach-O nested code object', () => {
  it('declares no externalBin for macOS', () => {
    // Every externalBin entry lands in Contents/MacOS. Since the only sidecar
    // we ever needed there was a script, the safe steady state is zero.
    expect(
      macosExternalBins(),
      'A macOS bundle.externalBin entry lands in HQ.app/Contents/MacOS as a nested ' +
        'code object. If it is not a Mach-O its signature is stored in extended ' +
        'attributes, which the auto-updater\'s tar extraction strips — every ' +
        'auto-updated install then has an INVALID bundle signature and macOS stops ' +
        'persisting TCC grants (Accessibility / Screen Recording), so meeting ' +
        'detection can never start. Ship it under Contents/Resources/ and spawn it ' +
        'explicitly from Rust instead (see recall_sdk::resolve_sdk_command).',
    ).toEqual([]);
  });

  it('keeps no macOS sidecar scripts staged in src-tauri/binaries', () => {
    // The three `recall-desktop-sdk-*-apple-darwin` bash wrappers used to live
    // here. Anything darwin-triple-named that is not a Mach-O would be picked
    // up by a re-added externalBin and reintroduce the bug.
    const dir = repoUrl('src-tauri/binaries');
    if (!existsSync(dir)) return;
    const offenders = readdirSync(dir).filter(
      (name) =>
        name.includes('apple-darwin') &&
        statSync(join(dir, name)).isFile() &&
        !isMachO(join(dir, name)),
    );
    expect(
      offenders,
      `src-tauri/binaries contains non-Mach-O darwin sidecar file(s): ${offenders.join(', ')}. ` +
        'These can only carry an xattr-based signature, which the auto-updater strips.',
    ).toEqual([]);
  });

  it('ships bridge.mjs as a bundled resource for the resolver to find', () => {
    // This assertion owns the half of the contract that lives in THIS repo: the app
    // must bundle bridge.mjs as a plain resource, so a shipped .app has it under
    // Contents/Resources/recall-sdk-bridge/bridge.mjs.
    //
    // The other half — that the Rust resolver looks via ../Resources and honours the
    // RECALL_BRIDGE_PATH override — moved to indigoai-us/hq-plugin-meetings with the
    // resolver itself, and is covered there by behavioural tests that plant a bridge
    // on disk and resolve it, rather than by the source-text greps this test used to
    // do: recall_sdk::bridge_resolution_tests::{
    //   resolve_bridge_entry_finds_the_macos_bundle_resources_layout,
    //   resolve_bridge_entry_prefers_the_env_override,
    //   resolve_bridge_entry_ignores_a_blank_or_dangling_override }.
    //
    // Careful: the two halves now live in different repos and neither CI checks the
    // other. Changing this bundled path without changing the resolver's expectation
    // leaves both test suites green and breaks recording at runtime. Treat the
    // literal below as a cross-repo contract.
    expect(
      resourceSources.some((src) => src.endsWith('sidecar/recall-sdk-bridge/bridge.mjs')),
    ).toBe(true);
  });

  it('a built .app has only Mach-O files in Contents/MacOS', () => {
    // Opportunistic: only runs when a bundle happens to be present locally
    // (CI lint/test legs do not build one). The authoritative gate for release
    // builds is the same assertion in scripts/sign-bundle.sh Phase 6.
    const candidates = [
      'src-tauri/target/release/bundle/macos/HQ.app',
      'src-tauri/target/debug/bundle/macos/HQ.app',
      'src-tauri/target/universal-apple-darwin/release/bundle/macos/HQ.app',
    ]
      .map(repoUrl)
      .filter(existsSync);

    for (const app of candidates) {
      const macosDir = join(app, 'Contents', 'MacOS');
      if (!existsSync(macosDir)) continue;
      const offenders = readdirSync(macosDir).filter(
        (name) => statSync(join(macosDir, name)).isFile() && !isMachO(join(macosDir, name)),
      );
      expect(
        offenders,
        `${app}/Contents/MacOS contains non-Mach-O file(s): ${offenders.join(', ')} — ` +
          'their signatures live in extended attributes and will not survive the ' +
          'auto-updater\'s tar extraction.',
      ).toEqual([]);
    }
  });
});

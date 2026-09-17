// Source-contract guard for HQ-DESKTOP-6C (never panic on a broken stdout/stderr
// pipe). The fix works by shadowing the std print macros with hq-desktop-core's
// best-effort variants at the two crate roots. That wiring is invisible to the
// compiler as "correct placement" — a shadow moved below the first `mod` silently
// un-shadows the modules above it — so this test locks it textually:
//
//   1. Both crate roots define a `#[cfg(not(test))]` shadow for each of
//      eprintln/eprint/println/print that delegates to the matching
//      `best_effort_*` macro, positioned before the first `mod`/`pub mod`.
//   2. No path-qualified std print macro (`std::eprintln!`) or `dbg!` reappears
//      under the app or core src (those bypass the shadow).
//   3. hq-platform and hq-telemetry — same-process crates with no shadow — use no
//      print macros at all, so nothing there can panic on a broken pipe.
//
// Style mirrors scripts/native-seam-wiring.test.ts (readFile at beforeAll,
// index/regex checks).

import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LIB_RS = "crates/hq-desktop-core/src/lib.rs";
const MAIN_RS = "apps/sync/src-tauri/src/main.rs";

const MACROS = ["eprintln", "eprint", "println", "print"] as const;

let libSource = "";
let mainSource = "";

beforeAll(async () => {
  [libSource, mainSource] = await Promise.all([
    readFile(resolve(rootDir, LIB_RS), "utf8"),
    readFile(resolve(rootDir, MAIN_RS), "utf8"),
  ]);
});

/** Index of the first `mod`/`pub mod` declaration in a crate root. */
function firstModIndex(source: string): number {
  const m = /^\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?mod\s+\w+\s*;/m.exec(source);
  if (!m) {
    throw new Error("no `mod`/`pub mod` declaration found");
  }
  return m.index;
}

/**
 * Find the `#[cfg(not(test))]` shadow for `name`, assert it delegates to
 * `best_effort_<name>!`, and return the index at which it starts.
 */
function shadowStart(source: string, label: string, name: string): number {
  const re = new RegExp(
    `#\\[cfg\\(not\\(test\\)\\)\\]\\s*` +
      `(?:#\\[allow\\(unused_macros\\)\\]\\s*)?` +
      `macro_rules!\\s+${name}\\s*\\{[\\s\\S]*?best_effort_${name}!`,
  );
  const m = re.exec(source);
  expect(
    m,
    `${label}: a #[cfg(not(test))] shadow for ${name}! delegating to best_effort_${name}! must exist`,
  ).not.toBeNull();
  return (m as RegExpExecArray).index;
}

async function rsFilesUnder(relDir: string): Promise<string[]> {
  const abs = resolve(rootDir, relDir);
  const entries = await readdir(abs, { recursive: true });
  return entries
    .filter((e) => e.endsWith(".rs"))
    .map((e) => resolve(abs, e));
}

async function readAll(paths: string[]): Promise<Array<[string, string]>> {
  return Promise.all(
    paths.map(async (p) => [p, await readFile(p, "utf8")] as [string, string]),
  );
}

describe("HQ-DESKTOP-6C stdio shadows", () => {
  for (const [label, get] of [
    ["lib.rs", () => libSource],
    ["main.rs", () => mainSource],
  ] as const) {
    for (const name of MACROS) {
      it(`${label} shadows ${name}! before its first mod, delegating to best_effort_${name}!`, () => {
        const source = get();
        const start = shadowStart(source, label, name);
        expect(
          start,
          `${label}: the ${name}! shadow must precede the first mod declaration, or the modules above it revert to the panicking std macro`,
        ).toBeLessThan(firstModIndex(source));
      });
    }
  }
});

describe("HQ-DESKTOP-6C no shadow bypass", () => {
  // A path-qualified std print macro reaches the panicking std path even where a
  // shadow is installed; `dbg!` prints to stderr and also panics on a broken pipe.
  const bypass = /\bstd::(?:eprintln|eprint|println|print)!/;
  const dbg = /\bdbg!\s*\(/;

  for (const dir of [
    "apps/sync/src-tauri/src",
    "crates/hq-desktop-core/src",
  ]) {
    it(`${dir} has no path-qualified std print macro or dbg!`, async () => {
      const files = await readAll(await rsFilesUnder(dir));
      const offenders = files
        .filter(([, src]) => bypass.test(src) || dbg.test(src))
        .map(([p]) => p);
      expect(
        offenders,
        `these files bypass the best-effort stdio shadow:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }
});

describe("HQ-DESKTOP-6C sibling crates stay print-macro-free", () => {
  // hq-platform and hq-telemetry link into the same process but have no shadow,
  // so any print macro there could panic a thread on a broken pipe.
  const anyPrint = /\b(?:eprintln|eprint|println|print)!\s*\(/;

  for (const dir of ["crates/hq-platform/src", "crates/hq-telemetry/src"]) {
    it(`${dir} uses no print macros`, async () => {
      const files = await readAll(await rsFilesUnder(dir));
      const offenders = files
        .filter(([, src]) => anyPrint.test(src))
        .map(([p]) => p);
      expect(
        offenders,
        `${dir} has no best-effort shadow; route diagnostics through crate::logfile::log instead:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }
});

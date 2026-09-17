import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// HQ-DESKTOP-6C source contract.
//
// The fix for the "failed printing to stderr: Broken pipe (os error 32)" panic
// is a set of crate-root `macro_rules!` that shadow the std prelude print
// macros so every `eprintln!`/`eprint!`/`println!`/`print!` call site routes
// through `hq_desktop_core::process_stdio`'s best-effort helpers. That shadow
// only reaches modules declared textually AFTER it, and only in non-test
// builds. This guard fails if any of those load-bearing properties regresses —
// a shadow removed, un-gated, no longer delegating, or moved below the first
// `mod`; a path-qualified std print macro or `dbg!` that would bypass the
// shadow; or a print macro reappearing in a sibling crate that has no shadow.

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LIB_RS = "crates/hq-desktop-core/src/lib.rs";
const MAIN_RS = "apps/sync/src-tauri/src/main.rs";
const PROCESS_STDIO_RS = "crates/hq-desktop-core/src/process_stdio.rs";

// Sibling crates that link into the same process but carry no shadow, so a
// print macro there would still be able to panic on a broken pipe.
const UNSHADOWED_CRATE_SRC_DIRS = [
  "crates/hq-platform/src",
  "crates/hq-telemetry/src",
];

// Directories whose shadow only holds if nothing bypasses it with a
// path-qualified std print macro or a stray `dbg!`.
const SHADOWED_SRC_DIRS = [
  "crates/hq-desktop-core/src",
  "apps/sync/src-tauri/src",
];

const SHADOW_START = "// --- HQ-DESKTOP-6C: best-effort stdio shadows";
const SHADOW_END = "// --- end HQ-DESKTOP-6C shadows";
const MACROS = ["eprintln", "eprint", "println", "print"] as const;

let lib = "";
let main = "";
let processStdio = "";

beforeAll(async () => {
  [lib, main, processStdio] = await Promise.all([
    readFile(resolve(rootDir, LIB_RS), "utf8"),
    readFile(resolve(rootDir, MAIN_RS), "utf8"),
    readFile(resolve(rootDir, PROCESS_STDIO_RS), "utf8"),
  ]);
});

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Missing shadow block start marker: ${startMarker}`);
  }
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    throw new Error(`Missing shadow block end marker: ${endMarker}`);
  }
  return source.slice(start, end);
}

/** Index of the first `mod`/`pub mod` declaration (module tree entry). */
function firstModIndex(source: string): number {
  const match = /^[ \t]*(?:pub[ \t]+)?mod[ \t]+[A-Za-z_]\w*[ \t]*[;{]/m.exec(source);
  if (!match || match.index === undefined) {
    throw new Error("no `mod` declaration found");
  }
  return match.index;
}

async function readRustSources(
  relDir: string,
): Promise<{ rel: string; text: string }[]> {
  const absDir = resolve(rootDir, relDir);
  const entries = await readdir(absDir, { recursive: true });
  const rustFiles = entries.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.endsWith(".rs"),
  );
  return Promise.all(
    rustFiles.map(async (rel) => ({
      rel: `${relDir}/${rel}`,
      text: await readFile(resolve(absDir, rel), "utf8"),
    })),
  );
}

// A standalone print macro call: `eprintln!`/`eprint!`/`println!`/`print!` not
// preceded by an identifier char (so `best_effort_println!` is not a match).
const PRINT_MACRO = /(?<![A-Za-z0-9_])e?print(?:ln)?!/;
// The same, but path-qualified through `std::` (or `::std::`) — a shadow bypass.
const STD_QUALIFIED_PRINT = /\bstd::e?print(?:ln)?!/;
const DBG_MACRO = /(?<![A-Za-z0-9_])dbg!/;

describe.each([
  { label: "hq-desktop-core lib.rs", file: () => lib, delegate: (n: string) => `$crate::best_effort_${n}!` },
  { label: "app main.rs", file: () => main, delegate: (n: string) => `::hq_desktop_core::best_effort_${n}!` },
])("$label crate-root shadows", ({ file, delegate }) => {
  it("defines all four shadows above the first `mod`", () => {
    const source = file();
    const blockStart = source.indexOf(SHADOW_START);
    expect(blockStart, "shadow block must be present").toBeGreaterThanOrEqual(0);
    expect(
      blockStart,
      "the shadows must precede the first `mod` (textual macro scope reaches only later modules)",
    ).toBeLessThan(firstModIndex(source));
  });

  it.each(MACROS)("shadows `%s` — gated, delegating, inside the block", (name) => {
    const block = sourceBetween(file(), SHADOW_START, SHADOW_END);
    // Each shadow is `#[cfg(not(test))]` (optionally `#[allow(unused_macros)]`)
    // immediately above `macro_rules! <name> {`.
    const gated = new RegExp(
      `#\\[cfg\\(not\\(test\\)\\)\\]\\s*(?:#\\[allow\\(unused_macros\\)\\]\\s*)?macro_rules!\\s+${name}\\s*\\{`,
    );
    expect(block, `\`${name}\` shadow must be cfg(not(test)) and inside the block`).toMatch(gated);
    expect(block, `\`${name}\` shadow must delegate to best_effort_${name}!`).toContain(
      delegate(name),
    );
  });
});

describe("best-effort helpers and module registration", () => {
  it("registers `pub mod process_stdio;` in the crate root", () => {
    expect(lib).toContain("pub mod process_stdio;");
  });

  it.each(MACROS)("exports `best_effort_%s!` with #[macro_export]", (name) => {
    const exported = new RegExp(
      `#\\[macro_export\\]\\s*macro_rules!\\s+best_effort_${name}\\s*\\{`,
    );
    expect(processStdio).toMatch(exported);
  });
});

describe("no shadow bypass in the shadowed source dirs", () => {
  it("no path-qualified std print macro", async () => {
    for (const dir of SHADOWED_SRC_DIRS) {
      for (const { rel, text } of await readRustSources(dir)) {
        expect(
          STD_QUALIFIED_PRINT.test(text),
          `${rel} uses a path-qualified std print macro, bypassing the shadow`,
        ).toBe(false);
      }
    }
  });

  it("no `dbg!`", async () => {
    for (const dir of SHADOWED_SRC_DIRS) {
      for (const { rel, text } of await readRustSources(dir)) {
        expect(DBG_MACRO.test(text), `${rel} contains a stray dbg!`).toBe(false);
      }
    }
  });
});

describe("sibling crates in the same process have no unshadowed print macros", () => {
  it("hq-platform and hq-telemetry never call a print macro", async () => {
    for (const dir of UNSHADOWED_CRATE_SRC_DIRS) {
      for (const { rel, text } of await readRustSources(dir)) {
        expect(
          PRINT_MACRO.test(text),
          `${rel} calls a print macro but its crate has no best-effort shadow — it could panic on a broken pipe`,
        ).toBe(false);
      }
    }
  });
});

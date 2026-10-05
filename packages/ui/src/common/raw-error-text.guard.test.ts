// AUDIT-3c: no console-rail surface shows an error object's own text. A thrown
// invoke/transport error reads like `[invoke] x HTTP 500 ...`; it belongs in the
// log, and the screen gets plain copy with a next step. This guard fails when a
// component writes an error's `.message` or `String(err)` into markup, into a
// template string, or into an `err instanceof Error ? err.message : ...` value.
// Lines that only log (console.*) are ignored. A line whose raw text never
// reaches the screen (it feeds a classifier or telemetry) carries a
// `raw-error-ok: <reason>` comment on that line or the line above.
//
// Not scanned: components no production entry imports (see UNMOUNTED). If one of
// them is mounted again, remove it from the list and fix what this guard finds.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");

const UNMOUNTED = new Set([
  "company/SecretsPanel.svelte",
  "company/DeploymentsPanel.svelte",
  "company/CompanyLibraryPanel.svelte",
  "company/CompanyOperationsPanel.svelte",
  "company/CompanyBoardPanel.svelte",
  "library/PersonalLibraryPage.svelte",
  "projects/CompanyGoalsPage.svelte",
  "settings/CompaniesSettingsPane.svelte",
]);

const ERR = String.raw`(?<![\w.$])(?:e|err|error|cause|reason)`;
const PATTERNS: Array<[string, RegExp]> = [
  ["error .message in a template string", new RegExp(String.raw`\$\{[^}]*${ERR}\??\.message\b`)],
  ["String(err) in a template string", new RegExp(String.raw`\$\{\s*String\(${ERR}\)`)],
  ["err instanceof Error ? err.message", new RegExp(String.raw`${ERR}\s+instanceof\s+Error\s*\?\s*${ERR}\.message\b`)],
  ["error .message in markup", new RegExp(String.raw`\{[^{}]*${ERR}\??\.message\b[^{}]*\}`)],
];

function svelteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...svelteFiles(path));
    else if (name.endsWith(".svelte")) out.push(path);
  }
  return out;
}

function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function markupOf(source: string): string {
  return source.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, (m) => m.replace(/[^\n]/g, " "));
}

export function findRawErrorText(source: string): string[] {
  const hits: string[] = [];
  const seen = new Set<number>();
  const raw = source.split("\n");
  const exempt = (i: number) => /raw-error-ok:/.test(raw[i] ?? "") || /raw-error-ok:/.test(raw[i - 1] ?? "");
  const clean = stripComments(source);
  const markup = markupOf(clean);
  let inConsoleCall = false;
  clean.split("\n").forEach((line, i) => {
    if (/console\.(warn|error|info|log|debug)\(/.test(line)) inConsoleCall = true;
    if (inConsoleCall) {
      if (/\);\s*$/.test(line)) inConsoleCall = false;
      return;
    }
    if (exempt(i)) return;
    for (const [label, re] of PATTERNS.slice(0, 3)) {
      if (!seen.has(i) && re.test(line)) {
        seen.add(i);
        hits.push(`${i + 1}: ${label}: ${line.trim()}`);
      }
    }
  });
  markup.split("\n").forEach((line, i) => {
    if (/console\.(warn|error|info|log|debug)\(/.test(line)) return;
    if (!seen.has(i) && !exempt(i) && PATTERNS[3][1].test(line)) hits.push(`${i + 1}: ${PATTERNS[3][0]}: ${line.trim()}`);
  });
  return hits;
}

describe("raw error text guard", () => {
  it("catches each shape it is meant to catch", () => {
    expect(findRawErrorText("x = `Couldn't open: ${String(err)}`;")).toHaveLength(1);
    expect(findRawErrorText("x = `Couldn't send — ${error.message}`;")).toHaveLength(1);
    expect(findRawErrorText("x = err instanceof Error ? err.message : 'Nope';")).toHaveLength(1);
    expect(findRawErrorText("<script>let a;</script>\n<p>{error?.message}</p>")).toHaveLength(1);
    expect(findRawErrorText('console.warn("[x] failed", `${err.message}`);')).toHaveLength(0);
    expect(findRawErrorText('console.error(\n  "[x] failed",\n  err instanceof Error ? err.message : String(err),\n);')).toHaveLength(0);
    expect(findRawErrorText("<p>{req.message}</p>")).toHaveLength(0);
    expect(findRawErrorText("<p>{view.error.message}</p>")).toHaveLength(0);
    expect(findRawErrorText("// raw-error-ok: classifier input\nconst r = err instanceof Error ? err.message : '';")).toHaveLength(0);
  });

  it("no mounted component writes an error's own text to the screen", () => {
    const offenders: string[] = [];
    for (const file of svelteFiles(src)) {
      const rel = relative(src, file);
      if (UNMOUNTED.has(rel)) continue;
      for (const hit of findRawErrorText(readFileSync(file, "utf8"))) offenders.push(`${rel}:${hit}`);
    }
    expect(offenders).toEqual([]);
  });
});

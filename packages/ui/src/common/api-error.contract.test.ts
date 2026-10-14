import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * QA-080 contract: raw transport text from the HQ API client must never be
 * written into UI code as product copy. Errors go through friendlyApiError
 * (common/api-error.ts), which logs the raw text and returns plain language.
 */
const REPO = join(__dirname, "..", "..", "..", "..");
const ROOTS = ["packages/ui/src", "apps/sync/src"];
const RAW_TRANSPORT = /error sending request|Network error:/i;
// An error/failure string that interpolates a URL, path, or endpoint.
const RAW_URL_IN_ERROR =
  /(error|failed|could not|couldn't)[^`\n]*\$\{[^}]*\b(url|path|endpoint)\b[^}]*\}/i;
// Intentional: the download step tells the person which page to open.
const ALLOWED = new Set(["packages/ui/src/chat/SetupConnectStep.svelte"]);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$|\.spec\.ts$/.test(name)) out.push(full);
  }
  return out;
}

describe("API error copy contract (QA-080)", () => {
  it("UI code never renders raw transport text or URLs in errors", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sources(join(REPO, root))) {
        const rel = relative(REPO, file);
        if (ALLOWED.has(rel)) continue;
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (RAW_TRANSPORT.test(line) || RAW_URL_IN_ERROR.test(line)) {
              offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
            }
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Every source in the deployed CSP must be a source the browser can actually
 * parse.
 *
 * CSP source-list parsing is per-source and silent: an unparseable entry is
 * discarded with a console error and the REST of the directive still applies.
 * So an invalid source never blocks a request — it just logs an error on every
 * single page load, and (worse) reads in review like a grant that is in force
 * when it is not.
 *
 * The rule that is easy to get wrong, and that shipped wrong here, is the
 * host-source wildcard: per the CSP3 grammar a `*` may only stand for the
 * WHOLE host or for the LEFTMOST label (`*.example.com`). `s3.*.amazonaws.com`
 * is not a wildcard-in-the-middle — it is simply not a host-source at all.
 *
 * This asserts the REAL production value from `$lib/server/csp`, not a
 * fixture, so a bad source cannot reach a deploy again.
 */

import { describe, expect, it } from "vitest";

import { buildCsp } from "./lib/server/csp";

/** Sources that are keywords rather than hosts, and so skip host parsing. */
const KEYWORD_SOURCE = /^'[^']+'$/;
/** A bare scheme source, e.g. `https:`, `data:`, `blob:`. */
const SCHEME_SOURCE = /^[a-z][a-z0-9+\-.]*:$/i;

/**
 * CSP3 host-source host-part: `*`, or an optional leading `*.` followed by
 * dot-separated labels. A `*` anywhere else is a parse failure.
 */
const HOST_PART = /^(\*|(\*\.)?[a-z0-9\-_]+(\.[a-z0-9\-_]+)*)$/i;

function parseDirectives(csp: string): Array<[string, string[]]> {
  return csp
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...sources] = part.split(/\s+/);
      return [name, sources] as [string, string[]];
    });
}

/** Returns null when valid, else why the browser would reject the source. */
function hostSourceProblem(source: string): string | null {
  if (KEYWORD_SOURCE.test(source)) return null;
  if (SCHEME_SOURCE.test(source)) return null;

  // Strip an optional scheme, then port and path — only the host is at issue.
  const withoutScheme = source.replace(/^[a-z][a-z0-9+\-.]*:\/\//i, "");
  const host = withoutScheme.split("/")[0].split(":")[0];

  if (!host) return "has no host";
  if (!HOST_PART.test(host)) {
    if (host.includes("*")) {
      return `wildcard is not leftmost — '*' may only replace the whole host or the first label, so '${host}' is discarded by the browser`;
    }
    return `'${host}' is not a valid CSP host`;
  }
  return null;
}

describe("CSP — every source is parseable", () => {
  const csps = [
    ["default (no API origin)", buildCsp()],
    ["with configured API origin", buildCsp("https://hqapi.example.test/v1")],
  ] as const;

  for (const [label, csp] of csps) {
    it(`${label}: no directive contains an unparseable source`, () => {
      const problems: string[] = [];
      for (const [name, sources] of parseDirectives(csp)) {
        for (const source of sources) {
          const problem = hostSourceProblem(source);
          if (problem) problems.push(`${name}: "${source}" ${problem}`);
        }
      }
      expect(
        problems,
        "an invalid CSP source is silently dropped and logs a console error on every page load",
      ).toEqual([]);
    });
  }

  it("the validator itself rejects a mid-host wildcard", () => {
    // Guards against the assertion above passing vacuously.
    expect(hostSourceProblem("https://s3.*.amazonaws.com")).toMatch(
      /wildcard is not leftmost/,
    );
    expect(hostSourceProblem("https://*.amazonaws.com")).toBeNull();
    expect(hostSourceProblem("'self'")).toBeNull();
    expect(hostSourceProblem("https:")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import {
  MINTED_AT_VARIABLE,
  REMINT_DUE_DAYS,
  TOKEN_LIFETIME_DAYS,
  classifyTokenAge,
  runAgeCheck,
} from "./smoke-token-age.mjs";
import { SMOKE_TOKEN_SECRET, smokeError } from "./macos-artifact-smoke.mjs";

const MINTED = "2026-10-03T02:50:34Z";
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(Date.parse(MINTED) + days * DAY_MS);

describe("classifyTokenAge", () => {
  it("uses a 30-day lifetime and a day-25 re-mint point", () => {
    expect(TOKEN_LIFETIME_DAYS).toBe(30);
    expect(REMINT_DUE_DAYS).toBe(25);
  });

  it("passes a fresh token", () => {
    expect(classifyTokenAge(MINTED, at(1)).status).toBe("ok");
    expect(classifyTokenAge(MINTED, at(24.99)).status).toBe("ok");
  });

  it("fails from day 25, before the token expires", () => {
    const due = classifyTokenAge(MINTED, at(25));
    expect(due.status).toBe("due");
    expect(due.message).toContain("docs/RELEASE.md");
    expect(classifyTokenAge(MINTED, at(29.99)).status).toBe("due");
  });

  it("reports an expired token from day 30", () => {
    expect(classifyTokenAge(MINTED, at(30)).status).toBe("expired");
    // The 2026-10-03 incident: minted 2026-09-03T01:12Z, smoke failed at 01:46Z.
    expect(
      classifyTokenAge("2026-09-03T01:12:23Z", new Date("2026-10-03T01:46:00Z")).status,
    ).toBe("expired");
  });

  it("fails closed when the mint time is missing or unreadable", () => {
    expect(classifyTokenAge(undefined, at(1)).status).toBe("missing");
    expect(classifyTokenAge("  ", at(1)).status).toBe("missing");
    expect(classifyTokenAge("yesterday", at(1)).status).toBe("invalid");
    expect(classifyTokenAge("2026-10-03", at(1)).status).toBe("invalid");
    expect(classifyTokenAge("2026-10-03T02:50:34+02:00", at(1)).status).toBe("invalid");
    expect(classifyTokenAge(MINTED, at(-1)).status).toBe("invalid");
  });
});

describe("runAgeCheck", () => {
  const env = { [MINTED_AT_VARIABLE]: MINTED, [SMOKE_TOKEN_SECRET]: "token-value" };

  it("passes a fresh token that Cognito accepts", async () => {
    let calls = 0;
    const result = await runAgeCheck({
      env,
      now: at(2),
      verifyImpl: async () => {
        calls += 1;
        return { checked: true };
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("fails a fresh token that Cognito rejects", async () => {
    const result = await runAgeCheck({
      env,
      now: at(2),
      verifyImpl: async () => {
        throw smokeError("rejected by Cognito (NotAuthorizedException)");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("NotAuthorizedException");
  });

  it("fails at day 25 without calling Cognito", async () => {
    let calls = 0;
    const result = await runAgeCheck({
      env,
      now: at(25),
      verifyImpl: async () => {
        calls += 1;
        return { checked: true };
      },
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it("fails when the token secret is missing", async () => {
    const result = await runAgeCheck({
      env: { [MINTED_AT_VARIABLE]: MINTED },
      now: at(2),
      verifyImpl: async () => ({ checked: true }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(SMOKE_TOKEN_SECRET);
  });

  it("never puts the token value in its messages", async () => {
    const results = await Promise.all([
      runAgeCheck({ env, now: at(2), verifyImpl: async () => ({ checked: true }) }),
      runAgeCheck({ env, now: at(26), verifyImpl: async () => ({ checked: true }) }),
    ]);
    for (const result of results) expect(result.message).not.toContain("token-value");
  });
});

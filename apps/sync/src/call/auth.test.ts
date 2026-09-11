/**
 * US-017 — identity resolution and account-generation binding.
 *
 * The two refusals pinned hardest here are the ones that would otherwise let
 * a call outlive its authority: a display-only Cognito subject standing in for
 * a canonical person, and a grant that lands after the account changed.
 */

import { describe, expect, it, vi } from "vitest";

import {
  AUTH_SESSION_EVENT,
  callIdentityMessage,
  createAccountBinding,
  isCanonicalPersonUid,
  parseAuthSessionEnvelope,
  resolveCallIdentity,
  type AuthSessionEnvelope,
} from "./auth";

const EXPECTED = { personUid: "prs_1", companyUid: "cmp-1" };

function identity(value: unknown, ok = true) {
  return {
    whoami: vi.fn(async () =>
      ok
        ? ({ ok: true as const, value } as never)
        : ({ ok: false as const, reason: "error" as const } as never),
    ),
  };
}

function envelope(
  overrides: Partial<AuthSessionEnvelope> = {},
): AuthSessionEnvelope {
  return {
    accountId: "acct-1",
    generation: 1,
    status: "active",
    reason: null,
    ...overrides,
  };
}

describe("canonical person uids", () => {
  it("accepts prs_ ids and refuses Cognito subjects", () => {
    expect(isCanonicalPersonUid("prs_01HQ")).toBe(true);
    expect(isCanonicalPersonUid("prs_a-b_c")).toBe(true);
    // The adapter's degrade path hands back the Cognito subject verbatim.
    expect(isCanonicalPersonUid("6f0a1e2c-1111-4222-8333-444455556666")).toBe(
      false,
    );
    expect(isCanonicalPersonUid("prs_")).toBe(false);
    expect(isCanonicalPersonUid("prs-1")).toBe(false);
    expect(isCanonicalPersonUid(undefined)).toBe(false);
  });
});

describe("resolveCallIdentity", () => {
  it("resolves when the canonical uid matches the grant's self", async () => {
    const result = await resolveCallIdentity({
      identity: identity({ personUid: "prs_1", email: "a@b.c" }),
      expected: EXPECTED,
      generation: 3,
    });
    expect(result).toEqual({ ok: true, personUid: "prs_1", generation: 3 });
  });

  it("refuses a display-only Cognito subject as recoverable", async () => {
    const result = await resolveCallIdentity({
      identity: identity({
        personUid: "6f0a1e2c-1111-4222-8333-444455556666",
        email: "a@b.c",
      }),
      expected: EXPECTED,
      generation: 1,
    });
    expect(result).toEqual({
      ok: false,
      code: "IDENTITY_UNRESOLVED",
      recoverable: true,
    });
    expect(callIdentityMessage("IDENTITY_UNRESOLVED")).toContain(
      "Confirm your account",
    );
  });

  it("refuses a whoami failure and a thrown whoami as recoverable", async () => {
    await expect(
      resolveCallIdentity({
        identity: identity(null, false),
        expected: EXPECTED,
        generation: 1,
      }),
    ).resolves.toMatchObject({ code: "IDENTITY_UNRESOLVED", recoverable: true });

    await expect(
      resolveCallIdentity({
        identity: {
          whoami: vi.fn(async () => {
            throw new Error("offline");
          }) as never,
        },
        expected: EXPECTED,
        generation: 1,
      }),
    ).resolves.toMatchObject({ code: "IDENTITY_UNRESOLVED", recoverable: true });
  });

  it("refuses a canonical identity that is not the grant's self", async () => {
    await expect(
      resolveCallIdentity({
        identity: identity({ personUid: "prs_2" }),
        expected: EXPECTED,
        generation: 1,
      }),
    ).resolves.toEqual({
      ok: false,
      code: "IDENTITY_MISMATCH",
      recoverable: false,
    });
  });

  it("refuses a grant whose own self uid is not canonical", async () => {
    await expect(
      resolveCallIdentity({
        identity: identity({ personUid: "prs_1" }),
        expected: { personUid: "prs-1", companyUid: "cmp-1" },
        generation: 1,
      }),
    ).resolves.toEqual({
      ok: false,
      code: "IDENTITY_UNRESOLVED",
      recoverable: false,
    });
  });

  it("discards a whoami that lands after the account changed", async () => {
    const binding = createAccountBinding({
      generation: 1,
      accountId: "acct-1",
      personUid: "prs_1",
      companyUid: "cmp-1",
    });
    const result = resolveCallIdentity({
      identity: {
        whoami: vi.fn(async () => {
          binding.accept(envelope({ generation: 2, accountId: "acct-2" }));
          return { ok: true as const, value: { personUid: "prs_1" } } as never;
        }),
      },
      expected: EXPECTED,
      generation: 1,
      binding,
    });
    await expect(result).resolves.toEqual({
      ok: false,
      code: "ACCOUNT_CHANGED",
      recoverable: false,
    });
  });

  it("does not even ask when the binding is already stale", async () => {
    const binding = createAccountBinding({
      generation: 1,
      personUid: "prs_1",
      companyUid: "cmp-1",
    });
    binding.accept(envelope({ generation: 2, status: "credentials_absent" }));
    const whoami = vi.fn();
    await expect(
      resolveCallIdentity({
        identity: { whoami: whoami as never },
        expected: EXPECTED,
        generation: 1,
        binding,
      }),
    ).resolves.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(whoami).not.toHaveBeenCalled();
  });
});

describe("account binding", () => {
  it("stays current for a redelivered identical active envelope", () => {
    const binding = createAccountBinding({
      generation: 4,
      accountId: "acct-1",
      personUid: "prs_1",
      companyUid: "cmp-1",
    });
    expect(binding.accept(envelope({ generation: 4 }))).toBe(false);
    // An older envelope is a reordered delivery, not an account change.
    expect(binding.accept(envelope({ generation: 2 }))).toBe(false);
    expect(binding.isCurrent(4)).toBe(true);
    expect(binding.invalidated).toBe(false);
  });

  it("invalidates on a generation bump, sign-out and account switch", () => {
    for (const next of [
      envelope({ generation: 5 }),
      envelope({ generation: 4, status: "credentials_absent" }),
      envelope({ generation: 4, accountId: "acct-2" }),
      envelope({ generation: 4, status: "credentials_invalid" }),
    ]) {
      const binding = createAccountBinding({
        generation: 4,
        accountId: "acct-1",
        personUid: "prs_1",
        companyUid: "cmp-1",
      });
      const seen: unknown[] = [];
      binding.onInvalidate((change) => seen.push(change));
      expect(binding.accept(next)).toBe(true);
      expect(binding.invalidated).toBe(true);
      expect(binding.isCurrent(4)).toBe(false);
      expect(seen).toHaveLength(1);
    }
  });

  it("pauses authority — never invalidates — on a temporarily unavailable refresh", () => {
    // A refresh the host could not complete is a connectivity fact, not an
    // account fact. Ending the call there would drop a working conversation
    // because a laptop changed networks; instead nothing NEW is authorized and
    // established media runs to its own grant's traffic stop.
    const binding = createAccountBinding({
      generation: 4,
      accountId: "acct-1",
      personUid: "prs_1",
      companyUid: "cmp-1",
    });
    const seen: boolean[] = [];
    binding.onAuthorityChange((paused) => seen.push(paused));
    binding.onInvalidate(() => {
      throw new Error("a temporary refresh failure must not invalidate");
    });

    expect(
      binding.accept(
        envelope({ generation: 4, status: "refresh_temporarily_unavailable" }),
      ),
    ).toBe(false);
    expect(binding.invalidated).toBe(false);
    expect(binding.isCurrent(4)).toBe(true);
    expect(binding.authorityPaused).toBe(true);
    expect(seen).toEqual([true]);

    // A later `active` for the same account lifts the pause.
    expect(binding.accept(envelope({ generation: 4 }))).toBe(false);
    expect(binding.authorityPaused).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("still invalidates immediately on absent credentials and account switch", () => {
    for (const next of [
      envelope({ generation: 4, status: "credentials_absent" }),
      envelope({ generation: 4, accountId: "acct-2" }),
      envelope({ generation: 5 }),
    ]) {
      const binding = createAccountBinding({
        generation: 4,
        accountId: "acct-1",
        personUid: "prs_1",
        companyUid: "cmp-1",
      });
      // Even from a paused state, a real account change is still terminal.
      binding.accept(
        envelope({ generation: 4, status: "refresh_temporarily_unavailable" }),
      );
      expect(binding.authorityPaused).toBe(true);
      expect(binding.accept(next)).toBe(true);
      expect(binding.invalidated).toBe(true);
      expect(binding.authorityPaused).toBe(false);
    }
  });

  it("invalidates exactly once and latches", () => {
    const binding = createAccountBinding({
      generation: 1,
      personUid: "prs_1",
      companyUid: "cmp-1",
    });
    const seen: unknown[] = [];
    binding.onInvalidate((change) => seen.push(change));
    binding.accept(envelope({ generation: 2 }));
    binding.accept(envelope({ generation: 3 }));
    expect(seen).toHaveLength(1);
    expect(binding.accept(envelope({ generation: 1 }))).toBe(true);
  });

  it("holds its own company uid, independent of any main-window event", () => {
    const binding = createAccountBinding({
      generation: 1,
      personUid: "prs_1",
      companyUid: "cmp-1",
    });
    expect(binding.companyUid).toBe("cmp-1");
    binding.accept(envelope({ generation: 1 }));
    expect(binding.companyUid).toBe("cmp-1");
  });
});

describe("auth session envelope parsing", () => {
  it("pins the event name Rust publishes", () => {
    expect(AUTH_SESSION_EVENT).toBe("auth:session-changed");
  });

  it("parses a well-formed envelope and bounds the reason", () => {
    expect(
      parseAuthSessionEnvelope({
        accountId: "  acct-1 ",
        generation: 2,
        status: "credentials_invalid",
        reason: "x".repeat(500),
      }),
    ).toEqual({
      accountId: "acct-1",
      generation: 2,
      status: "credentials_invalid",
      reason: "x".repeat(200),
    });
  });

  it("refuses malformed payloads rather than trusting them", () => {
    for (const bad of [
      null,
      "active",
      { generation: 0, status: "active" },
      { generation: 1.5, status: "active" },
      { generation: 1, status: "signed_out" },
      { generation: 1 },
    ]) {
      expect(parseAuthSessionEnvelope(bad)).toBeNull();
    }
  });
});

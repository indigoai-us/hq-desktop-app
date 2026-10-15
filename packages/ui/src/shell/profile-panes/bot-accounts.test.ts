import { describe, expect, it, vi } from "vitest";
import {
  accountName,
  accountSignInFromPayload,
  accountsClientFor,
  accountsFromStatusPayload,
  accountsFromWritePayload,
  addFailureMessage,
  removeFailureMessage,
  signInFailureMessage,
  statusLabel,
} from "./bot-accounts.js";

describe("bot accounts model", () => {
  it("returns null when the status read has no accounts field, so the section stays hidden", () => {
    expect(accountsFromStatusPayload({ codexAuthMode: "subscription" })).toBeNull();
    expect(accountsFromStatusPayload(null)).toBeNull();
    expect(accountsFromStatusPayload({ accounts: null })).toBeNull();
  });

  it("coerces a non-array accounts field to an empty list and drops malformed rows", () => {
    expect(accountsFromStatusPayload({ accounts: "nope" })).toEqual([]);
    const list = accountsFromStatusPayload({
      accounts: [
        { id: "legacy", provider: "codex", label: "", authKind: "subscription", status: "active" },
        { id: "acct_2", provider: "claude", label: "Work", status: "benched", benchedUntil: "2026-10-14T18:00:00Z" },
        { id: "", provider: "codex" },
        { id: "acct_3", provider: "gemini" },
        "junk",
      ],
    });
    expect(list?.map((a) => a.id)).toEqual(["legacy", "acct_2"]);
    expect(list?.[0].legacy).toBe(true);
    expect(list?.[1]).toMatchObject({ provider: "claude", status: "benched", benchedUntil: "2026-10-14T18:00:00Z" });
  });

  it("reads the list an add or remove hands back", () => {
    expect(accountsFromWritePayload({ accounts: [{ id: "acct_1", provider: "grok" }] })?.[0].provider).toBe("grok");
    expect(accountsFromWritePayload({ account: {} })).toBeNull();
  });

  it("names the legacy row Default and labels each status in plain words", () => {
    const [legacy, work, needs] = accountsFromStatusPayload({
      accounts: [
        { id: "legacy", provider: "codex" },
        { id: "acct_2", provider: "codex", label: "Work", status: "benched" },
        { id: "acct_3", provider: "claude", status: "needs_auth" },
      ],
    })!;
    expect(accountName(legacy)).toBe("Default");
    expect(accountName(work)).toBe("Work");
    expect(accountName(needs)).toBe("Claude");
    expect(statusLabel(legacy)).toBe("Active");
    expect(statusLabel(work)).toBe("Resting");
    expect(statusLabel(needs)).toBe("Needs sign-in");
  });

  it("reads every sign-in state", () => {
    expect(accountSignInFromPayload({ state: "starting" })).toEqual({ state: "pending", url: null, code: null });
    expect(accountSignInFromPayload({ state: "pending", url: "https://auth.example/device", code: "ABCD-1234" })).toEqual({
      state: "pending",
      url: "https://auth.example/device",
      code: "ABCD-1234",
    });
    expect(accountSignInFromPayload({ state: "signed-in" })).toEqual({ state: "signed-in" });
    expect(accountSignInFromPayload({ state: "failed", reason: "expired" })).toEqual({ state: "failed", reason: "expired" });
    expect(accountSignInFromPayload({ state: "idle" })).toEqual({ state: "idle" });
    expect(accountSignInFromPayload("??")).toEqual({ state: "unknown" });
  });

  it("maps failures to plain copy, never server text", () => {
    expect(addFailureMessage({ ok: false, status: 403, message: "Forbidden: not owner" })).toBe("Only the bot's owner can change its accounts.");
    expect(addFailureMessage({ ok: false, status: 500, message: "boom" })).toBe("Couldn't add the account. Try again.");
    expect(removeFailureMessage({ ok: false, status: 409 })).toBe("A bot needs at least one account.");
    expect(signInFailureMessage("expired")).toBe("The sign-in link expired. Start again.");
    expect(signInFailureMessage("duplicate-account")).toBe("That login is already on this bot.");
    expect(signInFailureMessage("sign-in-failed")).toBe("Couldn't finish sign-in. Try again.");
  });

  it("binds the account calls to one bot, and is null on a build without them", async () => {
    expect(accountsClientFor({} as never, "agt_1")).toBeNull();
    const api = {
      addAccount: vi.fn(async () => ({ ok: true as const, value: {} })),
      removeAccount: vi.fn(async () => ({ ok: true as const, value: {} })),
      startAccountSignIn: vi.fn(async () => ({ ok: true as const, value: {} })),
      getAccountSignIn: vi.fn(async () => ({ ok: true as const, value: {} })),
    };
    const client = accountsClientFor(api as never, "agt_1")!;
    await client.add({ provider: "codex", label: "Work" });
    await client.remove("acct_2");
    expect(api.addAccount).toHaveBeenCalledWith("agt_1", { provider: "codex", label: "Work" });
    expect(api.removeAccount).toHaveBeenCalledWith("agt_1", "acct_2");
    expect(client.submitLoginCode).toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  CLAUDE_CODE_CONFIRM_MS,
  CLAUDE_CODE_RESEND_AFTER_MS,
  claudeCodeAnswer,
  submitClaudeCode,
  type ClaudeCodeSubmitDeps,
} from "./claude-code-submit";

/** A clock that only moves when the flow sleeps. */
function clock() {
  let now = 0;
  return {
    now: () => now,
    sleep: vi.fn(async (ms: number) => { now += ms; }),
    advance: (ms: number) => { now += ms; },
  };
}

function deps(overrides: Partial<ClaudeCodeSubmitDeps> & Pick<ClaudeCodeSubmitDeps, "send" | "confirm">): ClaudeCodeSubmitDeps {
  const time = clock();
  return { now: time.now, sleep: time.sleep, ...overrides };
}

const answer = (outcome?: string) => ({ ok: true, value: { uid: "agt_1", ok: true, ...(outcome ? { outcome, reason: "r", at: "2026-10-10T00:00:00.000Z" } : {}) } });

describe("claudeCodeAnswer", () => {
  it("reads Claude's answer from the adapter result", () => {
    expect(claudeCodeAnswer(answer("accepted"))).toBe("accepted");
    expect(claudeCodeAnswer(answer("rejected"))).toBe("rejected");
    expect(claudeCodeAnswer(answer("unknown"))).toBe("unknown");
    // An older server says only ok: the answer is not known.
    expect(claudeCodeAnswer(answer())).toBe("unknown");
    expect(claudeCodeAnswer({ ok: true })).toBe("unknown");
    expect(claudeCodeAnswer({ ok: false, code: "network", message: "timed out" })).toBe("failed");
    expect(claudeCodeAnswer(null)).toBe("failed");
  });
});

describe("submitClaudeCode", () => {
  it("asks for a re-check straight after an accepted code instead of waiting for the next scheduled one", async () => {
    const confirm = vi.fn(async () => true);
    const send = vi.fn(async () => answer("accepted"));
    await expect(submitClaudeCode(deps({ send, confirm }))).resolves.toBe("signed-in");
    expect(send).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("sends the code once more when Claude's answer was not seen and the sign-in has not moved (owner: the second submit worked)", async () => {
    const time = clock();
    let sends = 0;
    const send = vi.fn(async () => answer(++sends === 1 ? "unknown" : "accepted"));
    const confirm = vi.fn(async () => sends >= 2);
    const result = await submitClaudeCode({ send, confirm, now: time.now, sleep: time.sleep });
    expect(result).toBe("signed-in");
    expect(send).toHaveBeenCalledTimes(2);
    // The resend waited for the sign-in first.
    expect(time.now()).toBeGreaterThanOrEqual(CLAUDE_CODE_RESEND_AFTER_MS);
  });

  it("does not send again when the sign-in shows up while waiting", async () => {
    const time = clock();
    const send = vi.fn(async () => answer("unknown"));
    const confirm = vi.fn(async () => time.now() >= 6_000);
    await expect(submitClaudeCode({ send, confirm, now: time.now, sleep: time.sleep })).resolves.toBe("signed-in");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("stops at a rejected code without waiting", async () => {
    const confirm = vi.fn(async () => false);
    const send = vi.fn(async () => answer("rejected"));
    await expect(submitClaudeCode(deps({ send, confirm }))).resolves.toBe("rejected");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("says failed for a refused request, after one look in case it went through", async () => {
    const confirm = vi.fn(async () => false);
    const send = vi.fn(async () => ({ ok: false, code: "network", message: "Network error: operation timed out" }));
    await expect(submitClaudeCode(deps({ send, confirm }))).resolves.toBe("failed");
    expect(confirm).toHaveBeenCalledTimes(1);

    const thrown = vi.fn(async () => { throw new Error("boom"); });
    await expect(submitClaudeCode(deps({ send: thrown, confirm: async () => true }))).resolves.toBe("signed-in");
  });

  it("times out with a bounded wait when the sign-in never shows", async () => {
    const time = clock();
    const send = vi.fn(async () => answer("accepted"));
    const confirm = vi.fn(async () => false);
    await expect(submitClaudeCode({ send, confirm, now: time.now, sleep: time.sleep })).resolves.toBe("timeout");
    expect(send).toHaveBeenCalledTimes(1);
    expect(time.now()).toBe(CLAUDE_CODE_CONFIRM_MS);
  });

  it("only checks again, without a second send, when the code was already accepted", async () => {
    const send = vi.fn(async () => answer("accepted"));
    await expect(submitClaudeCode(deps({ send, confirm: async () => true, alreadyAccepted: true }))).resolves.toBe("signed-in");
    expect(send).not.toHaveBeenCalled();
  });
});

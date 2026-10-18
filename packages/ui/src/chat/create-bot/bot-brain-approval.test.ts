import { describe, expect, it } from "vitest";

import { approvalOpenUrl, brainApprovalFromStatus } from "./bot-brain-approval.js";

describe("brain approval", () => {
  it('reads the selected brain while the bot keeps another active provider', () => {
    const pairing = { url: 'https://auth.openai.com/device', code: 'test-code' };
    expect(brainApprovalFromStatus({ agent: { provider: 'claude' }, brain: 'codex', pairing })?.provider).toBe('codex');
    expect(brainApprovalFromStatus({ agent: { provider: 'claude' }, pairing }, 'codex')?.provider).toBe('codex');
    expect(brainApprovalFromStatus({ agent: { provider: 'claude' }, pairing }, 'grok')).toBeNull();
    expect(brainApprovalFromStatus({ brain: 'grok', pairing }, 'codex')).toBeNull();
  });
  it("rejects a provider lookalike before it can be opened", () => {
    expect(brainApprovalFromStatus({
      agent: { provider: "grok" },
      pairing: {
        url: "https://accounts.x.ai.example.test/device",
        code: "current-code",
      },
    })).toBeNull();
  });

  it("replaces a stale Grok code in the provider URL", () => {
    expect(approvalOpenUrl({
      provider: "grok",
      url: "https://accounts.x.ai/device?user_code=stale-code",
      code: "current-code",
      capturedAt: null,
    })).toBe("https://accounts.x.ai/device?user_code=current-code");
  });
});

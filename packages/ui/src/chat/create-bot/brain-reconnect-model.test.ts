import { describe, expect, it } from "vitest";

import {
  applyReconnectCheckFailure,
  applyReconnectStart,
  applyReconnectStatus,
  beginReconnect,
  botOwnerUidFromStatus,
  brainSignedInFromStatus,
  reconnectCardView,
  reconnectLinkAgentUid,
  reconnectNeedsNudge,
  reconnectStatusLine,
  reconnectTargetFromStatus,
  signedOutBrainFromStatus,
} from "./brain-reconnect-model";

const DONE_STEPS = [
  { name: "identity", status: "done" },
  { name: "runtime", status: "done" },
  { name: "codex-auth", status: "done" },
  { name: "sync", status: "done" },
];

function status(agent: Record<string, unknown>, extra: Record<string, unknown> = {}, phase = "ready", steps = DONE_STEPS) {
  return {
    agent: { uid: "agt_sasha", name: "sasha", ownerUid: "prs_ben", codexModel: "gpt-5.5", provider: "agents-v2", ...agent },
    setupState: { phase, steps },
    ...extra,
  };
}

const CODEX_PAIRING = {
  pairing: { url: "https://auth.openai.com/codex/device", code: "ABCD-EFGH", capturedAt: new Date().toISOString() },
};

describe("signedOutBrainFromStatus", () => {
  it("names the bot's own model when its sign-in expired (the Sasha case)", () => {
    expect(signedOutBrainFromStatus(status({ authorizedBrains: { codex: "expired" } }))).toBe("codex");
  });

  it("prefers the bot's own model over another expired one", () => {
    const payload = status({ codexModel: "claude-sonnet-5", authorizedBrains: { codex: "expired", claude: "expired" } });
    expect(signedOutBrainFromStatus(payload)).toBe("claude");
  });

  it("names another expired brain when the bot's own is fine", () => {
    expect(signedOutBrainFromStatus(status({ authorizedBrains: { codex: "authorized", grok: "expired" } }))).toBe("grok");
  });

  it("reads a needs-re-auth health alert", () => {
    const payload = status({ authorizedBrains: { codex: "authorized" }, runtime: { healthAlert: { streakState: "needs-re-auth" } } });
    expect(signedOutBrainFromStatus(payload)).toBe("codex");
  });

  it("reads a sign-in next action on a bot that was set up before", () => {
    const payload = status({}, { nextActions: [{ id: "brain-signin:codex", kind: "brain_signin_device", required: true, brain: "codex", url: "https://auth.openai.com/x", code: "A" }] });
    expect(signedOutBrainFromStatus(payload)).toBe("codex");
  });

  it("leaves a new bot's first sign-in to the waking screen", () => {
    const steps = [
      { name: "runtime", status: "done" },
      { name: "codex-auth", status: "waiting" },
      { name: "sync", status: "pending" },
    ];
    const payload = status({}, { nextActions: [{ id: "brain-signin:codex", kind: "brain_signin_device", required: true, brain: "codex", url: "https://auth.openai.com/x", code: "A" }] }, "waiting", steps);
    expect(signedOutBrainFromStatus(payload)).toBeNull();
  });

  it("says nothing for a signed-in bot, a pending sign-in, or a bot being removed", () => {
    expect(signedOutBrainFromStatus(status({ authorizedBrains: { codex: "authorized" } }))).toBeNull();
    expect(signedOutBrainFromStatus(status({ authorizedBrains: { codex: "pending" } }))).toBeNull();
    expect(signedOutBrainFromStatus(status({ authorizedBrains: { codex: "expired" } }, {}, "deprovisioning"))).toBeNull();
    expect(signedOutBrainFromStatus(null)).toBeNull();
  });
});

describe("brainSignedInFromStatus", () => {
  it("waits for the brain to report authorized on agents-v2, whatever the steps say", () => {
    expect(brainSignedInFromStatus(status({ authorizedBrains: { codex: "pending" } }), "codex")).toBe(false);
    expect(brainSignedInFromStatus(status({ authorizedBrains: { codex: "authorized" } }), "codex")).toBe(true);
  });

  it("falls back to the sign-in step on older runtimes", () => {
    const pending = [...DONE_STEPS.filter((s) => s.name !== "codex-auth"), { name: "codex-auth", status: "waiting" }];
    expect(brainSignedInFromStatus(status({ provider: "codex" }, {}, "waiting", pending), "codex")).toBe(false);
    expect(brainSignedInFromStatus(status({ provider: "codex" }), "codex")).toBe(true);
  });
});

describe("the reconnect session", () => {
  const begin = () => beginReconnect({ agentUid: "agt_sasha", name: "Sasha", brain: "codex" });

  it("starts idle, and waits on the code the restart answered with", () => {
    const session = begin();
    expect(session.phase).toBe("idle");
    expect(reconnectStatusLine(session)).toContain("Sasha can't answer until it's signed back in to ChatGPT");
    const next = applyReconnectStart(session, { ok: true, value: status({ authorizedBrains: { codex: "pending" } }, CODEX_PAIRING) });
    expect(next.phase).toBe("waiting");
    expect(next.approval?.code).toBe("ABCD-EFGH");
  });

  it("keeps polling while the brain is pending, and is done once it is authorized", () => {
    let session = applyReconnectStart(begin(), { ok: true, value: status({ authorizedBrains: { codex: "pending" } }) });
    expect(session.phase).toBe("starting");
    session = applyReconnectStatus(session, status({ authorizedBrains: { codex: "pending" } }, CODEX_PAIRING));
    expect(session.phase).toBe("waiting");
    session = applyReconnectStatus(session, status({ authorizedBrains: { codex: "pending" } }, { pairing: null }));
    expect(session.phase).toBe("waiting");
    expect(session.approval?.code).toBe("ABCD-EFGH");
    session = applyReconnectStatus(session, status({ authorizedBrains: { codex: "authorized" } }));
    expect(session.phase).toBe("done");
    expect(reconnectStatusLine(session)).toBe("Sasha is signed back in to ChatGPT.");
  });

  it("ignores a code for another brain", () => {
    const grok = { pairing: { url: "https://accounts.x.ai/device", code: "XYZ", capturedAt: null } };
    const next = applyReconnectStart(begin(), { ok: true, value: status({ authorizedBrains: { codex: "pending" } }, grok) });
    expect(next.phase).toBe("starting");
    expect(next.approval).toBeNull();
  });

  it("explains a refused restart", () => {
    expect(reconnectStatusLine(applyReconnectStart(begin(), { ok: false, status: 403, code: "http-403" }))).toBe(
      "Only Sasha's owner can sign it back in.",
    );
    expect(applyReconnectStart(begin(), { ok: false, code: "REAUTH_NOT_APPLICABLE" }).refusal).toBe("api-key");
    expect(applyReconnectStart(begin(), { ok: true, value: { signIn: "failed" } }).phase).toBe("failed");
  });

  it("stops after the server twice says the bot is gone", () => {
    let session = applyReconnectStart(begin(), { ok: true, value: status({ authorizedBrains: { codex: "pending" } }) });
    session = applyReconnectCheckFailure(session, { ok: false, status: 404 });
    expect(session.phase).toBe("starting");
    session = applyReconnectCheckFailure(session, { ok: false, status: 404 });
    expect(session.phase).toBe("stopped");
    expect(reconnectStatusLine(session)).toBe("Sasha was removed.");
  });

  it("does not move a finished or idle session on a late read", () => {
    const idle = begin();
    expect(applyReconnectStatus(idle, status({ authorizedBrains: { codex: "authorized" } }))).toBe(idle);
  });
});

describe("status helpers", () => {
  it("reads the owner, the target, and whether the setup needs a nudge", () => {
    const payload = status({ authorizedBrains: { codex: "expired" }, profile: { displayName: "Sasha" } });
    expect(botOwnerUidFromStatus(payload)).toBe("prs_ben");
    expect(reconnectTargetFromStatus(payload)).toEqual({ name: "Sasha", brain: "codex" });
    expect(reconnectTargetFromStatus(status({ codexModel: "grok-4" }))).toEqual({ name: "sasha", brain: "grok" });
    expect(reconnectNeedsNudge(payload)).toBe(false);
    expect(reconnectNeedsNudge(status({}, {}, "waiting"))).toBe(true);
  });
});

describe("reconnectLinkAgentUid", () => {
  it("reads the agent from HQ's reconnect link", () => {
    expect(reconnectLinkAgentUid("https://hq.computer/resolve/agents/agt_7PPSH6SS2ZX8D9MY6Q4HBXXK32/reconnect")).toBe(
      "agt_7PPSH6SS2ZX8D9MY6Q4HBXXK32",
    );
    expect(reconnectLinkAgentUid("https://hq.getindigo.ai/resolve/agents/agt_abc/reconnect/")).toBe("agt_abc");
  });

  it("leaves every other link alone", () => {
    expect(reconnectLinkAgentUid("https://hq.computer/resolve/agents/agt_abc")).toBeNull();
    expect(reconnectLinkAgentUid("https://evil.example/resolve/agents/agt_abc/reconnect")).toBeNull();
    expect(reconnectLinkAgentUid("http://hq.computer/resolve/agents/agt_abc/reconnect")).toBeNull();
    expect(reconnectLinkAgentUid("https://hq.computer.evil.example/resolve/agents/agt_abc/reconnect")).toBeNull();
    expect(reconnectLinkAgentUid("not a url")).toBeNull();
  });
});

describe("reconnectCardView", () => {
  it("gives the owner the button", () => {
    const view = reconnectCardView({ botName: "Sasha", brain: "codex", canSignIn: true });
    expect(view.title).toBe("Signed out of ChatGPT");
    expect(view.line).toBe("Sasha can't answer until you sign it back in.");
    expect(view.primaryLabel).toBe("Sign back in");
    expect(view.primaryAction).toBe("signIn");
  });

  it("tells anyone else who has to do it, with no button", () => {
    const view = reconnectCardView({ botName: "Sasha", brain: "claude", canSignIn: false, ownerName: "Ben" });
    expect(view.title).toBe("Signed out of Claude");
    expect(view.line).toBe("Sasha can't answer until Ben signs it back in.");
    expect(view.primaryLabel).toBeNull();
    expect(reconnectCardView({ botName: "Sasha", brain: "codex", canSignIn: false }).line).toContain("its owner");
  });
});

import { describe, expect, it } from "vitest";
import { parseNextActions, reduceSetup, brainOfAgent } from "./reducer.js";
import type {
  AgentSetupPhase,
  AgentSetupStep,
  AgentSetupStepStatus,
  AgentStatusResponse,
} from "./types.js";

const ORDER = [
  "identity",
  "membership",
  "vault",
  "runtime",
  "codex-auth",
  "sync",
  "channels",
  "audit",
  "runtime-install",
] as const;

function steps(statuses: Partial<Record<(typeof ORDER)[number], AgentSetupStepStatus>>, errors: Record<string, string> = {}): AgentSetupStep[] {
  return ORDER.map((name) => ({
    name,
    status: statuses[name] ?? "pending",
    ...(errors[name] ? { lastError: errors[name] } : {}),
  }));
}

function allDone(): Partial<Record<(typeof ORDER)[number], AgentSetupStepStatus>> {
  return Object.fromEntries(ORDER.map((n) => [n, "done"])) as Record<(typeof ORDER)[number], AgentSetupStepStatus>;
}

function status(
  phase: AgentSetupPhase,
  stepList: AgentSetupStep[],
  extra: Partial<AgentStatusResponse> = {},
): AgentStatusResponse {
  return {
    agent: { uid: "agt_1", name: "Ada", slug: "ada", companyUid: "cmp_1" },
    setupState: { version: 3, phase, idempotencyKey: "k", steps: stepList, updatedAt: "2026-10-02T00:00:00Z" },
    pairing: null,
    ...extra,
  };
}

const DEVICE = {
  id: "brain-signin:codex",
  kind: "brain_signin_device",
  required: true,
  title: "Sign in to ChatGPT so Ada can think",
  url: "https://auth.openai.com/codex/device",
  code: "ABCD-1234",
  expiresAt: "2026-10-02T15:04:00Z",
  brain: "codex",
};
const PASTE = {
  id: "brain-signin:claude",
  kind: "brain_signin_paste",
  required: true,
  title: "Sign in to Claude",
  url: "https://claude.ai/oauth/authorize?x=1",
};
const PLAN = {
  id: "plan",
  kind: "plan_upgrade",
  required: true,
  title: "Upgrade",
  requiredPlan: "agents-500",
  checkoutUrl: "https://checkout.example/1",
  amountMinor: 50000,
  currency: "usd",
};
const RETRY = { id: "retry:audit", kind: "retry", required: true, title: "Final checks failed", step: "audit", reason: "timed out" };
const SYNC = { id: "sync", kind: "sync_in_progress", required: true, title: "Getting files", progress: { done: 40, total: 100, label: "40 of 100 files" } };

describe("reduceSetup phases", () => {
  it("provisioning with nothing asked is working, groups fold in plain words", () => {
    const view = reduceSetup(status("provisioning", steps({ identity: "done", membership: "running" })), {});
    expect(view.stage).toBe("working");
    expect(view.ready).toBe(false);
    expect(view.chatReady).toBe(false);
    expect(view.groups).toEqual([
      { id: "computer", label: "Creating Ada's computer", status: "active" },
      { id: "signin", label: "Sign in", status: "pending" },
      { id: "files", label: "Getting Ada's files", status: "pending" },
      { id: "checks", label: "Final checks", status: "pending" },
    ]);
    expect(view.failure).toBeNull();
    expect(view.primaryAction).toBeNull();
  });

  it("waiting surfaces the waiting group and stays working when no action is required", () => {
    const view = reduceSetup(
      status("waiting", steps({ identity: "done", membership: "done", vault: "done", runtime: "done", "codex-auth": "done", sync: "waiting" }), {
        nextActions: [],
      }),
    );
    expect(view.stage).toBe("working");
    expect(view.groups.find((g) => g.id === "files")?.status).toBe("waiting");
  });

  it("failed names the failed step and its reason", () => {
    const view = reduceSetup(
      status("failed", steps({ identity: "done", audit: "failed" }, { audit: "audit timed out" }), { nextActions: [RETRY] }),
    );
    expect(view.stage).toBe("failed");
    expect(view.failure).toEqual({ step: "audit", reason: "audit timed out" });
    expect(view.groups.find((g) => g.id === "checks")?.status).toBe("failed");
    expect(view.primaryAction).toMatchObject({ kind: "retry", step: "audit" });
  });

  it("ready is ready, chat follows ready when the server sends no chatReady", () => {
    const view = reduceSetup(status("ready", steps(allDone()), { nextActions: [] }));
    expect(view.stage).toBe("ready");
    expect(view.ready).toBe(true);
    expect(view.chatReady).toBe(true);
    expect(view.groups.every((g) => g.status === "done")).toBe(true);
  });

  it("chatReady from the server wins before ready", () => {
    const view = reduceSetup(status("provisioning", steps({ "codex-auth": "done", "runtime-install": "done" }), { chatReady: true, nextActions: [] }));
    expect(view.chatReady).toBe(true);
    expect(view.ready).toBe(false);
  });

  it.each(["deprovisioning", "deprovisioned"] as const)("%s reads as removed", (phase) => {
    expect(reduceSetup(status(phase, steps({}))).stage).toBe("removed");
  });

  it("uses the display name, then the name, then a neutral noun", () => {
    const s = status("provisioning", steps({}));
    expect(reduceSetup({ ...s, agent: { ...s.agent, profile: { displayName: "Dr Love" } } }).groups[0]?.label).toBe("Creating Dr Love's computer");
    expect(reduceSetup({ ...s, agent: { ...s.agent, name: "" } }).groups[0]?.label).toBe("Creating the bot's computer");
    expect(reduceSetup(s, { botName: "Zed" }).groups[0]?.label).toBe("Creating Zed's computer");
  });

  it("reduces a create response (no pairing, no nextActions)", () => {
    const view = reduceSetup({ agent: { uid: "agt_1", name: "Ada", slug: "ada", companyUid: "cmp_1" }, setupState: status("provisioning", steps({})).setupState });
    expect(view.stage).toBe("working");
    expect(view.actions).toEqual([]);
  });
});

describe("reduceSetup action kinds", () => {
  it("brain_signin_device is the primary action and needs the person", () => {
    const view = reduceSetup(status("waiting", steps({ "codex-auth": "waiting" }), { nextActions: [DEVICE] }));
    expect(view.stage).toBe("needs_action");
    expect(view.primaryAction).toEqual(DEVICE);
  });

  it("brain_signin_paste is the primary action", () => {
    const view = reduceSetup(status("waiting", steps({ "codex-auth": "waiting" }), { nextActions: [PASTE] }));
    expect(view.primaryAction).toMatchObject({ kind: "brain_signin_paste", url: PASTE.url });
  });

  it("plan_upgrade carries price and checkout", () => {
    const view = reduceSetup(status("provisioning", steps({}), { nextActions: [PLAN] }));
    expect(view.primaryAction).toEqual(PLAN);
  });

  it("retry is offered for a failure", () => {
    const view = reduceSetup(status("failed", steps({ sync: "failed" }), { nextActions: [RETRY] }));
    expect(view.actions).toEqual([RETRY]);
  });

  it("sync_in_progress is informational: never primary, never blocking", () => {
    const view = reduceSetup(status("provisioning", steps({ "codex-auth": "done" }), { chatReady: true, nextActions: [SYNC] }));
    expect(view.stage).toBe("working");
    expect(view.primaryAction).toBeNull();
    expect(view.sync).toEqual({ ...SYNC, required: false });
  });

  it("required actions come first and unknown kinds are dropped", () => {
    const view = reduceSetup(
      status("waiting", steps({}), {
        nextActions: [SYNC, { id: "slack", kind: "slack_connect", required: true, title: "Slack" }, DEVICE],
      }),
    );
    expect(view.actions.map((a) => a.kind)).toEqual(["brain_signin_device", "sync_in_progress"]);
  });

  it("an empty nextActions list is respected: nothing is derived from pairing", () => {
    const view = reduceSetup(
      status("waiting", steps({ "codex-auth": "waiting" }), {
        nextActions: [],
        pairing: { url: "https://auth.openai.com/codex/device", code: "OLD-CODE" },
      }),
    );
    expect(view.actions).toEqual([]);
  });
});

describe("reduceSetup without nextActions (older server)", () => {
  it("derives a device sign-in from pairing while codex-auth is open", () => {
    const view = reduceSetup(
      status("waiting", steps({ "codex-auth": "waiting" }), {
        pairing: { url: "https://auth.openai.com/codex/device", code: "WXYZ-9876" },
      }),
    );
    expect(view.primaryAction).toMatchObject({
      kind: "brain_signin_device",
      code: "WXYZ-9876",
      required: true,
      brain: "codex",
      title: "Sign in so Ada can think",
    });
  });

  it("derives a paste sign-in for a Claude bot", () => {
    const s = status("waiting", steps({ "codex-auth": "waiting" }), { pairing: { url: "https://claude.ai/oauth", code: "" } });
    const view = reduceSetup({ ...s, agent: { ...s.agent, codexModel: "claude-opus-5-5" } });
    expect(view.primaryAction).toMatchObject({ kind: "brain_signin_paste", brain: "claude" });
  });

  it("derives nothing from a stale pairing once sign-in is done", () => {
    const view = reduceSetup(
      status("provisioning", steps({ "codex-auth": "done" }), { pairing: { url: "https://x", code: "C" } }),
    );
    expect(view.actions).toEqual([]);
  });

  it("derives a Retry with the failed step's reason", () => {
    const view = reduceSetup(status("failed", steps({ runtime: "failed" }, { runtime: "boot timed out" })));
    expect(view.primaryAction).toMatchObject({
      kind: "retry",
      step: "runtime",
      reason: "boot timed out",
      title: "Setup stopped at starting the bot's computer",
    });
  });
});

describe("parseNextActions", () => {
  it("drops entries missing what their kind needs", () => {
    expect(
      parseNextActions([
        { id: "a", kind: "brain_signin_device", required: true, title: "x", url: "https://x" },
        { id: "b", kind: "brain_signin_paste", required: true, title: "x" },
        { kind: "retry", required: true, title: "no id" },
        null,
        "retry",
      ]),
    ).toEqual([]);
  });

  it("returns [] for a non-array", () => {
    expect(parseNextActions({})).toEqual([]);
    expect(parseNextActions(undefined)).toEqual([]);
  });

  it("treats a missing required as optional", () => {
    expect(parseNextActions([{ id: "r", kind: "retry", title: "Retry" }])).toEqual([
      { id: "r", kind: "retry", required: false, title: "Retry" },
    ]);
  });
});

describe("brainOfAgent", () => {
  it("maps the model to a brain, Codex by default", () => {
    expect(brainOfAgent({ codexModel: "claude-opus-5-5" })).toBe("claude");
    expect(brainOfAgent({ codexModel: "grok-4.7" })).toBe("grok");
    expect(brainOfAgent({ codexModel: "gpt-5.5" })).toBe("codex");
    expect(brainOfAgent(null)).toBe("codex");
  });
});

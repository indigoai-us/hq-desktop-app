// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import BrainReconnectScreen from "./BrainReconnectScreen.svelte";
import { RECONNECT_POLL_MS } from "./brain-reconnect-model";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

const READY_STEPS = [
  { name: "runtime", status: "done" },
  { name: "codex-auth", status: "done" },
];

function statusValue(brains: Record<string, string>, pairing: unknown = null) {
  return { agent: { uid: "agt_sasha", ownerUid: "prs_ben", authorizedBrains: brains }, setupState: { phase: "ready", steps: READY_STEPS }, pairing };
}

const CODEX_PAIRING = { url: "https://auth.openai.com/codex/device", code: "ABCD-EFGH", capturedAt: new Date().toISOString() };
const CLAUDE_PAIRING = { url: "https://claude.ai/oauth/authorize?x=1", code: "", capturedAt: new Date().toISOString() };

function render(overrides: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const restartBrainApproval = vi.fn(async () => ({ ok: true, value: statusValue({ codex: "pending" }, CODEX_PAIRING) }));
  const getStatus = vi.fn(async () => ({ ok: true, value: statusValue({ codex: "pending" }, CODEX_PAIRING) }));
  const onclose = vi.fn();
  const ondone = vi.fn();
  const openExternal = vi.fn(() => true);
  const retryAgent = vi.fn(async () => ({ ok: true }));
  const props = {
    agentUid: "agt_sasha",
    name: "Sasha",
    brain: "codex",
    getStatus,
    restartBrainApproval,
    retryAgent,
    openExternal,
    onclose,
    ondone,
    ...overrides,
  };
  component = mount(BrainReconnectScreen, { target: host, props });
  return props as typeof props & { getStatus: typeof getStatus; restartBrainApproval: typeof restartBrainApproval };
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.useRealTimers();
});

describe("BrainReconnectScreen", () => {
  it("asks before it starts when opened from a link, since a fresh sign-in replaces the old one", async () => {
    const { restartBrainApproval, getStatus } = render();
    await settle();
    expect(q("brain-reconnect-screen")?.textContent).toContain("Signed out of ChatGPT");
    expect(q("brain-reconnect-screen")?.textContent).toContain("Sign Sasha back in");
    expect(q("brain-reconnect-status")?.textContent).toContain("replaces the old sign-in");
    expect(restartBrainApproval).not.toHaveBeenCalled();
    expect(getStatus).not.toHaveBeenCalled();
    q("brain-reconnect-start")!.click();
    await settle();
    expect(restartBrainApproval).toHaveBeenCalledWith("agt_sasha", "codex");
    expect(q("new-bot-codex-code")?.textContent).toBe("ABCD-EFGH");
  });

  it("starts at once from the card, and keeps reading the status for its brain until it is authorized", async () => {
    vi.useFakeTimers();
    let brains: Record<string, string> = { codex: "pending" };
    const getStatus = vi.fn(async () => ({ ok: true, value: statusValue(brains, brains.codex === "pending" ? CODEX_PAIRING : null) }));
    const { ondone, restartBrainApproval } = render({ autostart: true, getStatus });
    await settle();
    expect(restartBrainApproval).toHaveBeenCalledTimes(1);
    expect(q("brain-reconnect-screen")?.dataset.phase).toBe("waiting");

    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(RECONNECT_POLL_MS);
      await settle();
    }
    expect(getStatus.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(getStatus).toHaveBeenCalledWith("agt_sasha", "codex");
    expect(q("brain-reconnect-screen")?.dataset.phase).toBe("waiting");

    brains = { codex: "authorized" };
    await vi.advanceTimersByTimeAsync(RECONNECT_POLL_MS);
    await settle();
    expect(q("brain-reconnect-screen")?.dataset.phase).toBe("done");
    expect(q("brain-reconnect-status")?.textContent).toBe("Sasha is signed back in to ChatGPT.");
    expect(ondone).toHaveBeenCalledTimes(1);

    const reads = getStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RECONNECT_POLL_MS * 3);
    expect(getStatus.mock.calls.length).toBe(reads);
    expect(q("brain-reconnect-close")?.textContent).toContain("Back to chat");
  });

  it("does not nudge setup on a ready bot; the status read is what moves it", async () => {
    vi.useFakeTimers();
    const { retryAgent } = render({ autostart: true });
    await settle();
    for (let i = 0; i < 6; i += 1) await vi.advanceTimersByTimeAsync(RECONNECT_POLL_MS);
    expect(retryAgent).not.toHaveBeenCalled();
  });

  it("opens the device page with the code copied", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { openExternal } = render({ autostart: true });
    await settle();
    q("new-bot-approval-open")!.click();
    await settle();
    expect(openExternal).toHaveBeenCalledWith(CODEX_PAIRING.url);
    expect(writeText).toHaveBeenCalledWith("ABCD-EFGH");
  });

  it("takes Claude's code by paste and finishes once Claude reports authorized", async () => {
    let brains: Record<string, string> = { claude: "pending" };
    const getStatus = vi.fn(async () => ({ ok: true, value: statusValue(brains, brains.claude === "pending" ? CLAUDE_PAIRING : null) }));
    const restartBrainApproval = vi.fn(async () => ({ ok: true, value: statusValue({ claude: "pending" }, CLAUDE_PAIRING) }));
    const submitClaudeLoginCode = vi.fn(async () => {
      brains = { claude: "authorized" };
      return { ok: true, value: { outcome: "accepted" } };
    });
    render({ brain: "claude", autostart: true, getStatus, restartBrainApproval, submitClaudeLoginCode });
    await settle();
    expect(q("brain-reconnect-screen")?.textContent).toContain("Signed out of Claude");
    q("new-bot-approval-open")!.click();
    await settle();
    const input = q("new-bot-claude-code") as HTMLInputElement;
    input.value = "code#state";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    q("new-bot-claude-submit")!.click();
    await vi.waitFor(() => expect(q("brain-reconnect-screen")?.dataset.phase).toBe("done"));
    expect(submitClaudeLoginCode).toHaveBeenCalledWith("agt_sasha", "code#state");
  });

  it("says plainly when only the owner may do it, with no Try again", async () => {
    render({ autostart: true, restartBrainApproval: vi.fn(async () => ({ ok: false, status: 403, code: "http-403" })) });
    await settle();
    expect(q("brain-reconnect-status")?.textContent).toBe("Only Sasha's owner can sign it back in.");
    expect(q("brain-reconnect-retry")).toBeNull();
  });

  it("offers Try again when the server could not start it", async () => {
    const restartBrainApproval = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, code: "http-500" })
      .mockResolvedValueOnce({ ok: true, value: statusValue({ codex: "pending" }, CODEX_PAIRING) });
    render({ autostart: true, restartBrainApproval });
    await settle();
    expect(q("brain-reconnect-status")?.textContent).toBe("We couldn't start a fresh sign-in. Try again.");
    q("brain-reconnect-retry")!.click();
    await settle();
    expect(restartBrainApproval).toHaveBeenCalledTimes(2);
    expect(q("new-bot-codex-code")?.textContent).toBe("ABCD-EFGH");
  });

  it("stops reading once it closes", async () => {
    vi.useFakeTimers();
    const { getStatus, onclose } = render({ autostart: true });
    await settle();
    q("brain-reconnect-close")!.click();
    expect(onclose).toHaveBeenCalled();
    await unmount(component!);
    component = null;
    const reads = getStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RECONNECT_POLL_MS * 4);
    expect(getStatus.mock.calls.length).toBe(reads);
  });
});

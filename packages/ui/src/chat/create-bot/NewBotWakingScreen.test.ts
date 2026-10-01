// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import NewBotWakingScreen from "./NewBotWakingScreen.svelte";
import { beginWakingSession, recordWakingCheckFailure } from "./waking-model";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(): Promise<void> {
  await tick();
  await Promise.resolve();
  await tick();
}

function render(session = beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova", now: Date.now() })) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const onupdate = vi.fn();
  const onclose = vi.fn();
  const onretry = vi.fn();
  const onopenchat = vi.fn();
  component = mount(NewBotWakingScreen, {
    target: host,
    props: {
      session,
      getStatus: async () => ({ ok: true, value: { setupState: { phase: "creating" } } }),
      onupdate,
      onclose,
      onretry,
      onopenchat,
    },
  });
  return { onupdate, onclose, onretry, onopenchat };
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("NewBotWakingScreen", () => {
  it("shows one calm status line and never renders setup step labels", async () => {
    render();
    await settle();
    const screen = document.querySelector('[data-testid="new-bot-waking-screen"]');
    const ring = document.querySelector('[data-testid="new-bot-waking-ring"]');
    const status = document.querySelector('[data-testid="new-bot-waking-status"]');
    expect(screen?.textContent).toContain("Waking up Nova");
    expect(screen?.textContent).not.toMatch(/identity|membership|vault|runtime|sync|channels|audit/i);
    expect(screen?.hasAttribute("aria-live")).toBe(false);
    expect(ring?.getAttribute("role")).toBe("progressbar");
    expect(ring?.getAttribute("aria-valuenow")).toBe("8");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.getAttribute("aria-atomic")).toBe("true");
  });

  it("offers a quiet close and early chat route while the bot wakes", async () => {
    const { onclose, onopenchat } = render();
    await settle();
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-waking-open-chat"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-waking-close"]')!.click();
    expect(onopenchat).toHaveBeenCalledOnce();
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("shows a single-sentence failure with Try again", async () => {
    const { onretry } = render(recordWakingCheckFailure({
      ...beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova" }),
      phase: "failed",
    }));
    await settle();
    expect(document.querySelector('[data-testid="new-bot-waking-status"]')?.textContent).toBe("We couldn't start this bot.");
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-waking-retry"]')!.click();
    expect(onretry).toHaveBeenCalledOnce();
  });
});

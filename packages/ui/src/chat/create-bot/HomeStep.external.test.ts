// @vitest-environment happy-dom

/**
 * Ported from the retired six-step sheet (NewAgentStepper.test.ts, "External
 * paid-plan chip"): the one New bot modal offers an external bot on its
 * coding-tool step (details → kind → home), labels it a paid-plan option, and shows the
 * enroll code only as a mask.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import CreateBotFlow from "./CreateBotFlow.svelte";

/** details (name) → kind → home: the coding-tool screen is the third local step. */
async function walkToHome(root: HTMLElement, settleFn: () => Promise<void>): Promise<void> {
  const name = root.querySelector<HTMLInputElement>('[data-testid="chat-bot-name"]');
  if (!name) throw new Error("missing chat-bot-name");
  name.value = "Dr Love";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  await settleFn();
  for (const expected of ["kind", "home"]) {
    const next = root.querySelector<HTMLButtonElement>('[data-testid="create-bot-next"]');
    if (!next) throw new Error("missing create-bot-next");
    next.click();
    await settleFn();
    if (!root.querySelector(`[data-testid="create-bot-sunrise-${expected}"]`)) throw new Error(`not on ${expected}`);
  }
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("New bot modal: external runtime", () => {
  it("offers External with a Paid plans chip and a masked enroll code", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(CreateBotFlow, {
      target: host,
      props: {
        botRuntimeReady: { claude: true, codex: true, grok: true },
        oncreate: async () => {},
      },
    });
    await tick();
    await walkToHome(host, async () => { await tick(); await Promise.resolve(); });
    expect(host.querySelector("[data-testid=create-bot-runtime-section]")).not.toBeNull();
    const external = host.querySelector("[data-testid=chat-bot-where-external]");
    expect(external).not.toBeNull();
    expect(host.querySelector("[data-testid=chat-bot-external-paid]")?.textContent).toContain("Paid plans");
    expect(host.querySelector("[data-testid=chat-bot-external-enroll-mask]")?.textContent).toContain("••••");
    expect(external?.textContent).toContain("hq agent enroll");
    expect(host.textContent).not.toMatch(/sk_live_|enroll_[A-Za-z0-9]{8}/);
  });
});

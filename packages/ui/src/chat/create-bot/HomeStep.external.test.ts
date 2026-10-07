// @vitest-environment happy-dom

/**
 * Ported from the retired six-step sheet (NewAgentStepper.test.ts, "External
 * paid-plan chip"): the one New bot modal offers an external bot on its
 * "Where does it run?" step, labels it a paid-plan option, and shows the
 * enroll code only as a mask.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import CreateBotFlow from "./CreateBotFlow.svelte";

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
        previewPlacement: "top",
      },
    });
    await tick();
    host.querySelector<HTMLButtonElement>("[data-testid=create-bot-next]")!.click();
    await tick();
    expect(host.querySelector("[data-testid=create-bot-home-step]")).not.toBeNull();
    const external = host.querySelector("[data-testid=chat-bot-where-external]");
    expect(external).not.toBeNull();
    expect(host.querySelector("[data-testid=chat-bot-external-paid]")?.textContent).toContain("Paid plans");
    expect(host.querySelector("[data-testid=chat-bot-external-enroll-mask]")?.textContent).toContain("••••");
    expect(external?.textContent).toContain("hq agent enroll");
    expect(host.textContent).not.toMatch(/sk_live_|enroll_[A-Za-z0-9]{8}/);
  });
});

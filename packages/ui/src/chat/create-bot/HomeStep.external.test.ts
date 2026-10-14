// @vitest-environment happy-dom

/**
 * Ported from the retired six-step sheet (NewAgentStepper.test.ts, "External
 * paid-plan chip"). After the owner's review the coding tool step no longer
 * carries the "Runs somewhere else?" disclosure. The Where step has one quiet
 * line under its tiles, "Already have a bot running somewhere else? Connect
 * it", and Connect it opens its own screen that labels it a paid-plan option
 * and shows the enroll code only as a mask.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok } from "@hq/platform";
import CreateBotFlow from "./CreateBotFlow.svelte";

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

/** The name, then the flow's own "Where should it live?". */
async function walkToWhere(root: HTMLElement): Promise<void> {
  const name = root.querySelector<HTMLInputElement>('[data-testid="new-bot-name"]');
  if (!name) throw new Error("missing new-bot-name");
  name.value = "Dr Love";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  root.querySelector<HTMLButtonElement>('[data-testid="new-bot-continue-name"]')!.click();
  await settle();
  if (!root.querySelector('[data-testid="new-bot-kind-choice"]')) throw new Error("not on where");
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("New bot: a bot that runs somewhere else", () => {
  it("is offered on the Where step, not on the coding tool step, with a paid-plan note and a masked enroll code", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(CreateBotFlow, {
      target: host,
      props: {
        botRuntimeReady: { claude: true, codex: true, grok: true },
        oncreate: async () => {},
        agentTargets: [{ companyUid: "cmp_indigo", label: "Indigo" }],
        onCloudCreate: async () => {},
        loadCloudProvisionOptions: async () => ok({ defaultInstanceType: "t4g.medium", catalogVersion: "c", options: [] }),
      },
    });
    await settle();
    await walkToWhere(host);
    // Where: one quiet line, and no paid-plan words on it.
    const line = host.querySelector('[data-testid="new-bot-connect-external-line"]');
    expect(line?.textContent).toContain("Already have a bot running somewhere else?");
    expect(line?.textContent).not.toMatch(/paid/i);

    // The coding tool step has no external disclosure any more.
    host.querySelector<HTMLButtonElement>('[data-testid="new-bot-choice-local"]')!.click();
    await settle();
    expect(host.querySelector("[data-testid=create-bot-runtime-section]")).not.toBeNull();
    expect(host.querySelector("[data-testid=chat-bot-where-external]")).toBeNull();
    expect(host.textContent).not.toContain("Runs somewhere else?");

    // Back to Where, then Connect it: its own screen.
    host.querySelector<HTMLButtonElement>('[data-testid="create-bot-back"]')!.click();
    await settle();
    host.querySelector<HTMLButtonElement>('[data-testid="new-bot-connect-external"]')!.click();
    await settle();
    const external = host.querySelector("[data-testid=chat-bot-where-external]");
    expect(external).not.toBeNull();
    expect(host.querySelector("[data-testid=chat-bot-external-paid]")?.textContent).toContain("paid plans");
    expect(host.querySelector("[data-testid=chat-bot-external-enroll-mask]")?.textContent).toContain("••••");
    expect(external?.textContent).toContain("hq agent enroll");
    expect(host.textContent).not.toMatch(/sk_live_|enroll_[A-Za-z0-9]{8}/);
  });
});

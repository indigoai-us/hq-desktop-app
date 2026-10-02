// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import NewAgentStepper from "./NewAgentStepper.svelte";

let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) unmount(component);
  component = null;
});

function host(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

async function click(selector: string) {
  document.querySelector<HTMLButtonElement>(selector)!.click();
  await tick();
}

describe("NewAgentStepper", () => {
  it("offers Local, Hosted sizes and region, and an External paid-plan chip", async () => {
    component = mount(NewAgentStepper, { target: host(), props: { instantProbe: true, companyLabel: "Indigo" } });
    await tick();
    expect(document.querySelector("[data-testid=new-agent-place-local]")?.textContent).toContain("Local on this Mac");
    expect(document.querySelector("[data-testid=new-agent-place-hosted]")?.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("[data-testid=new-agent-size-basic]")).toBeTruthy();
    expect(document.querySelector("[data-testid=new-agent-size-power]")?.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("[data-testid=new-agent-size-dev]")).toBeTruthy();
    expect(document.querySelector("[data-testid=new-agent-region-us-east-1]")).toBeTruthy();
    await click("[data-testid=new-agent-place-external]");
    expect(document.querySelector("[data-testid=new-agent-paid-chip]")?.textContent).toContain("Paid plans");
    expect(document.querySelector("[data-testid=new-agent-enroll-mask]")?.textContent).toContain("••••");
    expect(document.body.textContent).not.toMatch(/sk_live_|enroll_[A-Za-z0-9]{8}/);
  });

  it("uses read or write grants, the shared pickers, and a reply-received probe for hosted", async () => {
    const onCloudCreate = vi.fn(async () => ({ ok: true }));
    const ondone = vi.fn();
    component = mount(NewAgentStepper, {
      target: host(),
      props: {
        instantProbe: true,
        companyLabel: "Indigo",
        companies: [{ id: "co_indigo", label: "Indigo" }],
        onCloudCreate,
        ondone,
      },
    });
    await tick();
    await click("[data-testid=new-agent-next]");
    const name = document.querySelector<HTMLInputElement>("[data-testid=new-agent-name]")!;
    name.value = "ledger";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    await click("[data-testid=new-agent-next]");
    await click("[data-testid=new-agent-next]");
    await click("[data-testid=new-agent-add-path]");
    expect(document.querySelector("[data-testid=folder-picker]")).toBeTruthy();
    (document.querySelector("[data-testid=folder-picker-row]") as HTMLButtonElement).click();
    await tick();
    await click("[data-testid=folder-picker-choose]");
    const write = document.querySelector<HTMLButtonElement>("[data-testid=new-agent-grant-write]")!;
    write.click();
    await tick();
    expect(write.getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).not.toMatch(/\badmin\b/i);
    await click("[data-testid=new-agent-next]");
    await click("[data-testid=new-agent-open-skills]");
    expect(document.querySelector("[data-testid=skill-picker]")).toBeTruthy();
    await click("[data-testid=skill-picker-standup-brief]");
    document.querySelector<HTMLButtonElement>(".sp-done")!.click();
    await tick();
    await click("[data-testid=new-agent-next]");
    expect(document.querySelector("[data-testid=new-agent-reply-received]")?.textContent).toContain("reply received");
    expect(onCloudCreate).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toMatch(/sk_live_|rk_live_/);
    await click("[data-testid=new-agent-next]");
    expect(ondone).toHaveBeenCalledOnce();
  });
});

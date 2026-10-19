// @vitest-environment happy-dom

// Owner report: on a detected live meeting, the "Record as" company list
// opened inside the live card and was cut to the card's height, so only one
// or two companies showed. The list must open outside the card, show every
// company, and keep keyboard and pointer behaviour.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import LiveNowCard from "./LiveNowCard.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const memberships = [
  { companyUid: "co-indigo", companyName: "Indigo", status: "active" },
  { companyUid: "co-holler", companyName: "Holler", status: "active" },
  { companyUid: "co-frogbear", companyName: "Frogbear", status: "active" },
  { companyUid: "co-wargames", companyName: "Wargames", status: "active" },
];

async function mountCard(oncompany = vi.fn()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(LiveNowCard, {
    target: host,
    props: {
      meeting: {
        windowId: "zoom-window-1",
        meetingUrl: "recall-window:zoom-window-1",
        platform: "zoom",
        detectedAt: new Date().toISOString(),
        state: "detected",
        companyUid: null,
        summary: "HQ Dev Standup",
      },
      memberships,
      onstart: () => {},
      onstop: () => {},
      oncompany,
    },
  });
  const button = await vi.waitFor(() => {
    const el = host.querySelector<HTMLButtonElement>('[data-testid="live-company-select"]');
    if (!el) throw new Error("picker not loaded");
    return el;
  });
  const card = host.querySelector<HTMLElement>('[data-testid="meetings-live-now"]')!;
  return { button, card, oncompany };
}

async function openMenu(button: HTMLButtonElement): Promise<HTMLElement> {
  button.click();
  await tick();
  await tick();
  const menu = document.querySelector<HTMLElement>('[data-testid="live-company-select-menu"]');
  expect(menu).not.toBeNull();
  return menu!;
}

describe("LiveNowCard company picker", () => {
  it("opens the list outside the live card, fixed to the picker, with every company", async () => {
    const { button, card } = await mountCard();
    const menu = await openMenu(button);

    expect(card.contains(menu)).toBe(false);
    expect(menu.style.position).toBe("fixed");
    const labels = [...menu.querySelectorAll('[role="option"] .dd-label')].map((o) => o.textContent);
    expect(labels).toEqual(["Personal", "Indigo", "Holler", "Frogbear", "Wargames"]);
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("picks a company with the arrow keys and Enter, then returns focus to the picker", async () => {
    const { button, oncompany } = await mountCard();
    const menu = await openMenu(button);
    expect(document.activeElement).toBe(menu);

    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();

    expect(oncompany).toHaveBeenCalledWith("zoom-window-1", "co-holler");
    expect(document.querySelector('[data-testid="live-company-select-menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("picks a company by pointer even though the list is outside the card", async () => {
    const { button, oncompany } = await mountCard();
    const menu = await openMenu(button);
    const option = menu.querySelector<HTMLElement>('[data-value="co-wargames"]')!;

    option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await tick();
    expect(document.querySelector('[data-testid="live-company-select-menu"]')).not.toBeNull();
    option.click();
    await tick();

    expect(oncompany).toHaveBeenCalledWith("zoom-window-1", "co-wargames");
  });

  it("closes on Escape and on a click outside, removing the portaled list", async () => {
    const { button, oncompany } = await mountCard();
    let menu = await openMenu(button);
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(document.querySelector('[data-testid="live-company-select-menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);

    menu = await openMenu(button);
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await tick();
    expect(document.querySelector('[data-testid="live-company-select-menu"]')).toBeNull();
    expect(oncompany).not.toHaveBeenCalled();
  });
});

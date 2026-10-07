// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import RecipientPicker from "./RecipientPicker.svelte";
import type { RecipientItem } from "./recipient-picker-model.js";

const ITEMS: RecipientItem[] = [
  { id: "dm:prs_ada", kind: "person", name: "Ada Lovelace", subtitle: "ada@getindigo.ai", companyUid: "cmp_indigo", principalUid: "prs_ada", lastActivityAt: 9, online: true },
  { id: "dm:prs_alan", kind: "person", name: "Alan Turing", subtitle: "alan@getindigo.ai", companyUid: "cmp_indigo", principalUid: "prs_alan", lastActivityAt: 0 },
  { id: "dm:agt_izzy", kind: "bot", name: "Izzy", companyUid: "cmp_indigo", principalUid: "agt_izzy", lastActivityAt: 0, hint: "ready" },
  { id: "ch:welcome", kind: "channel", name: "welcome", companyUid: "cmp_indigo", channelId: "welcome", lastActivityAt: 0, hint: "12 members" },
];

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function mountPicker(props: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const onsubmit = vi.fn();
  const oncancel = vi.fn();
  const onSelect = vi.fn();
  const onscopechange = vi.fn();
  component = mount(RecipientPicker, {
    target: host,
    props: {
      items: ITEMS,
      scopes: [
        { id: "", label: "This conversation" },
        { id: "cmp_indigo", label: "Indigo" },
        { id: "cmp_other", label: "Other" },
      ],
      onsubmit,
      oncancel,
      onSelect,
      onscopechange,
      ...props,
    } as never,
  });
  flushSync();
  const input = host.querySelector<HTMLInputElement>('[data-testid="recipient-query"]')!;
  const type = (value: string) => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
  };
  const key = (k: string, init: KeyboardEventInit = {}) => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
    flushSync();
  };
  const chips = () => [...host.querySelectorAll<HTMLElement>('[data-testid="recipient-chip"]')].map((c) => c.dataset.id);
  const submit = () => host.querySelector<HTMLButtonElement>('[data-testid="recipient-submit"]')!;
  const sections = () => [...host.querySelectorAll<HTMLElement>('[data-testid="recipient-section"]')].map((s) => s.dataset.section);
  const row = (id: string) => host.querySelector<HTMLElement>(`[data-testid="recipient-row"][data-id="${id}"]`);
  return { input, type, key, chips, submit, sections, row, onsubmit, oncancel, onSelect, onscopechange };
}

describe("RecipientPicker", () => {
  it("groups rows Recent, Channels, People, Bots with avatars, presence, subtitles, and tags", () => {
    const { sections, row } = mountPicker();
    expect(sections()).toEqual(["recent", "channels", "people", "bots"]);
    const ada = row("dm:prs_ada")!;
    expect(ada.dataset.section).toBe("recent");
    expect(ada.textContent).toContain("ada@getindigo.ai");
    expect(ada.querySelector('[data-testid="avatar-presence"]')).not.toBeNull();
    expect(row("dm:prs_alan")!.querySelector('[data-testid="avatar-presence"]')).toBeNull();
    expect(row("dm:agt_izzy")!.querySelector('[data-testid="avatar"]')?.getAttribute("data-face")).not.toBe("initials");
    expect(row("dm:agt_izzy")!.textContent).toContain("ready");
    expect(row("dm:prs_alan")!.textContent).toContain("Person");
    expect(row("ch:welcome")!.textContent).toContain("#welcome");
    expect(row("ch:welcome")!.textContent).toContain("12 members");
  });

  it("ranks the best match first and highlights the matched text", () => {
    const { type } = mountPicker();
    type("tur");
    const first = host.querySelector<HTMLElement>('[data-testid="recipient-row"]')!;
    expect(first.dataset.id).toBe("dm:prs_alan");
    expect(first.querySelector("mark")?.textContent).toBe("Tur");
  });

  it("disables the primary until something is picked, then counts in the label", () => {
    const { key, type, submit, chips } = mountPicker();
    expect(submit().disabled).toBe(true);
    expect(submit().textContent?.trim()).toBe("Start conversation");
    type("ada");
    key("Enter");
    type("alan");
    key("Enter");
    expect(chips()).toEqual(["dm:prs_ada", "dm:prs_alan"]);
    expect(submit().disabled).toBe(false);
    expect(submit().textContent?.trim()).toBe("Start conversation with 2");
  });

  it("moves with arrows, adds with Enter, and removes the last chip with Backspace", () => {
    const { key, chips, input, onSelect } = mountPicker();
    key("ArrowDown");
    const active = host.querySelector<HTMLElement>(`#${input.getAttribute("aria-activedescendant")}`)!;
    expect(active.classList.contains("highlight")).toBe(true);
    expect(active.dataset.id).toBe("ch:welcome");
    key("Enter");
    expect(chips()).toEqual(["ch:welcome"]);
    expect(onSelect).toHaveBeenLastCalledWith(["ch:welcome"], [expect.objectContaining({ id: "ch:welcome" })]);
    expect(host.querySelector('[data-id="ch:welcome"][role="option"]')?.getAttribute("aria-selected")).toBe("true");
    key("Backspace");
    expect(chips()).toEqual([]);
  });

  it("toggles a row off on a second click and removes a chip from its x", () => {
    const { row, chips } = mountPicker();
    row("dm:agt_izzy")!.click();
    flushSync();
    expect(chips()).toEqual(["dm:agt_izzy"]);
    row("dm:agt_izzy")!.click();
    flushSync();
    expect(chips()).toEqual([]);
    row("dm:agt_izzy")!.click();
    flushSync();
    host.querySelector<HTMLButtonElement>('[aria-label="Remove Izzy"]')!.click();
    flushSync();
    expect(chips()).toEqual([]);
  });

  it("keeps one target in single-select mode", () => {
    const { type, key, chips } = mountPicker({ multiple: false });
    type("ada");
    key("Enter");
    type("alan");
    key("Enter");
    expect(chips()).toEqual(["dm:prs_alan"]);
  });

  it("replaces people with a channel when channelOpens is set", () => {
    const { type, key, chips } = mountPicker({ channelOpens: true });
    type("ada");
    key("Enter");
    type("welcome");
    key("Enter");
    expect(chips()).toEqual(["ch:welcome"]);
  });

  it("switches scope with ⌥→ and from the chip menu", () => {
    const { key, onscopechange } = mountPicker();
    const chip = host.querySelector<HTMLButtonElement>('[data-testid="recipient-scope"]')!;
    expect(chip.textContent?.trim()).toBe("This conversation");
    key("ArrowRight", { altKey: true });
    expect(chip.textContent?.trim()).toBe("Indigo");
    expect(onscopechange).toHaveBeenLastCalledWith("cmp_indigo");
    chip.click();
    flushSync();
    host.querySelector<HTMLButtonElement>('[data-testid="recipient-scope-menu"] [data-value="cmp_other"]')!.click();
    flushSync();
    expect(chip.textContent?.trim()).toBe("Other");
    expect(onscopechange).toHaveBeenLastCalledWith("cmp_other");
  });

  it("submits with ⌘↵ only once something is picked, and Escape closes the menu before cancelling", () => {
    const { key, type, onsubmit, oncancel } = mountPicker();
    key("Enter", { metaKey: true });
    expect(onsubmit).not.toHaveBeenCalled();
    type("ada");
    key("Enter");
    key("Enter", { metaKey: true });
    expect(onsubmit).toHaveBeenCalledWith(["dm:prs_ada"]);
    host.querySelector<HTMLButtonElement>('[data-testid="recipient-scope"]')!.click();
    flushSync();
    key("Escape");
    expect(oncancel).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="recipient-scope-menu"]')).toBeNull();
    key("Escape");
    expect(oncancel).toHaveBeenCalled();
  });

  it("labels the primary by mode and renders the quoted message card", () => {
    mountPicker({
      mode: "forward",
      quote: { authorName: "Corey Epstein", time: "14:05", origin: "in #welcome", body: "please add them to testflight" },
    });
    expect(host.querySelector('[data-testid="recipient-submit"]')!.textContent?.trim()).toBe("Forward");
    const quote = host.querySelector('[data-testid="recipient-quote"]')!;
    expect(quote.textContent).toContain("Corey Epstein");
    expect(quote.textContent).toContain("14:05");
    expect(quote.textContent).toContain("in #welcome");
    expect(quote.querySelector('[data-testid="avatar"]')).not.toBeNull();
  });

  it("hides its footer for hosts that own one, but still submits on ⌘↵", () => {
    const { key, onsubmit } = mountPicker({ hideFooter: true });
    expect(host.querySelector('[data-testid="recipient-submit"]')).toBeNull();
    key("Enter", { metaKey: true });
    expect(onsubmit).toHaveBeenCalledWith([]);
  });

  it("in dropdown form shows the list only while typing and offers a typed email", () => {
    const { type, key, chips } = mountPicker({ presentation: "dropdown", multiple: false, freeEmail: true, scopes: [] });
    expect(host.querySelector('[data-testid="recipient-list"]')).toBeNull();
    type("new@person.io");
    expect(host.querySelector<HTMLElement>('[data-testid="recipient-row"]')!.dataset.id).toBe("email:new@person.io");
    key("Enter");
    expect(chips()).toEqual(["email:new@person.io"]);
    expect(host.querySelector('[data-testid="recipient-list"]')).toBeNull();
  });

  it("shows a plain error with Retry, never raw transport text", () => {
    const onretry = vi.fn();
    mountPicker({ items: [], error: "People couldn’t be loaded.", onretry });
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("People couldn’t be loaded.");
    alert.querySelector("button")!.click();
    expect(onretry).toHaveBeenCalled();
  });
});

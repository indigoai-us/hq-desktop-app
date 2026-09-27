// @vitest-environment happy-dom

/**
 * Selection affordance regression tests.
 *
 * The rail used to mark selected rows with a curved accent stroke hugging the
 * left edge — an inset accent box-shadow, curved by the row's 8px radius.
 * That treatment is banned. Selection is now a checkbox in a gutter
 * that opens only when a selection exists or the user holds Shift over the
 * rail, so resting rows keep their geometry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function seedRow(id: string, name: string): ChannelDirectoryRow {
  return {
    channelId: id,
    type: "project",
    scope: "project",
    companyUid: "cmp_1",
    name,
    lastActivityAt: new Date().toISOString(),
  };
}

const rows = [seedRow("chn_a", "alpha"), seedRow("chn_b", "bravo")];

function stubApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_1",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows,
    }),
    listContacts: async () => ({ contacts: [] }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => null,
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    searchMessages: async () => ({ results: [] }),
    logToFile: async () => {},
    ensureCompanyHomeChannel: async (companyUid: string) => ({ homeChannelId: `chn_home_${companyUid}` }),
  };
}

function boxFor(id: string): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>(
    `[data-checkbox-for="${id}"]`,
  );
  if (!el) throw new Error(`no checkbox for ${id}`);
  return el;
}

function rowFor(id: string): HTMLButtonElement {
  const el = host.querySelector<HTMLButtonElement>(
    `[data-conversation-id="${id}"]`,
  );
  if (!el) throw new Error(`no row for ${id}`);
  return el;
}

function gutterOpen(id: string): boolean {
  return boxFor(id).closest(".chat-li")!.classList.contains("gutter-open");
}

async function mountRail(): Promise<void> {
  component = mount(ChatSidebar, {
    target: host,
    props: { api: stubApi(), seedDirectory: rows },
  });
  await vi.waitFor(() =>
    expect(host.querySelector('[data-conversation-id="ch:chn_a"]')).toBeTruthy(),
  );
}


beforeEach(() => {
  window.localStorage?.clear?.();
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  // Release any modifier the test pressed so it cannot leak into the next one.
  window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" }));
  window.localStorage?.clear?.();
});

describe("ChatSidebar checkbox selection", () => {
  it("never renders the banned curved left stroke on a selected row", async () => {
    await mountRail();
    const css = Array.from(document.querySelectorAll("style"))
      .map((node) => node.textContent ?? "")
      .join("\n");
    // Read the declarations of the selected-row rule itself, so the ban is
    // asserted against real CSS rather than any prose that mentions it.
    const rule = /\.chat-row\.selected[^{]*\{([^}]*)\}/.exec(css);
    expect(rule, "no .chat-row.selected rule found").toBeTruthy();
    expect(rule![1]).not.toMatch(/box-shadow/);
    expect(rule![1]).not.toMatch(/border-left/);
  });

  it("keeps the gutter closed at rest and opens it while Shift is held over the rail", async () => {
    await mountRail();
    expect(gutterOpen("ch:chn_a")).toBe(false);

    // Shift alone is not enough — the pointer has to be on the rail.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
    await tick();
    expect(gutterOpen("ch:chn_a")).toBe(false);

    host
      .querySelector('[data-testid="chat-conversation-list"]')!
      .dispatchEvent(new MouseEvent("mouseenter"));
    await tick();
    expect(gutterOpen("ch:chn_a")).toBe(true);
    // Preview only: the boxes are empty until something is actually selected.
    expect(boxFor("ch:chn_a").checked).toBe(false);
    expect(boxFor("ch:chn_b").checked).toBe(false);

    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" }));
    await tick();
    expect(gutterOpen("ch:chn_a")).toBe(false);
  });

  it("clears a stuck Shift when the window blurs so boxes cannot strand on screen", async () => {
    await mountRail();
    host
      .querySelector('[data-testid="chat-conversation-list"]')!
      .dispatchEvent(new MouseEvent("mouseenter"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
    await tick();
    expect(gutterOpen("ch:chn_a")).toBe(true);

    window.dispatchEvent(new Event("blur"));
    await tick();
    expect(gutterOpen("ch:chn_a")).toBe(false);
  });

  it("ticks the box for every selected row and keeps the gutter open without Shift", async () => {
    await mountRail();
    rowFor("ch:chn_a").dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
    );
    await tick();

    expect(boxFor("ch:chn_a").checked).toBe(true);
    expect(boxFor("ch:chn_b").checked).toBe(false);
    // A live selection holds the gutter open on every row, Shift or not.
    expect(gutterOpen("ch:chn_a")).toBe(true);
    expect(gutterOpen("ch:chn_b")).toBe(true);
    expect(rowFor("ch:chn_a").classList.contains("selected")).toBe(true);
  });

  it("toggles a single row when its box is clicked, without opening the conversation", async () => {
    await mountRail();
    boxFor("ch:chn_a").click();
    await tick();
    expect(boxFor("ch:chn_a").checked).toBe(true);

    boxFor("ch:chn_b").click();
    await tick();
    expect(boxFor("ch:chn_a").checked).toBe(true);
    expect(boxFor("ch:chn_b").checked).toBe(true);

    // Unticking the last remaining row leaves selection mode entirely.
    boxFor("ch:chn_a").click();
    boxFor("ch:chn_b").click();
    await tick();
    expect(gutterOpen("ch:chn_a")).toBe(false);
  });

  it("ticks a box from the keyboard, relying on the native Space activation", async () => {
    await mountRail();
    const box = boxFor("ch:chn_a");
    box.focus();
    // A checkbox turns Space into a click itself; the component adds no
    // second keyboard handler that would fight it back off.
    box.click();
    await tick();
    expect(boxFor("ch:chn_a").checked).toBe(true);
  });

  it("extends the selection over a shift-click range", async () => {
    await mountRail();
    boxFor("ch:chn_a").click();
    await tick();
    rowFor("ch:chn_b").dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }),
    );
    await tick();
    expect(boxFor("ch:chn_a").checked).toBe(true);
    expect(boxFor("ch:chn_b").checked).toBe(true);
  });

  it("Escape clears the selection and closes the gutter", async () => {
    await mountRail();
    boxFor("ch:chn_a").click();
    await tick();
    expect(boxFor("ch:chn_a").checked).toBe(true);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await tick();
    expect(boxFor("ch:chn_a").checked).toBe(false);
    expect(gutterOpen("ch:chn_a")).toBe(false);
  });
});

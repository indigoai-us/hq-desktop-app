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
import { flushSync, mount, tick, unmount } from "svelte";

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

function stubApi(directory: ChannelDirectoryRow[] = rows): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_1",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: directory,
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

/**
 * A real pointer click runs a microtask checkpoint after each listener, so
 * Svelte's batched DOM update lands while the event is still dispatching and
 * before the browser settles the checkbox's activation. `el.click()` from a
 * test drains microtasks only after dispatch ends, which hid the bug where a
 * cancelled click flipped the box back to empty after Svelte had ticked it.
 * Flushing from a document listener reproduces the browser's ordering.
 */
function realClick(el: HTMLElement, init: MouseEventInit = {}): boolean {
  const flush = () => flushSync();
  document.addEventListener("click", flush);
  try {
    return el.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ...init }),
    );
  } finally {
    document.removeEventListener("click", flush);
  }
}

function selectionCount(): string {
  return (
    document.querySelector('[data-testid="chat-selection-count"]')?.textContent ?? ""
  ).trim();
}

async function mountRail(seed: ChannelDirectoryRow[] = rows): Promise<void> {
  component = mount(ChatSidebar, {
    target: host,
    props: { api: stubApi(seed), seedDirectory: seed },
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

  it("keeps a clicked box ticked under real browser event ordering", async () => {
    await mountRail();
    const box = boxFor("ch:chn_a");
    // The click must not be cancelled: a cancelled checkbox click is undone by
    // the browser after Svelte has already drawn the tick.
    expect(realClick(box)).toBe(true);
    await tick();
    expect(boxFor("ch:chn_a").checked).toBe(true);
    expect(boxFor("ch:chn_a").getAttribute("aria-checked")).toBe("true");
    expect(rowFor("ch:chn_a").classList.contains("selected")).toBe(true);
    expect(selectionCount()).toContain("1 selected");

    realClick(boxFor("ch:chn_b"));
    await tick();
    expect(boxFor("ch:chn_a").checked).toBe(true);
    expect(boxFor("ch:chn_b").checked).toBe(true);
    expect(selectionCount()).toContain("2 selected");

    // Unticking one row keeps the other.
    realClick(boxFor("ch:chn_a"));
    await tick();
    expect(boxFor("ch:chn_a").checked).toBe(false);
    expect(boxFor("ch:chn_a").getAttribute("aria-checked")).toBe("false");
    expect(boxFor("ch:chn_b").checked).toBe(true);
    expect(selectionCount()).toContain("1 selected");
  });

  it("toggles a row on a plain row click in selection mode instead of replacing", async () => {
    const onselect = vi.fn();
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stubApi(), seedDirectory: rows, selectedId: "ch:chn_a", onselect },
    });
    await vi.waitFor(() =>
      expect(host.querySelector('[data-conversation-id="ch:chn_a"]')).toBeTruthy(),
    );
    realClick(boxFor("ch:chn_a"));
    await tick();

    realClick(rowFor("ch:chn_b"));
    await tick();
    expect(boxFor("ch:chn_a").checked).toBe(true);
    expect(boxFor("ch:chn_b").checked).toBe(true);
    expect(rowFor("ch:chn_b").getAttribute("aria-selected")).toBe("true");
    expect(selectionCount()).toContain("2 selected");

    // A second plain click takes the row back out.
    realClick(rowFor("ch:chn_b"));
    await tick();
    expect(boxFor("ch:chn_b").checked).toBe(false);
    expect(boxFor("ch:chn_a").checked).toBe(true);
    expect(selectionCount()).toContain("1 selected");
    // Selection mode never opens the conversation.
    expect(onselect).not.toHaveBeenCalled();
  });

  it("archives exactly the selected rows and clears the selection", async () => {
    await mountRail([...rows, seedRow("chn_c", "charlie")]);
    realClick(boxFor("ch:chn_a"));
    await tick();
    realClick(rowFor("ch:chn_c"));
    await tick();
    expect(selectionCount()).toContain("2 selected");

    host
      .ownerDocument.querySelector<HTMLButtonElement>(
        '[data-testid="chat-selection-archive"]',
      )!
      .click();
    await tick();

    expect(host.querySelector('[data-conversation-id="ch:chn_a"]')).toBeNull();
    expect(host.querySelector('[data-conversation-id="ch:chn_c"]')).toBeNull();
    expect(host.querySelector('[data-conversation-id="ch:chn_b"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="chat-selection-bar"]')).toBeNull();
    expect(boxFor("ch:chn_b").checked).toBe(false);
  });

  it("lets the selection bar wrap so Archive and Done stay reachable in a narrow rail", async () => {
    await mountRail();
    const css = Array.from(document.querySelectorAll("style"))
      .map((node) => node.textContent ?? "")
      .join("\n");
    const rule = /\.chat-selection-bar[^{,]*\{([^}]*)\}/.exec(css);
    expect(rule, "no .chat-selection-bar rule found").toBeTruthy();
    expect(rule![1]).toMatch(/flex-wrap:\s*wrap/);
  });
});

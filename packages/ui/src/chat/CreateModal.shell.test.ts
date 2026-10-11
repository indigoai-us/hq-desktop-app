// @vitest-environment happy-dom

/**
 * Design contract for the create modal's shell (PR #772 port onto the
 * console-rail beta). Visual only: the card hangs from the top on a lighter
 * scrim; it is a 560px, 12px-radius card on the beta's overlay surface (the
 * OWNER-006 guard keeps overlay files free of blur and off --panel-bg); the
 * title is visible with a labelled "To" row under it; close/back are 24px
 * Phosphor icon buttons; chips are 6px-radius; and the scope picker is the
 * shared Dropdown sized to its value rather than stretched across the row.
 * The beta's Messages type scale (13px/500 title, sentence-case group labels)
 * is kept. Production's flows are untouched.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import CreateModal from "./CreateModal.svelte";
import { dropdownButton } from "../test-support/dropdown.js";
import type { ChatSidebarApi } from "./chat-api.js";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "CreateModal.svelte"),
  "utf8",
);
const css = src.slice(src.indexOf("<style>"));

/** Body of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|\\n)\\s*${esc}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`rule not found: ${selector}`);
  return m[1];
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function stubApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "createmodalcursor000000000000000000",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: [],
    }),
    listContacts: async () => ({ contacts: [] }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => null,
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    searchMessages: async () => ({ results: [] }),
    logToFile: async () => {},
    ensureCompanyHomeChannel: async (companyUid: string) => ({
      homeChannelId: `chn_home_${companyUid}`,
    }),
    createChannel: async () => ({ channelId: "chn_new" }),
    addChannelMember: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
  } as ChatSidebarApi;
}

const $ = <T extends Element>(selector: string): T | null =>
  document.querySelector<T>(selector);

function open() {
  component = mount(CreateModal, {
    target: host,
    props: {
      api: stubApi(),
      rows: [],
      contacts: [],
      scopeCompanies: [
        { companyUid: "cmp_indigo", label: "Indigo" },
        { companyUid: "cmp_acme", label: "Acme" },
      ],
      activeScope: "cmp_indigo",
      self: { uid: "prs_me", displayName: "Stefan" },
      onclose: () => {},
      onpick: () => {},
      oncreated: () => {},
    },
  });
}

async function gotoCreate(name: string): Promise<void> {
  const input = $<HTMLInputElement>('[data-testid="chat-create-query"]')!;
  input.value = name;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(150);
  await tick();
  $<HTMLButtonElement>('[data-testid="chat-create-channel-row"]')?.click();
  await tick();
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.localStorage?.clear?.();
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document
    .querySelectorAll('[data-testid="chat-create-modal"]')
    .forEach((node) => node.remove());
  vi.useRealTimers();
});

describe("CreateModal shell: markup", () => {
  it("shows a visible title and a labelled To row carrying the finder field", async () => {
    open();
    await tick();
    const title = $<HTMLElement>("#create-modal-title")!;
    expect(title.classList.contains("create-title")).toBe(true);
    expect(title.classList.contains("create-sr")).toBe(false);
    expect(title.textContent?.trim().length ?? 0).toBeGreaterThan(0);

    const to = $<HTMLElement>(".create-to")!;
    expect(to).toBeTruthy();
    expect(to.querySelector(".create-to-label")?.textContent?.trim()).toBe("To");
    expect(to.querySelector('[data-testid="chat-create-query"]')).toBeTruthy();
    // The field no longer sits in the title's slot.
    expect(
      $(".create-head")!.querySelector('[data-testid="chat-create-query"]'),
    ).toBeNull();
  });

  it("draws close and back as Phosphor icons, not the × and ‹ text glyphs", async () => {
    open();
    await tick();
    const close = $<HTMLButtonElement>(".create-close")!;
    expect(close.querySelector('svg[data-rail-icon="x"]')).toBeTruthy();
    expect(close.textContent?.trim()).toBe("");
    expect(close.getAttribute("aria-label")).toBe("Close");

    await gotoCreate("Growth");
    const back = $<HTMLButtonElement>('[data-testid="chat-create-back"]')!;
    expect(back.querySelector('svg[data-rail-icon="caret-left"]')).toBeTruthy();
    expect(back.textContent?.trim()).toBe("");
  });

  it("sizes the scope picker to its value with a caret instead of stretching it", async () => {
    open();
    await tick();
    await gotoCreate("Growth");
    const button = await dropdownButton(document, "chat-channel-scope");
    const root = button.closest(".dd")!;
    expect(root).toBeTruthy();
    // `block` stretches the shared Dropdown across the row like a text field.
    expect(root.classList.contains("block")).toBe(false);
    expect(button.querySelector('svg[data-rail-icon="chevron-down"]')).toBeTruthy();
  });
});

describe("CreateModal shell: styles", () => {
  it("hangs the card 72px from the top on a lighter 0.28 scrim", () => {
    const overlay = rule(".create-overlay");
    expect(overlay).toMatch(/align-items:\s*flex-start/);
    expect(overlay).toMatch(/padding:\s*72px\b/);
    expect(overlay).toMatch(/background:\s*rgba\(0,\s*0,\s*0,\s*0\.28\)/);
  });

  it("is a 560px, 12px-radius card on the overlay surface", () => {
    const card = rule(".create-card");
    expect(card).toMatch(/width:\s*min\(560px/);
    expect(card).toMatch(/border-radius:\s*12px/);
    expect(card).toMatch(/background:\s*var\(--overlay-bg\)/);
  });

  it("uses 24px icon buttons and 6px chips", () => {
    const btn = rule(".create-back,\n  .create-close");
    expect(btn).toMatch(/width:\s*24px/);
    expect(btn).toMatch(/height:\s*24px/);
    expect(rule(".create-chip")).toMatch(/border-radius:\s*6px/);
  });

  it("keeps the focus ring on close/back (the focus list no longer swallows .create-kind)", () => {
    const focus = rule(
      ".create-back:focus-visible,\n  .create-close:focus-visible,\n  .create-row:focus-visible,\n  .create-submit:focus-visible,\n  .create-inline-btn:focus-visible,\n  .create-chip-x:focus-visible",
    );
    expect(focus).toMatch(/outline:\s*2px solid/);
    expect(focus).not.toMatch(/display:/);
  });
});

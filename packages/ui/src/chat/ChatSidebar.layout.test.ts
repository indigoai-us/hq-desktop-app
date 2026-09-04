// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import { createFixtureChatSidebarApi } from "../shell/fixtures.js";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "ChatSidebar.svelte"),
  "utf8",
);

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("ChatSidebar identity footer layout", () => {
  it("does not treat right-click as pin (that shuffled the web rail)", () => {
    expect(src).toMatch(/oncontextmenu=\{\(e\) => openContextMenu\(row, e\)\}/);
    expect(src).not.toMatch(/oncontextmenu=\{[^}]*handlePin/);
    expect(src).toMatch(/data-testid="chat-pin"/);
  });

  it("defaults the rail to member projects, chats, and DMs", () => {
    expect(src).toMatch(/data-testid="chat-filter-mine"/);
    expect(src).toMatch(/loadShowFilter\(storage\)/);
    expect(src).toMatch(/browseOnly:\s*true/);
  });

  it("sizes the filter popover for the rail and keeps it in the viewport", () => {
    expect(src).toContain("FILTER_POPOVER_MAX_PX");
    expect(src).toContain("FILTER_POPOVER_RAIL_OVERHANG_PX");
    expect(src).toContain('placement: "bottom-end"');
    expect(src).toMatch(
      /max-width:\s*min\(360px,\s*calc\(100vw - 16px\)\)/,
    );
    expect(src).toMatch(
      /\.chat-filter-row\s*\{[\s\S]*?font-size:\s*var\(--type-metadata,\s*13px\)/,
    );
  });

  it("uses border-box so rail padding cannot overflow the parent height", () => {
    const block = src.match(/\.chat-sidebar\s*\{[^}]+\}/);
    expect(block?.[0]).toMatch(/box-sizing:\s*border-box/);
    expect(block?.[0]).toMatch(/align-self:\s*stretch/);
    expect(block?.[0]).not.toMatch(/height:\s*100%;/);
  });

  it("renders the signed-in identity card inside the rail", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: createFixtureChatSidebarApi(),
        accountLabel: "Stefan Johnson",
        accountInitials: "SJ",
        self: { uid: "prs_test", displayName: "Stefan Johnson" },
      },
    });

    const rail = host.querySelector(".chat-sidebar");
    const card = host.querySelector('[data-testid="chat-user-card"]');
    expect(rail).toBeTruthy();
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain("Stefan");
    expect(card?.textContent).toMatch(/Signed in/i);
    // happy-dom does not apply Svelte scoped CSS, so box-sizing is
    // asserted from source in the test above — here we lock the DOM
    // contract the live apps rely on.
    expect(card?.parentElement?.className).toMatch(/chat-footer/);
  });
});

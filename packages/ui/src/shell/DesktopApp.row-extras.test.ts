// @vitest-environment happy-dom

/**
 * `rowExtras` — the generic host decoration for sidebar rows.
 *
 * A vendored local divergence (see `packages/VENDORED.md`): Sync marks project
 * channels with the agent sessions bound to them, and the shell must show a
 * badge, a hover card and a row action WITHOUT learning what they mean. So the
 * contract proved here is deliberately row-agnostic — a badge after the title,
 * a host component mounted with the hovered row, a context-menu action that
 * runs the host's callback (here: a navigation into an `extraPages` page), and
 * nothing at all on rows the host returns `null` for.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import ExtraPageProbe from "./ExtraPageProbe.test.svelte";
import RowExtrasProbe from "./RowExtrasProbe.test.svelte";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import type { ChatSidebarApi } from "../chat/chat-api.js";
import { dispatchEmbeddedNavigation } from "./embedded-navigation.js";
import type { ChannelDirectoryRow } from "../chat/channel-directory-reconciler.js";
import type { ConversationRowExtras, RowExtrasResolver } from "../chat/row-extras.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

function webAdapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok(null),
      fetchDm: async () => ok(null),
    },
  } as unknown as PlatformAdapter;
}

const memoryStorage = installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document
    .querySelectorAll(
      '[data-testid="chat-context-menu"], [data-testid="chat-row-hover-card"]',
    )
    .forEach((n) => n.remove());
  memoryStorage.clear();
});

// Real "now" so the rows land in TODAY and are painted (day grouping uses the
// process clock).
const now = () => new Date().toISOString();

/** A project channel row (has sessions) and a plain company channel (none). */
const projectRow: ChannelDirectoryRow = {
  channelId: "chn_launch",
  type: "project",
  scope: "project",
  companyUid: "cmp_1",
  projectId: "launch",
  name: "p-launch",
  lastActivityAt: now(),
};
const plainRow: ChannelDirectoryRow = {
  channelId: "chn_general",
  type: "chat",
  scope: "company",
  companyUid: "cmp_1",
  name: "general",
  lastActivityAt: now(),
};

/** A directory-backed sidebar API: exactly the two rows above, nothing else. */
function directoryApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_1",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: [projectRow, plainRow],
    }),
    listContacts: async () => ({ contacts: [] }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => null,
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    searchMessages: async () => ({ results: [] }),
  };
}

const probePages = {
  probe: { label: "Probe", detail: "A host page", component: ExtraPageProbe },
};

/** Decorates ONLY the project row, the way a host would from its own data. */
function projectRowExtras(onselect: () => void): RowExtrasResolver {
  return (row) => {
    if (row.channelId !== "chn_launch") return null;
    const extras: ConversationRowExtras = {
      badge: "2 sessions",
      hoverCard: RowExtrasProbe,
      actions: [{ id: "new-session", label: "New session", onselect }],
    };
    return extras;
  };
}

async function mountShell(rowExtras: RowExtrasResolver | null): Promise<void> {
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: webAdapter(),
      sidebarApi: directoryApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: {
        uid: "prs_test",
        displayName: "Stefan Johnson",
        email: "stefan@example.com",
      },
      coreFixtures: false,
      seedDirectory: [projectRow, plainRow],
      extraPages: probePages,
      rowExtras,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

function rowButton(id: string): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(`[data-conversation-id="${id}"]`);
  if (!button) throw new Error(`row ${id} is not painted`);
  return button;
}

async function waitForRows(): Promise<void> {
  await vi.waitFor(() => {
    rowButton("ch:chn_launch");
    rowButton("ch:chn_general");
  });
}

describe("DesktopApp rowExtras", () => {
  it("shows the host badge after the title, only on rows the host decorates", async () => {
    await mountShell(projectRowExtras(() => {}));
    await waitForRows();

    const decorated = rowButton("ch:chn_launch");
    const badge = decorated.querySelector('[data-testid="chat-row-extra-badge"]');
    expect(badge?.textContent?.trim()).toBe("2 sessions");
    // The badge follows the title, not the glyph.
    expect(decorated.textContent?.indexOf("p-launch")).toBeLessThan(
      decorated.textContent?.indexOf("2 sessions") ?? -1,
    );

    const plain = rowButton("ch:chn_general");
    expect(plain.querySelector('[data-testid="chat-row-extra-badge"]')).toBeNull();
  });

  it("mounts the host hover card with the hovered row, and only for decorated rows", async () => {
    await mountShell(projectRowExtras(() => {}));
    await waitForRows();

    // Hovering the plain row shows nothing: the host returned null for it.
    rowButton("ch:chn_general")
      .closest(".chat-li")
      ?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    await tick();
    expect(document.querySelector('[data-testid="chat-row-hover-card"]')).toBeNull();

    rowButton("ch:chn_launch")
      .closest(".chat-li")
      ?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    await tick();

    const card = document.querySelector<HTMLElement>('[data-testid="chat-row-hover-card"]');
    expect(card).toBeTruthy();
    expect(card?.getAttribute("data-conversation-id")).toBe("ch:chn_launch");
    const probe = card?.querySelector('[data-testid="row-extras-probe"]');
    expect(probe?.getAttribute("data-row-id")).toBe("ch:chn_launch");
    expect(probe?.textContent).toContain("Sessions for p-launch");

    // Leaving the row hides the card after the grace delay that lets the
    // pointer cross into it.
    rowButton("ch:chn_launch")
      .closest(".chat-li")
      ?.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
    await new Promise((resolve) => setTimeout(resolve, 260));
    await tick();
    expect(document.querySelector('[data-testid="chat-row-hover-card"]')).toBeNull();
  });

  it("appends the host action to the row's context menu and runs it — here, into an extra page", async () => {
    await mountShell(
      projectRowExtras(() =>
        dispatchEmbeddedNavigation({
          kind: "extra",
          page: "probe",
          param: "new?company=indigo&project=launch",
        }),
      ),
    );
    await waitForRows();

    rowButton("ch:chn_launch").dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }),
    );
    await tick();
    const menu = document.querySelector('[data-testid="chat-context-menu"]');
    expect(menu).toBeTruthy();
    // The shell's own item is still first; the host's follows it.
    expect(menu?.querySelector('[data-testid="chat-context-pin"]')).toBeTruthy();
    const action = menu?.querySelector<HTMLButtonElement>(
      '[data-testid="chat-context-action-new-session"]',
    );
    expect(action?.textContent?.trim()).toBe("New session");

    action?.click();
    await tick();
    await tick();

    // The menu closed and the host's callback navigated the shell.
    expect(document.querySelector('[data-testid="chat-context-menu"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="extra-page-host"]')?.getAttribute("data-page"),
    ).toBe("probe");
    expect(
      host.querySelector('[data-testid="extra-page-probe-param"]')?.textContent,
    ).toBe("new?company=indigo&project=launch");
  });

  it("has no host action in the menu of an undecorated row", async () => {
    await mountShell(projectRowExtras(() => {}));
    await waitForRows();

    rowButton("ch:chn_general").dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }),
    );
    await tick();
    const menu = document.querySelector('[data-testid="chat-context-menu"]');
    expect(menu?.querySelector('[data-testid="chat-context-pin"]')).toBeTruthy();
    expect(menu?.querySelector('[data-testid^="chat-context-action-"]')).toBeNull();
  });

  it("changes nothing when the host registers no rowExtras", async () => {
    await mountShell(null);
    await waitForRows();

    expect(host.querySelector('[data-testid="chat-row-extra-badge"]')).toBeNull();
    rowButton("ch:chn_launch")
      .closest(".chat-li")
      ?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    await tick();
    expect(document.querySelector('[data-testid="chat-row-hover-card"]')).toBeNull();
  });
});

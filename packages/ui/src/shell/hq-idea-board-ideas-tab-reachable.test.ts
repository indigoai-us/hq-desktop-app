// @vitest-environment happy-dom

/**
 * REACHABILITY. The Idea Board shipped for weeks behind a surface no user
 * could navigate to, because every test mounted the board component directly.
 *
 * So this test refuses to import the board. It mounts the REAL shell, looks
 * for Ideas in the REAL rendered tab bar, clicks it like a user, and only then
 * asserts the board is on screen. If the tab is ever dropped from the tab
 * list, the deep-link allowlist, or the content switch, this fails.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type IdeaCapture, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

const COMPANY_ROW: ConversationRow = {
  id: "ch:chn_acme",
  kind: "channel",
  title: "acme",
  channelId: "chn_acme",
  channelScope: "company",
  companyUid: "cmp_acme",
} as ConversationRow;

const CAPTURE: IdeaCapture = {
  id: "cap_01",
  company_slug: "acme",
  kind: "quote",
  status: "extracted",
  confidence: 0.92,
  image_path: "/tmp/cap_01.png",
  ocr_text: "a stitch in time saves nine",
  extracted: { text: "A stitch in time saves nine", attribution: "Proverb" },
  tags: ["craft"],
  provenance: {
    app: "Safari",
    window_title: "Proverbs",
    url: "https://example.com/proverbs",
    captured_at: "2026-09-01T10:00:00.000Z",
    display_id: 1,
  },
  note: null,
  cited_count: 0,
  created_at: "2026-09-01T10:00:00.000Z",
  updated_at: "2026-09-01T10:00:00.000Z",
};

function adapterWithIdeas(
  captures: IdeaCapture[] = [CAPTURE],
): PlatformAdapter {
  return {
    kind: "desktop",
    // Capability flags off: this test is about NAVIGATION, so the shell's
    // optional side effects (sync polling, updates) stay dormant.
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
      getCompanyTab: async (_uid: string, tab: string) =>
        ok({ tab, companyUid: "cmp_acme", viewer: { canAct: false }, sections: [] }),
    },
    settings: {
      getSetupStatus: async () =>
        ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
    ideas: {
      listCaptures: async () => ok(captures),
      setKind: async () => ok(null),
      correctKind: async () => ok(null),
      setNote: async () => ok(null),
      setTags: async () => ok(null),
      moveCapture: async () => ok(undefined),
      deleteCapture: async () => ok(undefined),
      listCompanies: async () => ok(["acme", "other"]),
      getSettings: async () => ok({ syncEnabled: true, capturesRoot: "/tmp" }),
      filePreview: async () => ok(null),
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function mountShell(adapter: PlatformAdapter): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter,
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: {
        uid: "prs_test",
        displayName: "Stefan Johnson",
        email: "stefan@example.com",
      },
      coreFixtures: false,
      initialRow: COMPANY_ROW,
    },
  });
}

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

describe("hq-idea-board: the Ideas board is reachable from the shell", () => {
  it("renders an Ideas tab in the company channel tab bar", async () => {
    mountShell(adapterWithIdeas());
    await vi.waitFor(
      () => {
        expect(
          host.querySelector('[data-testid="company-channel-tabs"]'),
        ).toBeTruthy();
      },
      { timeout: 10_000, interval: 50 },
    );
    const tabs = host.querySelector('[data-testid="company-channel-tabs"]')!;
    const ideasTab = tabs.querySelector<HTMLButtonElement>(
      '[data-testid="company-tab-ideas"]',
    );
    expect(ideasTab).toBeTruthy();
    expect(ideasTab?.textContent?.trim()).toBe("Ideas");
  });

  it("puts the board on screen when a user clicks that tab", async () => {
    mountShell(adapterWithIdeas());
    await vi.waitFor(
      () => {
        expect(
          host.querySelector('[data-testid="company-tab-ideas"]'),
        ).toBeTruthy();
      },
      { timeout: 10_000, interval: 50 },
    );
    // Not mounted until navigated to — proving the click is what reveals it.
    expect(host.querySelector('[data-testid="ideas-board"]')).toBeNull();

    host
      .querySelector<HTMLButtonElement>('[data-testid="company-tab-ideas"]')!
      .click();
    await settle();

    await vi.waitFor(
      () => {
        expect(host.querySelector('[data-testid="ideas-board"]')).toBeTruthy();
      },
      { timeout: 10_000, interval: 50 },
    );
    // And it is the real board: search, chips, and the loaded capture.
    expect(host.querySelector('[data-testid="ideas-search"]')).toBeTruthy();
    expect(
      host.querySelectorAll('[data-testid="ideas-board"] .ideas-chip').length,
    ).toBeGreaterThan(1);
    await vi.waitFor(
      () => {
        expect(host.querySelectorAll('[data-testid="idea-card"]').length).toBe(1);
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(
      host.querySelector('[data-testid="company-tab-ideas"]')?.className,
    ).toContain("active");
  });

  it("shows the empty surface — not an error — when the company has no captures", async () => {
    mountShell(adapterWithIdeas([]));
    await vi.waitFor(
      () => {
        expect(
          host.querySelector('[data-testid="company-tab-ideas"]'),
        ).toBeTruthy();
      },
      { timeout: 10_000, interval: 50 },
    );
    host
      .querySelector<HTMLButtonElement>('[data-testid="company-tab-ideas"]')!
      .click();
    await settle();
    await vi.waitFor(
      () => {
        expect(host.querySelector('[data-testid="ideas-empty"]')).toBeTruthy();
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(host.querySelector('[data-testid="ideas-error"]')).toBeNull();
  });
});

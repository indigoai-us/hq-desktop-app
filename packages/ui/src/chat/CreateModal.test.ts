// @vitest-environment happy-dom

/**
 * Component tests for the unified create modal — keyboard contract, the
 * honest three-state collision UI, the cross-company confirmation, and the
 * per-member failure summary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import CreateModal from "./CreateModal.svelte";
import type { ChatSidebarApi } from "./chat-api.js";
import type { ConversationRow, DmContactInput } from "./sidebar-model.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function stubApi(overrides: Partial<ChatSidebarApi> = {}): ChatSidebarApi {
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
    createChannel: async () => ({ channelId: "chn_new" }),
    addChannelMember: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    ...overrides,
  };
}

function channelRow(partial: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: "ch:chn_q4",
    kind: "channel",
    title: "Q4 Board",
    companyUid: "cmp_indigo",
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
    channelId: "chn_q4",
    ...partial,
  };
}

function personRow(partial: Partial<ConversationRow> = {}): ConversationRow {
  return channelRow({
    id: "dm:prs_ada",
    kind: "dm",
    title: "Ada",
    personUid: "prs_ada",
    channelId: undefined,
    companyUid: null,
    ...partial,
  });
}

interface MountArgs {
  api?: ChatSidebarApi;
  rows?: ConversationRow[];
  contacts?: DmContactInput[];
  scopeCompanies?: Array<{ companyUid: string; label: string }>;
  activeScope?: string;
  onclose?: (id?: string) => void;
  onpick?: (row: ConversationRow) => void;
  oncreated?: () => void;
}

function open(args: MountArgs = {}) {
  const props = {
    api: args.api ?? stubApi(),
    rows: args.rows ?? [],
    contacts: args.contacts ?? [],
    scopeCompanies: args.scopeCompanies ?? [
      { companyUid: "cmp_indigo", label: "Indigo" },
    ],
    activeScope: args.activeScope ?? "cmp_indigo",
    self: { uid: "prs_me", displayName: "Stefan" },
    onclose: args.onclose ?? (() => {}),
    onpick: args.onpick ?? (() => {}),
    oncreated: args.oncreated ?? (() => {}),
  };
  component = mount(CreateModal, { target: host, props });
  return props;
}

/** Pick the first suggestion for `name` in the member picker. */
async function pickMember(name: string): Promise<void> {
  const picker = $<HTMLInputElement>(
    '[data-testid="chat-channel-participants"]',
  )!;
  type(picker, name);
  await tick();
  $<HTMLButtonElement>('[data-testid="chat-channel-suggestion"]')?.click();
  await tick();
}

const $ = <T extends Element>(selector: string): T | null =>
  document.querySelector<T>(selector);

async function settleQuery(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  await tick();
}

function type(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  node.value = value;
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(node: EventTarget, key: string, init: KeyboardEventInit = {}) {
  node.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, ...init }),
  );
}

/** Type into the find input and walk through to the create step. */
async function gotoCreate(name: string): Promise<void> {
  const input = $<HTMLInputElement>('[data-testid="chat-create-query"]')!;
  type(input, name);
  await settleQuery();
  $<HTMLButtonElement>('[data-testid="chat-create-channel-row"]')?.click();
  await tick();
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
  document
    .querySelectorAll('[data-testid="chat-create-modal"]')
    .forEach((node) => node.remove());
});

describe("CreateModal find step", () => {
  it("traps Tab inside the dialog and wraps", async () => {
    open();
    await tick();
    const dialog = $<HTMLElement>('[role="dialog"]')!;
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>("input, button"),
    ];
    expect(focusable.length).toBeGreaterThan(1);

    focusable[0].focus();
    press(dialog, "Tab");
    expect(document.activeElement).toBe(focusable[1]);
    // Wrap forward off the end…
    focusable[focusable.length - 1].focus();
    press(dialog, "Tab");
    expect(document.activeElement).toBe(focusable[0]);
    // …and backward off the start.
    press(dialog, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);
  });

  it("wraps ArrowDown/ArrowUp and tracks aria-activedescendant", async () => {
    open({ rows: [channelRow(), personRow()] });
    await tick();
    const input = $<HTMLInputElement>('[data-testid="chat-create-query"]')!;
    type(input, "a");
    await settleQuery();

    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options.length).toBeGreaterThan(1);
    expect(input.getAttribute("aria-activedescendant")).toBe("create-opt-0");

    press(input, "ArrowDown");
    await tick();
    expect(input.getAttribute("aria-activedescendant")).toBe("create-opt-1");

    // Wrap past the end back to 0.
    for (let i = 1; i < options.length; i += 1) press(input, "ArrowDown");
    await tick();
    expect(input.getAttribute("aria-activedescendant")).toBe("create-opt-0");

    // Wrap backwards to the last row.
    press(input, "ArrowUp");
    await tick();
    expect(input.getAttribute("aria-activedescendant")).toBe(
      `create-opt-${options.length - 1}`,
    );
  });

  it("tells the truth about an email query instead of offering a garbage slug", async () => {
    open({ rows: [personRow()] });
    await tick();
    type($<HTMLInputElement>('[data-testid="chat-create-query"]')!, "a@b.co");
    await settleQuery();

    expect($('[data-testid="chat-create-no-match"]')?.textContent).toContain(
      "No one on HQ matches that address",
    );
    expect($('[data-testid="chat-create-channel-row"]')).toBeNull();
  });
});

describe("CreateModal create step", () => {
  it("Escape returns to the find step with the name preserved in the query", async () => {
    open();
    await tick();
    await gotoCreate("Q4 board");
    expect($('[data-testid="chat-channel-name"]')).toBeTruthy();

    press(window, "Escape");
    await tick();

    const input = $<HTMLInputElement>('[data-testid="chat-create-query"]');
    expect(input?.value).toBe("Q4 board");
    expect($('[data-testid="chat-channel-name"]')).toBeNull();
  });

  it("renaming the slug renames the channel and says so", async () => {
    open();
    await tick();
    await gotoCreate("Q4 board");

    const slug = $<HTMLInputElement>('[data-testid="chat-channel-slug"]')!;
    type(slug, "Growth Team!");
    await tick();
    expect(slug.value).toBe("growth-team-");

    slug.dispatchEvent(new Event("blur", { bubbles: true }));
    await tick();
    expect(slug.value).toBe("growth-team");
    expect(
      $<HTMLInputElement>('[data-testid="chat-channel-name"]')?.value,
    ).toBe("growth-team");
  });

  it("blocks a known in-scope collision and offers to open it", async () => {
    const onpick = vi.fn();
    open({ rows: [channelRow()], onpick });
    await tick();
    // "Q4 Board" exists, so the find step will not offer a create row —
    // reach the create step through a free name and then rename onto it.
    await gotoCreate("Growth");
    const slug = $<HTMLInputElement>('[data-testid="chat-channel-slug"]')!;
    type(slug, "q4-board");
    await tick();

    const note = $('[data-testid="chat-channel-slug-note"]');
    expect(note?.textContent).toContain("You're already in #q4-board here.");
    expect(
      $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.disabled,
    ).toBe(true);
    expect(
      $<HTMLButtonElement>('[data-testid="chat-channel-slug-suggest"]')
        ?.textContent,
    ).toContain("q4-board-2");

    $<HTMLButtonElement>('[data-testid="chat-channel-slug-open"]')?.click();
    await tick();
    expect(onpick).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "chn_q4" }),
    );
  });

  it("admits the limits of the company-scope check instead of implying availability", async () => {
    open();
    await tick();
    await gotoCreate("Growth");
    const note = $('[data-testid="chat-channel-slug-note"]');
    const copy = note?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    expect(copy).toContain(
      "#growth — we only see channels you're in, so this name may still be taken.",
    );
    expect(copy).not.toMatch(/available|free/i);
    expect(
      $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.disabled,
    ).toBe(false);
  });

  it("confirms a cross-company invite and adds nothing when dismissed", async () => {
    // "Outside" comes from the authoritative company roster; the contacts row
    // carries no companyUid (the wire shape), so the shared create-scope rules
    // have nothing to block on and the question is the right surface.
    const outsider = personRow({
      id: "dm:prs_kai",
      title: "Kai",
      personUid: "prs_kai",
    });
    const listCompanyMembers = vi.fn(async () => ({
      contacts: [{ personUid: "prs_ada", displayName: "Ada" }],
    }));
    open({
      api: stubApi({ listCompanyMembers }),
      rows: [outsider],
      contacts: [{ personUid: "prs_kai", displayName: "Kai" }],
    });
    await tick();
    await gotoCreate("Growth");
    await vi.waitFor(() => {
      expect(listCompanyMembers).toHaveBeenCalledWith("cmp_indigo");
    });
    await tick();

    const picker = $<HTMLInputElement>(
      '[data-testid="chat-channel-participants"]',
    )!;
    type(picker, "Kai");
    await tick();
    $<HTMLButtonElement>('[data-testid="chat-channel-suggestion"]')?.click();
    await tick();

    const confirm = $('[data-testid="chat-create-confirm-external"]');
    const confirmCopy =
      confirm?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    expect(confirmCopy).toContain("from outside Indigo");
    // D9 — chat only, never files or membership.
    expect(confirmCopy).toContain(
      "does not give them workspace membership or access to any files",
    );
    expect(document.querySelectorAll('[data-testid="chat-channel-chip"]'))
      .toHaveLength(0);
    // Submit is held while the confirm is up.
    expect(
      $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.disabled,
    ).toBe(true);

    press(window, "Escape");
    await tick();
    expect($('[data-testid="chat-create-confirm-external"]')).toBeNull();
    expect(
      document.querySelectorAll('[data-testid="chat-channel-chip"]'),
    ).toHaveLength(0);
    // Still on the create step — Escape dismissed only the panel.
    expect($('[data-testid="chat-channel-name"]')).toBeTruthy();

    // Confirming adds the chip with an `external` tag.
    type(picker, "Kai");
    await tick();
    $<HTMLButtonElement>('[data-testid="chat-channel-suggestion"]')?.click();
    await tick();
    $<HTMLButtonElement>(
      '[data-testid="chat-create-confirm-external-add"]',
    )?.click();
    await tick();
    const chip = $('[data-testid="chat-channel-chip"]');
    expect(chip?.textContent).toContain("Kai");
    expect(chip?.textContent).toContain("external");
  });

  it("does not confirm for a teammate inside the target workspace", async () => {
    open({
      rows: [personRow({ id: "dm:prs_kai", title: "Kai", personUid: "prs_kai" })],
      contacts: [
        { personUid: "prs_kai", displayName: "Kai", companyUid: "cmp_indigo" },
      ],
    });
    await tick();
    await gotoCreate("Growth");
    type(
      $<HTMLInputElement>('[data-testid="chat-channel-participants"]')!,
      "Kai",
    );
    await tick();
    $<HTMLButtonElement>('[data-testid="chat-channel-suggestion"]')?.click();
    await tick();
    expect($('[data-testid="chat-create-confirm-external"]')).toBeNull();
    expect(
      document.querySelectorAll('[data-testid="chat-channel-chip"]'),
    ).toHaveLength(1);
  });
});

describe("CreateModal submit", () => {
  it("keeps the create step and remembers the slug when the server 409s", async () => {
    const createChannel = vi.fn(async () => {
      throw new Error(
        'channel name "Growth" is already taken in scope company#cmp_indigo',
      );
    });
    const onclose = vi.fn();
    open({ api: stubApi({ createChannel }), onclose });
    await tick();
    await gotoCreate("Growth");

    $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.click();
    await vi.waitFor(() => {
      expect($('[data-testid="chat-channel-error"]')).toBeTruthy();
    });

    const error = $('[data-testid="chat-channel-error"]');
    expect(error?.textContent).toContain("already taken");
    expect(error?.textContent).not.toContain("cmp_");
    expect(onclose).not.toHaveBeenCalled();
    // Every field survives, and the live check now reports the collision.
    expect(
      $<HTMLInputElement>('[data-testid="chat-channel-name"]')?.value,
    ).toBe("Growth");
    expect(
      $('[data-testid="chat-channel-slug-note"]')?.textContent,
    ).toContain("already taken in this workspace");
    expect(
      $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.disabled,
    ).toBe(true);
  });

  it("does not abort the member loop on one rejection and lands in the summary", async () => {
    const addChannelMember = vi
      .fn<(channelId: string, uid: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("RECIPIENT_NOT_FOUND"))
      .mockResolvedValue(undefined);
    const onclose = vi.fn();
    open({
      api: stubApi({ addChannelMember }),
      rows: [
        personRow({ id: "dm:prs_kai", title: "Kai", personUid: "prs_kai" }),
        personRow({ id: "dm:prs_ada", title: "Ada", personUid: "prs_ada" }),
      ],
      contacts: [
        { personUid: "prs_kai", displayName: "Kai", companyUid: "cmp_indigo" },
        { personUid: "prs_ada", displayName: "Ada", companyUid: "cmp_indigo" },
      ],
      onclose,
    });
    await tick();
    await gotoCreate("Growth");

    const picker = $<HTMLInputElement>(
      '[data-testid="chat-channel-participants"]',
    )!;
    for (const name of ["Kai", "Ada"]) {
      type(picker, name);
      await tick();
      $<HTMLButtonElement>('[data-testid="chat-channel-suggestion"]')?.click();
      await tick();
    }
    expect(
      document.querySelectorAll('[data-testid="chat-channel-chip"]'),
    ).toHaveLength(2);

    $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.click();
    await vi.waitFor(() => {
      expect($('[data-testid="chat-create-summary"]')).toBeTruthy();
    });

    // Both members were attempted — the first failure did not abort the loop.
    expect(addChannelMember).toHaveBeenCalledTimes(2);
    const summaryRows = document.querySelectorAll(
      '[data-testid="chat-create-summary-row"]',
    );
    expect(summaryRows).toHaveLength(1);
    expect(summaryRows[0].textContent).toContain("Kai");
    // Not closed behind the user's back — the summary accounts for the failure.
    expect(onclose).not.toHaveBeenCalled();

    $<HTMLButtonElement>('[data-testid="chat-create-summary-done"]')?.click();
    await tick();
    expect(onclose).toHaveBeenCalledWith(
      "chn_new",
      expect.objectContaining({ title: expect.any(String) }),
    );
  });

  it("refuses a channel id the timeline could not open", async () => {
    const onclose = vi.fn();
    const createChannel = vi.fn(async () => ({ channelId: "growth" }));
    open({ api: stubApi({ createChannel }), onclose });
    await tick();
    await gotoCreate("Growth");
    $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.click();
    await vi.waitFor(() => {
      expect($('[data-testid="chat-channel-error"]')).toBeTruthy();
    });
    expect($('[data-testid="chat-channel-error"]')?.textContent).toContain(
      "unusable channel id",
    );
    expect(onclose).not.toHaveBeenCalled();
    // The server answered 2xx, so a channel may exist: a second click must not
    // POST a second create.
    const button = $<HTMLButtonElement>('[data-testid="chat-channel-create"]')!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Creation unconfirmed");
    button.click();
    await tick();
    expect(createChannel).toHaveBeenCalledTimes(1);
  });

  it("does not lock retry because another workspace has a same-named channel", async () => {
    const createChannel = vi.fn(async () => {
      throw new Error("upstream timeout");
    });
    open({
      api: stubApi({ createChannel }),
      rows: [
        channelRow({
          id: "ch:chn_other",
          channelId: "chn_other",
          title: "Growth",
          companyUid: "cmp_other",
        }),
      ],
    });
    await tick();
    await gotoCreate("Growth");
    $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.click();
    await vi.waitFor(() => {
      expect($('[data-testid="chat-channel-error"]')).toBeTruthy();
    });
    expect($('[data-testid="chat-channel-error"]')?.textContent).toContain(
      "you can try again",
    );
    const button = $<HTMLButtonElement>('[data-testid="chat-channel-create"]')!;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain("Create channel");
  });

  it("locks retry when the create target now lists the name", async () => {
    const createChannel = vi.fn(async () => {
      throw new Error("upstream timeout");
    });
    // The post-failure lookup finds the name in the TARGET workspace (the
    // server committed before answering) — retry would create a duplicate.
    const listChannels = vi.fn(async () => ({
      channels: [
        {
          channelId: "chn_growth",
          id: "chn_growth",
          name: "Growth",
          scope: "company" as const,
          companyUid: "cmp_indigo",
        },
      ],
    }));
    open({ api: stubApi({ createChannel, listChannels }) });
    await tick();
    await gotoCreate("Growth");
    $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.click();
    await vi.waitFor(() => {
      expect($('[data-testid="chat-channel-error"]')).toBeTruthy();
    });
    expect($('[data-testid="chat-channel-error"]')?.textContent).toContain(
      "retry is disabled",
    );
    expect(listChannels).toHaveBeenCalledWith(
      expect.objectContaining({ companyUid: "cmp_indigo" }),
    );
    const button = $<HTMLButtonElement>('[data-testid="chat-channel-create"]')!;
    expect(button.disabled).toBe(true);
    button.click();
    await tick();
    expect(createChannel).toHaveBeenCalledTimes(1);
  });

  it("does not lock retry from remote channels in a different workspace", async () => {
    const createChannel = vi.fn(async () => {
      throw new Error("upstream timeout");
    });
    const listChannels = vi.fn(async () => ({
      channels: [
        {
          channelId: "chn_other",
          name: "Growth",
          scope: "company" as const,
          companyUid: "cmp_other",
        },
      ],
    }));
    const fetchChannelDirectory = vi.fn(async () => ({
      snapshot: true,
      cursor: "createmodalcursor000000000000000000",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: [
        {
          channelId: "chn_other",
          name: "Growth",
          scope: "company",
          companyUid: "cmp_other",
          lastActivityAt: null,
        },
      ],
    }));
    open({
      api: stubApi({ createChannel, listChannels, fetchChannelDirectory }),
    });
    await tick();
    await gotoCreate("Growth");

    $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.click();
    await vi.waitFor(() => {
      expect($('[data-testid="chat-channel-error"]')?.textContent).toContain(
        "you can try again",
      );
    });
    expect(fetchChannelDirectory).toHaveBeenCalledWith(null);
    expect(
      $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.disabled,
    ).toBe(false);
  });

  it("does not lock a personal retry from remote company channels", async () => {
    const createChannel = vi.fn(async () => {
      throw new Error("upstream timeout");
    });
    const listChannels = vi.fn(async () => ({
      channels: [
        {
          channelId: "chn_company",
          name: "Growth",
          scope: "company" as const,
          companyUid: "cmp_indigo",
        },
      ],
    }));
    const fetchChannelDirectory = vi.fn(async () => ({
      snapshot: true,
      cursor: "createmodalcursor000000000000000000",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: [
        {
          channelId: "chn_company",
          name: "Growth",
          scope: "company",
          companyUid: "cmp_indigo",
          lastActivityAt: null,
        },
      ],
    }));
    open({
      api: stubApi({ createChannel, listChannels, fetchChannelDirectory }),
      activeScope: "personal",
    });
    await tick();
    await gotoCreate("Growth");
    expect($<HTMLSelectElement>('[data-testid="chat-channel-scope"]')?.value).toBe(
      "",
    );

    $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.click();
    await vi.waitFor(() => {
      expect($('[data-testid="chat-channel-error"]')?.textContent).toContain(
        "you can try again",
      );
    });
    expect(fetchChannelDirectory).toHaveBeenCalledWith(null);
    expect(
      $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.disabled,
    ).toBe(false);
  });

  it("reports the name that was actually submitted when Enter fires before slug blur", async () => {
    const addChannelMember = vi
      .fn<(channelId: string, uid: string) => Promise<void>>()
      .mockRejectedValue(new Error("RECIPIENT_NOT_FOUND"));
    const createChannel = vi.fn(async () => ({ channelId: "chn_new" }));
    const onclose = vi.fn();
    open({
      api: stubApi({ addChannelMember, createChannel }),
      rows: [personRow({ id: "dm:prs_kai", title: "Kai", personUid: "prs_kai" })],
      contacts: [{ personUid: "prs_kai", displayName: "Kai", companyUid: "cmp_indigo" }],
      onclose,
    });
    await tick();
    await gotoCreate("Growth");
    await pickMember("Kai");
    const slug = $<HTMLInputElement>('[data-testid="chat-channel-slug"]')!;
    type(slug, "growth-ops");
    await tick();
    // Enter in the slug field submits without a blur — `channelName` is stale.
    press(slug, "Enter");
    await vi.waitFor(() => {
      expect($('[data-testid="chat-create-summary"]')).toBeTruthy();
    });
    expect(createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "growth-ops" }),
    );
    $<HTMLButtonElement>('[data-testid="chat-create-summary-done"]')?.click();
    await tick();
    expect(onclose).toHaveBeenCalledWith(
      "chn_new",
      expect.objectContaining({ title: "growth-ops" }),
    );
  });

  it("hides the first-message field when the host cannot send one", async () => {
    // `sendChannelMessage` is required on the typed contract, so this is a
    // defensive guard against an untyped host that omits it at runtime.
    const api = stubApi();
    delete (api as Partial<ChatSidebarApi>).sendChannelMessage;
    open({ api });
    await tick();
    await gotoCreate("Growth");
    expect($('[data-testid="chat-channel-first-message"]')).toBeNull();
  });

  it("hides the members row when the host cannot add members", async () => {
    const api = stubApi();
    delete api.addChannelMember;
    open({ api, rows: [personRow()] });
    await tick();
    await gotoCreate("Growth");
    expect($('[data-testid="chat-channel-participants"]')).toBeNull();
  });
});

describe("CreateModal member picker", () => {
  const emailApi = () =>
    stubApi({ sendDmToEmail: async () => ({ state: "delivered" as const }) });

  async function typeEmailAndEnter(value: string): Promise<void> {
    const picker = $<HTMLInputElement>(
      '[data-testid="chat-channel-participants"]',
    )!;
    type(picker, value);
    await tick();
    press(picker, "Enter");
    await tick();
  }

  // Regression: the raw-email fallback pushed a second chip with an identical
  // `{#each}` key, throwing `each_key_duplicate` and tearing down the modal.
  it("adds the same address only once, however it is typed", async () => {
    open({ api: emailApi() });
    await tick();
    await gotoCreate("Growth");

    await typeEmailAndEnter("zed@example.com");
    expect(
      document.querySelectorAll('[data-testid="chat-channel-chip"]'),
    ).toHaveLength(1);

    await typeEmailAndEnter("zed@example.com");
    await typeEmailAndEnter("Zed@Example.com");
    expect(
      document.querySelectorAll('[data-testid="chat-channel-chip"]'),
    ).toHaveLength(1);

    // Still alive: the duplicate key threw `each_key_duplicate`, which tore
    // the keyed block down and stopped it rendering anything further.
    await typeEmailAndEnter("other@example.com");
    expect(
      [...document.querySelectorAll('[data-testid="chat-channel-chip"]')].map(
        (node) => node.textContent?.replace(/\s+/g, " ").trim(),
      ),
    ).toEqual([
      "ZE zed@example.com not on hq ×",
      "OT other@example.com not on hq ×",
    ]);
    expect($('[data-testid="chat-channel-name"]')).toBeTruthy();
  });

  // Regression: the find list got `scrollActiveIntoView`, the picker did not,
  // so arrowing past the second candidate walked below the fold silently.
  it("scrolls the highlighted candidate into view", async () => {
    const seen: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      seen.push(this.id);
    } as typeof original;
    try {
      open({
        rows: [
          personRow({ id: "dm:prs_a1", title: "Alpha One", personUid: "prs_a1" }),
          personRow({ id: "dm:prs_a2", title: "Alpha Two", personUid: "prs_a2" }),
          personRow({
            id: "dm:agt_alpha",
            title: "Alpha Bot",
            personUid: "agt_alpha",
          }),
        ],
      });
      await tick();
      await gotoCreate("Growth");
      const picker = $<HTMLInputElement>(
        '[data-testid="chat-channel-participants"]',
      )!;
      type(picker, "Alpha");
      await tick();
      press(picker, "ArrowDown");
      press(picker, "ArrowDown");
      await tick();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

      expect(picker.getAttribute("aria-activedescendant")).toBe(
        "create-pick-2",
      );
      expect(seen).toContain("create-pick-2");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe("CreateModal cross-company confirmation (D7)", () => {
  const TWO_COMPANIES = [
    { companyUid: "cmp_indigo", label: "Indigo" },
    { companyUid: "cmp_other", label: "Holler" },
  ];
  /** Company rosters (`list_company_members`): Kai is in Holler only. */
  const rosters = () =>
    vi.fn(async (companyUid: string) => ({
      contacts:
        companyUid === "cmp_other"
          ? [{ personUid: "prs_kai", displayName: "Kai" }]
          : [{ personUid: "prs_ada", displayName: "Ada" }],
    }));
  /** Wire shape of GET /v1/notify/contacts — no companyUid. */
  const kaiContact = [{ personUid: "prs_kai", displayName: "Kai" }];

  // Contacts/DM rows that positively place someone in ANOTHER company are the
  // shared create-scope rules' business (#597): the "In" option is marked
  // unavailable and Create is blocked inline. Asking "add anyway?" first would
  // promise something Create then refuses.
  it("hands a member contacts place elsewhere to the scope rules, not the confirmation", async () => {
    const createChannel = vi.fn(async () => ({ channelId: "chn_new" }));
    open({
      api: stubApi({ createChannel }),
      rows: [personRow({ id: "dm:prs_kai", title: "Kai", personUid: "prs_kai" })],
      contacts: [
        { personUid: "prs_kai", displayName: "Kai", companyUid: "cmp_other" },
      ],
    });
    await tick();
    await gotoCreate("Growth");
    await pickMember("Kai");

    expect($('[data-testid="chat-create-confirm-external"]')).toBeNull();
    expect(
      document.querySelectorAll('[data-testid="chat-channel-chip"]'),
    ).toHaveLength(1);
    // Indigo is the only company on offer and Kai is not in it, so the shared
    // rules fall back to Personal — which a teammate cannot be in either.
    expect(
      $('[data-testid="chat-channel-validation"]')?.textContent,
    ).toMatch(/Kai isn't a member of/);
    expect(
      $('[data-testid="chat-channel-scope-unavailable"]')?.textContent,
    ).toContain("Kai isn't a member of Indigo");
    const scope = $<HTMLSelectElement>('[data-testid="chat-channel-scope"]')!;
    expect(
      [...scope.options].find((option) => option.value === "cmp_indigo")
        ?.disabled,
    ).toBe(true);
    const create = $<HTMLButtonElement>('[data-testid="chat-channel-create"]')!;
    expect(create.disabled).toBe(true);
    create.click();
    await tick();
    expect(createChannel).not.toHaveBeenCalled();

    // Removing the chip lifts the block.
    $<HTMLButtonElement>('[aria-label="Remove Kai"]')?.click();
    await tick();
    expect($('[data-testid="chat-channel-validation"]')).toBeNull();
  });

  // Regression: `external` was decided once, at pick time. Switching the
  // workspace afterwards smuggled the member across companies with no
  // confirmation and no `external` tag.
  it("re-asks when the workspace changes under an already-picked member", async () => {
    const listCompanyMembers = rosters();
    open({
      api: stubApi({ listCompanyMembers }),
      rows: [personRow({ id: "dm:prs_kai", title: "Kai", personUid: "prs_kai" })],
      contacts: kaiContact,
      scopeCompanies: TWO_COMPANIES,
      activeScope: "cmp_other",
    });
    await tick();
    await gotoCreate("Growth");
    await vi.waitFor(() => {
      expect(listCompanyMembers).toHaveBeenCalledWith("cmp_other");
    });
    await tick();

    // Inside the active workspace → straight in, no question, no tag.
    await pickMember("Kai");
    expect($('[data-testid="chat-create-confirm-external"]')).toBeNull();
    expect($('[data-testid="chat-channel-chip"]')?.textContent).not.toContain(
      "external",
    );

    const scope = $<HTMLSelectElement>('[data-testid="chat-channel-scope"]')!;
    scope.value = "cmp_indigo";
    scope.dispatchEvent(new Event("change", { bubbles: true }));
    // The Indigo roster loads asynchronously; the question follows it.
    await vi.waitFor(() => {
      expect($('[data-testid="chat-create-confirm-external"]')).toBeTruthy();
    });

    const confirm = $('[data-testid="chat-create-confirm-external"]');
    expect(confirm?.textContent?.replace(/\s+/g, " ")).toContain(
      "Add Kai from outside Indigo?",
    );
    expect($('[data-testid="chat-channel-chip"]')?.textContent).toContain(
      "external",
    );
    expect(
      $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.disabled,
    ).toBe(true);

    // "Remove" is the honest decline for a member already in the list.
    $<HTMLButtonElement>(
      '[data-testid="chat-create-confirm-external-cancel"]',
    )?.click();
    await tick();
    expect($('[data-testid="chat-create-confirm-external"]')).toBeNull();
    expect(
      document.querySelectorAll('[data-testid="chat-channel-chip"]'),
    ).toHaveLength(0);
    expect(
      $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.disabled,
    ).toBe(false);
  });

  it("keeps the member, tagged, once the switch is confirmed", async () => {
    const listCompanyMembers = rosters();
    open({
      api: stubApi({ listCompanyMembers }),
      rows: [personRow({ id: "dm:prs_kai", title: "Kai", personUid: "prs_kai" })],
      contacts: kaiContact,
      scopeCompanies: TWO_COMPANIES,
      activeScope: "cmp_other",
    });
    await tick();
    await gotoCreate("Growth");
    await vi.waitFor(() => {
      expect(listCompanyMembers).toHaveBeenCalledWith("cmp_other");
    });
    await tick();
    await pickMember("Kai");

    const scope = $<HTMLSelectElement>('[data-testid="chat-channel-scope"]')!;
    const select = async (value: string) => {
      scope.value = value;
      scope.dispatchEvent(new Event("change", { bubbles: true }));
      await tick();
    };

    await select("cmp_indigo");
    await vi.waitFor(() => {
      expect(
        $('[data-testid="chat-create-confirm-external-add"]'),
      ).toBeTruthy();
    });
    $<HTMLButtonElement>(
      '[data-testid="chat-create-confirm-external-add"]',
    )?.click();
    await tick();
    expect($('[data-testid="chat-create-confirm-external"]')).toBeNull();
    // Kept, still tagged, and the form is live again.
    const chip = $('[data-testid="chat-channel-chip"]')?.textContent ?? "";
    expect(chip).toContain("Kai");
    expect(chip).toContain("external");
    expect(
      $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.disabled,
    ).toBe(false);
    expect(
      $<HTMLElement>(".create-body")?.hasAttribute("inert"),
    ).toBe(false);
  });

  // Regression: the confirmation could never fire in production because
  // `GET /v1/notify/contacts` returns no companyUid. It has to come from the
  // company roster instead.
  it("fires from the company roster when contacts carry no companyUid", async () => {
    const listCompanyMembers = vi.fn(async () => ({
      contacts: [
        { personUid: "prs_ada", displayName: "Ada", email: "ada@indigo.test" },
      ],
    }));
    open({
      api: stubApi({ listCompanyMembers }),
      rows: [
        personRow({ id: "dm:prs_kai", title: "Kai", personUid: "prs_kai" }),
      ],
      // Exactly the wire shape of GET /v1/notify/contacts — no companyUid.
      contacts: [
        { personUid: "prs_kai", displayName: "Kai", email: "kai@acme.test" },
      ],
    });
    await tick();
    await gotoCreate("Growth");
    await vi.waitFor(() => {
      expect(listCompanyMembers).toHaveBeenCalledWith("cmp_indigo");
    });
    await tick();

    await pickMember("Kai");
    expect($('[data-testid="chat-create-confirm-external"]')).toBeTruthy();
    expect(
      document.querySelectorAll('[data-testid="chat-channel-chip"]'),
    ).toHaveLength(0);
  });

  it("does not confirm for someone the roster lists", async () => {
    const listCompanyMembers = vi.fn(async () => ({
      contacts: [
        { personUid: "prs_kai", displayName: "Kai", email: "kai@acme.test" },
      ],
    }));
    open({
      api: stubApi({ listCompanyMembers }),
      rows: [
        personRow({ id: "dm:prs_kai", title: "Kai", personUid: "prs_kai" }),
      ],
      contacts: [
        { personUid: "prs_kai", displayName: "Kai", email: "kai@acme.test" },
      ],
    });
    await tick();
    await gotoCreate("Growth");
    await vi.waitFor(() => {
      expect(listCompanyMembers).toHaveBeenCalled();
    });
    await tick();

    await pickMember("Kai");
    expect($('[data-testid="chat-create-confirm-external"]')).toBeNull();
    expect(
      document.querySelectorAll('[data-testid="chat-channel-chip"]'),
    ).toHaveLength(1);
  });

  // Regression: the alertdialog shared the card's Tab ring, so Tab walked out
  // of it and into the still-enabled form it was asking about.
  it("keeps Tab inside the confirmation", async () => {
    const listCompanyMembers = rosters();
    open({
      api: stubApi({ listCompanyMembers }),
      rows: [personRow({ id: "dm:prs_kai", title: "Kai", personUid: "prs_kai" })],
      contacts: kaiContact,
    });
    await tick();
    await gotoCreate("Growth");
    await vi.waitFor(() => {
      expect(listCompanyMembers).toHaveBeenCalledWith("cmp_indigo");
    });
    await tick();
    await pickMember("Kai");

    const add = $<HTMLButtonElement>(
      '[data-testid="chat-create-confirm-external-add"]',
    )!;
    const cancel = $<HTMLButtonElement>(
      '[data-testid="chat-create-confirm-external-cancel"]',
    )!;
    const dialog = $<HTMLElement>('[role="dialog"]')!;
    add.focus();
    for (const expected of [cancel, add, cancel, add]) {
      press(dialog, "Tab");
      expect(document.activeElement).toBe(expected);
    }
    // The form underneath is marked inert while the question is up.
    expect(
      $<HTMLElement>('[data-testid="chat-channel-name"]')?.closest(
        ".create-body",
      )?.hasAttribute("inert"),
    ).toBe(true);
  });
});

describe("CreateModal in-flight and summary", () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  // Regression: only Escape was guarded, so the × and the backdrop could tear
  // the modal down mid-request — losing the failure summary and firing
  // `onclose` a second time from the still-running submit.
  it("cannot be dismissed while the create request is in flight", async () => {
    const gate = deferred<{ channelId: string }>();
    const onclose = vi.fn();
    open({
      api: stubApi({
        createChannel: () => gate.promise,
        addChannelMember: async () => {
          throw new Error("RECIPIENT_NOT_FOUND");
        },
      }),
      rows: [personRow({ id: "dm:prs_kai", title: "Kai", personUid: "prs_kai" })],
      contacts: [{ personUid: "prs_kai", displayName: "Kai" }],
      onclose,
    });
    await tick();
    await gotoCreate("Growth");
    await pickMember("Kai");

    $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.click();
    await tick();
    const close = $<HTMLButtonElement>(".create-close")!;
    expect(close.disabled).toBe(true);

    close.click();
    $<HTMLElement>('[data-testid="chat-create-modal"]')?.click();
    press(window, "Escape");
    await tick();
    expect(onclose).not.toHaveBeenCalled();

    gate.resolve({ channelId: "chn_new" });
    await vi.waitFor(() => {
      expect($('[data-testid="chat-create-summary"]')).toBeTruthy();
    });
    // The failure report survived — it was never dropped on an unmounted card.
    expect($('[data-testid="chat-create-summary-row"]')?.textContent).toContain(
      "Kai",
    );
    expect(onclose).not.toHaveBeenCalled();

    $<HTMLButtonElement>('[data-testid="chat-create-summary-done"]')?.click();
    await tick();
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(onclose).toHaveBeenCalledWith(
      "chn_new",
      expect.objectContaining({ title: expect.any(String) }),
    );
  });

  // Regression: the summary step left focus on <body>, which both escapes the
  // trap and leaves the only report of what failed unannounced.
  it("moves focus into the summary and announces it", async () => {
    open({
      api: stubApi({
        addChannelMember: async () => {
          throw new Error("RECIPIENT_NOT_FOUND");
        },
      }),
      rows: [personRow({ id: "dm:prs_kai", title: "Kai", personUid: "prs_kai" })],
      contacts: [{ personUid: "prs_kai", displayName: "Kai" }],
    });
    await tick();
    await gotoCreate("Growth");
    await pickMember("Kai");
    $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.click();
    await vi.waitFor(() => {
      expect($('[data-testid="chat-create-summary"]')).toBeTruthy();
    });

    const done = $<HTMLButtonElement>(
      '[data-testid="chat-create-summary-done"]',
    )!;
    expect(document.activeElement).toBe(done);
    const summary = $<HTMLElement>('[data-testid="chat-create-summary"]')!;
    expect(summary.getAttribute("aria-live")).toBe("polite");
    expect($<HTMLElement>('[role="dialog"]')!.contains(document.activeElement))
      .toBe(true);
  });

  // Regression: a failed retry was swallowed into console.error, so it looked
  // exactly like a click that never registered — and every impatient click
  // fired another request.
  it("reports a failed retry instead of swallowing it", async () => {
    const gate = deferred<void>();
    const addChannelMember = vi
      .fn<(channelId: string, uid: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom in scope company#cmp_indigo"))
      .mockImplementationOnce(async () => {
        await gate.promise;
        throw new Error("still broken");
      });
    open({
      api: stubApi({ addChannelMember }),
      rows: [personRow({ id: "dm:prs_kai", title: "Kai", personUid: "prs_kai" })],
      contacts: [{ personUid: "prs_kai", displayName: "Kai" }],
    });
    await tick();
    await gotoCreate("Growth");
    await pickMember("Kai");
    $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.click();
    await vi.waitFor(() => {
      expect($('[data-testid="chat-create-summary"]')).toBeTruthy();
    });

    const retry = () =>
      $<HTMLButtonElement>('[data-testid="chat-create-summary-action"]')!;
    retry().click();
    await tick();
    // Held while the retry is in flight — a second click cannot double-fire.
    expect(retry().disabled).toBe(true);
    retry().click();
    await tick();

    gate.resolve();
    await vi.waitFor(() => {
      expect($('[data-testid="chat-create-summary-error"]')).toBeTruthy();
    });
    const error = $('[data-testid="chat-create-summary-error"]')!;
    expect(error.textContent).toContain("still broken");
    expect(error.textContent).not.toContain("cmp_");
    expect(retry().disabled).toBe(false);
    expect(addChannelMember).toHaveBeenCalledTimes(2);
  });

  it("offers no retry when the server refused on role", async () => {
    const addChannelMember = vi
      .fn<(channelId: string, uid: string) => Promise<void>>()
      .mockRejectedValue(new Error("CHANNEL_NOT_OWNER"));
    open({
      api: stubApi({ addChannelMember }),
      rows: [personRow({ id: "dm:prs_kai", title: "Kai", personUid: "prs_kai" })],
      contacts: [{ personUid: "prs_kai", displayName: "Kai", companyUid: "cmp_indigo" }],
    });
    await tick();
    await gotoCreate("Growth");
    await pickMember("Kai");
    $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.click();
    await vi.waitFor(() => {
      expect($('[data-testid="chat-create-summary"]')).toBeTruthy();
    });
    const row = $('[data-testid="chat-create-summary-row"]')!;
    expect(row.textContent).toContain("only the channel owner can add people");
    expect($('[data-testid="chat-create-summary-action"]')).toBeNull();
  });

  // Regression: nothing adds an email invitee to the channel when they accept
  // the connection request, but both the form and the summary said it would
  // happen automatically.
  it("never promises an automatic join for an email invitee", async () => {
    open({
      api: stubApi({
        sendDmToEmail: async () => ({ state: "connectionRequested" as const }),
      }),
    });
    await tick();
    await gotoCreate("Growth");
    const picker = $<HTMLInputElement>(
      '[data-testid="chat-channel-participants"]',
    )!;
    type(picker, "kai@acme.test");
    await tick();
    press(picker, "Enter");
    await tick();

    const note = $('[data-testid="chat-channel-email-note"]')
      ?.textContent?.replace(/\s+/g, " ")
      .trim();
    expect(note).toContain("Add them to the channel once they accept");
    expect(note).not.toMatch(/they join the channel/i);

    $<HTMLButtonElement>('[data-testid="chat-channel-create"]')?.click();
    await vi.waitFor(() => {
      expect($('[data-testid="chat-create-summary"]')).toBeTruthy();
    });
    const row = $('[data-testid="chat-create-summary-row"]')
      ?.textContent?.replace(/\s+/g, " ")
      .trim();
    expect(row).toContain("Add them to #growth once they accept");
    expect(row).not.toMatch(/they'll join/i);
  });
});

describe("CreateModal accessibility", () => {
  // Regression: the empty/no-match notes were direct children of the listbox,
  // which may only contain options (and presentational group headings).
  it("keeps status notes out of the results listbox", async () => {
    open({ rows: [personRow()] });
    await tick();
    const listbox = () => document.getElementById("create-results")!;
    const offending = () =>
      Array.from(listbox().children).filter((child) => {
        const role = child.getAttribute("role");
        return role !== "option" && role !== "presentation";
      });

    type($<HTMLInputElement>('[data-testid="chat-create-query"]')!, "a@b.co");
    await settleQuery();
    const note = $('[data-testid="chat-create-no-match"]')!;
    expect(note.getAttribute("role")).toBe("status");
    expect(listbox().contains(note)).toBe(false);
    expect(offending()).toHaveLength(0);

    type($<HTMLInputElement>('[data-testid="chat-create-query"]')!, "zzzz-nope");
    await settleQuery();
    // A create row is offered for a plain name, so force a real empty state via
    // a personal-scope-only query with no candidates: assert structure only.
    expect(offending()).toHaveLength(0);
    const empty = $('[data-testid="chat-create-empty"]');
    if (empty) expect(listbox().contains(empty)).toBe(false);
  });

  // Regression: the live slug preview and the collision verdict were rendered
  // with no id, no role and no live region — the modal had none at all.
  it("describes the slug field with its verdict and announces changes", async () => {
    open();
    await tick();
    await gotoCreate("Q4 board");

    const slug = $<HTMLInputElement>('[data-testid="chat-channel-slug"]')!;
    expect(slug.getAttribute("aria-describedby")).toContain("create-slug-note");
    expect(slug.getAttribute("maxlength")).toBe("200");

    const live = document.getElementById("create-slug-note")!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.querySelector('[data-testid="chat-channel-slug-note"]'))
      .toBeTruthy();
  });

  // Regression: an empty slug disabled the button and suppressed every note,
  // leaving a dead control with no explanation anywhere.
  it("says why the create button is disabled", async () => {
    open();
    await tick();
    await gotoCreate("Growth");
    type($<HTMLInputElement>('[data-testid="chat-channel-name"]')!, "");
    await tick();

    const button = $<HTMLButtonElement>(
      '[data-testid="chat-channel-create"]',
    )!;
    expect(button.disabled).toBe(true);
    const reasonId = button.getAttribute("aria-describedby");
    expect(reasonId).toBe("create-submit-reason");
    expect(document.getElementById(reasonId!)?.textContent).toContain(
      "Name the channel",
    );
  });

  // Regression: browse-only rows are channels the caller is explicitly NOT in,
  // yet the copy claimed membership and offered a dead "Open it".
  it("does not claim membership of a browse-only collision", async () => {
    open({
      rows: [
        channelRow({
          id: "ch:chn_secret",
          title: "Secret Project",
          channelId: "chn_secret",
          browseOnly: true,
        }),
      ],
    });
    await tick();
    await gotoCreate("Growth");
    type(
      $<HTMLInputElement>('[data-testid="chat-channel-slug"]')!,
      "secret-project",
    );
    await tick();

    const note = $('[data-testid="chat-channel-slug-note"]')?.textContent ?? "";
    expect(note).toContain("is already taken in this workspace");
    expect(note).not.toContain("You're already in");
    expect($('[data-testid="chat-channel-slug-open"]')).toBeNull();
    expect($('[data-testid="chat-channel-slug-suggest"]')).toBeTruthy();
  });

  it("still offers to open a channel the caller IS in", async () => {
    open({ rows: [channelRow({ title: "Secret Project" })] });
    await tick();
    await gotoCreate("Growth");
    type(
      $<HTMLInputElement>('[data-testid="chat-channel-slug"]')!,
      "secret-project",
    );
    await tick();
    expect($('[data-testid="chat-channel-slug-open"]')).toBeTruthy();
  });
});

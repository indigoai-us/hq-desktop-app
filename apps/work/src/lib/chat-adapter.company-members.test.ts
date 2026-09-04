// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import { ok, type PlatformAdapter } from "@hq/platform";
import CreateModal from "../../../../packages/ui/src/chat/CreateModal.svelte";
import type { ChatSidebarApi } from "../../../../packages/ui/src/chat/chat-api.js";
import type {
  ConversationRow,
  DmContactInput,
} from "../../../../packages/ui/src/chat/sidebar-model.js";

import { createChatSidebarApi } from "./chat-adapter.js";

function rosterAdapter(listContacts: unknown): PlatformAdapter {
  return {
    messaging: { listContacts },
  } as unknown as PlatformAdapter;
}

describe("createChatSidebarApi company roster", () => {
  it("exposes listCompanyMembers and normalizes scoped envelope and bare-array rosters", async () => {
    const listContacts = vi
      .fn()
      .mockResolvedValueOnce(
        ok({
          contacts: [{ personUid: "prs_ada", displayName: "Ada" }],
        }),
      )
      .mockResolvedValueOnce(ok([{ personUid: "prs_kai", displayName: "Kai" }]));
    const api = createChatSidebarApi(rosterAdapter(listContacts));

    expect(
      api.listCompanyMembers,
      "live sidebar API must expose the listCompanyMembers capability",
    ).toBeTypeOf("function");
    await expect(api.listCompanyMembers?.("cmp_indigo")).resolves.toEqual({
      contacts: [{ personUid: "prs_ada", displayName: "Ada" }],
    });
    await expect(api.listCompanyMembers?.("cmp_holler")).resolves.toEqual({
      contacts: [{ personUid: "prs_kai", displayName: "Kai" }],
    });
    expect(listContacts).toHaveBeenNthCalledWith(1, {
      companyUid: "cmp_indigo",
    });
    expect(listContacts).toHaveBeenNthCalledWith(2, {
      companyUid: "cmp_holler",
    });
  });
});

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function personRow(): ConversationRow {
  return {
    id: "dm:prs_kai",
    kind: "dm",
    title: "Kai",
    personUid: "prs_kai",
    companyUid: null,
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
  };
}

function find<T extends Element>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

async function gotoCreate(): Promise<void> {
  const query = find<HTMLInputElement>("[data-testid=\"chat-create-query\"]");
  if (!query) throw new Error("CreateModal query input was not rendered");
  query.value = "Growth";
  query.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  await tick();
  const create = find<HTMLButtonElement>(
    "[data-testid=\"chat-create-channel-row\"]",
  );
  if (!create) throw new Error("CreateModal channel-create row was not rendered");
  create.click();
  await tick();
}

async function pickKai(): Promise<void> {
  const picker = find<HTMLInputElement>(
    "[data-testid=\"chat-channel-participants\"]",
  );
  if (!picker) throw new Error("CreateModal member picker was not rendered");
  picker.value = "Kai";
  picker.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  const suggestion = find<HTMLButtonElement>(
    "[data-testid=\"chat-channel-suggestion\"]",
  );
  if (!suggestion) throw new Error("CreateModal Kai suggestion was not rendered");
  suggestion.click();
  await tick();
}

describe("CreateModal with the live chat sidebar API", () => {
  beforeEach(() => {
    host = document.createElement("div");
    host.className = "desktop-shell chat-shell";
    document.body.appendChild(host);
  });

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    host.remove();
  });

  it("raises confirmation for an outside invitee from the live scoped roster", async () => {
    const listContacts = vi.fn(async () =>
      ok({
        contacts: [{ personUid: "prs_ada", displayName: "Ada" }],
      }),
    );
    const api: ChatSidebarApi = createChatSidebarApi(
      rosterAdapter(listContacts),
    );
    const contacts: DmContactInput[] = [
      { personUid: "prs_kai", displayName: "Kai" },
    ];

    component = mount(CreateModal, {
      target: host,
      props: {
        api,
        rows: [personRow()],
        contacts,
        scopeCompanies: [{ companyUid: "cmp_indigo", label: "Indigo" }],
        activeScope: "cmp_indigo",
        self: { uid: "prs_me", displayName: "Me" },
        onclose: () => {},
        onpick: () => {},
        oncreated: () => {},
      },
    });

    await tick();
    await gotoCreate();
    await vi.waitFor(() => {
      expect(
        listContacts,
        "live listCompanyMembers must call the adapter's company-scoped contacts feed",
      ).toHaveBeenCalledWith({ companyUid: "cmp_indigo" });
    });
    await pickKai();

    expect(
      find('[data-testid="chat-create-confirm-external"]'),
      "the live listCompanyMembers capability must make CreateModal confirm an outside invitee",
    ).toBeTruthy();
  });
});

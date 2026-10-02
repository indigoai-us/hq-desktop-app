// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import NewChannelSheet from "./NewChannelSheet.svelte";
import type { ChatSidebarApi } from "./chat-api.js";
import type { ConversationRow } from "./sidebar-model.js";

function row(personUid: string, title: string): ConversationRow {
  return {
    id: `dm:${personUid}`,
    kind: "dm",
    title,
    companyUid: "cmp_indigo",
    unreadDot: false,
    lastActivityAt: 1,
    pinned: false,
    personUid,
  };
}

describe("US-017 new channel sheet", () => {
  let host: HTMLDivElement;
  afterEach(() => host?.remove());

  it("creates a channel with two members and lands on it", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const createChannel = vi.fn(async () => ({ channelId: "chn_cost" }));
    const addChannelMember = vi.fn(async () => {});
    const api = {
      createChannel,
      addChannelMember,
      sendChannelMessage: vi.fn(async () => {}),
    } as unknown as ChatSidebarApi;
    const onclose = vi.fn();
    const component = mount(NewChannelSheet, {
      target: host,
      props: {
        api,
        rows: [row("prs_eric", "Eric"), row("prs_maggie", "Maggie")],
        contacts: [],
        companies: [{ companyUid: "cmp_indigo", label: "Indigo" }],
        activeCompanyUid: "cmp_indigo",
        onclose,
        aftercreate: () => {},
      },
    });
    await tick();
    const name = document.querySelector<HTMLInputElement>('[data-testid="new-channel-name"]')!;
    name.value = "cost-desktop-push";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(document.querySelector('[data-testid="new-channel-path"]')?.textContent).toBe(
      "companies/indigo/channels/cost-desktop-push",
    );
    const people = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="people-picker-row"]')];
    expect(people.map((node) => node.dataset.id)).toEqual(["prs_eric", "prs_maggie"]);
    people[0].click();
    people[1].click();
    await tick();
    document.querySelector<HTMLButtonElement>('[data-testid="new-channel-create"]')!.click();
    await tick();
    await tick();
    expect(createChannel).toHaveBeenCalledWith({
      name: "cost-desktop-push",
      scope: "company",
      companyUid: "cmp_indigo",
      visibility: "invite",
    });
    await vi.waitFor(() => expect(onclose).toHaveBeenCalled());
    expect(addChannelMember).toHaveBeenCalledTimes(2);
    expect(onclose).toHaveBeenCalledWith("chn_cost", {
      title: "cost-desktop-push",
      companyUid: "cmp_indigo",
    });
    await unmount(component);
  });
});

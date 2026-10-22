// @vitest-environment happy-dom

/**
 * "+ Add" row under MEMBERS in the channel status popover: hidden without a
 * callback or candidates, folds open an inline filterable list, raises
 * onaddmember(row), shows the in-flight "…" and the inline error. No new
 * screen or modal — it is a state inside the existing popover.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount, tick } from "svelte";

import ChannelStatusPopover from "./ChannelStatusPopover.svelte";
import type {
  AddMemberCandidate,
  ChannelStatusModel,
} from "./channel-status-model.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function model(): ChannelStatusModel {
  return {
    liveAgents: [],
    activeSessions: [],
    stories: { complete: 0, total: 0, label: "stories 0/0", percent: 0 },
    project: { branch: null, repo: null, repos: [], previewUrl: null },
    members: [
      {
        personUid: "prs_me",
        displayName: "Ada Lovelace",
        role: "owner",
        email: null,
        avatarUrl: null,
        description: null,
        statusIcon: "idle",
        online: false,
      },
    ],
    agents: [],
    memberCount: 1,
    companyLabel: null,
  };
}

const CANDIDATES: AddMemberCandidate[] = [
  { personUid: "agt_jimbo", displayName: "Jimbo", kind: "bot", handle: "jimbo" },
  { personUid: "prs_amy", displayName: "Amy Lee", kind: "person" },
  {
    personUid: "prs_zed",
    displayName: "Zed Ops",
    kind: "person",
    avatarUrl: "https://example.test/zed.png",
  },
];

function mountPopover(
  props: Partial<Record<string, unknown>> = {},
): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelStatusPopover, {
    target: host,
    props: { model: model(), self: { uid: "prs_me" }, ...props },
  });
}

const q = <T extends Element = HTMLElement>(sel: string) =>
  host.querySelector<T>(sel);
const qa = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];

async function openAddList(): Promise<void> {
  q<HTMLButtonElement>('[data-testid="status-member-add"]')!.click();
  await tick();
}

describe("ChannelStatusPopover — + Add row", () => {
  it("is hidden without an onaddmember callback", () => {
    mountPopover({ addCandidates: CANDIDATES });
    expect(q('[data-testid="status-member-add"]')).toBeNull();
    expect(q('[data-testid="status-add-list"]')).toBeNull();
  });

  it("is hidden when there is no one to add", () => {
    mountPopover({ onaddmember: vi.fn(), addCandidates: [] });
    expect(q('[data-testid="status-member-add"]')).toBeNull();
  });

  it("folds open an inline list of candidates, bots first, with handle and avatar", async () => {
    mountPopover({ onaddmember: vi.fn(), addCandidates: CANDIDATES });
    const add = q<HTMLButtonElement>('[data-testid="status-member-add"]');
    expect(add).toBeTruthy();
    expect(add!.textContent).toContain("Add");
    expect(add!.getAttribute("aria-expanded")).toBe("false");
    expect(q('[data-testid="status-add-list"]')).toBeNull();

    await openAddList();

    expect(add!.getAttribute("aria-expanded")).toBe("true");
    expect(q('[data-testid="status-add-list"]')).toBeTruthy();
    const rows = qa('[data-testid="status-add-candidate"]');
    expect(rows.map((r) => r.dataset.uid)).toEqual([
      "agt_jimbo",
      "prs_amy",
      "prs_zed",
    ]);
    expect(rows[0].dataset.kind).toBe("bot");
    expect(rows[0].textContent).toContain("Jimbo");
    expect(rows[0].textContent).toContain("@jimbo");
    expect(rows[0].querySelector(".m-ava.ai svg")).toBeTruthy();
    expect(rows[2].querySelector("img")?.getAttribute("src")).toBe(
      "https://example.test/zed.png",
    );
    // No stray dialog / modal was created anywhere.
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);

    await openAddList();
    expect(q('[data-testid="status-add-list"]')).toBeNull();
    expect(add!.getAttribute("aria-expanded")).toBe("false");
  });

  it("filters candidates by name or handle and says when nothing matches", async () => {
    mountPopover({ onaddmember: vi.fn(), addCandidates: CANDIDATES });
    await openAddList();
    const input = q<HTMLInputElement>('[data-testid="status-add-filter"]')!;
    input.value = "jim";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(
      qa('[data-testid="status-add-candidate"]').map((r) => r.dataset.uid),
    ).toEqual(["agt_jimbo"]);

    input.value = "nobody";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(qa('[data-testid="status-add-candidate"]')).toHaveLength(0);
    expect(q('[data-testid="status-add-empty"]')?.textContent).toContain(
      "No one matches",
    );
  });

  it("clicking a candidate raises onaddmember with that row", async () => {
    const onaddmember = vi.fn();
    mountPopover({ onaddmember, addCandidates: CANDIDATES });
    await openAddList();
    qa('[data-testid="status-add-candidate"]')[1].click();
    expect(onaddmember).toHaveBeenCalledTimes(1);
    expect(onaddmember).toHaveBeenCalledWith(CANDIDATES[1]);
  });

  it("shows … on the adding row and blocks a second submission while in flight", async () => {
    const onaddmember = vi.fn();
    mountPopover({
      onaddmember,
      addCandidates: CANDIDATES,
      addingUid: "agt_jimbo",
    });
    await openAddList();
    const rows = qa('[data-testid="status-add-candidate"]');
    expect(rows[0].getAttribute("aria-busy")).toBe("true");
    expect(rows[0].textContent).toContain("…");
    expect(rows[1].textContent).not.toContain("…");
    for (const row of rows) {
      expect((row as HTMLButtonElement).disabled).toBe(true);
      row.click();
    }
    expect(onaddmember).not.toHaveBeenCalled();
  });

  it("shows the inline error sentence under the list", async () => {
    mountPopover({
      onaddmember: vi.fn(),
      addCandidates: CANDIDATES,
      addError: "Join the channel before adding members.",
    });
    expect(q('[data-testid="status-add-error"]')).toBeNull();
    await openAddList();
    const err = q('[data-testid="status-add-error"]');
    expect(err?.textContent).toContain("Join the channel before adding members.");
    expect(err?.getAttribute("role")).toBe("alert");
  });
});

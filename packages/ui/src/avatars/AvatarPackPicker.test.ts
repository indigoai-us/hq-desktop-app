// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import AvatarPackPicker from "./AvatarPackPicker.svelte";
import type { AvatarPack, AvatarSelection } from "./types.js";

const packs: AvatarPack[] = [
  {
    id: "generated-marks",
    name: "Generated marks",
    version: "1.0.0",
    author: "HQ",
    baseUrl: "builtin:generated-marks",
    items: [
      { id: "agent-01", name: "Mark 01", src: "a.png", tags: ["generated"] },
      { id: "agent-02", name: "Mark 02", src: "b.png", tags: ["generated"] },
    ],
  },
  {
    id: "hq-agent-mascots",
    name: "HQ agent mascots",
    version: "1.0.0",
    author: "Lizzy",
    baseUrl: "https://hq-agent-mascots.indigo-hq.com",
    items: [
      {
        id: "v2-dot",
        name: "Dot · simplified",
        src: "mascots/v2/dot.png",
        tags: ["rabbit", "v2"],
      },
      {
        id: "v1-fox",
        name: "Fox · retro cel",
        src: "mascots/v1/fox.png",
        tags: ["fox", "growth"],
      },
    ],
  },
];

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("AvatarPackPicker", () => {
  it("groups by pack and filters by name/tag", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AvatarPackPicker, {
      target: host,
      props: { agentUid: "agt_scout", packs },
    });
    await tick();
    expect(host.querySelectorAll('[data-testid="avatar-pack-item"]').length).toBe(
      4,
    );
    const search = host.querySelector(
      '[data-testid="avatar-pack-search"]',
    ) as HTMLInputElement;
    search.value = "fox";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    const visible = [
      ...host.querySelectorAll('[data-testid="avatar-pack-item"]'),
    ] as HTMLButtonElement[];
    expect(visible.map((btn) => btn.dataset.item)).toEqual(["v1-fox"]);
  });

  it("highlights the current selection and saves it", async () => {
    const onsave = vi.fn(async (_selection: AvatarSelection) => {});
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AvatarPackPicker, {
      target: host,
      props: { agentUid: "agt_scout", packs, onsave },
    });
    await tick();
    const dot = host.querySelector(
      '[data-item="v2-dot"]',
    ) as HTMLButtonElement;
    dot.click();
    await tick();
    expect(dot.getAttribute("aria-selected")).toBe("true");
    (
      host.querySelector('[data-testid="avatar-pack-save"]') as HTMLButtonElement
    ).click();
    await tick();
    expect(onsave).toHaveBeenCalledWith({
      kind: "item",
      packId: "hq-agent-mascots",
      itemId: "v2-dot",
    });
  });

  it("saves Use generated mark", async () => {
    const onsave = vi.fn(async (_selection: AvatarSelection) => {});
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AvatarPackPicker, {
      target: host,
      props: { agentUid: "agt_scout", packs, onsave },
    });
    await tick();
    (
      host.querySelector(
        '[data-testid="avatar-use-generated"]',
      ) as HTMLButtonElement
    ).click();
    (
      host.querySelector('[data-testid="avatar-pack-save"]') as HTMLButtonElement
    ).click();
    await tick();
    expect(onsave).toHaveBeenCalledWith({ kind: "generated" });
  });

  it("moves the keyboard cursor across the flattened grid", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AvatarPackPicker, {
      target: host,
      props: { agentUid: "agt_scout", packs },
    });
    await tick();
    const grid = host.querySelector(
      '[data-testid="avatar-pack-grid"]',
    ) as HTMLDivElement;
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await tick();
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    const selected = host.querySelector('[aria-selected="true"]') as HTMLButtonElement;
    expect(selected?.dataset.item).toBe("agent-02");
  });
});

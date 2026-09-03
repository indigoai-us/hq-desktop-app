// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import AvatarPackPicker from "./AvatarPackPicker.svelte";
import { generatedMarksPack } from "./generated-marks.js";
import { MARKETPLACE_COVER_HOST } from "./csp-image-src.js";
import type { AvatarPack, AvatarSelection } from "./types.js";
import {
  GENERATED_MARKS_AUTHOR,
  HQ_AGENT_MASCOTS_AUTHOR,
  HQ_AGENT_MASCOTS_PACK_NAME,
} from "./types.js";

const packs: AvatarPack[] = [
  {
    id: "generated-marks",
    name: "Generated marks",
    version: "1.0.0",
    author: "Default",
    baseUrl: "builtin:generated-marks",
    items: [
      { id: "agent-01", name: "Mark 01", src: "a.png", tags: ["generated"] },
      { id: "agent-02", name: "Mark 02", src: "b.png", tags: ["generated"] },
    ],
  },
  {
    id: "hq-agent-mascots",
    name: "Animals",
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

  it("renders Animals / Default headings and lazy-loads marketplace thumbs", async () => {
    const animals: AvatarPack = {
      id: "animals",
      name: HQ_AGENT_MASCOTS_PACK_NAME,
      version: "1.0.0",
      author: HQ_AGENT_MASCOTS_AUTHOR,
      baseUrl: "",
      items: [
        {
          id: "v2-dot",
          name: "Dot · simplified",
          src: `https://${MARKETPLACE_COVER_HOST}/avatar-packs/animals/thumbs/v2-dot.png?X-Amz-Signature=mock`,
          tags: ["v2"],
        },
      ],
    };
    const live = [generatedMarksPack(["/assets/agent-01.png"]), animals];
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AvatarPackPicker, {
      target: host,
      props: { agentUid: "agt_scout", packs: live },
    });
    await tick();
    expect(host.textContent).toContain("Generated marks");
    expect(host.textContent).toContain(`${GENERATED_MARKS_AUTHOR} · 1.0.0`);
    expect(host.textContent).toContain(HQ_AGENT_MASCOTS_PACK_NAME);
    expect(host.textContent).toContain(`${HQ_AGENT_MASCOTS_AUTHOR} · 1.0.0`);
    expect(host.textContent).not.toContain("HQ agent mascots");
    expect(host.textContent).not.toContain("HQ · 1.0.0");

    const remoteImg = host.querySelector(
      '[data-item="v2-dot"] img',
    ) as HTMLImageElement;
    expect(remoteImg).not.toBeNull();
    expect(remoteImg.getAttribute("loading")).toBe("lazy");
    expect(remoteImg.getAttribute("src")).toContain("/avatar-packs/");
  });

  it("shows a skeleton while the gallery is loading", async () => {
    let resolvePacks: (packs: AvatarPack[]) => void = () => {};
    const pending = new Promise<AvatarPack[]>((resolve) => {
      resolvePacks = resolve;
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AvatarPackPicker, {
      target: host,
      props: {
        agentUid: "agt_scout",
        loadPacks: () => pending,
      },
    });
    await tick();
    expect(host.querySelector('[data-testid="avatar-pack-skeleton"]')).not.toBeNull();
    resolvePacks(packs);
    await tick();
    await tick();
    expect(host.querySelector('[data-testid="avatar-pack-skeleton"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="avatar-pack-item"]').length).toBeGreaterThan(0);
  });

  it("shows a visible fallback mark when a tile image fails to load", async () => {
    const broken: AvatarPack[] = [
      {
        id: "generated-marks",
        name: "Generated marks",
        version: "1.0.0",
        author: "Default",
        baseUrl: "builtin:generated-marks",
        items: [
          {
            id: "agent-01",
            name: "Mark 01",
            src: "/this-avatar-does-not-exist.png",
            tags: ["generated"],
          },
        ],
      },
    ];
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AvatarPackPicker, {
      target: host,
      props: { agentUid: "agt_scout", packs: broken },
    });
    await tick();
    const img = host.querySelector(
      '[data-item="agent-01"] img',
    ) as HTMLImageElement;
    expect(img).not.toBeNull();
    img.dispatchEvent(new Event("error"));
    await tick();
    const fallback = host.querySelector(
      '[data-item="agent-01"] [data-testid="avatar-pack-item-fallback"]',
    );
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent?.trim()).toBe("M0");
    expect(img.classList.contains("is-broken")).toBe(true);
  });

  it("falls back immediately when a pack src is a remote URL the CSP would block", async () => {
    const remoteOnly: AvatarPack[] = [
      {
        id: "hq-agent-mascots",
        name: "Animals",
        version: "1.0.0",
        author: "Lizzy",
        baseUrl: "https://hq-agent-mascots.indigo-hq.com",
        items: [
          {
            id: "v2-dot",
            name: "Dot · simplified",
            src: "https://hq-agent-mascots.indigo-hq.com/mascots/v2/dot.png",
            tags: ["v2"],
          },
        ],
      },
    ];
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AvatarPackPicker, {
      target: host,
      props: { agentUid: "agt_scout", packs: remoteOnly },
    });
    await tick();
    expect(host.querySelector('[data-item="v2-dot"] img')).toBeNull();
    expect(
      host.querySelector(
        '[data-item="v2-dot"] [data-testid="avatar-pack-item-fallback"]',
      )?.textContent?.trim(),
    ).toBe("DS");
  });
});

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import AvatarPickerSlot from "./AvatarPickerSlot.svelte";
import type { AvatarPack, AvatarSelection } from "../avatars/types.js";

const packs: AvatarPack[] = [
  {
    id: "generated-marks",
    name: "Generated marks",
    version: "1.0.0",
    author: "HQ",
    baseUrl: "builtin:generated-marks",
    items: [
      { id: "agent-01", name: "Mark 01", src: "a.png", tags: ["generated"] },
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

describe("AvatarPickerSlot", () => {
  it("renders the pack picker from #605 in the agent-detail slot", async () => {
    const onsave = vi.fn(async (_selection: AvatarSelection) => {});
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AvatarPickerSlot, {
      target: host,
      props: {
        agentUid: "agt_izzy",
        displayName: "Izzy",
        packs,
        onsave,
      },
    });
    await tick();
    expect(
      host.querySelector('[data-testid="agent-detail-avatar-picker-slot"]'),
    ).not.toBeNull();
    expect(host.querySelector('[data-testid="avatar-pack-picker"]')).not.toBeNull();
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

  it("hides the picker when the slot is disabled", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AvatarPickerSlot, {
      target: host,
      props: {
        agentUid: "agt_izzy",
        displayName: "Izzy",
        disabled: true,
        packs,
      },
    });
    await tick();
    expect(
      host.querySelector('[data-testid="agent-detail-avatar-picker-slot"]'),
    ).not.toBeNull();
    expect(host.querySelector('[data-testid="avatar-pack-picker"]')).toBeNull();
  });
});

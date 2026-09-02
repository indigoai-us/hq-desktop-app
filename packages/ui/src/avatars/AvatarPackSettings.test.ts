// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import AvatarPackSettings from "./AvatarPackSettings.svelte";
import { HQ_AGENT_MASCOTS_BASE_URL, PACK_REGISTRY_STORAGE_KEY } from "./types.js";

function memoryStorage(seed: Record<string, string> = {}) {
  const store = { ...seed };
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("AvatarPackSettings", () => {
  it("lists default packs and can add/remove a URL", async () => {
    const storage = memoryStorage();
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AvatarPackSettings, {
      target: host,
      props: { storage },
    });
    await tick();
    expect(host.textContent).toContain(HQ_AGENT_MASCOTS_BASE_URL);

    const input = host.querySelector(
      '[data-testid="avatar-pack-url-input"]',
    ) as HTMLInputElement;
    input.value = "https://avatars.example.test/pack";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    (
      host.querySelector('[data-testid="avatar-pack-url-add"]') as HTMLButtonElement
    ).click();
    await tick();
    expect(host.textContent).toContain("https://avatars.example.test/pack");
    expect(JSON.parse(storage.getItem(PACK_REGISTRY_STORAGE_KEY) ?? "[]")).toEqual([
      HQ_AGENT_MASCOTS_BASE_URL,
      "https://avatars.example.test/pack",
    ]);

    const removes = [
      ...host.querySelectorAll('[data-testid="avatar-pack-url-remove"]'),
    ] as HTMLButtonElement[];
    removes[1]?.click();
    await tick();
    expect(host.textContent).not.toContain("https://avatars.example.test/pack");
  });
});

// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import AppRail from "./AppRail.svelte";
import { railItems } from "./app-rail.js";

const items = railItems([{ uid: "co_a", label: "Indigo", liveCount: 0 }], "Jonathan Drake");

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function renderRail(youPhoto: string | null, youPhotoPulse = 0): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(AppRail, {
    target: host,
    props: { items, activeId: null, youInitials: "JD", youPhoto, youPhotoPulse, onselect: () => {} },
  });
  await tick();
  return host.querySelector<HTMLElement>("[data-testid='rail-you'] .avatar")!;
}

describe("rail You avatar photo", () => {
  it("points at the photo with the HQ glow and an arrow after a save", async () => {
    await renderRail("data:image/png;base64,AAAA", 1);
    expect(host.querySelector("[data-testid='rail-you-glow']")).not.toBeNull();
    expect(host.querySelector("[data-testid='rail-you-arrow']")).not.toBeNull();
  });

  it("shows no arrow before any save", async () => {
    await renderRail("data:image/png;base64,AAAA");
    expect(host.querySelector("[data-testid='rail-you-arrow']")).toBeNull();
    expect(host.querySelector("[data-testid='rail-you-glow']")).toBeNull();
  });

  it("shows the saved profile photo instead of initials", async () => {
    const photo =
      "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/members/prs_jd/a.jpg?sig=1";
    const avatar = await renderRail(photo);
    const img = avatar.querySelector("[data-testid='rail-you-photo']");
    expect(img?.getAttribute("src")).toBe(photo);
    expect(avatar.textContent).not.toContain("JD");
  });

  it("keeps initials for a photo from a host the app cannot load", async () => {
    const avatar = await renderRail("https://tracker.example.com/p.png");
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toContain("JD");
  });

  it("falls back to initials when the photo fails to load", async () => {
    const avatar = await renderRail("data:image/png;base64,AAAA");
    const img = avatar.querySelector("[data-testid='rail-you-photo']")!;
    img.dispatchEvent(new Event("error"));
    flushSync();
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toContain("JD");
  });
});

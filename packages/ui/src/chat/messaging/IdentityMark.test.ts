// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount, flushSync } from "svelte";

import IdentityMark from "./IdentityMark.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("IdentityMark avatar", () => {
  it("renders a photo when avatarUrl is provided for a person", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(IdentityMark, {
      target: host,
      props: { kind: "person", label: "Ada", avatarUrl: "https://cdn/x.jpg" },
    });
    const img = host.querySelector("img.avatar-img") as HTMLImageElement | null;
    expect(img?.getAttribute("src")).toBe("https://cdn/x.jpg");
    expect(host.querySelector(".monogram")).toBeNull();
  });

  it("shows the monogram when no avatarUrl", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(IdentityMark, {
      target: host,
      props: { kind: "person", label: "Ada Lovelace" },
    });
    expect(host.querySelector("img.avatar-img")).toBeNull();
    expect(host.querySelector(".monogram")?.textContent).toBe("AL");
  });

  it("falls back to the monogram when the image fails to load", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(IdentityMark, {
      target: host,
      props: { kind: "person", label: "Ada", avatarUrl: "https://cdn/x.jpg" },
    });
    const img = host.querySelector("img.avatar-img") as HTMLImageElement;
    img.dispatchEvent(new Event("error"));
    flushSync();
    expect(host.querySelector("img.avatar-img")).toBeNull();
    expect(host.querySelector(".monogram")).not.toBeNull();
  });

  it("ignores avatarUrl for non-person/agent kinds (channel)", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(IdentityMark, {
      target: host,
      props: {
        kind: "channel",
        label: "general",
        avatarUrl: "https://cdn/x.jpg",
      },
    });
    expect(host.querySelector("img.avatar-img")).toBeNull();
  });
});

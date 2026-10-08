// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import Avatar from "./Avatar.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

function render(props: Record<string, unknown>): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  component = mount(Avatar, { target: host, props: props as never });
  flushSync();
  return host.querySelector<HTMLElement>("[data-testid='avatar']")!;
}

describe("Avatar", () => {
  it("draws a photo when the identity cache has one", () => {
    const el = render({ kind: "person", name: "Ada", id: "prs_ada", photo: "data:image/png;base64,AAAA" });
    expect(el.dataset.face).toBe("photo");
    expect(el.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it("draws colored initials for a person with no photo", () => {
    const el = render({ kind: "person", name: "Hassaan Saleem", id: "prs_hs" });
    expect(el.dataset.face).toBe("initials");
    expect(el.textContent?.trim()).toBe("HS");
    expect(el.getAttribute("style")).toMatch(/--av-hue:\s*\d+/);
  });

  it("never draws initials for a bot", () => {
    const el = render({ kind: "bot", name: "Izzy", id: "agt_izzy" });
    expect(["mascot", "glyph"]).toContain(el.dataset.face);
    expect(el.textContent?.trim()).not.toBe("IZ");
  });

  it("falls back from a broken photo to initials", () => {
    const el = render({ kind: "person", name: "Ada Lovelace", id: "prs_ada", photo: "data:image/png;base64,AAAA" });
    el.querySelector("img")!.dispatchEvent(new Event("error"));
    flushSync();
    const after = host!.querySelector<HTMLElement>("[data-testid='avatar']")!;
    expect(after.dataset.face).toBe("initials");
    expect(after.textContent?.trim()).toBe("AL");
  });

  it("puts the presence badge in its own element, only when asked", () => {
    const online = render({ kind: "person", name: "Ada", id: "prs_ada", presence: "online" });
    const badge = online.querySelector("[data-testid='avatar-presence']");
    expect(badge?.classList.contains("online")).toBe(true);
  });

  it("has no badge without presence", () => {
    const el = render({ kind: "person", name: "Ada", id: "prs_ada" });
    expect(el.querySelector("[data-testid='avatar-presence']")).toBeNull();
  });
});

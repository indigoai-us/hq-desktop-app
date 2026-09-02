// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount, flushSync } from "svelte";

import { MARKETPLACE_COVER_HOST } from "../../avatars/csp-image-src";
import IdentityMark from "./IdentityMark.svelte";
import { agentAvatarAssets, agentAvatarFor } from "./agent-avatars";

const ADA_PHOTO = `https://${MARKETPLACE_COVER_HOST}/members/prs_ada/h.png?X-Amz-Signature=mock`;
const AGENT_PHOTO = `https://${MARKETPLACE_COVER_HOST}/members/agt_parker/h.png?X-Amz-Signature=mock`;

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
      props: { kind: "person", label: "Ada", avatarUrl: ADA_PHOTO },
    });
    const img = host.querySelector("img.avatar-img") as HTMLImageElement | null;
    expect(img?.getAttribute("src")).toBe(ADA_PHOTO);
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
      props: { kind: "person", label: "Ada", avatarUrl: ADA_PHOTO },
    });
    const img = host.querySelector("img.avatar-img") as HTMLImageElement;
    img.dispatchEvent(new Event("error"));
    flushSync();
    expect(host.querySelector("img.avatar-img")).toBeNull();
    expect(host.querySelector(".monogram")).not.toBeNull();
  });

  it("prefers the assigned photo over the generated avatar for agents", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(IdentityMark, {
      target: host,
      props: {
        kind: "agent",
        label: "Parker",
        avatarUrl: AGENT_PHOTO,
        agentUid: "agt_parker",
      },
    });
    const img = host.querySelector("img.avatar-img") as HTMLImageElement | null;
    expect(img?.getAttribute("src")).toBe(AGENT_PHOTO);
  });

  it("renders a deterministic generated avatar for a photo-less agent", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(IdentityMark, {
      target: host,
      props: { kind: "agent", label: "Parker", agentUid: "agt_parker" },
    });
    const img = host.querySelector("img.avatar-img") as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(agentAvatarAssets).toContain(img?.getAttribute("src"));
    expect(img?.getAttribute("src")).toBe(agentAvatarFor("agt_parker"));
    expect(host.querySelector(".agent-glyph")).toBeNull();
  });

  it("keeps the ✦ glyph for agents with no uid", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(IdentityMark, {
      target: host,
      props: { kind: "agent", label: "Parker" },
    });
    expect(host.querySelector("img.avatar-img")).toBeNull();
    expect(host.querySelector(".agent-glyph")).not.toBeNull();
  });

  it("ignores agentUid for non-agent kinds (person keeps monogram)", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(IdentityMark, {
      target: host,
      props: { kind: "person", label: "Ada Lovelace", agentUid: "agt_parker" },
    });
    expect(host.querySelector("img.avatar-img")).toBeNull();
    expect(host.querySelector(".monogram")?.textContent).toBe("AL");
  });

  it("falls back to the ✦ glyph when the generated asset fails to load", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(IdentityMark, {
      target: host,
      props: { kind: "agent", label: "Parker", agentUid: "agt_parker" },
    });
    const img = host.querySelector("img.avatar-img") as HTMLImageElement;
    img.dispatchEvent(new Event("error"));
    flushSync();
    expect(host.querySelector("img.avatar-img")).toBeNull();
    expect(host.querySelector(".agent-glyph")).not.toBeNull();
  });

  it("ignores avatarUrl for non-person/agent kinds (channel)", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(IdentityMark, {
      target: host,
      props: {
        kind: "channel",
        label: "general",
        avatarUrl: ADA_PHOTO,
      },
    });
    expect(host.querySelector("img.avatar-img")).toBeNull();
  });

  it("does not paint an arbitrary https avatarUrl (packaged CSP contract)", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(IdentityMark, {
      target: host,
      props: {
        kind: "person",
        label: "Ada Lovelace",
        avatarUrl: "https://cdn.test/ada.jpg",
      },
    });
    expect(host.querySelector("img.avatar-img")).toBeNull();
    expect(host.querySelector(".monogram")?.textContent).toBe("AL");
  });
});

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

  it("renders a presence span when online=true", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(IdentityMark, {
      target: host,
      props: { kind: "person", label: "Ada", online: true },
    });
    expect(host.querySelector(".presence")).not.toBeNull();
  });

  it("omits the presence span when online is false", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(IdentityMark, {
      target: host,
      props: { kind: "person", label: "Ada", online: false },
    });
    expect(host.querySelector(".presence")).toBeNull();
  });
});

// Moved from apps/sync/src/components/messaging/IdentityMark.test.ts when the
// desktop copy of IdentityMark was removed in favour of this one.
describe("IdentityMark non-person kinds", () => {
  it("draws two stacked monograms for a group DM, without photo tiles", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(IdentityMark, {
      target: host,
      props: { kind: "group", members: ["Jacob Patel", "Alan Turing"] },
    });
    expect(host.querySelectorAll('[data-kind="group"] .stack > span')).toHaveLength(2);
  });

  it("draws a lock for a private channel", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(IdentityMark, {
      target: host,
      props: { kind: "channel", privateChannel: true },
    });
    expect(host.querySelector('[data-kind="channel"] .channel-lock')).not.toBeNull();
  });
});

// The online dot sits in a gap cut out of the avatar (iOS, hq-native-mobile
// #37), so it reads on any surface. A border painted in the window's ground
// colour matched one surface and drew a grey ring on hovered or selected rows.
describe("IdentityMark presence", () => {
  it("cuts the avatar around the online dot instead of ringing the dot", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(IdentityMark, {
      target: host,
      props: { kind: "person", label: "Ada", online: true },
    });
    flushSync();
    expect(host.querySelector(".identity")?.classList.contains("has-presence")).toBe(true);
    expect(host.querySelector(".presence")).not.toBeNull();

    // happy-dom cannot paint a mask, so the CSS contract is read from source.
    const css = readFileSync(resolve(process.cwd(), "src/chat/messaging/IdentityMark.svelte"), "utf8");
    const rule = (sel: string) => css.match(new RegExp(`\\n  ${sel.replace(/\./g, "\\.")} \\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule(".identity.has-presence")).toMatch(/mask:/);
    expect(rule(".presence")).not.toMatch(/border:/);
  });

  it("has no cut-out when the person is offline", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(IdentityMark, { target: host, props: { kind: "person", label: "Ada" } });
    flushSync();
    expect(host.querySelector(".identity")?.classList.contains("has-presence")).toBe(false);
  });
});

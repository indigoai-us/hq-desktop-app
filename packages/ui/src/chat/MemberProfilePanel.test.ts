// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";

import { MARKETPLACE_COVER_HOST } from "../avatars/csp-image-src.js";
import MemberProfilePanel from "./MemberProfilePanel.svelte";
import type { StatusPersonRow } from "./channel-status-model.js";

const MARCUS_PHOTO = `https://${MARKETPLACE_COVER_HOST}/members/prs_marcus/h.png?X-Amz-Signature=mock`;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function row(over: Partial<StatusPersonRow> = {}): StatusPersonRow {
  return {
    personUid: "prs_marcus",
    displayName: "Marcus Chen",
    email: "marcus@example.com",
    role: "member",
    avatarUrl: null,
    description: null,
    statusIcon: "idle",
    online: false,
    ...over,
  };
}

describe("MemberProfilePanel", () => {
  it("renders name, email, and a monogram avatar when no photo", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MemberProfilePanel, {
      target: host,
      props: { member: row() },
    });

    expect(
      host.querySelector('[data-testid="member-profile-name"]')?.textContent,
    ).toContain("Marcus Chen");
    const email = host.querySelector('[data-testid="member-profile-email"]');
    expect(email?.textContent).toBe("marcus@example.com");
    expect(email?.getAttribute("href")).toBe("mailto:marcus@example.com");
    // No avatarUrl → monogram, not an <img>.
    expect(
      host.querySelector('[data-testid="member-profile-avatar-img"]'),
    ).toBeNull();
  });

  it("uses a photo when an avatarUrl is supplied", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MemberProfilePanel, {
      target: host,
      props: { member: row(), avatarUrl: MARCUS_PHOTO },
    });
    const img = host.querySelector(
      '[data-testid="member-profile-avatar-img"]',
    ) as HTMLImageElement | null;
    expect(img?.getAttribute("src")).toBe(MARCUS_PHOTO);
  });

  it("does not paint an arbitrary https avatarUrl (packaged CSP contract)", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MemberProfilePanel, {
      target: host,
      props: { member: row(), avatarUrl: "https://cdn.test/a.jpg" },
    });
    expect(
      host.querySelector('[data-testid="member-profile-avatar-img"]'),
    ).toBeNull();
  });

  it("tags the panel 'you' for the signed-in member", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MemberProfilePanel, {
      target: host,
      props: { member: row({ personUid: "prs_me" }), self: { uid: "prs_me" } },
    });
    expect(
      host.querySelector('[data-testid="member-profile-you"]'),
    ).not.toBeNull();
  });

  it("renders the About line from the member's description", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MemberProfilePanel, {
      target: host,
      props: { member: row({ description: "Founder, building HQ" }) },
    });
    expect(
      host.querySelector('[data-testid="member-profile-about"]')?.textContent,
    ).toBe("Founder, building HQ");
  });

  it("shows the avatar picker only when the member is editable", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MemberProfilePanel, {
      target: host,
      props: {
        member: row({ personUid: "agt_scout", displayName: "Scout" }),
        editable: true,
        packs: [
          {
            id: "generated-marks",
            name: "Generated marks",
            version: "1.0.0",
            author: "Default",
            baseUrl: "builtin:generated-marks",
            items: [
              { id: "agent-01", name: "Mark 01", src: "a.png", tags: ["generated"] },
            ],
          },
        ],
      },
    });
    expect(
      host.querySelector('[data-testid="member-profile-avatar-picker"]'),
    ).not.toBeNull();
    expect(host.querySelector('[data-testid="avatar-pack-picker"]')).not.toBeNull();
  });

  it("hides the picker for read-only profiles", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MemberProfilePanel, {
      target: host,
      props: { member: row({ personUid: "agt_scout", displayName: "Scout" }) },
    });
    expect(
      host.querySelector('[data-testid="member-profile-avatar-picker"]'),
    ).toBeNull();
  });

  it("uses the member's own avatarUrl when no explicit photo is passed", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MemberProfilePanel, {
      target: host,
      props: { member: row({ avatarUrl: MARCUS_PHOTO }) },
    });
    const img = host.querySelector(
      '[data-testid="member-profile-avatar-img"]',
    ) as HTMLImageElement | null;
    expect(img?.getAttribute("src")).toBe(MARCUS_PHOTO);
  });
  it("shows a Message button for another person and reports the pick", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const picked: StatusPersonRow[] = [];
    let closed = 0;
    component = mount(MemberProfilePanel, {
      target: host,
      props: {
        member: row(),
        self: { uid: "prs_viewer" },
        onmessage: (member: StatusPersonRow) => picked.push(member),
        onclose: () => (closed += 1),
      },
    });
    const btn = host.querySelector(
      '[data-testid="member-profile-message"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn?.textContent?.trim()).toBe("Message");
    // Focusable, and Enter/Space activate it: a real <button>, not a div.
    expect(btn?.tagName).toBe("BUTTON");
    expect(btn?.getAttribute("type")).toBe("button");
    expect(btn?.hasAttribute("disabled")).toBe(false);
    btn?.click();
    expect(picked.map((p) => p.personUid)).toEqual(["prs_marcus"]);
    // The panel closes once the DM is open.
    expect(closed).toBe(1);
  });

  it("hides the Message button on your own profile but keeps its row", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MemberProfilePanel, {
      target: host,
      props: {
        member: row({ personUid: "prs_viewer", displayName: "You" }),
        self: { uid: "prs_viewer" },
        onmessage: () => {},
      },
    });
    expect(host.querySelector('[data-testid="member-profile-message"]')).toBeNull();
    // The row still occupies the panel, so opening your own profile does not
    // shift everything below it up.
    expect(host.querySelector(".pp-action")).not.toBeNull();
  });

  it("keeps the Message button for an agent profile", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MemberProfilePanel, {
      target: host,
      props: {
        member: row({ personUid: "agt_scout", displayName: "Scout", role: "agent" }),
        self: { uid: "prs_viewer" },
        onmessage: () => {},
      },
    });
    expect(
      host.querySelector('[data-testid="member-profile-message"]'),
    ).not.toBeNull();
  });
});

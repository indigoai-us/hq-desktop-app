// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";

import MemberProfilePanel from "./MemberProfilePanel.svelte";
import type { StatusPersonRow } from "./channel-status-model.js";

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
      props: { member: row(), avatarUrl: "https://cdn.test/a.jpg" },
    });
    const img = host.querySelector(
      '[data-testid="member-profile-avatar-img"]',
    ) as HTMLImageElement | null;
    expect(img?.getAttribute("src")).toBe("https://cdn.test/a.jpg");
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
      props: { member: row({ avatarUrl: "https://cdn/m.jpg" }) },
    });
    const img = host.querySelector(
      '[data-testid="member-profile-avatar-img"]',
    ) as HTMLImageElement | null;
    expect(img?.getAttribute("src")).toBe("https://cdn/m.jpg");
  });
});

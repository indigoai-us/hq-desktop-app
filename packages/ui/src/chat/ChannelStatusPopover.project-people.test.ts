// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelStatusPopover from "./ChannelStatusPopover.svelte";
import type { ChannelStatusModel } from "./channel-status-model.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

/** A project channel's people, shaped like GET /v1/notify/channels/{id}/members. */
function projectModel(): ChannelStatusModel {
  return {
    liveAgents: [],
    activeSessions: [],
    stories: { complete: 1, total: 2, label: "stories 1/2", percent: 50 },
    project: {
      branch: null,
      repo: null,
      repos: [],
      previewUrl: null,
    },
    members: [
      {
        personUid: "prs_stefan",
        displayName: "Stefan Johnson",
        role: "member",
        email: "stefan@getindigo.ai",
        avatarUrl: null,
        description: null,
        statusIcon: "idle",
        online: false,
      },
      {
        personUid: "prs_hassaan",
        displayName: "Hassaan",
        role: "owner",
        email: "hassaan@getindigo.ai",
        avatarUrl: "https://example.invalid/hassaan.jpg",
        description: null,
        statusIcon: "idle",
        online: true,
      },
    ],
    agents: [],
    memberCount: 5,
    companyLabel: "Indigo",
  };
}

function mountPopover(): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelStatusPopover, {
    target: host,
    props: { model: projectModel() },
  });
  return host;
}

describe("ChannelStatusPopover — project people", () => {
  it("lists every person on the project by name", async () => {
    const root = mountPopover();
    await tick();
    const names = [
      ...root.querySelectorAll('[data-testid="status-member"] .m-name'),
    ].map((n) => n.textContent?.trim());
    expect(names).toContain("Stefan Johnson");
    expect(names).toContain("Hassaan");
  });

  it("renders a real profile photo when the roster carries one", async () => {
    const root = mountPopover();
    await tick();
    const img = root.querySelector<HTMLImageElement>(
      '[data-testid="status-member-avatar"]',
    );
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://example.invalid/hassaan.jpg");
  });

  it("falls back to an initial when a person has no photo", async () => {
    const root = mountPopover();
    await tick();
    const wells = [...root.querySelectorAll('[data-testid="status-member"] .m-ava')];
    const initials = wells
      .filter((w) => !w.querySelector("img"))
      .map((w) => w.textContent?.trim());
    expect(initials).toContain("S");
  });

  it("puts owners first and tags the owner role", async () => {
    const root = mountPopover();
    await tick();
    const rows = [...root.querySelectorAll('[data-testid="status-member"]')];
    expect(rows[0]?.textContent).toContain("Hassaan");
    expect(
      root.querySelector('[data-testid="status-member-role"]')?.textContent,
    ).toContain("owner");
  });
});

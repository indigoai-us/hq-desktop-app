// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount, tick } from "svelte";

import ChannelStatusPopover from "./ChannelStatusPopover.svelte";
import type { ChannelStatusModel } from "./channel-status-model.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function model(
  over: Partial<ChannelStatusModel["project"]> = {},
): ChannelStatusModel {
  return {
    liveAgents: [],
    activeSessions: [],
    stories: { complete: 1, total: 2, label: "stories 1/2", percent: 50 },
    project: {
      branch: null,
      repo: null,
      repos: [],
      previewUrl: null,
      ...over,
    },
    members: [
      {
        personUid: "prs_me",
        displayName: "Ada Lovelace",
        role: null,
        email: null,
        avatarUrl: null,
        description: null,
        statusIcon: "idle",
        online: false,
      },
      {
        personUid: "prs_other",
        displayName: "Marcus Chen",
        role: "member",
        email: null,
        avatarUrl: null,
        description: null,
        statusIcon: "idle",
        online: false,
      },
    ],
    agents: [],
    memberCount: 2,
    companyLabel: null,
  };
}

describe("ChannelStatusPopover — self 'you' tagging", () => {
  it("tags exactly the signed-in member's roster row 'you'", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelStatusPopover, {
      target: host,
      props: { model: model(), self: { uid: "prs_me" } },
    });

    const youChips = host.querySelectorAll('[data-testid="status-member-you"]');
    expect(youChips).toHaveLength(1);

    const taggedRow = youChips[0].closest('[data-testid="status-member"]');
    expect(taggedRow?.textContent).toContain("Ada Lovelace");
    expect(taggedRow?.textContent).not.toContain("Marcus Chen");
  });

  it("tags no one when self is absent (unauth / fixture path)", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelStatusPopover, {
      target: host,
      props: { model: model(), self: null },
    });

    expect(
      host.querySelectorAll('[data-testid="status-member-you"]'),
    ).toHaveLength(0);
  });
});

describe("ChannelStatusPopover — multi-repo project block", () => {
  const threeRepos = {
    branch: "feature/a",
    repo: "repos/private/hq-pro",
    repos: [
      { path: "repos/private/hq-pro", branch: "feature/a" },
      { path: "repos/private/hq-core-staging", branch: "feature/b" },
      { path: "repos/public/hq-desktop-app", branch: "feature/c" },
    ],
  };

  it("shows the first repo and a 1/N pager when several repos exist", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelStatusPopover, {
      target: host,
      props: { model: model(threeRepos) },
    });
    await tick();

    expect(
      host.querySelector('[data-testid="status-repo-path"]')?.textContent,
    ).toBe("hq-pro");
    expect(
      host.querySelector('[data-testid="status-repo-index"]')?.textContent,
    ).toBe("1/3");
    expect(
      host.querySelector('[data-testid="status-branch"]')?.textContent,
    ).toBe("feature/a");
    expect(
      host.querySelector('[data-testid="status-branch-select"]'),
    ).toBeNull();
  });

  it("cycles repos with next/prev and wraps", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelStatusPopover, {
      target: host,
      props: { model: model(threeRepos) },
    });
    await tick();

    const next = host.querySelector(
      '[data-testid="status-repo-next"]',
    ) as HTMLButtonElement;
    const prev = host.querySelector(
      '[data-testid="status-repo-prev"]',
    ) as HTMLButtonElement;
    next.click();
    await tick();
    expect(
      host.querySelector('[data-testid="status-repo-path"]')?.textContent,
    ).toBe("hq-core-staging");
    expect(
      host.querySelector('[data-testid="status-branch"]')?.textContent,
    ).toBe("feature/b");
    expect(
      host.querySelector('[data-testid="status-repo-index"]')?.textContent,
    ).toBe("2/3");

    prev.click();
    await tick();
    expect(
      host.querySelector('[data-testid="status-repo-path"]')?.textContent,
    ).toBe("hq-pro");

    prev.click();
    await tick();
    expect(
      host.querySelector('[data-testid="status-repo-path"]')?.textContent,
    ).toBe("hq-desktop-app");
    expect(
      host.querySelector('[data-testid="status-repo-index"]')?.textContent,
    ).toBe("3/3");
  });

  it("left-clicks the repo name to advance and right-clicks to go back", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelStatusPopover, {
      target: host,
      props: { model: model(threeRepos) },
    });
    await tick();

    const name = host.querySelector(
      '[data-testid="status-repo-path"]',
    ) as HTMLButtonElement;
    name.dispatchEvent(new MouseEvent("click", { button: 0, bubbles: true }));
    await tick();
    expect(
      host.querySelector('[data-testid="status-repo-path"]')?.textContent,
    ).toBe("hq-core-staging");

    name.dispatchEvent(
      new MouseEvent("contextmenu", { button: 2, bubbles: true }),
    );
    await tick();
    expect(
      host.querySelector('[data-testid="status-repo-path"]')?.textContent,
    ).toBe("hq-pro");
  });

  it("offers a branch dropdown when one repo has several branches", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelStatusPopover, {
      target: host,
      props: {
        model: model({
          branch: "feature/a",
          repo: "repos/private/hq-pro",
          repos: [
            { path: "repos/private/hq-pro", branch: "feature/a" },
            { path: "repos/private/hq-pro", branch: "feature/b" },
          ],
        }),
      },
    });
    await tick();

    const select = host.querySelector(
      '[data-testid="status-branch-select"]',
    ) as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(Array.from(select!.options).map((o) => o.value)).toEqual([
      "feature/a",
      "feature/b",
    ]);
    expect(host.querySelector('[data-testid="status-repo-index"]')).toBeNull();
  });

  it("hides the pager for a single repo", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelStatusPopover, {
      target: host,
      props: {
        model: model({
          branch: "main",
          repo: "repos/private/hq-pro",
          repos: [{ path: "repos/private/hq-pro", branch: "main" }],
        }),
      },
    });
    await tick();

    expect(
      host.querySelector('[data-testid="status-repo-path"]')?.textContent,
    ).toBe("hq-pro");
    expect(host.querySelector('[data-testid="status-repo-next"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="status-branch-select"]'),
    ).toBeNull();
    expect(
      host.querySelector('[data-testid="status-branch"]')?.textContent,
    ).toBe("main");
  });
});

describe("ChannelStatusPopover — prototype agent card", () => {
  it("puts stories on the progress row next to the running agent", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelStatusPopover, {
      target: host,
      props: {
        model: {
          ...model(),
          liveAgents: [
            {
              id: "a1",
              label: "Agent running · US-002 · 62%",
              storyId: "US-002",
              progressPercent: 62,
              status: "running",
              tool: null,
              displayName: "Desktop Agent",
            },
          ],
          stories: {
            complete: 7,
            total: 12,
            label: "stories 7/12",
            percent: 58,
          },
          agents: [
            {
              personUid: "agt_desktop",
              displayName: "Desktop Agent",
              role: "agent",
              email: null,
              avatarUrl: null,
              description: null,
              statusIcon: "running",
              online: false,
            },
          ],
        },
      },
    });
    await tick();

    const card = host.querySelector('[data-testid="status-live-agent"]');
    expect(card?.textContent).toContain("Agent running");
    expect(card?.textContent).toContain("US-002 · 62%");
    expect(card?.textContent).toContain("7/12 STORIES");
    expect(
      host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"),
    ).toBe("58");
    expect(
      host.querySelector('[data-testid="status-agent"]')?.textContent,
    ).toContain("Desktop Agent");
  });

  it("always shows the progress card and MEMBERS heading", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelStatusPopover, {
      target: host,
      props: {
        model: {
          liveAgents: [],
          activeSessions: [],
          stories: { complete: 0, total: 0, label: "stories 0/0", percent: 0 },
          project: { branch: null, repo: null, repos: [], previewUrl: null },
          members: [],
          agents: [],
          memberCount: 0,
          companyLabel: null,
        },
      },
    });
    await tick();

    const card = host.querySelector('[data-testid="status-live-agent"]');
    expect(card).not.toBeNull();
    expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="status-story-rollup"]')?.textContent,
    ).toBe("0/0 STORIES");
    expect(host.textContent).toContain("MEMBERS");
  });

  it("lists owners first with an owner label", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelStatusPopover, {
      target: host,
      props: {
        model: {
          ...model(),
          members: [
            {
              personUid: "prs_other",
              displayName: "Marcus Chen",
              role: "member",
              email: null,
              avatarUrl: null,
              description: null,
              statusIcon: "idle",
              online: false,
            },
            {
              personUid: "prs_me",
              displayName: "Ada Lovelace",
              role: "owner",
              email: null,
              avatarUrl: null,
              description: null,
              statusIcon: "idle",
              online: false,
            },
          ],
        },
      },
    });
    await tick();

    const rows = [...host.querySelectorAll('[data-testid="status-member"]')];
    expect(rows[0]?.textContent).toContain("Ada Lovelace");
    expect(rows[0]?.textContent).toContain("owner");
    expect(rows[1]?.textContent).toContain("Marcus Chen");
    expect(rows[1]?.textContent).not.toContain("member");
  });
});

describe("ChannelStatusPopover — presence + live sessions (US-015)", () => {
  it("renders mixed online/offline actors and active session cards", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelStatusPopover, {
      target: host,
      props: {
        model: {
          ...model(),
          members: [
            {
              personUid: "prs_corey",
              displayName: "Corey",
              role: "owner",
              email: null,
              avatarUrl: null,
              description: null,
              statusIcon: "idle",
              online: true,
            },
            {
              personUid: "prs_stefan",
              displayName: "Stefan",
              role: "member",
              email: null,
              avatarUrl: null,
              description: null,
              statusIcon: "idle",
              online: false,
            },
          ],
          agents: [
            {
              personUid: "agt_ralph",
              displayName: "Ralph",
              role: "agent",
              email: null,
              avatarUrl: null,
              description: null,
              statusIcon: "running",
              online: true,
            },
          ],
          activeSessions: [
            {
              id: "sess_corey",
              principal: "Corey",
              principalKind: "human",
              context: "US-015",
              percent: null,
              lastActivityLabel: "last activity just now",
              blockedReason: null,
              harness: "claude-code",
              taskId: "US-015",
              turnCount: 12,
              online: true,
            },
            {
              id: "sess_ralph",
              principal: "Ralph",
              principalKind: "agent",
              context: "US-015",
              percent: null,
              lastActivityLabel: "last activity 1m ago",
              blockedReason: null,
              harness: "agent-box",
              taskId: "US-015",
              turnCount: 7,
              online: true,
            },
          ],
        },
      },
    });
    await tick();

    const sessions = host.querySelectorAll(
      '[data-testid="status-active-session"]',
    );
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.textContent).toContain("Corey");
    expect(sessions[0]?.textContent).toContain("US-015");
    expect(sessions[1]?.textContent).toContain("Ralph");
    const dots = host.querySelectorAll('[data-testid="status-presence-dot"]');
    // 2 online members/agents + 2 online sessions (offline Stefan has none)
    expect(dots.length).toBeGreaterThanOrEqual(3);
    expect(host.textContent).toContain("Stefan");
  });

  it("empty state shows no session rows and no presence dots", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelStatusPopover, {
      target: host,
      props: { model: model() },
    });
    await tick();
    expect(
      host.querySelectorAll('[data-testid="status-active-session"]'),
    ).toHaveLength(0);
    expect(
      host.querySelectorAll('[data-testid="status-presence-dot"]'),
    ).toHaveLength(0);
  });
});

describe("ChannelStatusPopover — email, profile-open, and remove", () => {
  function ownerModel(): ChannelStatusModel {
    const m = model();
    m.members = [
      {
        personUid: "prs_me",
        displayName: "Ada Lovelace",
        role: "owner",
        email: "ada@example.com",
        avatarUrl: null,
        description: null,
        statusIcon: "idle",
        online: false,
      },
      {
        personUid: "prs_other",
        displayName: "Marcus Chen",
        role: "member",
        email: "marcus@example.com",
        avatarUrl: null,
        description: null,
        statusIcon: "idle",
        online: false,
      },
    ];
    return m;
  }

  it("renders each member's email under the name", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelStatusPopover, {
      target: host,
      props: { model: ownerModel(), self: { uid: "prs_me" } },
    });
    await tick();
    const emails = [
      ...host.querySelectorAll('[data-testid="status-member-email"]'),
    ].map((n) => n.textContent);
    expect(emails).toContain("ada@example.com");
    expect(emails).toContain("marcus@example.com");
  });

  it("emits View agent from the agents roster", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const opened: Array<{ personUid: string }> = [];
    component = mount(ChannelStatusPopover, {
      target: host,
      props: {
        model: {
          ...model(),
          agents: [
            {
              personUid: "agt_desktop",
              displayName: "Desktop Agent",
              role: "agent",
              email: null,
              avatarUrl: null,
              description: null,
              statusIcon: "running",
              online: false,
            },
          ],
        },
        onopenprofile: (row: { personUid: string }) => {
          opened.push(row);
        },
      },
    });
    await tick();
    const btn = host.querySelector(
      '[data-testid="status-agent-open"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toContain("View agent");
    btn!.click();
    await tick();
    expect(opened[0]?.personUid).toBe("agt_desktop");
  });

  it("emits onopenprofile with the clicked member row", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    let opened: { personUid: string } | null = null;
    component = mount(ChannelStatusPopover, {
      target: host,
      props: {
        model: ownerModel(),
        self: { uid: "prs_me" },
        onopenprofile: (row: { personUid: string }) => (opened = row),
      },
    });
    await tick();
    const openBtns = host.querySelectorAll(
      '[data-testid="status-member-open"]',
    );
    (openBtns[1] as HTMLButtonElement).click();
    await tick();
    expect(opened).not.toBeNull();
    expect(opened!.personUid).toBe("prs_other");
  });

  it("shows remove for an owner and emits onremovemember", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    let removed: { personUid: string } | null = null;
    component = mount(ChannelStatusPopover, {
      target: host,
      props: {
        model: ownerModel(),
        self: { uid: "prs_me" },
        onremovemember: (row: { personUid: string }) => (removed = row),
      },
    });
    await tick();
    const removeBtns = host.querySelectorAll(
      '[data-testid="status-member-remove"]',
    );
    // Owner sees remove on every row (self-leave + owner-removes-others).
    expect(removeBtns.length).toBe(2);
    (removeBtns[1] as HTMLButtonElement).click();
    await tick();
    expect(removed!.personUid).toBe("prs_other");
  });

  it("hides remove-others for a non-owner (only self-leave)", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const m = ownerModel();
    // Signed-in member is the non-owner 'other'.
    component = mount(ChannelStatusPopover, {
      target: host,
      props: {
        model: m,
        self: { uid: "prs_other" },
        onremovemember: () => {},
      },
    });
    await tick();
    const removeBtns = [
      ...host.querySelectorAll('[data-testid="status-member-remove"]'),
    ];
    // Only the caller's own row (self-leave) offers remove.
    expect(removeBtns.length).toBe(1);
    const selfRow = removeBtns[0].closest('[data-testid="status-member"]');
    expect(selfRow?.textContent).toContain("Marcus Chen");
  });
});

describe("ChannelStatusPopover — delete channel (owner-only trash)", () => {
  function ownerModel(): ChannelStatusModel {
    const m = model();
    m.members = [
      {
        personUid: "prs_me",
        displayName: "Ada Lovelace",
        role: "owner",
        email: null,
        avatarUrl: null,
        description: null,
        statusIcon: "idle",
        online: false,
      },
      {
        personUid: "prs_other",
        displayName: "Marcus Chen",
        role: "member",
        email: null,
        avatarUrl: null,
        description: null,
        statusIcon: "idle",
        online: false,
      },
    ];
    return m;
  }

  it("renders the trash control for the owner when a callback is provided", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelStatusPopover, {
      target: host,
      props: {
        model: ownerModel(),
        self: { uid: "prs_me" },
        ondeletechannel: () => {},
      },
    });
    await tick();
    const btn = host.querySelector<HTMLButtonElement>(
      '[data-testid="status-channel-delete"]',
    );
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute("aria-label")).toBe("Delete channel");
    expect(btn!.getAttribute("title")).toBe("Delete channel");
    expect(btn!.disabled).toBe(false);
    expect(btn!.querySelector("svg")).not.toBeNull();
    // The footer sits after the roster sections, never inside a member row.
    expect(btn!.closest('[data-testid="status-member"]')).toBeNull();
    const footer = host.querySelector('[data-testid="status-channel-actions"]');
    const members = host.querySelector('section[aria-label="Members"]');
    expect(
      members!.compareDocumentPosition(footer!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("hides the trash control when no callback is provided (even for the owner)", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelStatusPopover, {
      target: host,
      props: { model: ownerModel(), self: { uid: "prs_me" } },
    });
    await tick();
    expect(
      host.querySelector('[data-testid="status-channel-delete"]'),
    ).toBeNull();
  });

  it("hides the trash control for a non-owner", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelStatusPopover, {
      target: host,
      props: {
        model: ownerModel(),
        self: { uid: "prs_other" },
        ondeletechannel: () => {},
      },
    });
    await tick();
    expect(
      host.querySelector('[data-testid="status-channel-delete"]'),
    ).toBeNull();
  });

  it("invokes ondeletechannel on click without confirming itself", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    let calls = 0;
    component = mount(ChannelStatusPopover, {
      target: host,
      props: {
        model: ownerModel(),
        self: { uid: "prs_me" },
        ondeletechannel: () => {
          calls += 1;
        },
      },
    });
    await tick();
    host
      .querySelector<HTMLButtonElement>('[data-testid="status-channel-delete"]')!
      .click();
    await tick();
    expect(calls).toBe(1);
    // No dialog of its own — the shell owns the confirm.
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
  });

  it("disables the trash control and shows an ellipsis while deleting", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    let calls = 0;
    component = mount(ChannelStatusPopover, {
      target: host,
      props: {
        model: ownerModel(),
        self: { uid: "prs_me" },
        ondeletechannel: () => {
          calls += 1;
        },
        deleting: true,
      },
    });
    await tick();
    const btn = host.querySelector<HTMLButtonElement>(
      '[data-testid="status-channel-delete"]',
    )!;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent?.trim()).toBe("…");
    expect(btn.querySelector("svg")).toBeNull();
    btn.click();
    await tick();
    expect(calls).toBe(0);
  });
});

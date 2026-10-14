// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import TeamPage from "./TeamPage.svelte";
import { writeTeamCache } from "./team-bots-pages.js";
import type { TeamMember } from "./team-telemetry.js";

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
});

function member(id: string, displayName: string, kind: "human" | "agent"): TeamMember {
  return {
    id,
    displayName,
    kind,
    email: kind === "human" ? `${id}@example.com` : null,
    role: "Member",
    activeProjects: [],
    topSkills: [],
    joined: null,
  } as unknown as TeamMember;
}

function seed(slug: string): void {
  const humans = [member("prs_maya", "Maya Chen", "human")];
  const agents = [member("agt_lin", "Lin", "agent")];
  writeTeamCache(slug, {
    view: { members: [...humans, ...agents], humans, agents, error: null, empty: false },
    invites: [],
  });
}

function render(props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(TeamPage, { target, props: { company: null, ...props } as never }));
  flushSync();
  return target;
}

describe("TeamPage clicks (console-rail design lane 4)", () => {
  it("opens the shared profile pane when a member row is clicked, and closes it on a second click", async () => {
    seed("acme-a");
    const target = render({ slug: "acme-a" });
    expect(target.querySelector("[data-testid='team-profile-pane']")).toBeNull();
    (target.querySelector("[data-testid='team-open-prs_maya']") as HTMLButtonElement).click();
    flushSync();
    expect(target.querySelector("[data-testid='team-profile-pane']")).not.toBeNull();
    expect(
      target.querySelector("[data-member-id='prs_maya']")?.classList.contains("is-selected"),
    ).toBe(true);
    (target.querySelector("[data-testid='team-open-prs_maya']") as HTMLButtonElement).click();
    flushSync();
    expect(target.querySelector("[data-testid='team-profile-pane']")).toBeNull();
  });

  it("member rows use the shared avatar: photo, colored initials, bot art; handle on its own line", () => {
    seed("acme-avatars");
    const target = render({ slug: "acme-avatars", avatarByUid: { prs_maya: "data:image/png;base64,AAAA" } });
    const maya = target.querySelector<HTMLElement>("[data-member-id='prs_maya']")!;
    const mayaAvatar = maya.querySelector<HTMLElement>("[data-testid='team-avatar']")!;
    expect(mayaAvatar.dataset.face).toBe("photo");
    // Presence is its own badge element beside the face, not inside the text.
    expect(mayaAvatar.querySelector("[data-testid='avatar-presence']")).not.toBeNull();
    expect(maya.querySelector(".who-line .nm")?.textContent).toBe("Maya Chen");
    expect(maya.querySelector(".who-text > .em")?.textContent).toBe("prs_maya@example.com");

    const lin = target.querySelector<HTMLElement>("[data-member-id='agt_lin']")!;
    const linAvatar = lin.querySelector<HTMLElement>("[data-testid='team-avatar']")!;
    expect(["mascot", "glyph"]).toContain(linAvatar.dataset.face);
    expect(linAvatar.textContent?.trim()).not.toBe("LI");
  });

  it("a person without a photo gets initials", () => {
    seed("acme-initials");
    const target = render({ slug: "acme-initials" });
    const avatar = target.querySelector<HTMLElement>("[data-member-id='prs_maya'] [data-testid='team-avatar']")!;
    expect(avatar.dataset.face).toBe("initials");
    expect(avatar.textContent?.trim()).toBe("MC");
  });

  it("Add agent calls the host's New bot opener instead of navigating", () => {
    seed("acme-b");
    const onaddagent = vi.fn();
    const target = render({ slug: "acme-b", onaddagent });
    (target.querySelector("[data-testid='team-add-agent']") as HTMLButtonElement).click();
    expect(onaddagent).toHaveBeenCalledTimes(1);
  });

  it("opens the invite sheet when the sidepane bumps inviteSeq", async () => {
    seed("acme-c");
    const props = $state({ slug: "acme-c", company: null, inviteSeq: 0 });
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(TeamPage, { target, props: props as never }));
    flushSync();
    expect(target.querySelector("[data-testid='invite-sheet']")).toBeNull();
    props.inviteSeq = 1;
    flushSync();
    await tick();
    expect(target.querySelector("[data-testid='invite-sheet']")).not.toBeNull();
  });

  it("renders plain sentence-case section labels and no table headers", () => {
    seed("acme-d");
    const target = render({ slug: "acme-d" });
    const labels = [...target.querySelectorAll("[data-testid='team-section-label']")].map((el) =>
      el.textContent?.trim(),
    );
    expect(labels).toEqual(["Humans · 1", "Bots · 1", "Pending invites · 0"]);
    expect(target.querySelector("th")).toBeNull();
  });
});

describe("TeamPage roster (QA-022)", () => {
  it("lists company members from the roster when telemetry has no rows", async () => {
    const company = {
      getTeamTelemetry: vi.fn(async () => ({ ok: true as const, value: { perMember: [] } })),
      listMembers: vi.fn(async () => ({ ok: true as const, value: [] })),
    };
    const messaging = {
      listContacts: vi.fn(async () => ({
        ok: true as const,
        value: [
          { personUid: "prs_ana", displayName: "Ana Ruiz", email: "ana@example.com" },
          { personUid: "agt_scout", displayName: "Scout", kind: "agent" },
        ],
      })),
    };
    const target = render({ slug: "amass-roster", companyUid: "cmp_amass", company, messaging });
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelectorAll("[data-testid='team-row']")).toHaveLength(2);
    });
    expect(messaging.listContacts).toHaveBeenCalledWith({ companyUid: "cmp_amass" });
    const labels = [...target.querySelectorAll("[data-testid='team-section-label']")].map((el) =>
      el.textContent?.trim(),
    );
    expect(labels.slice(0, 2)).toEqual(["Humans · 1", "Bots · 1"]);
    expect(target.querySelector("[data-testid='team-seat-chip']")?.textContent?.trim()).toBe("1 seat");
  });

  it("still shows the roster when the telemetry read fails, without raw error text", async () => {
    const company = {
      getTeamTelemetry: vi.fn(async () => ({ ok: false as const, reason: "http", message: "HTTP 404 Not Found {\"error\":\"x\"}" })),
      listMembers: vi.fn(async () => ({ ok: true as const, value: [{ personUid: "prs_bo", displayName: "Bo" }] })),
    };
    const target = render({ slug: "amass-fail", company });
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelectorAll("[data-testid='team-row']")).toHaveLength(1);
    });
    expect(target.textContent).not.toContain("HTTP 404");
  });

  it("shows a dash, not an invented Member, when the roster has no role (QA-048)", async () => {
    const company = {
      getTeamTelemetry: vi.fn(async () => ({ ok: true as const, value: { perMember: [] } })),
      listMembers: vi.fn(async () => ({
        ok: true as const,
        value: [
          { personUid: "prs_cy", displayName: "Cy" },
          { personUid: "prs_di", displayName: "Di", role: "owner" },
        ],
      })),
    };
    const target = render({ slug: "amass-roles", company });
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelectorAll("[data-testid='team-row']")).toHaveLength(2);
    });
    const rows = [...target.querySelectorAll("[data-testid='team-row']")].map((row) => row.textContent ?? "");
    expect(rows.find((text) => text.includes("Cy"))).toContain("\u2014");
    expect(rows.find((text) => text.includes("Cy"))).not.toContain("Member");
    expect(rows.find((text) => text.includes("Di"))).toContain("owner");
  });
});

describe("TeamPage failed read (AUDIT-3)", () => {
  it("offers Try again and shows the team once the read succeeds", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = true;
    const company = {
      getTeamTelemetry: vi.fn(async () =>
        fail
          ? ({ ok: false as const, reason: "http", message: "HTTP 502 Bad Gateway" })
          : ({ ok: true as const, value: { perMember: [] } }),
      ),
      listMembers: vi.fn(async () =>
        fail
          ? ({ ok: true as const, value: [] })
          : ({ ok: true as const, value: [{ personUid: "prs_ana", displayName: "Ana Ruiz", email: "ana@example.com" }] }),
      ),
    };
    const target = render({ slug: "acme-retry", company });
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector("[data-testid='team-load-error']")?.textContent).toContain("Could not read the team.");
    });
    expect(target.textContent).not.toContain("502");
    fail = false;
    (target.querySelector("[data-testid='team-retry']") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector("[data-testid='team-load-error']")).toBeNull();
      expect(target.querySelectorAll("[data-testid='team-row']")).toHaveLength(1);
    });
  });
});

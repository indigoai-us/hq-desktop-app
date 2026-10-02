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

// @vitest-environment happy-dom
// Team member pane access summary: an owner gets one line of truth and no
// per-path list; other members get grants rolled up by source and folder,
// collapsed, with a search inside long groups. Read only.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import MemberAccessSection from "./MemberAccessSection.svelte";

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
});

const created = Array.from({ length: 46 }, (_, i) => ({
  path: `agents/bot-${i}/*`,
  permission: "admin",
  sources: [{ via: "creator", permission: "admin" }],
}));

async function render(payload: unknown, role = "Owner") {
  const company = { getMemberAccess: vi.fn(async () => ({ ok: true as const, value: payload })) };
  component = mount(MemberAccessSection, {
    target: document.body,
    props: { company, companyUid: "cmp_acme", personUid: "prs_x", role, companyLabel: "Indigo", joined: "Apr 2026", botName: () => null } as never,
  });
  flushSync();
  await vi.waitFor(() => expect(document.querySelector("[data-testid='member-access-loading']")).toBeNull());
  return document.querySelector<HTMLElement>("[data-testid='member-access']")!;
}

describe("MemberAccessSection summary", () => {
  it("owner: one line of truth, a Why with role and groups, and no grant rows", async () => {
    const el = await render({
      identity: { groups: [{ name: "core" }, { name: "Dev Test" }] },
      files: { roleBypass: true, grants: [{ path: "*", permission: "admin", sources: [{ via: "person" }] }, ...created] },
      secrets: { roleBypass: true, grants: [] },
    });
    expect(el.querySelector("[data-testid='member-access-everything']")?.textContent).toBe(
      "Owner: every file and secret in Indigo",
    );
    expect(el.querySelectorAll("[data-testid='member-access-group']")).toHaveLength(0);
    expect(el.textContent).not.toContain("agents/");
    const why = el.querySelector("[data-testid='member-access-why']")!;
    expect(why.textContent).toContain("Owner");
    expect(why.textContent).toContain("Dev Test");
  });

  it("member: one collapsed line per source and folder, with counts; secrets apart", async () => {
    const el = await render(
      {
        identity: { groups: [{ name: "Finance" }] },
        files: {
          roleBypass: false,
          grants: [...created, { path: "knowledge/", permission: "read", sources: [{ via: "company-wide" }] }],
        },
        secrets: { roleBypass: false, grants: [{ path: "stripe/", permission: "read", sources: [{ via: "group", groupName: "Finance" }] }] },
      },
      "Member",
    );
    const groups = [...el.querySelectorAll<HTMLDetailsElement>("[data-testid='member-access-files'] [data-testid='member-access-group']")];
    expect(groups.map((g) => g.querySelector("summary")?.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "knowledge/… 1 prefix read · shared company-wide",
      "agents/… 46 prefixes admin · because they created them",
    ]);
    expect(groups.every((g) => !g.open)).toBe(true);
    expect(el.querySelector("[data-testid='member-access-secrets']")?.textContent).toContain("stripe/");
  });

  it("filters a long group with its search", async () => {
    const el = await render({ identity: { groups: [] }, files: { roleBypass: false, grants: created }, secrets: { roleBypass: false, grants: [] } }, "Member");
    const group = el.querySelector<HTMLDetailsElement>("[data-testid='member-access-group']")!;
    const input = group.querySelector<HTMLInputElement>("[data-testid='member-access-search']")!;
    input.value = "bot-4";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    // bot-4 and bot-40..45
    expect(group.querySelectorAll("ul.rows li")).toHaveLength(7);
  });
});

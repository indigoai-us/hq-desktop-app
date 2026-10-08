// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import CompanySettingsPage from "./CompanySettingsPage.svelte";

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
});

// OWNER-R24: each settings area is its own company panel pane; the seat
// card (formerly HQ Workforce) sits at the top of Billing.
const current = $state({ section: "general" });
function render(props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  current.section = "general";
  const all = { companyLabel: "Unicom", ...props, get section() { return current.section; } };
  mounted.push(mount(CompanySettingsPage, { target, props: all as never }));
  flushSync();
  return target;
}

function openWorkforce(_target: HTMLElement): void {
  current.section = "billing";
  flushSync();
}

function text(target: HTMLElement, id: string): string {
  return target.querySelector(`[data-testid='${id}']`)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

describe("CompanySettingsPage HQ Workforce seats (QA-046)", () => {
  it("counts seats from the Team roster, agents separately, and re-reads on revisit", async () => {
    let roster: unknown[] = [
      { personUid: "prs_ana", displayName: "Ana" },
      { personUid: "prs_bo", displayName: "Bo" },
      { personUid: "agt_scout", displayName: "Scout", kind: "agent" },
    ];
    const company = {
      getTeamTelemetry: vi.fn(async () => ({ ok: true as const, value: { perMember: [] } })),
      listMembers: vi.fn(async () => ({ ok: true as const, value: [] })),
    };
    const messaging = { listContacts: vi.fn(async () => ({ ok: true as const, value: roster })) };
    const target = render({ slug: "unicom-qa046", companyUid: "cmp_unicom", company, messaging });
    openWorkforce(target);
    await vi.waitFor(() => {
      flushSync();
      expect(text(target, "workforce-seats")).toMatch(/^2Seats used/);
    });
    expect(text(target, "workforce-seats")).not.toContain("0 of 10");
    expect(text(target, "workforce-agents")).toMatch(/^1Hosted agents/);
    expect(text(target, "workforce-limit-unavailable")).toContain("not available");
    expect(messaging.listContacts).toHaveBeenCalledWith({ companyUid: "cmp_unicom" });
    // Owner 2026-10-05: Billing shows the counts only, not a row per roster member.
    expect(target.querySelectorAll("[data-testid='company-settings'] .line")).toHaveLength(0);
    expect(target.textContent).not.toContain("Scout");

    roster = [...roster, { personUid: "prs_cy", displayName: "Cy" }];
    current.section = "general";
    flushSync();
    openWorkforce(target);
    await vi.waitFor(() => {
      flushSync();
      expect(text(target, "workforce-seats")).toMatch(/^3Seats used/);
    });
  });

  it("says the seat count is unavailable when the team read fails", async () => {
    const company = {
      getTeamTelemetry: vi.fn(async () => ({ ok: false as const, reason: "http", message: "HTTP 500" })),
      listMembers: vi.fn(async () => ({ ok: false as const, reason: "http", message: "HTTP 500" })),
    };
    const target = render({ slug: "unicom-fail", company });
    openWorkforce(target);
    await vi.waitFor(() => {
      flushSync();
      expect(text(target, "workforce-error")).toContain("Seat count unavailable");
    });
    expect(target.textContent).not.toContain("HTTP 500");
  });
});

describe("CompanySettingsPage General", () => {
  it("has no open-on-sign-in row and saving keeps the stored value (owner 2026-10-05)", async () => {
    const { readSettingsCache, writeSettingsCache, emptySnapshot } = await import("./company-settings.js");
    const seeded = emptySnapshot("Unicom", "unicom-signin");
    seeded.general.openOnSignIn = false;
    writeSettingsCache("unicom-signin", seeded);
    const target = render({ slug: "unicom-signin", role: "Owner" });
    expect(target.querySelector("[data-testid='settings-default-company']")).toBeNull();
    expect(target.textContent).not.toContain("on sign-in for members");
    const name = target.querySelector<HTMLInputElement>("input.in");
    name!.value = "Unicom Co";
    name!.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    target.querySelector<HTMLButtonElement>("[data-testid='settings-save']")!.click();
    flushSync();
    expect(readSettingsCache("unicom-signin")?.general.name).toBe("Unicom Co");
    expect(readSettingsCache("unicom-signin")?.general.openOnSignIn).toBe(false);
  });
});

describe("CompanySettingsPage Brand", () => {
  it("has no logo file-name box and saving keeps the stored logo name (owner 2026-10-05)", async () => {
    const { readSettingsCache, writeSettingsCache, emptySnapshot } = await import("./company-settings.js");
    const seeded = emptySnapshot("Unicom", "unicom-brand");
    seeded.brand.logoName = "mark.svg";
    writeSettingsCache("unicom-brand", seeded);
    const target = render({ slug: "unicom-brand", role: "Owner" });
    current.section = "brand";
    flushSync();
    expect(target.querySelector(".sub")?.textContent).toBe("Accent color and voice");
    expect(target.textContent).not.toContain("file name");
    expect(target.querySelector("input[placeholder='wordmark.svg']")).toBeNull();
    expect(target.textContent).not.toContain("rail tile");
    expect(target.textContent).toContain("The accent color tints this company's buttons and highlights.");
    const accent = target.querySelector<HTMLInputElement>("input.in.mono");
    accent!.value = "#112233";
    accent!.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    target.querySelector<HTMLButtonElement>("[data-testid='brand-save']")!.click();
    flushSync();
    expect(readSettingsCache("unicom-brand")?.brand.accent).toBe("#112233");
    expect(readSettingsCache("unicom-brand")?.brand.logoName).toBe("mark.svg");
  });
});

describe("CompanySettingsPage live Groups and Grants", () => {
  const tree = (prefix: string, children: unknown[]) => ({
    prefix,
    direct: [],
    inherited: [{ granteeType: "group", granteeId: "grp_core", permission: "admin", grantedBy: "prs_a", grantedAt: "x", sourcePrefix: "*" }],
    children,
    directRow: null,
    identities: { prs_ana: { uid: "prs_ana", type: "person", name: "Ana" } },
  });

  function filesApi(overrides: Record<string, unknown> = {}) {
    return {
      listDir: vi.fn(async () => ({
        ok: true as const,
        value: [
          { name: "agents", path: "companies/acme/agents", isDir: true, hasChildren: true },
          { name: "knowledge", path: "companies/acme/knowledge", isDir: true, hasChildren: true },
        ],
      })),
      listAccessGroups: vi.fn(async () => ({
        ok: true as const,
        value: { groups: [{ groupId: "grp_core", name: "core" }, { groupId: "grp_exec", name: "Exec", memberCount: 3 }] },
      })),
      getAccessTree: vi.fn(async (_uid: string, prefix: string) => ({
        ok: true as const,
        value:
          prefix === "agents/*"
            ? tree(prefix, [{ granteeType: "person", granteeId: "prs_ana", permission: "write", grantedBy: "prs_a", grantedAt: "x", sourcePrefix: "agents/a/*" }])
            : tree(prefix, [{ granteeType: "group", granteeId: "grp_exec", permission: "read", grantedBy: "prs_a", grantedAt: "x", sourcePrefix: "knowledge/*" }]),
      })),
      ...overrides,
    };
  }

  function open(section: "groups" | "grants", props: Record<string, unknown>) {
    const target = render(props);
    current.section = section;
    flushSync();
    return target;
  }

  it("Groups shows a loader, then the server's groups with their grant summary", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const files = filesApi();
    const inner = files.listAccessGroups;
    files.listAccessGroups = vi.fn(async () => {
      await gate;
      return inner();
    });
    const target = open("groups", { slug: "acme", companyUid: "cmp_live1", files });
    expect(target.querySelector("[data-testid='groups-loading']")).not.toBeNull();
    expect(target.querySelector("[data-testid='groups-empty']")).toBeNull();
    release();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelectorAll("[data-testid='group-row']")).toHaveLength(2);
    });
    expect(text(target, "groups-sub")).toMatch(/^2 groups/);
    expect(files.listAccessGroups).toHaveBeenCalledWith("cmp_live1");
    await vi.waitFor(() => {
      flushSync();
      expect(text(target, "group-grants")).toContain("1 · 1 admin, 0 write, 0 read");
    });
    expect(text(target, "group-members")).toContain("Not included");
    expect(target.textContent).not.toContain("after the next sync");
    expect(target.querySelector("[data-testid='delete-group']")).toBeNull();
  });

  it("Groups says the read failed, never zero groups, and retries", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = true;
    const files = filesApi({
      listAccessGroups: vi.fn(async () =>
        fail ? { ok: false as const, reason: "error" as const, code: "http-500", message: "boom" } : { ok: true as const, value: { groups: [] } },
      ),
    });
    const target = open("groups", { slug: "acme", companyUid: "cmp_live2", files });
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector("[data-testid='groups-failed']")).not.toBeNull();
    });
    expect(target.querySelector("[data-testid='groups-empty']")).toBeNull();
    expect(target.textContent).not.toContain("boom");
    fail = false;
    target.querySelector<HTMLButtonElement>("[data-testid='groups-retry']")!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(text(target, "groups-empty")).toBe("This company has no groups yet.");
    });
    warn.mockRestore();
  });

  it("Groups says it is unavailable without a cloud company", () => {
    const target = open("groups", { slug: "acme", companyUid: null, files: filesApi() });
    expect(target.querySelector("[data-testid='groups-unavailable']")).not.toBeNull();
  });

  it("Grants reads each top-level folder and shows counts per folder that expand to rows", async () => {
    const files = filesApi();
    const target = open("grants", { slug: "acme", companyUid: "cmp_live3", files });
    expect(target.querySelector("[data-testid='grants-loading']")).not.toBeNull();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelectorAll("[data-testid='grant-section']")).toHaveLength(3);
    });
    expect(files.listDir).toHaveBeenCalledWith("companies/acme");
    expect(files.getAccessTree.mock.calls.map((c) => c[1]).sort()).toEqual(["agents/*", "knowledge/*"]);
    expect(text(target, "grants-sub")).toMatch(/^3 folder grants/);
    const folders = [...target.querySelectorAll<HTMLElement>("[data-testid='grant-section']")].map((b) => b.dataset.folder);
    expect(folders[0]).toBe("*");
    const agents = target.querySelector<HTMLButtonElement>("[data-testid='grant-section'][data-folder='agents']")!;
    expect(agents.textContent?.replace(/\s+/g, " ").trim()).toBe("agents/ 1 0 0 0 1");
    expect(target.querySelector("[data-testid='grant-row']")).toBeNull();
    agents.click();
    flushSync();
    expect(text(target, "grant-row")).toBe("Ana agents/a/* write No expiry");

    target.querySelector<HTMLButtonElement>("[data-testid='grant-filter-groups']")!.click();
    flushSync();
    expect(target.querySelectorAll("[data-testid='grant-section']")).toHaveLength(2);
    target.querySelector<HTMLButtonElement>("[data-testid='grant-filter-expiring']")!.click();
    flushSync();
    expect(text(target, "grants-filter-empty")).toContain("No folder grants have an expiry date");
  });

  it("Grants lists folders it could not read instead of hiding them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const base = filesApi();
    const files = filesApi({
      getAccessTree: vi.fn(async (uid: string, prefix: string) =>
        prefix === "knowledge/*" ? { ok: false as const, reason: "error" as const, code: "http-502", message: "bad gateway" } : base.getAccessTree(uid, prefix),
      ),
    });
    const target = open("grants", { slug: "acme", companyUid: "cmp_live4", files });
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector("[data-testid='grants-unread']")).not.toBeNull();
    });
    expect(text(target, "grants-unread")).toContain("knowledge/ · Could not read this folder's grants.");
    expect(target.textContent).not.toContain("bad gateway");
    warn.mockRestore();
  });

  it("Grants shows failed when every folder read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const files = filesApi({ getAccessTree: vi.fn(async () => ({ ok: false as const, reason: "error" as const, code: "http-500", message: "x" })) });
    const target = open("grants", { slug: "acme", companyUid: "cmp_live5", files });
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector("[data-testid='grants-failed']")).not.toBeNull();
    });
    expect(target.querySelector("[data-testid='grant-section']")).toBeNull();
    warn.mockRestore();
  });

  // New group is an inline row on the Groups pane (no new screen).
  async function openGroups(uid: string, role: string | null, files: Record<string, unknown>) {
    const target = open("groups", { slug: "acme", companyUid: uid, files, role });
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelectorAll("[data-testid='group-row']")).toHaveLength(2);
    });
    return target;
  }

  function q<T extends HTMLElement = HTMLElement>(target: HTMLElement, id: string): T | null {
    return target.querySelector<T>(`[data-testid='${id}']`);
  }

  function typeName(target: HTMLElement, value: string): void {
    const input = q<HTMLInputElement>(target, "group-create-name")!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
  }

  function createFiles(impl: (...args: unknown[]) => Promise<unknown>) {
    const createAccessGroup = vi.fn(impl);
    return { ...filesApi({ createAccessGroup }), createAccessGroup };
  }

  it("New group is hidden for members and guests, shown for owners and admins", async () => {
    const files = createFiles(async () => ({ ok: true as const, value: {} }));
    for (const role of ["Member", "Guest", null]) {
      const target = await openGroups(`cmp_create_hidden_${role}`, role, files);
      expect(q(target, "new-group")).toBeNull();
      expect(q(target, "group-create-row")).toBeNull();
      unmount(mounted.pop()!);
    }
    for (const role of ["Owner", "Admin"]) {
      const target = await openGroups(`cmp_create_shown_${role}`, role, files);
      expect(q(target, "new-group")?.textContent?.trim()).toBe("New group");
      unmount(mounted.pop()!);
    }
  });

  it("New group is hidden when the host cannot create groups", async () => {
    const target = await openGroups("cmp_create_nohost", "Owner", filesApi());
    expect(q(target, "new-group")).toBeNull();
  });

  it("creates a group from the inline row and selects it in the list", async () => {
    const files = createFiles(async (_uid: unknown, input: unknown) => ({
      ok: true as const,
      value: { group: { ...(input as object), companyUid: "cmp_create_ok", creatorUid: "prs_me", createdAt: "2026-10-07T00:00:00Z" } },
    }));
    const target = await openGroups("cmp_create_ok", "Owner", files);
    q<HTMLButtonElement>(target, "new-group")!.click();
    flushSync();
    expect(q(target, "group-create-row")).not.toBeNull();
    expect(q(target, "new-group")).toBeNull();
    expect(document.activeElement).toBe(q(target, "group-create-name"));
    typeName(target, "Design Team");
    const desc = q<HTMLInputElement>(target, "group-create-description")!;
    desc.value = "Brand and product design";
    desc.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    q<HTMLFormElement>(target, "group-create-row")!.requestSubmit();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelectorAll("[data-testid='group-row']")).toHaveLength(3);
    });
    expect(files.createAccessGroup).toHaveBeenCalledTimes(1);
    expect(files.createAccessGroup).toHaveBeenCalledWith("cmp_create_ok", {
      groupId: "grp_design-team",
      name: "Design Team",
      description: "Brand and product design",
    });
    expect(q(target, "group-create-row")).toBeNull();
    const current = target.querySelector("[data-testid='group-row'][aria-current='true']");
    expect(current?.textContent).toContain("Design Team");
    expect(text(target, "group-detail")).toContain("grp_design-team");
    expect(text(target, "group-detail")).toContain("Brand and product design");
    expect(text(target, "groups-sub")).toMatch(/^3 groups/);
  });

  it("Enter in the name field submits without a description", async () => {
    const files = createFiles(async () => ({ ok: true as const, value: { group: { groupId: "grp_ops", name: "Ops" } } }));
    const target = await openGroups("cmp_create_enter", "Admin", files);
    q<HTMLButtonElement>(target, "new-group")!.click();
    flushSync();
    typeName(target, "Ops");
    expect(q<HTMLButtonElement>(target, "group-create-submit")!.type).toBe("submit");
    q(target, "group-create-name")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(files.createAccessGroup).toHaveBeenCalledWith("cmp_create_enter", { groupId: "grp_ops", name: "Ops" }));
  });

  it("shows a pending state and blocks a second submit", async () => {
    let release!: (v: unknown) => void;
    const files = createFiles(() => new Promise((r) => (release = r)));
    const target = await openGroups("cmp_create_pending", "Owner", files);
    q<HTMLButtonElement>(target, "new-group")!.click();
    flushSync();
    typeName(target, "Finance");
    const form = q<HTMLFormElement>(target, "group-create-row")!;
    form.requestSubmit();
    flushSync();
    const submit = q<HTMLButtonElement>(target, "group-create-submit")!;
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute("aria-busy")).toBe("true");
    expect(submit.textContent?.trim()).toBe("Creating…");
    expect(q<HTMLButtonElement>(target, "group-create-cancel")!.disabled).toBe(true);
    form.requestSubmit();
    form.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    expect(files.createAccessGroup).toHaveBeenCalledTimes(1);
    expect(q(target, "group-create-row")).not.toBeNull();
    release({ ok: true, value: { group: { groupId: "grp_finance", name: "Finance" } } });
    await vi.waitFor(() => {
      flushSync();
      expect(q(target, "group-create-row")).toBeNull();
    });
    expect(files.createAccessGroup).toHaveBeenCalledTimes(1);
  });

  it("a failed create shows a plain message, keeps the typed name, and can retry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let attempt = 0;
    const files = createFiles(async () => {
      attempt += 1;
      if (attempt === 1) return { ok: false, reason: "error", code: "http-500", status: 500, message: "Internal Server Error: ddb boom" };
      if (attempt === 2) return { ok: false, reason: "error", code: "http-409", status: 409, message: "Group cmp:grp_sales already exists" };
      if (attempt === 3) return { ok: false, reason: "error", code: "http-403", status: 403, message: "Forbidden: manage-groups permission required" };
      return { ok: true, value: { group: { groupId: "grp_sales", name: "Sales" } } };
    });
    const target = await openGroups("cmp_create_fail", "Admin", files);
    q<HTMLButtonElement>(target, "new-group")!.click();
    flushSync();
    typeName(target, "Sales");
    const form = q<HTMLFormElement>(target, "group-create-row")!;

    form.requestSubmit();
    await vi.waitFor(() => {
      flushSync();
      expect(text(target, "group-create-error")).toBe("Could not create the group. Try again.");
    });
    expect(q<HTMLInputElement>(target, "group-create-name")!.value).toBe("Sales");
    expect(q<HTMLButtonElement>(target, "group-create-submit")!.disabled).toBe(false);
    expect(target.textContent).not.toContain("ddb boom");

    form.requestSubmit();
    await vi.waitFor(() => {
      flushSync();
      expect(text(target, "group-create-error")).toBe("A group with this name already exists. Choose another name.");
    });
    expect(target.textContent).not.toContain("cmp:grp_sales");

    form.requestSubmit();
    await vi.waitFor(() => {
      flushSync();
      expect(text(target, "group-create-error")).toBe("Only the owner, or an admin the owner allows, can create groups.");
    });
    expect(target.textContent).not.toContain("Forbidden");
    expect(q<HTMLInputElement>(target, "group-create-name")!.value).toBe("Sales");
    expect(target.querySelectorAll("[data-testid='group-row']")).toHaveLength(2);

    form.requestSubmit();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelectorAll("[data-testid='group-row']")).toHaveLength(3);
    });
    expect(q(target, "group-create-error")).toBeNull();
    warn.mockRestore();
  });

  it("refuses a name an existing group already has without calling the server", async () => {
    const files = createFiles(async () => ({ ok: true as const, value: {} }));
    const target = await openGroups("cmp_create_dupe", "Owner", files);
    q<HTMLButtonElement>(target, "new-group")!.click();
    flushSync();
    typeName(target, "exec");
    q<HTMLFormElement>(target, "group-create-row")!.requestSubmit();
    flushSync();
    expect(text(target, "group-create-error")).toBe("A group with this name already exists. Choose another name.");
    expect(files.createAccessGroup).not.toHaveBeenCalled();
  });

  it("Escape and Cancel close the row without creating", async () => {
    const files = createFiles(async () => ({ ok: true as const, value: {} }));
    const target = await openGroups("cmp_create_escape", "Owner", files);
    q<HTMLButtonElement>(target, "new-group")!.click();
    flushSync();
    typeName(target, "Half typed");
    q(target, "group-create-name")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    expect(q(target, "group-create-row")).toBeNull();
    expect(q(target, "new-group")).not.toBeNull();
    q<HTMLButtonElement>(target, "new-group")!.click();
    flushSync();
    expect(q<HTMLInputElement>(target, "group-create-name")!.value).toBe("");
    q<HTMLButtonElement>(target, "group-create-cancel")!.click();
    flushSync();
    expect(q(target, "group-create-row")).toBeNull();
    expect(files.createAccessGroup).not.toHaveBeenCalled();
    expect(target.querySelectorAll("[data-testid='group-row']")).toHaveLength(2);
  });
});

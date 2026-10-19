// @vitest-environment happy-dom
import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import CompanyOutpostPage from "./CompanyOutpostPage.svelte";
import { COMPANY_OUTPOST_SCREENS, companyOutpostPreview, FIXTURE_BOXES, FIXTURE_NOW, successOutpost } from "./company-outpost.fixture.js";
import { createCompanyOutpostStub } from "./company-outpost-stub.js";
import { blockedNote, failureCopy, outpostJobsDestination, UNAVAILABLE_COPY } from "./company-outpost-model.js";
import type { CompanyOutpostRole } from "./company-outpost-model.js";

const BILLING_TEXT = /billing|billed|\bbill\b|charge|payment|payer|\bpays?\b|price|pricing|invoice|subscription|USD|\$\s?\d|a month|per month/i;

describe("Company Outpost page", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function settle() {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
      flushSync();
    }
  }

  async function addOutpost(target: HTMLElement) {
    click(target, target.querySelector("[data-testid='add-outpost']") ? "add-outpost" : "add-outpost-empty");
    click(target, "add-continue");
    click(target, "create-outpost");
    await settle();
  }

  async function show(role: CompanyOutpostRole, options: Parameters<typeof createCompanyOutpostStub>[0] = {}, props: Record<string, unknown> = {}) {
    const client = createCompanyOutpostStub({
      role,
      items: FIXTURE_BOXES,
      ...options,
    });
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(CompanyOutpostPage, {
      target,
      props: { companyUid: "cmp_1", role, client, now: FIXTURE_NOW, pollMs: null, ...props },
    });
    flushSync();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    return { target, client };
  }

  function click(target: HTMLElement, testid: string) {
    target.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)?.click();
    flushSync();
  }

  it("shows the shared loader while the list read is still waiting", () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const client = createCompanyOutpostStub({ role: "member", items: FIXTURE_BOXES });
    client.list = () => new Promise(() => {});
    component = mount(CompanyOutpostPage, {
      target,
      props: { companyUid: "cmp_1", role: "member", client, now: FIXTURE_NOW, pollMs: null },
    });
    flushSync();
    expect(target.querySelector(".read-loader")).not.toBeNull();
    expect(target.querySelector("[data-testid='empty-outposts']")).toBeNull();
  });

  it("shows list columns for an admin and the add action", async () => {
    const { target } = await show("admin");
    expect(target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-manage")).toBe("true");
    expect(target.querySelector("[data-testid='outpost-row-demo-1']")?.textContent).toContain("main");
    expect(target.querySelector("[data-testid='outpost-row-demo-1']")?.textContent).toContain("Running");
    expect(target.querySelector("[data-testid='jobs-count-demo-1']")?.textContent).toBe("2");
    expect(target.querySelector("[data-testid='outpost-row-demo-1']")?.textContent).toContain("1 ran on time, 1 missed");
    expect(target.querySelector("[data-testid='add-outpost']")?.textContent).toContain("Add an Outpost");
    expect(target.querySelector("[data-testid='cap-hint']")?.textContent).toBe("A company can have up to 5 Outposts.");
  });

  it("shows the member list without manage actions", async () => {
    const { target } = await show("member");
    expect(target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-manage")).toBe("false");
    expect(target.querySelector("[data-testid='add-outpost']")).toBeNull();
    expect(target.querySelector("[data-testid='member-note']")?.textContent).toContain("Only company owners and admins can manage them.");
    expect(target.querySelector("[data-testid='cap-hint']")).toBeNull();
    click(target, "open-demo-1");
    await Promise.resolve();
    flushSync();
    expect(target.querySelector("[data-testid='manage-actions']")).toBeNull();
    expect(target.querySelector("[data-testid='member-detail-note']")?.textContent).toContain("Only owners and admins can change it.");
    expect(target.textContent).not.toContain("i-0abc");
  });

  it("follows the empty states", async () => {
    const admin = await show("admin", { items: [] });
    expect(admin.target.querySelector("[data-testid='empty-outposts']")?.textContent).toContain("No Outposts yet");
    expect(admin.target.querySelector("[data-testid='add-outpost-empty']")).not.toBeNull();
    await unmount(component!);
    component = null;
    const member = await show("member", { items: [] });
    expect(member.target.textContent).toContain("Ask an owner or admin to add one.");
  });

  it("hides add when the company is at the cap", async () => {
    const { target } = await show("admin", {
      items: [
        ...FIXTURE_BOXES,
        { ...FIXTURE_BOXES[0]!, id: "demo-5", name: "quiet-pine" },
      ],
    });
    expect(target.querySelector("[data-testid='add-outpost']")).toBeNull();
    expect(target.querySelector("[data-testid='cap-note']")?.textContent).toContain("which is the current limit");
  });

  it("does not add a row when provision fails", async () => {
    const { target, client } = await show("admin", {
      items: [FIXTURE_BOXES[0]!],
      plan: [{ status: "failure", message: failureCopy() }],
    });
    click(target, "add-outpost");
    click(target, "add-continue");
    expect(target.querySelector("[data-testid='agree']")).toBeNull();
    click(target, "create-outpost");
    await Promise.resolve();
    flushSync();
    expect(target.querySelector("[data-testid='provision-notice']")?.textContent).toBe("The Outpost was not added.");
    expect(client.readItems().map((item) => item.id)).toEqual(["demo-1"]);
  });

  it("shows the neutral not-available state with one line and one action when the company cannot add an Outpost", async () => {
    expect(UNAVAILABLE_COPY).toBe("Outposts are not available for this company yet.");
    for (const role of ["owner", "admin"] as const) {
      const { target, client } = await show(role, { items: [], plan: [{ status: "unavailable" }, successOutpost()] });
      click(target, "add-outpost-empty");
      click(target, "add-continue");
      click(target, "create-outpost");
      await Promise.resolve();
      flushSync();
      const card = target.querySelector<HTMLElement>("[data-testid='outposts-unavailable']");
      expect(card).not.toBeNull();
      expect(card!.querySelectorAll("p")).toHaveLength(1);
      expect(card!.querySelector("p")?.textContent).toBe(UNAVAILABLE_COPY);
      expect(card!.querySelectorAll("button")).toHaveLength(1);
      expect(card!.textContent ?? "").not.toMatch(BILLING_TEXT);
      expect(client.readItems()).toEqual([]);
      click(target, "unavailable-retry");
      expect(target.querySelector("[data-testid='outposts-unavailable']")).toBeNull();
      click(target, "create-outpost");
      await Promise.resolve();
      await Promise.resolve();
      flushSync();
      expect(client.readItems().map((item) => item.id)).toEqual(["demo-new"]);
      await unmount(component!);
      component = null;
    }
  });

  it("opens the not-available state from the preview and goes back to the list", async () => {
    const preview = companyOutpostPreview("unavailable-admin");
    const { target } = await show(preview.role, { items: [] }, { initialScreen: preview.initialScreen });
    expect(target.querySelector("[data-testid='outposts-unavailable'] p")?.textContent).toBe(UNAVAILABLE_COPY);
    click(target, "back-list");
    expect(target.querySelector("[data-testid='outposts-unavailable']")).toBeNull();
    expect(target.querySelector("[data-testid='empty-outposts']")).not.toBeNull();
  });

  it("renders no billing, price, or payer text in any fixture state for admin and member, light and dark", async () => {
    for (const theme of ["light", "dark"]) {
      document.documentElement.setAttribute("data-force-theme", theme);
      for (const screen of COMPANY_OUTPOST_SCREENS) {
        for (const role of ["admin", "member"] as const) {
          const label = `${theme} ${screen} ${role}`;
          const preview = companyOutpostPreview(screen);
          const target = document.createElement("div");
          document.body.appendChild(target);
          component = mount(CompanyOutpostPage, {
            target,
            props: {
              companyUid: "cmp_1",
              role,
              client: preview.client,
              now: FIXTURE_NOW,
              pollMs: null,
              initialScreen: preview.initialScreen,
              initialOutpostId: preview.initialOutpostId ?? "",
              initialJobId: preview.initialJobId ?? "",
              initialNotice: preview.initialNotice ?? "",
            },
          });
          for (let i = 0; i < 10; i += 1) {
            await Promise.resolve();
            flushSync();
            if (target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-ready") === "true") break;
          }
          expect(target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-ready"), label).toBe("true");
          const attributes = [...target.querySelectorAll("[title],[aria-label],[placeholder]")]
            .map((node) => ["title", "aria-label", "placeholder"].map((name) => node.getAttribute(name) ?? "").join(" "))
            .join(" ");
          expect(`${target.textContent ?? ""} ${attributes}`, label).not.toMatch(BILLING_TEXT);
          await unmount(component);
          component = null;
          target.remove();
        }
      }
    }
    document.documentElement.removeAttribute("data-force-theme");
  });

  it("adds a row only after a successful provision", async () => {
    const { target, client } = await show("admin", { items: [], plan: [successOutpost()] });
    click(target, "add-outpost-empty");
    click(target, "add-continue");
    click(target, "create-outpost");
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(client.readItems().map((item) => item.id)).toEqual(["demo-new"]);
  });

  it("opens a job on the outpost-jobs route, and keeps the stub when the app cannot open it yet", async () => {
    const open = vi.fn(() => false);
    vi.spyOn(window, "open").mockImplementation(() => null);
    const { target } = await show("admin", {}, { onOpenJob: open });
    click(target, "open-demo-4");
    await settle();
    expect(target.querySelector("[data-testid='blocked-note']")?.textContent).toBe(blockedNote("admin"));
    click(target, "job-inbox-check");
    await settle();
    expect(open).toHaveBeenCalledWith(outpostJobsDestination("cmp_1", "demo-4"));
    expect(outpostJobsDestination("cmp_1", "demo-4")).toEqual({
      kind: "extra",
      page: "outpost-jobs",
      companyUid: "cmp_1",
      param: "outpostId=demo-4&company=cmp_1",
    });
    expect(target.querySelector("[data-testid='outpost-jobs-stub']")?.getAttribute("data-route")).toBe("outpost-jobs");
    expect(window.open).not.toHaveBeenCalled();
  });

  it("leaves the stub closed when the app opens the outpost-jobs route", async () => {
    const open = vi.fn(async () => true);
    const { target } = await show("admin", {}, { onOpenJob: open });
    click(target, "open-demo-4");
    await settle();
    click(target, "job-inbox-check");
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(target.querySelector("[data-testid='outpost-jobs-stub']")).toBeNull();
    expect(target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-screen")).toBe("detail");
  });

  it("has no sign in again that only asks for a new link, and mounts the sign-in card slot", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    const signInCard = createRawSnippet((args: () => { companyUid: string; outpostId: string }) => ({
      render: () => `<span data-testid="signin-probe">${args().companyUid}/${args().outpostId}</span>`,
    }));
    const { target } = await show("admin", {}, { signInCard });
    click(target, "open-demo-1");
    await settle();
    expect(target.querySelector("[data-testid='sign-in-again']")).toBeNull();
    expect(target.textContent).not.toContain("This screen does not open a sign-in page.");
    expect(target.querySelector("[data-testid='company-outpost-signin-slot'] [data-testid='signin-probe']")?.textContent).toBe("cmp_1/demo-1");
    click(target, "back-list");
    click(target, "open-demo-4");
    await settle();
    expect(target.querySelector("[data-testid='company-outpost-signin-slot']")).toBeNull();
    expect(window.open).not.toHaveBeenCalled();
    await unmount(component!);
    component = null;
    const member = await show("member", {}, { signInCard });
    click(member.target, "open-demo-1");
    await settle();
    expect(member.target.querySelector("[data-testid='company-outpost-signin-slot']")).toBeNull();
  });

  it("opens the existing Outpost when provision answers already exists", async () => {
    const { target } = await show("admin", { items: [FIXTURE_BOXES[0]!], plan: [{ status: "already_exists", outpostId: "demo-1" }] });
    await addOutpost(target);
    expect(target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-screen")).toBe("detail");
    expect(target.querySelector("h1")?.textContent).toBe("main");
    expect(target.querySelector("[data-testid='detail-notice']")?.textContent).toBe("An Outpost already exists for this company.");
  });

  it("opens the listed Outpost when already exists names no id", async () => {
    const { target } = await show("admin", { items: [FIXTURE_BOXES[0]!], plan: [{ status: "already_exists" }] });
    await addOutpost(target);
    expect(target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-screen")).toBe("detail");
    expect(target.querySelector("h1")?.textContent).toBe("main");
  });

  it("keeps checking after an outcome-unknown provision, and Check now re-reads", async () => {
    const { target, client } = await show("admin", {
      items: [],
      plan: [{ status: "pending", attemptId: "" }, { status: "checking", signIn: false }, successOutpost()],
    });
    await addOutpost(target);
    expect(target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-screen")).toBe("preparing");
    const lists = client.listCount();
    click(target, "check-now");
    await settle();
    expect(client.pollArgs()).toEqual([""]);
    expect(client.listCount()).toBeGreaterThan(lists);
    expect(target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-screen")).toBe("preparing");
    click(target, "check-now");
    await settle();
    expect(client.pollArgs()).toEqual(["", ""]);
    expect(target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-screen")).toBe("detail");
  });

  it("does not open an older Outpost while an add with no id is still checking", async () => {
    const { target, client } = await show("admin", {
      items: [FIXTURE_BOXES[0]!],
      plan: [{ status: "pending", attemptId: "" }, { status: "success", outpost: { ...FIXTURE_BOXES[0]!, jobHealth: { ...FIXTURE_BOXES[0]!.jobHealth } } }],
    });
    await addOutpost(target);
    click(target, "check-now");
    await settle();
    expect(client.pollArgs()).toEqual([""]);
    expect(target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-screen")).toBe("preparing");
  });

  it("polls on its own while preparing, even with no attempt id", async () => {
    vi.useFakeTimers();
    const { target, client } = await show("admin", {
      items: [],
      plan: [{ status: "pending", attemptId: "" }, successOutpost()],
    }, { pollMs: 1000 });
    await addOutpost(target);
    expect(target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-screen")).toBe("preparing");
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(client.pollArgs()).toEqual([""]);
    expect(target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-screen")).toBe("detail");
  });

  it("stays on Preparing with a neutral note when the status read fails, and offers HQ sign-in when it expired", async () => {
    const onSignIn = vi.fn();
    const { target } = await show("admin", {
      items: [],
      plan: [{ status: "pending", attemptId: "op_1" }, { status: "checking", signIn: false }, { status: "checking", signIn: true }],
    }, { onSignIn });
    await addOutpost(target);
    click(target, "check-now");
    await settle();
    expect(target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-screen")).toBe("preparing");
    expect(target.textContent).not.toContain(failureCopy());
    expect(target.querySelector("[data-testid='check-now']")).not.toBeNull();
    expect(target.querySelector("[data-testid='prep-signin']")).toBeNull();
    click(target, "check-now");
    await settle();
    expect(target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-screen")).toBe("preparing");
    expect(target.textContent).not.toContain(failureCopy());
    expect(target.querySelector("[data-testid='prep-signin']")?.textContent).toContain("Sign in to HQ again to continue.");
    click(target, "prep-signin-action");
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it("refuses a rename that breaks the name rule and a remove until the name matches", async () => {
    const { target, client } = await show("admin");
    click(target, "open-demo-1");
    await Promise.resolve();
    flushSync();
    click(target, "rename");
    const input = target.querySelector<HTMLInputElement>("[data-testid='rename-name']")!;
    input.value = "Main Box";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    click(target, "rename-save");
    expect(target.querySelector("[data-testid='rename-error']")?.textContent).toContain("lowercase letters");
    click(target, "remove");
    const typed = target.querySelector<HTMLInputElement>("[data-testid='remove-name']")!;
    typed.value = "other";
    typed.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(target.querySelector<HTMLButtonElement>("[data-testid='remove-confirm']")?.disabled).toBe(true);
    typed.value = "main";
    typed.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    click(target, "remove-confirm");
    await Promise.resolve();
    flushSync();
    expect(client.readItems().map((item) => item.id)).not.toContain("demo-1");
  });

  it("tells a guest they do not have access", async () => {
    const { target } = await show("guest", { items: [] });
    expect(target.textContent).toContain("You do not have access");
    expect(target.textContent).toContain("Only company members can view Outposts.");
  });
});

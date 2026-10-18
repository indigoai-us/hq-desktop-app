// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import CompanyOutpostPage from "./CompanyOutpostPage.svelte";
import { FIXTURE_BOXES, FIXTURE_NOW, successOutpost } from "./company-outpost.fixture.js";
import { createCompanyOutpostStub } from "./company-outpost-stub.js";
import { blockedNote, failureCopy, formatOutpostPrice } from "./company-outpost-model.js";
import type { CompanyOutpostRole } from "./company-outpost-model.js";

describe("Company Outpost page", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    vi.restoreAllMocks();
  });

  async function show(role: CompanyOutpostRole, options: Parameters<typeof createCompanyOutpostStub>[0] = {}, props: Record<string, unknown> = {}) {
    const client = createCompanyOutpostStub({
      role,
      items: FIXTURE_BOXES,
      priceHint: formatOutpostPrice(80, "the company"),
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
    expect(target.querySelector("[data-testid='price-hint']")?.textContent).toContain("USD 80 a month, billed to the company");
  });

  it("shows the member list without manage actions", async () => {
    const { target } = await show("member");
    expect(target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-manage")).toBe("false");
    expect(target.querySelector("[data-testid='add-outpost']")).toBeNull();
    expect(target.querySelector("[data-testid='member-note']")?.textContent).toContain("Only company owners and admins can manage them.");
    expect(target.querySelector("[data-testid='price-hint']")).toBeNull();
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
    expect(member.target.querySelector("[data-testid='empty-outposts']")?.textContent).not.toContain("USD");
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

  it("does not add a row when provision fails, and records no charge", async () => {
    const { target, client } = await show("admin", {
      items: [FIXTURE_BOXES[0]!],
      plan: [{ status: "failure", charged: false, message: failureCopy(false) }],
    });
    click(target, "add-outpost");
    click(target, "add-continue");
    const agree = target.querySelector<HTMLInputElement>("[data-testid='agree']")!;
    agree.checked = true;
    agree.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    click(target, "create-outpost");
    await Promise.resolve();
    flushSync();
    expect(target.querySelector("[data-testid='provision-notice']")?.textContent).toContain("Nothing was charged.");
    expect(client.readItems().map((item) => item.id)).toEqual(["demo-1"]);
    expect(client.chargeCount()).toBe(0);
  });

  it("opens billing for the owner and not for another admin", async () => {
    const owner = await show("owner", { items: [], plan: [{ status: "payment_not_set_up" }] });
    click(owner.target, "add-outpost-empty");
    click(owner.target, "add-continue");
    const agree = owner.target.querySelector<HTMLInputElement>("[data-testid='agree']")!;
    agree.checked = true;
    agree.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    click(owner.target, "create-outpost");
    await Promise.resolve();
    flushSync();
    expect(owner.target.querySelector("[data-testid='open-billing']")).not.toBeNull();
    await unmount(component!);
    component = null;
    const admin = await show("admin", { items: [], plan: [{ status: "payment_not_set_up" }] });
    click(admin.target, "add-outpost-empty");
    click(admin.target, "add-continue");
    const box = admin.target.querySelector<HTMLInputElement>("[data-testid='agree']")!;
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    click(admin.target, "create-outpost");
    await Promise.resolve();
    flushSync();
    expect(admin.target.querySelector("[data-testid='billing-blocked']")).not.toBeNull();
    expect(admin.target.querySelector("[data-testid='open-billing']")).toBeNull();
  });

  it("adds a row only after a successful provision", async () => {
    const { target, client } = await show("admin", { items: [], plan: [successOutpost()] });
    click(target, "add-outpost-empty");
    click(target, "add-continue");
    const agree = target.querySelector<HTMLInputElement>("[data-testid='agree']")!;
    agree.checked = true;
    agree.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    click(target, "create-outpost");
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(client.readItems().map((item) => item.id)).toEqual(["demo-new"]);
    expect(client.chargeCount()).toBe(0);
  });

  it("shows the blocked note and a job stub on the stable route", async () => {
    const open = vi.fn();
    vi.spyOn(window, "open").mockImplementation(() => null);
    const { target } = await show("admin", {}, { onOpenJob: open });
    click(target, "open-demo-4");
    await Promise.resolve();
    flushSync();
    expect(target.querySelector("[data-testid='blocked-note']")?.textContent).toBe(blockedNote("admin"));
    click(target, "job-inbox-check");
    expect(target.querySelector("[data-testid='outpost-jobs-stub']")?.getAttribute("data-route")).toBe("outpost-jobs");
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ route: "outpost-jobs", jobId: "inbox-check" }));
    expect(window.open).not.toHaveBeenCalled();
  });

  it("asks for sign-in again without opening a page", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    const { target, client } = await show("admin");
    click(target, "open-demo-1");
    await Promise.resolve();
    flushSync();
    click(target, "sign-in-again");
    await Promise.resolve();
    flushSync();
    expect(target.textContent).toContain("This screen does not open a sign-in page.");
    expect(client.signInCount()).toBe(1);
    expect(window.open).not.toHaveBeenCalled();
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

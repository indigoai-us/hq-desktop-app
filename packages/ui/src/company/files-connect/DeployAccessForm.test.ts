// @vitest-environment happy-dom
import { ok } from "@hq/platform";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import DeployAccessForm from "./DeployAccessForm.svelte";

type Handler = (method: string, path: string, body?: unknown) => Record<string, unknown>;

let component: Record<string, unknown> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
});

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

function render(handler: Handler, props: Record<string, unknown> = {}) {
  const request = vi.fn(async (_scope: string, method: string, path: string, body?: unknown) => ok(handler(method, path, body)));
  const target = document.createElement("div");
  document.body.appendChild(target);
  const onclose = vi.fn();
  const ondone = vi.fn();
  component = mount(DeployAccessForm, {
    target,
    props: {
      appId: "app_1",
      appName: "standup-report",
      scope: "indigo",
      request,
      companyUid: "cmp_1",
      members: [{ id: "prs_a", email: "ada@x.co", label: "Ada · ada@x.co" }],
      onclose,
      ondone,
      ...props,
    },
  });
  return { target, request, ondone };
}

const q = (t: HTMLElement, id: string) => t.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const save = (t: HTMLElement) => q(t, "access-save") as HTMLButtonElement;

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

describe("QA-059 DeployAccessForm", () => {
  it("shows a skeleton while loading", () => {
    const request = vi.fn(() => new Promise(() => {}));
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(DeployAccessForm, {
      target,
      props: { appId: "app_1", appName: "x", scope: "indigo", request: request as never, onclose: () => {} },
    });
    flushSync();
    expect(q(target, "deploy-access-loading")).not.toBeNull();
    expect(save(target).disabled).toBe(true);
  });

  it("explains every mode and marks the current one", async () => {
    const { target } = render(() => ({ mode: "company", companyUid: "cmp_1" }));
    await settle();
    expect(q(target, "access-mode-company")?.getAttribute("aria-checked")).toBe("true");
    expect(q(target, "access-mode-company")?.textContent).toContain("current");
    expect(q(target, "access-mode-company")?.textContent).toContain("Signed-in members of this company can open it.");
    for (const label of ["Public", "Password", "Company members", "Selected people", "Email allowlist"]) {
      expect(target.textContent).toContain(label);
    }
    expect(save(target).disabled).toBe(true);
  });

  it("lists selected people by name", async () => {
    const { target } = render(() => ({ mode: "selected", companyUid: "cmp_1", users: [{ id: "prs_a" }], groups: [{ id: "grp_eng" }] }));
    await settle();
    const grants = q(target, "access-grants")!;
    expect(grants.textContent).toContain("Ada · ada@x.co");
    expect(grants.textContent).toContain("grp_eng");
  });

  it("lists the email allowlist for a private app", async () => {
    const { target, request } = render(
      () => ({ emails: [{ pattern: "@x.co", patternKey: "@x.co" }] }),
      { hint: { privateMode: true } },
    );
    await settle();
    expect(request.mock.calls[0]?.[2]).toBe("/api/apps/app_1/allowed-emails");
    expect(q(target, "access-mode-private")?.getAttribute("aria-checked")).toBe("true");
    expect(q(target, "access-grants")?.textContent).toContain("@x.co");
  });

  it("enables Save only after a change and confirms before applying", async () => {
    const { target, request, ondone } = render((method) => (method === "GET" ? { mode: "company", companyUid: "cmp_1" } : { mode: "public" }));
    await settle();
    expect(save(target).disabled).toBe(true);
    q(target, "access-mode-public")!.click();
    flushSync();
    expect(save(target).disabled).toBe(false);
    save(target).click();
    flushSync();
    const confirm = q(target, "deploy-access-confirm")!;
    expect(confirm.textContent).toContain("This will apply:");
    expect(confirm.textContent).toContain("Access changes from Company members to Public. Anyone with the link can open it.");
    expect(request).toHaveBeenCalledTimes(1);
    (q(target, "access-apply") as HTMLButtonElement).click();
    await settle();
    expect(request.mock.calls[1]).toEqual(["indigo", "POST", "/api/apps/app_1/access-mode", { mode: "public" }]);
    expect(ondone).toHaveBeenCalledWith("Access for standup-report saved: Public.");
  });

  it("never echoes the password back", async () => {
    const { target, request } = render((method) => (method === "GET" ? { mode: "password", companyUid: "cmp_1" } : {}));
    await settle();
    expect(target.textContent).toContain("A password is set. It is never shown here.");
    const input = q(target, "access-password") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    type(input, "short");
    expect(save(target).disabled).toBe(true);
    expect(q(target, "access-blocked")?.textContent).toContain("at least 8");
    type(input, "s3cret-rotated");
    save(target).click();
    flushSync();
    expect(q(target, "deploy-access-confirm")?.textContent).not.toContain("s3cret-rotated");
    expect(target.innerHTML).not.toContain("s3cret-rotated");
    (q(target, "access-apply") as HTMLButtonElement).click();
    await settle();
    expect(request.mock.calls[1]).toEqual([
      "indigo",
      "PUT",
      "/api/apps/app_1/access-policy",
      { mode: "password", companyUid: "cmp_1", password: "s3cret-rotated" },
    ]);
    expect((q(target, "access-password") as HTMLInputElement).value).toBe("");
  });

  it("adds an allowlist entry when switching to Email allowlist", async () => {
    const { target } = render(() => ({ mode: "public", companyUid: "cmp_1" }));
    await settle();
    q(target, "access-mode-private")!.click();
    flushSync();
    expect(save(target).disabled).toBe(true);
    type(q(target, "access-email") as HTMLInputElement, "@example.com");
    (q(target, "access-email-add") as HTMLButtonElement).click();
    flushSync();
    expect(q(target, "access-grants")?.textContent).toContain("@example.com");
    expect(save(target).disabled).toBe(false);
    save(target).click();
    flushSync();
    expect(q(target, "deploy-access-confirm")?.textContent).toContain("Add @example.com.");
  });

  it("shows a load error", async () => {
    const request = vi.fn(async () => ({ ok: false as const, reason: "network", message: "deploy access HTTP 403: Admin or owner access required" }));
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(DeployAccessForm, {
      target,
      props: { appId: "app_1", appName: "x", scope: "indigo", request: request as never, onclose: () => {} },
    });
    await settle();
    const text = q(target, "deploy-access-error")?.textContent ?? "";
    expect(text).toContain("Only company admins and owners");
    expect(text).not.toContain("Admin or owner access required");
    expect(text).not.toMatch(/HTTP \d{3}/);
  });
});

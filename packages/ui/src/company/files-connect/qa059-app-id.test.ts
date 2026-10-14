// @vitest-environment happy-dom
import { ok } from "@hq/platform";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import DeployAccessForm from "./DeployAccessForm.svelte";
import { accessErrorCopy } from "./deploy-access.js";
import { companyDeploymentRows } from "./files-connect-model.js";

// Shape of a real `GET /api/apps` row (org-scoped), ids redacted to placeholders.
const APPS_PAGE = {
  apps: [
    {
      accessMode: "company",
      active: true,
      createdAt: "2026-09-30T12:00:00.000Z",
      dnsStatus: "active",
      id: "00000000-0000-4000-8000-000000000001",
      lastVisitAt: "2026-10-02T12:00:00.000Z",
      name: "hq-lifecycle-email-map",
      orgSlug: "indigo",
      ownerId: "owner-placeholder",
      passwordProtected: false,
      policyVersion: 1,
      privateMode: false,
      status: "active",
      subdomain: "hq-lifecycle-email-map",
      type: "static",
      url: "https://hq-lifecycle-email-map.indigo-hq.com",
      views30d: 3,
    },
    { name: "no-record", subdomain: "no-record", status: "active" },
  ],
  callerSub: "owner-placeholder",
};

describe("QA-059 Access uses the hq-deploy app id", () => {
  it("maps the app record id, not the scoped row key or subdomain", () => {
    const [row] = companyDeploymentRows(APPS_PAGE as never, "indigo");
    expect(row.appId).toBe("00000000-0000-4000-8000-000000000001");
    expect(row.appId).not.toContain(":");
  });

  it("leaves appId empty when the server has no app record id", () => {
    const rows = companyDeploymentRows(APPS_PAGE as never, "indigo");
    expect(rows[1].appId ?? null).toBeNull();
  });
});

describe("QA-059 access error copy", () => {
  it("never passes raw transport text through", () => {
    for (const raw of ["deploy access: invalid app id", "deploy access HTTP 500: boom", "deploy access fetch: dns", "auth: expired"]) {
      const copy = accessErrorCopy(new Error(raw), "load");
      expect(copy).not.toMatch(/^deploy access/);
      expect(copy).not.toContain(raw);
    }
  });

  it("says access is managed where it was deployed when there is no record", () => {
    expect(accessErrorCopy(new Error("deploy access HTTP 404: App not found"), "load")).toMatch(/managed where it was deployed/);
  });
});

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

describe("QA-059 DeployAccessForm load failure", () => {
  it("shows plain copy and Try again, and retries", async () => {
    let calls = 0;
    const request = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? ({ ok: false as const, reason: "error", message: "deploy access: invalid app id" } as never)
        : ok({ mode: "company", users: [], groups: [] });
    });
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(DeployAccessForm, {
      target,
      props: { appId: "app_1", appName: "x", scope: "indigo", request, companyUid: "cmp_1", members: [], onclose: () => {} },
    });
    await settle();
    const alert = target.querySelector('[data-testid="deploy-access-error"]') as HTMLElement;
    expect(alert).not.toBeNull();
    expect(target.textContent ?? "").not.toMatch(/deploy access:/);
    const retry = target.querySelector('[data-testid="deploy-access-retry"]') as HTMLButtonElement;
    expect(retry).not.toBeNull();
    retry.click();
    await settle();
    expect(target.querySelector('[data-testid="deploy-access-error"]')).toBeNull();
  });
});

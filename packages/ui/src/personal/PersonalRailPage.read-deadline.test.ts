// @vitest-environment happy-dom
// BLANK-1: personal Secrets and Connections reads that never answer must not
// hold their skeletons forever; after the shared read deadline each shows
// plain copy and Retry.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectPendingRead } from "../common/read-loader.test-support.js";
import PersonalRailPage from "./PersonalRailPage.svelte";
import { clearPersonalRailCache } from "./personal-rail-model.js";
import { clearIntegrationsCache } from "./personal-integrations.js";

vi.mock("../company/company-store.svelte.js", () => ({
  companyStore: {
    revision: 0,
    loadSecrets: vi.fn(() => new Promise(() => {})),
    loadDeployments: vi.fn(() => new Promise(() => {})),
  },
}));

let component: Record<string, unknown> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  clearPersonalRailCache();
  clearIntegrationsCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PersonalRailPage pending read (BLANK-3)", () => {
  it("a secrets read that never answers keeps loading with a waiting line and Try again, never a failed state", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    component = mount(PersonalRailPage, { target: document.body, props: { page: "secrets" } });
    flushSync();
    expect(document.querySelector("[data-testid='personal-secrets-loader']")).toBeTruthy();
    await expectPendingRead(document, "personal-secrets-loader");
    expect(document.querySelector("[data-testid='personal-secrets-error']")).toBeNull();
    // BLANK-2: no zero counts next to the failed read.
    expect(document.querySelector("[data-testid='personal-secrets-count']")).toBeNull();
    // OWNER-R36: no side nav and no lone Personal scope; the count waits for a read that succeeded.
    expect(document.querySelector("[data-testid='scope-personal']")).toBeNull();
    expect(document.querySelector("[data-testid='personal-secrets-count']")).toBeNull();
  });

  it("a connections read that never answers keeps loading with a waiting line and Try again, never a failed state", async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    const never = () => new Promise(() => {});
    component = mount(PersonalRailPage, {
      target: document.body,
      props: { page: "connections", integrationsApi: { listMyGoogleAccounts: vi.fn(never), listMySlackAccounts: vi.fn(never) } } as never,
    });
    flushSync();
    expect(document.querySelector("[data-testid='personal-integrations-loader']")).toBeTruthy();
    await expectPendingRead(document, "personal-integrations-loader");
    expect(document.querySelector("[data-testid='personal-integrations-error']")).toBeNull();
    // OWNER-R36: no side nav; the header count waits for a read that succeeded.
    expect(document.querySelector("[data-testid='connections-personal-nav']")).toBeNull();
    expect(document.querySelector("[data-testid='personal-integrations-count']")).toBeNull();
    expect(logged).not.toHaveBeenCalled();
  });
});

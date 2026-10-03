// @vitest-environment happy-dom
// BLANK-1: personal Secrets and Connections reads that never answer must not
// hold their skeletons forever; after the shared read deadline each shows
// plain copy and Retry.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { READ_DEADLINE_MS } from "../common/read-deadline.js";
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

describe("PersonalRailPage read deadline (BLANK-1)", () => {
  it("a secrets read that never answers ends in the failed-read state", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    component = mount(PersonalRailPage, { target: document.body, props: { page: "secrets" } });
    flushSync();
    expect(document.querySelector("[data-testid='personal-secrets-skeleton']")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS + 10);
    flushSync();
    expect(document.querySelector("[data-testid='personal-secrets-skeleton']")).toBeNull();
    expect(document.querySelector("[data-testid='personal-secrets-error']")?.textContent).toContain("Could not reach your vault.");
    expect(document.querySelector("[data-testid='personal-secrets-retry']")).toBeTruthy();
  });

  it("a connections read that never answers ends in the failed-read state", async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    const never = () => new Promise(() => {});
    component = mount(PersonalRailPage, {
      target: document.body,
      props: { page: "connections", integrationsApi: { listMyGoogleAccounts: vi.fn(never), listMySlackAccounts: vi.fn(never) } } as never,
    });
    flushSync();
    expect(document.querySelector("[data-testid='personal-integrations-skeleton']")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS + 10);
    flushSync();
    expect(document.querySelector("[data-testid='personal-integrations-skeleton']")).toBeNull();
    expect(document.querySelector("[data-testid='personal-integrations-error']")?.textContent).toContain("Could not load your connections.");
    expect(document.querySelector("[data-testid='personal-integrations-retry']")).toBeTruthy();
    expect(logged).toHaveBeenCalled();
  });
});

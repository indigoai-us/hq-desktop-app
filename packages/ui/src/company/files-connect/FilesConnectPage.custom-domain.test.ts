// @vitest-environment happy-dom
import type { SettingsApi, ShellApi } from "@hq/platform";
import { ok } from "@hq/platform";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import FilesConnectPage from "./FilesConnectPage.svelte";

const openAgentWorkflow = vi.hoisted(() => vi.fn(async () => ({
  outcome: "opened" as const,
  ok: true,
  message: "Opened the deploy workflow in Claude Code.",
})));

vi.mock("../agent-workflow.js", () => ({ openAgentWorkflow }));
vi.mock("../company-store.svelte.js", () => ({
  companyStore: {
    revision: 0,
    loadSecrets: vi.fn(async () => [
      { name: "ATTIO_API_KEY", value: "sk-live-do-not-render", kind: "standard" },
    ]),
    loadDeployments: vi.fn(async () => [
      { name: "standup-report", url: "https://standup.example.test", state: "live" },
    ]),
  },
}));

describe("US-007 FilesConnectPage custom domains", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    openAgentWorkflow.mockClear();
  });

  function mountPage(
    page: "vault" | "integrations" | "secrets" | "deployments",
    files: unknown = null,
    extra: Record<string, unknown> = {},
  ) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(FilesConnectPage, {
      target,
      props: {
        page,
        slug: "indigo",
        files: files as never,
        shell: {
          openInEditor: vi.fn(async () => ok(undefined)),
          openClaudeCodeLink: vi.fn(async () => ok(undefined)),
          openCodexDeepLink: vi.fn(async () => ok(undefined)),
          openFileInClaude: vi.fn(async () => ok(undefined)),
          launchClaudeCode: vi.fn(async () => ok(undefined)),
          launchCodexWorkspace: vi.fn(async () => ok(undefined)),
          launchCliInTerminal: vi.fn(async () => ok(undefined)),
          detectAiTools: vi.fn(async () => ok({})),
          pickFolder: vi.fn(async () => ok(null)),
          pickFile: vi.fn(async () => ok(null)),
        } satisfies ShellApi,
        settings: {
          getConfig: vi.fn(async () => ok({})),
          getSettings: vi.fn(async () => ok({})),
          updateSettings: vi.fn(async () => ok(undefined)),
          getSetupStatus: vi.fn(async () => ok({})),
          getTelemetryConsent: vi.fn(async () => ok(null)),
        } satisfies SettingsApi,
        openExternal: vi.fn(),
        ...extra,
      },
    });
    flushSync();
    return target;
  }

  const apps = () =>
    vi.fn(async () =>
      ok({ apps: [{ id: "app_1", name: "launch-notes", subdomain: "launch-notes", url: "https://launch-notes.indigo-hq.com", status: "active" }] }),
    );
  const domainRequest = () =>
    vi.fn(async (_scope: string, method: string) =>
      ok(method === "GET" ? { status: 200, body: { appId: "app_1", domains: [] } } : { status: 500, body: {} }),
    );

  it("gives owners the company-level options and a per-deployment Custom domain", async () => {
    const deployDomainRequest = domainRequest();
    const target = mountPage("deployments", null, { listDeployApps: apps(), deployDomainRequest, companyRole: "Owner" });
    await vi.waitFor(() => expect(target.querySelector("[data-testid='deploy-domain']")).not.toBeNull());

    (target.querySelector("[data-testid='domain-options']") as HTMLButtonElement).click();
    flushSync();
    const options = target.querySelector("[data-testid='custom-domain-options']");
    expect(options?.textContent).toContain("One deployment on your domain");
    expect(options?.textContent).toContain("$20/month each");
    expect(target.querySelector("[data-testid='custom-domain-option-premium']")?.textContent).toContain("$500/month");
    expect(target.querySelector("[data-testid='custom-domain-premium-soon']")?.textContent).toContain("Coming soon");

    (target.querySelector("[data-testid='custom-domain-continue']") as HTMLButtonElement).click();
    flushSync();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='custom-domain-input']")).not.toBeNull());
    expect(deployDomainRequest).toHaveBeenCalledWith("indigo", "GET", "/api/apps/app_1/domains", undefined);
  });

  it("shows members the status sheet only, with no company-level options", async () => {
    const deployDomainRequest = domainRequest();
    const target = mountPage("deployments", null, { listDeployApps: apps(), deployDomainRequest, companyRole: "Member" });
    await vi.waitFor(() => expect(target.querySelector("[data-testid='deploy-domain']")).not.toBeNull());
    expect(target.querySelector("[data-testid='domain-options']")).toBeNull();

    (target.querySelector("[data-testid='deploy-domain']") as HTMLButtonElement).click();
    flushSync();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='custom-domain-member-empty']")).not.toBeNull());
    expect(target.querySelector("[data-testid='custom-domain-input']")).toBeNull();
  });

  it("shows and opens the live custom domain instead of the default address", async () => {
    const openExternal = vi.fn();
    const deployDomainRequest = vi.fn(async () =>
      ok({ status: 200, body: { appId: "app_1", domains: [{ domain: "yousufkalim.com", environment: "production", validationState: "validated" }] } }),
    );
    const target = mountPage("deployments", null, { listDeployApps: apps(), deployDomainRequest, companyRole: "Owner", openExternal });
    await vi.waitFor(() => expect(target.querySelector("[data-testid='deploy-url']")?.textContent).toBe("https://yousufkalim.com"));
    (target.querySelector("[data-testid='deploy-open']") as HTMLButtonElement).click();
    expect(openExternal).toHaveBeenCalledWith("https://yousufkalim.com");
  });

  it("keeps the default address while the custom domain is still pending", async () => {
    const deployDomainRequest = vi.fn(async () =>
      ok({ status: 200, body: { appId: "app_1", domains: [{ domain: "yousufkalim.com", environment: "production", validationState: "pending" }] } }),
    );
    const target = mountPage("deployments", null, { listDeployApps: apps(), deployDomainRequest, companyRole: "Owner" });
    await vi.waitFor(() => expect(deployDomainRequest).toHaveBeenCalledWith("indigo", "GET", "/api/apps/app_1/domains", undefined));
    await vi.waitFor(() => expect(target.querySelector("[data-testid='deploy-url']")?.textContent).toBe("https://launch-notes.indigo-hq.com"));
  });

  it("hides Custom domain on a host without the domain routes", async () => {
    const target = mountPage("deployments", null, { listDeployApps: apps(), companyRole: "Owner" });
    await vi.waitFor(() => expect(target.querySelector("[data-testid='deploy-access']")).not.toBeNull());
    expect(target.querySelector("[data-testid='deploy-domain']")).toBeNull();
    expect(target.querySelector("[data-testid='domain-options']")).toBeNull();
  });
});

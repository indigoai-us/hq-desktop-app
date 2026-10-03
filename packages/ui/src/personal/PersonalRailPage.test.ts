// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import PersonalRailPage from "./PersonalRailPage.svelte";
import { clearPersonalRailCache } from "./personal-rail-model.js";
import { clearIntegrationsCache } from "./personal-integrations.js";

vi.mock("../company/company-store.svelte.js", () => ({
  companyStore: {
    revision: 0,
    loadSecrets: vi.fn(async () => [
      { name: "GITHUB_TOKEN", scope: "Personal", value: "ghp_do_not_render", kind: "standard" },
      { name: "ATTIO_API_KEY", scope: "Company", value: "sk-company-do-not-render", kind: "standard" },
    ]),
    loadDeployments: vi.fn(async () => []),
  },
}));

describe("US-033 PersonalRailPage", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    clearPersonalRailCache();
    clearIntegrationsCache();
  });

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
  }

  function mountPage(page: "secrets" | "connections", extra: Record<string, unknown> = {}) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(PersonalRailPage, { target, props: { page, ...extra } });
    flushSync();
    return target;
  }

  it("shows every personal secret, paging past 50 with a Show more row", async () => {
    const { companyStore } = await import("../company/company-store.svelte.js");
    const rows = Array.from({ length: 55 }, (_, i) => ({ name: `TOKEN_${i}`, scope: "Personal", kind: "standard" }));
    vi.mocked(companyStore.loadSecrets).mockResolvedValueOnce(rows as never);
    const target = mountPage("secrets");
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    const list = target.querySelector("[data-testid='personal-secrets-list']") as HTMLElement;
    expect(target.querySelector("[data-testid='personal-secrets-count']")?.textContent).toBe("Secrets · 55");
    expect(list.querySelectorAll("button.srow")).toHaveLength(50);
    (target.querySelector("[data-testid='personal-secrets-show-more']") as HTMLButtonElement).click();
    flushSync();
    expect(list.querySelectorAll("button.srow")).toHaveLength(55);
    expect(target.querySelector("[data-testid='personal-secrets-show-more']")).toBeNull();
  });

  it("QA-058: a secrets search with no hits says no matches, clears the inspector, and clears", async () => {
    const target = mountPage("secrets");
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    const before = target.querySelectorAll("[data-testid='personal-secrets-list'] .srow").length;
    expect(before).toBeGreaterThan(0);
    expect(target.querySelector("[data-testid='secret-inspector'] h2")).not.toBeNull();
    const search = target.querySelector("input.search") as HTMLInputElement;
    search.value = "zz-no-qa-match";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(target.querySelectorAll("[data-testid='personal-secrets-list'] .srow").length).toBe(0);
    const empty = target.querySelector("[data-testid='personal-secrets-no-matches']");
    expect(empty?.textContent).toContain("No matches for 'zz-no-qa-match'");
    expect(target.querySelector("[data-testid='personal-secrets-no-matches-total']")?.textContent).toBe(
      `${before} ${before === 1 ? "secret" : "secrets"}`,
    );
    expect(target.querySelector("[data-testid='secret-inspector'] h2")).toBeNull();
    (target.querySelector("[data-testid='personal-secrets-no-matches-clear']") as HTMLButtonElement).click();
    flushSync();
    expect(search.value).toBe("");
    expect(target.querySelectorAll("[data-testid='personal-secrets-list'] .srow").length).toBe(before);
    expect(target.querySelector("[data-testid='personal-secrets-no-matches']")).toBeNull();
  });

  it("opens on personal-scope secrets and never renders a value", async () => {
    const target = mountPage("secrets");
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    const list = target.querySelector("[data-testid='personal-secrets-list']");
    expect(list?.textContent).toContain("GITHUB_TOKEN");
    expect(list?.textContent).not.toContain("ATTIO_API_KEY");
    expect(target.textContent).not.toContain("ghp_do_not_render");
    expect(target.textContent).not.toContain("sk-company");
    const share = target.querySelector("[data-testid='share-secret']") as HTMLButtonElement;
    share.click();
    flushSync();
    expect(target.querySelector("[data-testid='sheet-share-secret']")).not.toBeNull();
    expect(target.querySelector("[data-testid='share-no-value']")?.textContent).toContain("No secret value");
    expect(target.textContent).toContain("read");
    expect(target.textContent).toContain("write");
  });

  it("lists the real personal vault rows from the desktop secrets transport, names only", async () => {
    const { companyStore } = await import("../company/company-store.svelte.js");
    // Shape returned by get_company_secrets for the personal slug.
    vi.mocked(companyStore.loadSecrets).mockResolvedValueOnce([
      { env: "default", count: 2, items: [
        { key: "OPENAI_API_KEY", upd: "2026-09-30T00:00:00Z", rot: "" },
        { key: "VERCEL_TOKEN", upd: "", rot: "" },
      ] },
      { env: "ALIVE", count: 1, items: [{ key: "DATABASE_URL", upd: "", rot: "" }] },
    ] as never);
    const target = mountPage("secrets");
    expect(target.querySelector("[data-testid='personal-secrets-skeleton']")).not.toBeNull();
    await settle();
    expect(vi.mocked(companyStore.loadSecrets)).toHaveBeenCalledWith("personal", false);
    const list = target.querySelector("[data-testid='personal-secrets-list']") as HTMLElement;
    expect(target.querySelector("[data-testid='personal-secrets-count']")?.textContent).toBe("Secrets · 3");
    expect(list.textContent).toContain("OPENAI_API_KEY");
    expect(list.textContent).toContain("ALIVE/DATABASE_URL");
    // No design-fixture rows in the running app.
    expect(list.textContent).not.toContain("GITHUB_TOKEN");
    expect(list.textContent).not.toContain("SCREENPIPE_TOKEN");
    expect(target.querySelector("[data-testid='personal-secrets-skeleton']")).toBeNull();
  });

  it("shows the real reason and a Retry that reloads when the vault cannot be reached", async () => {
    const { companyStore } = await import("../company/company-store.svelte.js");
    vi.mocked(companyStore.loadSecrets)
      .mockRejectedValueOnce(new Error("AUTH_REQUIRED: secrets (HTTP 401 Unauthorized)"))
      .mockResolvedValueOnce([{ env: "default", count: 1, items: [{ key: "HQ_TOKEN", upd: "", rot: "" }] }] as never);
    const target = mountPage("secrets");
    await settle();
    const error = target.querySelector("[data-testid='personal-secrets-error']");
    expect(error?.textContent).toContain("Sign in again");
    expect(error?.textContent).not.toContain("HTTP 401");
    expect(target.querySelector("[data-testid='personal-secrets-list']")?.textContent).not.toContain("GITHUB_TOKEN");
    (target.querySelector("[data-testid='personal-secrets-retry']") as HTMLButtonElement).click();
    await settle();
    expect(vi.mocked(companyStore.loadSecrets)).toHaveBeenLastCalledWith("personal", true);
    expect(target.querySelector("[data-testid='personal-secrets-error']")).toBeNull();
    expect(target.querySelector("[data-testid='personal-secrets-list']")?.textContent).toContain("HQ_TOKEN");
  });

  const GOOGLE_BODY = {
    accounts: [
      { accountId: "g1", email: "me@example.com", scope: "", connectedAt: "2026-09-30T12:00:00Z", capabilities: ["gmail", "calendar", "drive"] },
    ],
  };
  const SLACK_BODY = {
    accounts: [
      { accountId: "s1", teamId: "T1", slackUserId: "U1", teamName: "Acme", teamDomain: "acme", slackUserDisplay: "Corey", companyUid: "cmp_a", capabilities: [], connectedAt: "2026-09-29T12:00:00Z", status: "active" },
    ],
  };

  function integrationsApi(overrides: Record<string, unknown> = {}) {
    return {
      listMyGoogleAccounts: vi.fn(async () => ({ ok: true as const, value: GOOGLE_BODY })),
      listMySlackAccounts: vi.fn(async () => ({ ok: true as const, value: SLACK_BODY })),
      ...overrides,
    };
  }

  it("lists personal integrations from the console routes, not the per-company placeholder", async () => {
    const api = integrationsApi();
    const target = mountPage("connections", { integrationsApi: api });
    await settle();
    const list = target.querySelector("[data-testid='personal-integrations-list']") as HTMLElement;
    expect(list.textContent).toContain("Google");
    expect(list.textContent).toContain("me@example.com");
    expect(list.textContent).toContain("Slack (personal)");
    expect(list.textContent).toContain("Corey · Acme");
    expect(list.textContent).toContain("Active");
    expect(list.textContent).toContain("Sep 30, 2026");
    expect(target.textContent).not.toContain("managed per company");
    expect(target.textContent).not.toContain("HQ does not have personal connections");
    const sources = target.querySelector("[data-testid='integration-sources']");
    expect(sources?.textContent).toContain("Calendar");
    expect(sources?.textContent).toContain("Drive");
    expect(sources?.textContent).toContain("Gmail");
  });

  it("paints cached integrations on the first frame and never flashes empty", async () => {
    const first = mountPage("connections", { integrationsApi: integrationsApi() });
    await settle();
    expect(first.querySelectorAll("[data-testid^='integration-row-']")).toHaveLength(2);
    await unmount(component!);
    let resolve: (v: unknown) => void = () => {};
    const slow = integrationsApi({
      listMyGoogleAccounts: vi.fn(() => new Promise((r) => { resolve = r; })),
    });
    const target = mountPage("connections", { integrationsApi: slow });
    expect(target.querySelectorAll("[data-testid^='integration-row-']")).toHaveLength(2);
    expect(target.querySelector("[data-testid='personal-integrations-skeleton']")).toBeNull();
    expect(target.querySelector("[data-testid='personal-integrations-empty']")).toBeNull();
    resolve({ ok: true, value: GOOGLE_BODY });
    await settle();
    expect(target.querySelectorAll("[data-testid^='integration-row-']")).toHaveLength(2);
  });

  it("shows the empty state with a web console link when nothing is connected", async () => {
    const opened: string[] = [];
    const api = integrationsApi({
      listMyGoogleAccounts: vi.fn(async () => ({ ok: true as const, value: { accounts: [] } })),
      listMySlackAccounts: vi.fn(async () => ({ ok: true as const, value: { accounts: [] } })),
    });
    const target = mountPage("connections", { integrationsApi: api, openExternal: (url: string) => opened.push(url) });
    await settle();
    const empty = target.querySelector("[data-testid='personal-integrations-empty']") as HTMLElement;
    expect(empty.textContent).toContain("No personal connections yet · Manage in the web console");
    (target.querySelector("[data-testid='console-link-empty']") as HTMLAnchorElement).click();
    expect(opened).toEqual(["https://hq.computer/personal/integrations"]);
  });

  it("shows plain-language error copy with a retry, never the server text", async () => {
    const failure = { ok: false as const, reason: "error" as const, code: "http-500", message: "Internal Server Error: DynamoDB throttled" };
    const api = integrationsApi({
      listMyGoogleAccounts: vi.fn(async () => failure),
      listMySlackAccounts: vi.fn(async () => failure),
    });
    const target = mountPage("connections", { integrationsApi: api });
    await settle();
    const error = target.querySelector("[data-testid='personal-integrations-error']") as HTMLElement;
    expect(error.textContent).toContain("Could not load your connections");
    expect(target.textContent).not.toMatch(/500|Internal Server Error|DynamoDB|http-/);
    api.listMyGoogleAccounts.mockResolvedValueOnce({ ok: true, value: GOOGLE_BODY } as never);
    (target.querySelector("[data-testid='personal-integrations-retry']") as HTMLButtonElement).click();
    await settle();
    expect(target.querySelector("[data-testid='personal-integrations-error']")).toBeNull();
    expect(target.textContent).toContain("me@example.com");
  });

  it("is view-only: no add, manage, or disconnect, and the console link opens through the host", async () => {
    const opened: string[] = [];
    const api = integrationsApi();
    const target = mountPage("connections", { integrationsApi: api, openExternal: (url: string) => opened.push(url) });
    await settle();
    expect(Object.keys(api).filter((key) => /disconnect|connect[A-Z]|add|delete|remove/i.test(key))).toEqual([]);
    expect(target.querySelector("[data-testid='add-integration']")).toBeNull();
    expect(target.querySelector("[data-testid='integration-manage']")).toBeNull();
    expect(target.querySelector("[data-testid='integration-disconnect']")).toBeNull();
    const buttons = [...target.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
    expect(buttons.filter((t) => /^(Add integration|Manage|Disconnect|Show)$/.test(t))).toEqual([]);
    const link = target.querySelector("[data-testid='console-link']") as HTMLAnchorElement;
    expect(link.textContent).toBe("Manage connections in the web console");
    link.click();
    expect(opened).toEqual(["https://hq.computer/personal/integrations"]);
    expect(api.listMyGoogleAccounts).toHaveBeenCalledTimes(1);
    expect(api.listMySlackAccounts).toHaveBeenCalledTimes(1);
  });

  it("opens the selected company's console Integrations page from one row", async () => {
    const opened: string[] = [];
    const target = mountPage("connections", {
      integrationsApi: integrationsApi(),
      companies: [
        { uid: "cmp_a", label: "Acme" },
        { uid: "cmp_b", label: "Beta" },
      ],
      activeCompany: { uid: "cmp_b", label: "Beta", slug: "beta" },
      openExternal: (url: string) => opened.push(url),
    });
    await settle();
    expect(target.querySelector("[data-testid='connections-company-cmp_a']")).toBeNull();
    const link = target.querySelector("[data-testid='company-connections-link']") as HTMLButtonElement;
    expect(link.textContent).toContain("Company connections");
    link.click();
    expect(opened).toEqual(["https://hq.computer/companies/beta/integrations"]);
  });

  it("hides the company row when no company is selected", async () => {
    const target = mountPage("connections", { integrationsApi: integrationsApi() });
    await settle();
    expect(target.querySelector("[data-testid='company-connections-link']")).toBeNull();
  });

  it("shows Allowed, Ask first, and Never on the Agents and MCP tab in the design fixture", () => {
    const target = mountPage("connections", { fixtures: true });
    const tab = target.querySelector("[data-testid='agents-mcp']") as HTMLButtonElement;
    tab.click();
    flushSync();
    const policy = target.querySelector("[data-testid='policy-github']");
    expect(policy?.textContent).toContain("Allowed");
    expect(policy?.textContent).toContain("Ask first");
    expect(policy?.textContent).toContain("Never");
    const ask = [...(policy?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Never");
    ask?.click();
    flushSync();
    expect(policy?.querySelector("[aria-pressed='true']")?.textContent).toBe("Never");
  });

  it("closes Add connection and New secret on Escape (QA-003, QA-015)", async () => {
    // Add connection lives in the connections design fixture; the running app
    // shows the per-company state instead.
    const target = mountPage("connections", { fixtures: true });
    (target.querySelector("[data-testid='add-connection']") as HTMLButtonElement).click();
    flushSync();
    expect(target.querySelector("[data-testid='sheet-connect']")).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    flushSync();
    expect(target.querySelector("[data-testid='sheet-connect']")).toBeNull();
    await unmount(component!);
    component = null;

    const secrets = mountPage("secrets");
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    (secrets.querySelector("[data-testid='new-secret']") as HTMLButtonElement).click();
    flushSync();
    expect(secrets.querySelector("[data-testid='sheet-new-secret']")).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    flushSync();
    expect(secrets.querySelector("[data-testid='sheet-new-secret']")).toBeNull();
  });

  it("updates the detail pane when a connection row is clicked", () => {
    const target = mountPage("connections", { fixtures: true });
    const inspector = target.querySelector("[data-testid='connection-inspector']") as HTMLElement;
    expect(inspector.querySelector("h2")?.textContent).toBe("GitHub");
    (target.querySelector("[data-testid='connection-row-slack']") as HTMLElement).click();
    flushSync();
    expect(inspector.querySelector("h2")?.textContent).toBe("Slack");
    expect(target.querySelector("[data-testid='connection-row-slack']")?.getAttribute("aria-current")).toBe("true");
  });

  it("updates the secret inspector when a secret row is clicked", async () => {
    const target = mountPage("secrets");
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    const rows = [...target.querySelectorAll<HTMLButtonElement>("[data-testid='personal-secrets-list'] button.srow")];
    const last = rows[rows.length - 1]!;
    last.click();
    flushSync();
    const name = last.querySelector(".nm")?.textContent;
    expect(target.querySelector("[data-testid='secret-inspector'] h2")?.textContent).toBe(name);
  });

  it("wires the row Disconnect button to a confirm that really disconnects", () => {
    const target = mountPage("connections", { fixtures: true });
    (target.querySelector("[data-testid='row-action-github']") as HTMLButtonElement).click();
    flushSync();
    expect(target.querySelector("[data-testid='sheet-confirm-disconnect']")).not.toBeNull();
    (target.querySelector("[data-testid='confirm-disconnect']") as HTMLButtonElement).click();
    flushSync();
    expect(target.querySelector("[data-testid='sheet-confirm-disconnect']")).toBeNull();
    expect(target.querySelector("[data-testid='connection-row-github']")).toBeNull();
  });

  it("marks the chosen bot policy in the detail pane", () => {
    const target = mountPage("connections", { fixtures: true });
    const policy = target.querySelector("[data-testid='detail-policy']") as HTMLElement;
    const never = [...policy.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Never")!;
    never.click();
    flushSync();
    expect(policy.querySelector("[aria-pressed='true']")?.textContent?.trim()).toBe("Never");
  });

  it("keeps the app name and its account in separate, spaced spans (QA-035)", () => {
    const target = mountPage("connections", { fixtures: true });
    const row = target.querySelector("[data-testid='connection-row-github']") as HTMLElement;
    const name = row.querySelector(".nm");
    const meta = row.querySelector(".meta");
    expect(name?.textContent).toBe("GitHub");
    expect(meta?.textContent?.length).toBeGreaterThan(0);
    expect(name?.contains(meta!)).toBe(false);
    // The cell lays name and account out with a gap, so they never read as one word.
    expect(name?.parentElement?.classList.contains("cell")).toBe(true);
  });
});

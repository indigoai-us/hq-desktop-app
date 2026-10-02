// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import PersonalRailPage from "./PersonalRailPage.svelte";
import { clearPersonalRailCache } from "./personal-rail-model.js";

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

  it("says connections are managed per company and links into each company's Integrations", () => {
    const opened: string[] = [];
    const target = mountPage("connections", {
      companies: [
        { uid: "cmp_a", label: "Acme" },
        { uid: "cmp_b", label: "Beta" },
      ],
      onopenintegrations: (uid: string) => opened.push(uid),
    });
    const state = target.querySelector("[data-testid='connections-per-company']");
    expect(state?.textContent).toContain("managed per company");
    // No invented GitHub, Google, or Slack rows in the running app.
    expect(target.textContent).not.toContain("GitHub");
    expect(target.textContent).not.toContain("Slack");
    expect(target.querySelector("[data-testid='connections-list']")).toBeNull();
    (target.querySelector("[data-testid='connections-company-cmp_b']") as HTMLButtonElement).click();
    expect(opened).toEqual(["cmp_b"]);
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

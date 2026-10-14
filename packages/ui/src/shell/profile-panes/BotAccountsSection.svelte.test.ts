// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import BotAccountsSection from "./BotAccountsSection.svelte";
import { accountsFromStatusPayload, type AccountsClient, type BotAccount } from "./bot-accounts.js";

let host: HTMLDivElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (app) unmount(app);
  app = null;
  host.remove();
  vi.restoreAllMocks();
});

function q(sel: string): HTMLElement | null {
  return host.querySelector(sel) as HTMLElement | null;
}

function all(sel: string): HTMLElement[] {
  return Array.from(host.querySelectorAll(sel)) as HTMLElement[];
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await settle();
}

function typeInto(el: HTMLElement | null, value: string): void {
  const input = el as HTMLInputElement | HTMLSelectElement;
  input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

const LEGACY_ONLY = accountsFromStatusPayload({
  accounts: [{ id: "legacy", provider: "codex", label: "", authKind: "subscription", status: "active" }],
})!;

const ok = (value: unknown) => ({ ok: true as const, value });

function clientWith(overrides: Partial<AccountsClient> = {}): AccountsClient {
  return {
    add: vi.fn(async () => ok({})),
    remove: vi.fn(async () => ok({})),
    startSignIn: vi.fn(async () => ok({ state: "starting" })),
    getSignIn: vi.fn(async () => ok({ state: "pending" })),
    submitLoginCode: vi.fn(async () => ok({})),
    ...overrides,
  };
}

/** Mounts the section and keeps `accounts` in sync the way the host pane does. */
function mountSection(initial: readonly BotAccount[], props: { canManage: boolean; client: AccountsClient | null; onopenurl?: (url: string) => void }) {
  const state = $state({ accounts: [...initial] as BotAccount[] });
  app = mount(BotAccountsSection, {
    target: host,
    props: {
      get accounts() {
        return state.accounts;
      },
      canManage: props.canManage,
      client: props.client,
      onopenurl: props.onopenurl,
      pollMs: 5,
      onaccounts: (next: BotAccount[]) => {
        state.accounts = next;
      },
    },
  });
  return state;
}

function rowNames(): string[] {
  return all('[data-testid="bot-account"] .t').map((el) => el.textContent?.trim() ?? "");
}

describe("BotAccountsSection", () => {
  it("lets the owner add a second Codex account and sign it in end to end", async () => {
    const created = { id: "acct_2", provider: "codex", label: "Work", authKind: "subscription", status: "needs_auth" };
    let approved = false;
    const client = clientWith({
      add: vi.fn(async () => ok({ account: created, accounts: [{ id: "legacy", provider: "codex", status: "active" }, created] })),
      startSignIn: vi.fn(async () => ok({ state: "starting", account: created })),
      getSignIn: vi.fn(async () => {
        if (!approved) return ok({ state: "pending", url: "https://auth.example/device", code: "WXYZ-1234", account: created });
        return ok({ state: "signed-in", account: { ...created, status: "active" } });
      }),
    });
    const opened: string[] = [];
    mountSection(LEGACY_ONLY, { canManage: true, client, onopenurl: (url) => opened.push(url) });
    await settle();

    expect(rowNames()).toEqual(["Default"]);
    q('[data-testid="bot-accounts-add"]')!.click();
    await settle();
    typeInto(q('[data-testid="bot-accounts-add-label"]'), "Work");
    await settle();
    (q('[data-testid="bot-accounts-add-form"]') as HTMLFormElement).requestSubmit();
    await settle();

    expect(client.add).toHaveBeenCalledWith({ provider: "codex", label: "Work", authKind: "subscription" });
    expect(rowNames()).toEqual(["Default", "Work"]);
    expect(client.startSignIn).toHaveBeenCalledWith("acct_2");
    expect(q('[data-testid="bot-account-sign-in-panel"]')).not.toBeNull();

    await wait(10);
    expect(q('[data-testid="bot-account-sign-in-code"]')?.textContent).toBe("WXYZ-1234");
    q('[data-testid="bot-account-open-sign-in"]')!.click();
    expect(opened).toEqual(["https://auth.example/device"]);
    expect(q('[data-account-id="acct_2"] [data-testid="bot-account-status"]')?.textContent).toBe("Needs sign-in");

    approved = true;
    await wait(20);
    expect(q('[data-testid="bot-account-sign-in-panel"]')).toBeNull();
    const work = q('[data-account-id="acct_2"] [data-testid="bot-account-status"]');
    expect(work?.textContent).toBe("Active");
  });

  it("takes a pasted code for a Claude account", async () => {
    const claude = accountsFromStatusPayload({
      accounts: [
        { id: "legacy", provider: "claude", status: "active" },
        { id: "acct_3", provider: "claude", label: "Personal", status: "needs_auth" },
      ],
    })!;
    const client = clientWith({
      startSignIn: vi.fn(async () => ok({ state: "pending", url: "https://claude.example/oauth" })),
    });
    mountSection(claude, { canManage: true, client });
    await settle();

    q('[data-account-id="acct_3"] [data-testid="bot-account-sign-in"]')!.click();
    await settle();
    expect(q('[data-testid="bot-account-sign-in-code"]')).toBeNull();
    typeInto(q('[data-testid="bot-account-login-code"]'), "abc#def");
    await settle();
    q('[data-testid="bot-account-send-code"]')!.click();
    await settle();

    expect(client.submitLoginCode).toHaveBeenCalledWith("acct_3", "abc#def");
    expect(q('[data-testid="bot-account-code-sent"]')).not.toBeNull();
  });

  it("shows a non-owner the list with no add, remove or sign-in controls", async () => {
    const list = accountsFromStatusPayload({
      accounts: [
        { id: "legacy", provider: "codex", status: "active" },
        { id: "acct_2", provider: "claude", label: "Work", status: "needs_auth" },
      ],
    })!;
    mountSection(list, { canManage: false, client: clientWith() });
    await settle();

    expect(rowNames()).toEqual(["Default", "Work"]);
    expect(q('[data-testid="bot-accounts-add"]')).toBeNull();
    expect(q('[data-testid="bot-account-remove"]')).toBeNull();
    expect(q('[data-testid="bot-account-sign-in"]')).toBeNull();
  });

  it("hides the controls when this build has no account calls, even for the owner", async () => {
    mountSection(LEGACY_ONLY, { canManage: true, client: null });
    await settle();
    expect(q('[data-testid="bot-accounts-add"]')).toBeNull();
  });

  it("keeps the legacy Default row read-only", async () => {
    mountSection(LEGACY_ONLY, { canManage: true, client: clientWith() });
    await settle();
    expect(q('[data-account-id="legacy"] [data-testid="bot-account-remove"]')).toBeNull();
    expect(q('[data-testid="bot-accounts-add"]')).not.toBeNull();
  });

  it("keeps sign-in reachable on active and resting accounts", async () => {
    const list = accountsFromStatusPayload({
      accounts: [
        { id: "acct_1", provider: "codex", label: "Main", status: "active" },
        { id: "acct_2", provider: "claude", label: "Spare", status: "benched" },
        { id: "acct_3", provider: "codex", label: "New", status: "needs_auth" },
      ],
    })!;
    mountSection(list, { canManage: true, client: clientWith() });
    await settle();
    const label = (id: string) => q(`[data-account-id="${id}"] [data-testid="bot-account-sign-in"]`)?.textContent?.trim();
    expect(label("acct_1")).toBe("Sign in again");
    expect(label("acct_2")).toBe("Sign in again");
    expect(label("acct_3")).toBe("Sign in");
  });

  it("disables remove on the only account", async () => {
    const one = accountsFromStatusPayload({ accounts: [{ id: "acct_1", provider: "grok", label: "Solo" }] })!;
    mountSection(one, { canManage: true, client: clientWith() });
    await settle();
    expect((q('[data-testid="bot-account-remove"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("removes an account after confirm, and shows plain copy when the server refuses", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = accountsFromStatusPayload({
      accounts: [
        { id: "acct_1", provider: "codex", label: "Main" },
        { id: "acct_2", provider: "codex", label: "Spare" },
      ],
    })!;
    const remove = vi
      .fn<AccountsClient["remove"]>()
      .mockResolvedValueOnce({ ok: false, reason: "conflict", message: "last_account", status: 409 })
      .mockResolvedValueOnce(ok({ accounts: [{ id: "acct_1", provider: "codex", label: "Main" }] }));
    mountSection(list, { canManage: true, client: clientWith({ remove }) });
    await settle();

    q('[data-account-id="acct_2"] [data-testid="bot-account-remove"]')!.click();
    await settle();
    q('[data-testid="bot-account-remove-confirm"]')!.click();
    await settle();
    expect(q('[data-testid="bot-account-error"]')?.textContent).toBe("A bot needs at least one account.");
    expect(host.textContent).not.toContain("last_account");

    q('[data-testid="bot-account-remove-confirm"]')!.click();
    await settle();
    expect(remove).toHaveBeenLastCalledWith("acct_2");
    expect(rowNames()).toEqual(["Main"]);
  });

  it("offers Try again when sign-in fails", async () => {
    const list = accountsFromStatusPayload({
      accounts: [
        { id: "legacy", provider: "codex", status: "active" },
        { id: "acct_2", provider: "codex", label: "Work", status: "needs_auth" },
      ],
    })!;
    const startSignIn = vi
      .fn<AccountsClient["startSignIn"]>()
      .mockResolvedValueOnce(ok({ state: "failed", reason: "duplicate-account" }))
      .mockResolvedValueOnce(ok({ state: "pending", url: "https://auth.example/device", code: "AAAA-0000" }));
    mountSection(list, { canManage: true, client: clientWith({ startSignIn }) });
    await settle();

    q('[data-testid="bot-account-sign-in"]')!.click();
    await settle();
    expect(q('[data-testid="bot-account-sign-in-error"]')?.textContent).toBe("That login is already on this bot.");
    q('[data-testid="bot-account-sign-in-retry"]')!.click();
    await settle();
    expect(startSignIn).toHaveBeenCalledTimes(2);
    expect(q('[data-testid="bot-account-sign-in-code"]')?.textContent).toBe("AAAA-0000");
  });

  it("shows plain copy when an add is refused", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const add = vi.fn<AccountsClient["add"]>(async () => ({ ok: false, reason: "conflict", message: "label exists", status: 409 }));
    mountSection(LEGACY_ONLY, { canManage: true, client: clientWith({ add }) });
    await settle();
    q('[data-testid="bot-accounts-add"]')!.click();
    await settle();
    typeInto(q('[data-testid="bot-accounts-add-label"]'), "Work");
    await settle();
    (q('[data-testid="bot-accounts-add-form"]') as HTMLFormElement).requestSubmit();
    await settle();
    expect(q('[data-testid="bot-accounts-add-error"]')?.textContent).toContain("Pick another name");
    expect(q('[data-testid="bot-accounts-add-submit"]')?.textContent).toContain("Try again");
    expect(rowNames()).toEqual(["Default"]);
  });
});

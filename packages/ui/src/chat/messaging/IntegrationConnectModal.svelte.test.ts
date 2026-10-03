// @vitest-environment happy-dom

// The key modal of an integration card: the app's name and logo on the
// frame, one line, Get a key when the blueprint says where, the field
// labelled the way the blueprint names the credential, and Connect. The
// pasted key never leaves the field and the one request that carries it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import IntegrationConnectModal from "./IntegrationConnectModal.svelte";
import type { CardModalContentProps } from "./card-modal-registry.js";

/** An obviously fake key. Never a real one. */
const KEY = "fake-key-0000";
const NOVA = "agt_nova";
const LOGO = { mark: null, sources: ["https://t0.gstatic.com/faviconV2?x=example", "https://icons.duckduckgo.com/ip3/example.com.ico"] };

const BLUEPRINT = {
  ok: true,
  companyUid: "cmp_acme",
  blueprint: {
    provider: "example",
    displayName: "Example",
    domain: "example.com",
    credentials: [{ id: "api_key", type: "api_key", label: "API key", generateUrl: "https://example.com/settings/api" }],
    surfaces: [{ kind: "mcp", slug: "mcp", name: "MCP", url: "https://mcp.example.com/mcp", authStatus: "required", credentialIds: ["api_key"] }],
    warnings: [],
  },
};
const INSTALLED = {
  connection: { id: "acct_example", provider: "factory:example", status: "connected" },
  installation: { id: "inst_1", displayName: "Example", domain: "example.com", status: "installed" },
};

const refusal = (code: string, httpStatus?: number) => ({
  ok: false as const,
  reason: "error" as const,
  code,
  message: "server text that is never shown",
  ...(httpStatus ? { status: httpStatus } : {}),
});

let shell: HTMLDivElement;
let message: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let blueprint: ReturnType<typeof vi.fn>;
let install: ReturnType<typeof vi.fn>;
let openUrl: ReturnType<typeof vi.fn<(url: string) => void>>;
let started: ReturnType<typeof vi.fn<() => void>>;
let onclose: ReturnType<typeof vi.fn<() => void>>;
let connected: ReturnType<typeof vi.fn<(connection: { id: string; provider: string; name: string }) => void>>;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  shell = document.createElement("div");
  shell.className = "desktop-shell";
  shell.setAttribute("data-shell-focus-fallback", "");
  shell.tabIndex = -1;
  message = document.createElement("div");
  shell.appendChild(message);
  document.body.appendChild(shell);
  blueprint = vi.fn(async () => ok(BLUEPRINT));
  install = vi.fn(async () => ok(INSTALLED));
  openUrl = vi.fn<(url: string) => void>();
  started = vi.fn<() => void>();
  onclose = vi.fn<() => void>();
  connected = vi.fn();
});

afterEach(async () => {
  await takeDown();
  shell.remove();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

function render(over: Partial<CardModalContentProps> = {}, integration: Partial<CardModalContentProps["integration"] & object> = {}): void {
  const adapter = { integrations: { blueprint, install } } as unknown as PlatformAdapter;
  const props: CardModalContentProps = {
    frame: { open: true, title: "Example", icon: "integration", logo: LOGO, art: "/art/aurora.jpg", artPosition: "center", onclose },
    agentUid: NOVA,
    target: "integration",
    integration: { domain: "example.com", name: "Example", authClass: "key", catalogEntryId: null, connected, ...integration },
    botName: "Nova",
    companyUid: "cmp_acme",
    companySlug: "acme",
    status: null,
    statusDenied: false,
    checkedAt: Date.now(),
    adapter,
    openUrl,
    refresh: vi.fn(async () => {}),
    started,
    ...over,
  };
  component = mount(IntegrationConnectModal, { target: message, props });
  flushSync();
}

async function takeDown(): Promise<void> {
  if (component) await unmount(component);
  component = null;
}

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

const dialog = () => document.querySelector<HTMLElement>('[data-testid="card-modal"]')!;
const field = () => document.querySelector<HTMLInputElement>('[data-testid="integration-connect-key"] input')!;
const submit = () => document.querySelector<HTMLButtonElement>('[data-testid="integration-connect-submit"]')!;
const errorText = () => document.querySelector('[data-testid="card-modal-field-error"]')?.textContent ?? "";

function type(value: string): void {
  const input = field();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

/** Nothing anywhere holds the key: not storage, not the page, not a request's path. */
function expectNoKeyAnywhere(): void {
  expect(JSON.stringify(window.localStorage)).not.toContain(KEY);
  expect(JSON.stringify(window.sessionStorage)).not.toContain(KEY);
  expect(document.body.innerHTML).not.toContain(KEY);
  for (const call of install.mock.calls) expect(JSON.stringify(call[0]).includes(KEY)).toBe(true);
}

describe("IntegrationConnectModal", () => {
  it("draws the app's logo and name on the frame, one line, the field and Connect, and reads the blueprint once", async () => {
    render();
    await settle();
    expect(dialog().querySelector('[data-testid="card-modal-title"]')?.textContent).toBe("Example");
    expect(dialog().querySelector('[data-testid="connection-card-logo"]')).not.toBeNull();
    // No bundled mark for example.com: the generic glyph holds the box while the favicon loads. No letters from the name.
    expect(dialog().querySelector('[data-testid="connection-card-logo-generic"]')).not.toBeNull();
    expect(dialog().querySelector('[data-testid="connection-card-logo-img"]')?.getAttribute("src")).toBe(LOGO.sources[0]);
    expect(dialog().querySelector('[data-testid="connection-card-logo"]')?.textContent?.trim()).toBe("");
    expect(dialog().textContent).toContain("Example needs a key to connect.");
    expect(blueprint).toHaveBeenCalledTimes(1);
    expect(blueprint).toHaveBeenCalledWith({ companyUid: "cmp_acme", domain: "example.com" });
    // The field is a password field, labelled the way the blueprint names the credential, and has focus.
    expect(field().type).toBe("password");
    expect(dialog().querySelector("label")?.textContent).toBe("API key");
    expect(document.activeElement).toBe(field());
    expect(submit().disabled).toBe(true);
    // Get a key opens the blueprint's page through the host.
    dialog().querySelector<HTMLButtonElement>('[data-testid="integration-connect-get-key"]')!.click();
    expect(openUrl).toHaveBeenCalledWith("https://example.com/settings/api");
    expect(install).not.toHaveBeenCalled();
  });

  it("reads the blueprint by catalog entry when the lookup carried one, and installs by it", async () => {
    render({}, { catalogEntryId: "cat_example" });
    await settle();
    expect(blueprint).toHaveBeenCalledWith({ companyUid: "cmp_acme", catalogEntryId: "cat_example" });
    type(KEY);
    submit().click();
    await settle();
    expect(install).toHaveBeenCalledWith({ companyUid: "cmp_acme", catalogEntryId: "cat_example", bearerToken: KEY });
  });

  it("labels the field Key and offers no Get a key when the blueprint cannot be read", async () => {
    blueprint.mockResolvedValueOnce(refusal("http-500", 500));
    render();
    await settle();
    expect(dialog().querySelector("label")?.textContent).toBe("Key");
    expect(dialog().querySelector('[data-testid="integration-connect-get-key"]')).toBeNull();
    expect(dialog().textContent).toContain("Could not read what Example needs. You can still paste a key.");
  });

  it("submits the key once by the blueprint's MCP URL, clears it on accept, and tells the host", async () => {
    let finish: (value: unknown) => void = () => {};
    install.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    render();
    await settle();
    type(KEY);
    expect(submit().disabled).toBe(false);
    submit().click();
    submit().click();
    await settle();
    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith({
      companyUid: "cmp_acme",
      mcpUrl: "https://mcp.example.com/mcp",
      authMode: "bearer",
      bearerToken: KEY,
      provider: "example",
      displayName: "Example",
      domain: "example.com",
    });
    expect(started).toHaveBeenCalledTimes(1);
    // While it is on its way the dialog is busy and the keyboard stays in the field.
    expect(submit().disabled).toBe(true);
    expect(document.querySelector('[data-testid="card-modal-layer"]')?.getAttribute("data-busy")).toBe("true");
    expect(document.activeElement).toBe(field());
    finish(ok(INSTALLED));
    await settle();
    expect(connected).toHaveBeenCalledTimes(1);
    expect(connected).toHaveBeenCalledWith({ id: "acct_example", provider: "factory:example", name: "Example" });
    expect(dialog().querySelector('[data-testid="integration-connect-done"]')?.textContent).toContain("Example is connected. Nova can use it now.");
    expect(document.querySelector('[data-testid="integration-connect-key"]')).toBeNull();
    expectNoKeyAnywhere();
    dialog().querySelector<HTMLButtonElement>('[data-testid="integration-connect-finish"]')!.click();
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("submits on Enter in the field", async () => {
    render();
    await settle();
    type(KEY);
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("says a rejected key in one sentence, clears the field, keeps focus in it, and tells the host nothing", async () => {
    install.mockResolvedValueOnce(refusal("DIRECT_MCP_TOKEN_REJECTED", 401));
    render();
    await settle();
    type(KEY);
    submit().click();
    await settle();
    expect(errorText()).toBe("Example did not accept that key. Check it and try again.");
    expect(field().value).toBe("");
    expect(document.activeElement).toBe(field());
    expect(connected).not.toHaveBeenCalled();
    expectNoKeyAnywhere();
    // Typing again clears the sentence.
    type("x");
    expect(errorText()).toBe("");
  });

  it("treats an install that still needs credentials as a rejected key", async () => {
    install.mockResolvedValueOnce(ok({ ...INSTALLED, installation: { ...INSTALLED.installation, status: "needs_credentials" } }));
    render();
    await settle();
    type(KEY);
    submit().click();
    await settle();
    expect(errorText()).toBe("Example did not accept that key. Check it and try again.");
    expect(field().value).toBe("");
    expect(connected).not.toHaveBeenCalled();
  });

  it("sends the person to HQ Integrations on a plan limit, by the company's slug", async () => {
    install.mockResolvedValueOnce(refusal("PLAN_LIMIT_REACHED", 402));
    render();
    await settle();
    type(KEY);
    submit().click();
    await settle();
    expect(dialog().querySelector('[data-testid="integration-connect-elsewhere"]')?.textContent).toContain("Your plan's integration limit is reached.");
    expect(document.querySelector('[data-testid="integration-connect-key"]')).toBeNull();
    dialog().querySelector<HTMLButtonElement>('[data-testid="integration-connect-elsewhere-action"]')!.click();
    expect(openUrl).toHaveBeenCalledWith("https://hq.computer/companies/acme/integrations");
    expectNoKeyAnywhere();
  });

  it("says an install already in progress in one sentence and lets the person try again", async () => {
    install.mockResolvedValueOnce(refusal("INTEGRATION_FACTORY_INSTALL_IN_PROGRESS", 409));
    render();
    await settle();
    type(KEY);
    submit().click();
    await settle();
    expect(errorText()).toBe("A connection for Example is already in progress. Give it a minute.");
    expect(field().value).toBe("");
  });

  it("keeps the key in the field for a retry when the request never got an answer, and nowhere else", async () => {
    install.mockRejectedValueOnce(new Error(`offline ${KEY}`));
    render();
    await settle();
    type(KEY);
    submit().click();
    await settle();
    expect(errorText()).toBe("Could not start the connection. Try again.");
    expect(field().value).toBe(KEY);
    expect(JSON.stringify(window.localStorage)).not.toContain(KEY);
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it("points at HQ Integrations when the blueprint has no MCP surface to send the key to", async () => {
    blueprint.mockResolvedValueOnce(ok({ ...BLUEPRINT, blueprint: { ...BLUEPRINT.blueprint, surfaces: [] } }));
    render();
    await settle();
    type(KEY);
    submit().click();
    await settle();
    expect(install).not.toHaveBeenCalled();
    expect(dialog().querySelector('[data-testid="integration-connect-elsewhere"]')?.textContent).toContain(
      "Example could not be connected from here. Try it from HQ Integrations.",
    );
  });

  it("clears the key when the modal is closed", async () => {
    render();
    await settle();
    type(KEY);
    dialog().querySelector<HTMLButtonElement>('[data-testid="integration-connect-close"]')!.click();
    flushSync();
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(field().value).toBe("");
    expect(install).not.toHaveBeenCalled();
    expectNoKeyAnywhere();
  });

  it("clears the key when the modal is taken down, and nothing is left in storage after a run", async () => {
    render();
    await settle();
    type(KEY);
    const input = field();
    await takeDown();
    expect(input.value).toBe("");
    expect(document.querySelector('[data-testid="card-modal"]')).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("does nothing without a company to connect for", async () => {
    render({ companyUid: null });
    await settle();
    expect(blueprint).not.toHaveBeenCalled();
    type(KEY);
    submit().click();
    await settle();
    expect(install).not.toHaveBeenCalled();
  });
});

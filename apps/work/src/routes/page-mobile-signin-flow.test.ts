// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The root route on a phone, mounted.
 *
 * The gate and the flow are tested on their own. This checks the wiring
 * between them: a Microsoft tap with an email reaches hq-pro's resolve route
 * and opens Cognito at the provider it returns.
 */

const phone = vi.hoisted(() => ({
  beginSignIn: vi.fn(async () => {}),
}));

vi.mock("svelte", async () => {
  // @ts-expect-error happy-dom tests need Svelte's client runtime.
  return await import("../../node_modules/svelte/src/index-client.js");
});

vi.mock("@hq/platform", () => ({ resolveHostPlatform: () => "ios" }));

vi.mock("$lib/WorkShell.svelte", () => ({ default: () => {} }));

vi.mock("$lib/mobile-auth-host", () => ({
  createTauriMobileAuthSession: () => ({
    beginSignIn: phone.beginSignIn,
    completeSignIn: vi.fn(async () => {}),
    restore: vi.fn(async () => false),
    getToken: vi.fn(async () => null),
    clear: vi.fn(async () => {}),
  }),
  listenForAuthCallback: vi.fn(async () => () => {}),
  mobileTokenProvider: () => async () => null,
}));

import { flushSync, mount, tick, unmount } from "svelte";

import Page from "./+page.svelte";

const WORK_PROVIDER = "MsOrg87489d4600af47338b7bafe9bd";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let fetchMock: ReturnType<typeof vi.fn>;

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return host.querySelector<T>(`[data-testid="${id}"]`);
}

beforeEach(() => {
  vi.stubEnv("PUBLIC_HQ_PRO_API_URL", "https://hq-pro.test");
  host = document.createElement("div");
  document.body.appendChild(host);
  phone.beginSignIn.mockClear();
  fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ status: "enabled", providerName: WORK_PROVIDER }), {
      status: 200,
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the phone sign-in route", () => {
  it("sends a Microsoft work email to its MsOrg provider", async () => {
    component = mount(Page, { target: host, props: { data: { user: null } } as never });
    await vi.waitFor(() => expect(byTestId("mobile-signin-Microsoft")).not.toBeNull());

    byTestId<HTMLButtonElement>("mobile-signin-Microsoft")!.click();
    flushSync();
    const input = byTestId<HTMLInputElement>("mobile-microsoft-email")!;
    input.value = "person@contoso.example";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    byTestId<HTMLFormElement>("mobile-microsoft-email-form")!.requestSubmit();
    await tick();

    await vi.waitFor(() =>
      expect(phone.beginSignIn).toHaveBeenCalledExactlyOnceWith({
        identityProvider: WORK_PROVIDER,
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://hq-pro.test/v1/signin/microsoft-org/resolve",
    );
  });

  it("opens Google without asking hq-pro anything", async () => {
    component = mount(Page, { target: host, props: { data: { user: null } } as never });
    await vi.waitFor(() => expect(byTestId("mobile-signin-Google")).not.toBeNull());

    byTestId<HTMLButtonElement>("mobile-signin-Google")!.click();

    await vi.waitFor(() =>
      expect(phone.beginSignIn).toHaveBeenCalledExactlyOnceWith({ identityProvider: "Google" }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

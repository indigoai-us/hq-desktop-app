// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The root route on a phone, mounted.
 *
 * A phone reaches Microsoft through the Cognito hosted chooser. The sign-in
 * button must open that chooser (no named provider) and must not call hq-pro
 * first: hq-pro does not allow the mobile webview origins.
 */

const phone = vi.hoisted(() => ({
  beginSignIn: vi.fn(async (_options?: { identityProvider?: string }) => {}),
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

import { mount, unmount } from "svelte";

import Page from "./+page.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let fetchMock: ReturnType<typeof vi.fn>;

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return host.querySelector<T>(`[data-testid="${id}"]`);
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  phone.beginSignIn.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.unstubAllGlobals();
});

describe("the phone sign-in route", () => {
  it("opens the Cognito chooser, where Microsoft is offered, without calling hq-pro", async () => {
    component = mount(Page, { target: host, props: { data: { user: null } } as never });
    await vi.waitFor(() => expect(byTestId("mobile-signin-start")).not.toBeNull());

    byTestId<HTMLButtonElement>("mobile-signin-start")!.click();

    await vi.waitFor(() => expect(phone.beginSignIn).toHaveBeenCalledTimes(1));
    expect(phone.beginSignIn.mock.calls[0]?.[0]?.identityProvider).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

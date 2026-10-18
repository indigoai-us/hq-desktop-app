// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flushSync, mount, unmount } from "svelte";

import MobileSignInGate from "./MobileSignInGate.svelte";
import type { MobileSignInProvider } from "./mobile-providers";
import type { MobileSignInState } from "./mobile-sign-in";

/**
 * The phone's sign-in screen, mounted.
 *
 * The phone signs in to the desktop's Cognito client, where Microsoft is
 * enabled. The screen must offer it, and must collect the email first so the
 * flow can send a work account to its MsOrg provider.
 */

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function render(props: {
  signInState?: MobileSignInState;
  error?: string | null;
  onSignIn?: (provider: MobileSignInProvider, options?: { email?: string }) => void;
}) {
  const state = $state({
    signInState: props.signInState ?? "signed-out",
    error: props.error ?? null,
  });
  const onSignIn = props.onSignIn ?? vi.fn();
  component = mount(MobileSignInGate, {
    target: host,
    props: {
      get signInState() {
        return state.signInState;
      },
      get error() {
        return state.error;
      },
      onSignIn,
    },
  });
  flushSync();
  return { state, onSignIn };
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return host.querySelector<T>(`[data-testid="${id}"]`);
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
});

describe("phone sign-in screen", () => {
  it("offers Google and Microsoft, both usable", () => {
    render({});
    const google = byTestId<HTMLButtonElement>("mobile-signin-Google");
    const microsoft = byTestId<HTMLButtonElement>("mobile-signin-Microsoft");
    expect(google?.textContent?.trim()).toBe("Continue with Google");
    expect(microsoft?.textContent?.trim()).toBe("Continue with Microsoft");
    expect(google?.disabled).toBe(false);
    expect(microsoft?.disabled).toBe(false);
  });

  it("opens Google straight away", () => {
    const onSignIn = vi.fn();
    render({ onSignIn });
    byTestId<HTMLButtonElement>("mobile-signin-Google")!.click();
    expect(onSignIn).toHaveBeenCalledExactlyOnceWith("Google", undefined);
  });

  it("asks for the Microsoft email before opening the browser", () => {
    const onSignIn = vi.fn();
    render({ onSignIn });

    byTestId<HTMLButtonElement>("mobile-signin-Microsoft")!.click();
    flushSync();

    expect(onSignIn).not.toHaveBeenCalled();
    const input = byTestId<HTMLInputElement>("mobile-microsoft-email");
    const submit = byTestId<HTMLButtonElement>("mobile-microsoft-email-continue");
    expect(input).not.toBeNull();
    expect(submit?.disabled).toBe(true);

    input!.value = "  person@contoso.example ";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(submit?.disabled).toBe(false);

    byTestId<HTMLFormElement>("mobile-microsoft-email-form")!.requestSubmit();
    flushSync();

    expect(onSignIn).toHaveBeenCalledExactlyOnceWith("Microsoft", {
      email: "person@contoso.example",
    });
  });

  it("labels only the chosen button as opening, and locks both", () => {
    const { state } = render({ onSignIn: vi.fn() });
    byTestId<HTMLButtonElement>("mobile-signin-Google")!.click();
    state.signInState = "opening";
    flushSync();

    const google = byTestId<HTMLButtonElement>("mobile-signin-Google")!;
    const microsoft = byTestId<HTMLButtonElement>("mobile-signin-Microsoft")!;
    expect(google.textContent?.trim()).toBe("Opening your browser…");
    expect(microsoft.textContent?.trim()).toBe("Continue with Microsoft");
    expect(google.disabled).toBe(true);
    expect(microsoft.disabled).toBe(true);
  });

  it("shows a resolve error as an alert", () => {
    render({ error: "Enter a valid Microsoft email, then try again." });
    const alert = byTestId("mobile-signin-error");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toBe("Enter a valid Microsoft email, then try again.");
  });
});

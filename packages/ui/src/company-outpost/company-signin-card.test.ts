// @vitest-environment happy-dom
import { flushSync, mount, unmount, type ComponentProps } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import CompanySignInCard from "./CompanySignInCard.svelte";
import CompanySignInPanel from "./CompanySignInPanel.svelte";
import CompanyOutpostSignInPreview from "./CompanyOutpostSignInPreview.svelte";
import { SIGNIN_COPY } from "./company-signin-model.js";
import { COMPANY_OUTPOST_BOX_DETAIL_SIGNIN_SLOT } from "./company-signin-preview.js";
import { createCompanySignInClient, type CompanySignInPost } from "./company-signin-client.js";

const URL = "https://claude.ai/oauth/authorize?example=1";
const CODE = "EXAMPLE-NOT-A-REAL-CODE";
const NOW = Date.parse("2026-10-18T20:00:00.000Z");

describe("company sign-in card", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
  });

  function mountCard(props: ComponentProps<typeof CompanySignInCard>) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(CompanySignInCard, { target, props }) as Record<string, unknown>;
    flushSync();
    return target;
  }

  function typeCode(target: HTMLElement, value: string) {
    const input = target.querySelector<HTMLInputElement>("[data-testid='company-signin-code']");
    expect(input).not.toBeNull();
    input!.value = value;
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    return input!;
  }

  it("renders each admin state from fixtures", () => {
    const waiting = mountCard({
      role: "admin",
      now: NOW,
      view: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: "2026-10-18T20:10:00.000Z" },
    });
    expect(waiting.querySelector("[data-testid='company-signin-card']")?.getAttribute("data-phase")).toBe("awaiting_code");
    expect(waiting.querySelector("[data-testid='company-signin-open']")?.getAttribute("href")).toBe(URL);
    expect(waiting.querySelector("[data-testid='company-signin-expiry']")?.textContent).toBe("This link expires at 20:10 UTC.");
    expect(waiting.querySelector("[data-testid='company-signin-code']")?.getAttribute("type")).toBe("password");
    expect(waiting.textContent).not.toMatch(/USD|!/);
  });

  it("clears the code on submit and does not show it again", () => {
    const onSubmitCode = vi.fn();
    const target = mountCard({
      role: "admin",
      now: NOW,
      onSubmitCode,
      view: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: "2026-10-18T20:10:00.000Z" },
    });
    const input = typeCode(target, CODE);
    (target.querySelector("[data-testid='company-signin-submit']") as HTMLButtonElement).click();
    flushSync();
    expect(onSubmitCode).toHaveBeenCalledWith(CODE);
    expect(input.value).toBe("");
    expect(target.textContent).not.toContain(CODE);
  });

  it("shows one rejection line and keeps the field ready for another try", () => {
    const target = mountCard({
      role: "admin",
      now: NOW,
      codeError: SIGNIN_COPY.rejected,
      view: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: "2026-10-18T20:10:00.000Z" },
    });
    expect(target.querySelector("[data-testid='company-signin-error']")?.textContent).toBe(SIGNIN_COPY.rejected);
    expect(target.querySelector("[data-testid='company-signin-code']")).not.toBeNull();
    expect(target.textContent).not.toMatch(/invalid_login_code|http-/);
  });

  it("hides the link, the code, and the actions from a member", () => {
    const target = mountCard({
      role: "member",
      now: NOW,
      codeError: SIGNIN_COPY.rejected,
      view: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: "2026-10-18T20:10:00.000Z" },
    });
    expect(target.textContent).toContain(SIGNIN_COPY.memberNotSignedIn);
    expect(target.textContent).not.toContain(URL);
    expect(target.querySelector("[data-testid='company-signin-code']")).toBeNull();
    expect(target.querySelector("[data-testid='company-signin-new-link']")).toBeNull();
    expect(target.querySelector("[data-testid='company-signin-refresh']")).toBeNull();
    expect(target.querySelector("a")).toBeNull();
  });
});

describe("company sign-in panel", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    vi.restoreAllMocks();
  });

  it("sends a wrong code through the route, then shows one line and an empty field", async () => {
    const logs: string[] = [];
    for (const method of ["log", "info", "debug", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
    }
    const post = vi.fn<CompanySignInPost>(async (body) => {
      if (body.action === "code") return { ok: false, status: 400, code: "invalid_login_code", message: `no ${CODE}` };
      return { ok: true, status: 200, body: { signIn: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: "2026-10-18T20:10:00.000Z" } } };
    });
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(CompanySignInPanel, {
      target,
      props: {
        role: "admin",
        companyUid: "cmp_indigo",
        outpostId: "opc_main",
        preview: {
          now: NOW,
          view: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: "2026-10-18T20:10:00.000Z" },
        },
        client: createCompanySignInClient({ companyUid: "cmp_indigo", outpostId: "opc_main", role: "admin", post }),
      },
    }) as Record<string, unknown>;
    flushSync();
    const input = target.querySelector<HTMLInputElement>("[data-testid='company-signin-code']")!;
    input.value = CODE;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    (target.querySelector("[data-testid='company-signin-submit']") as HTMLButtonElement).click();
    flushSync();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-signin-error']")?.textContent).toBe(SIGNIN_COPY.rejected));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ action: "code", code: CODE }));
    expect(input.value).toBe("");
    expect(target.textContent).not.toContain(CODE);
    expect(logs.join("\n")).not.toContain(CODE);
  });

  it("drops the old link when an admin asks for a new one", async () => {
    const post = vi.fn<CompanySignInPost>(async (body) => {
      if (body.action === "regenerate") return { ok: true, status: 202, body: { ok: true } };
      return { ok: true, status: 200, body: { signIn: { signedIn: false, state: "awaiting_sign_in" } } };
    });
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(CompanySignInPanel, {
      target,
      props: {
        role: "admin",
        companyUid: "cmp_indigo",
        preview: {
          now: NOW,
          view: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: "2026-10-18T20:10:00.000Z" },
        },
        client: createCompanySignInClient({ companyUid: "cmp_indigo", role: "admin", post }),
      },
    }) as Record<string, unknown>;
    flushSync();
    (target.querySelector("[data-testid='company-signin-new-link']") as HTMLButtonElement).click();
    flushSync();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-signin-card']")?.getAttribute("data-phase")).toBe("preparing"));
    expect(target.textContent).not.toContain(URL);
    expect(target.querySelector("[data-testid='company-signin-open']")).toBeNull();
    expect(JSON.stringify(post.mock.calls)).not.toContain(URL);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ action: "regenerate" }));
  });

  it("keeps hiding the old link when status still returns it", async () => {
    const post = vi.fn<CompanySignInPost>(async (body) => {
      if (body.action === "regenerate") return { ok: true, status: 202, body: { ok: true } };
      return {
        ok: true,
        status: 200,
        body: { signIn: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: "2026-10-18T20:10:00.000Z" } },
      };
    });
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(CompanySignInPanel, {
      target,
      props: {
        role: "admin",
        companyUid: "cmp_indigo",
        preview: {
          now: NOW,
          view: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: "2026-10-18T20:10:00.000Z" },
        },
        client: createCompanySignInClient({ companyUid: "cmp_indigo", role: "admin", post }),
      },
    }) as Record<string, unknown>;
    flushSync();
    (target.querySelector("[data-testid='company-signin-new-link']") as HTMLButtonElement).click();
    flushSync();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-signin-card']")?.getAttribute("data-phase")).toBe("preparing"));
    expect(target.textContent).not.toContain(URL);
    expect(target.querySelector("[data-testid='company-signin-open']")).toBeNull();
  });

  it("shows finishing after an accepted code", async () => {
    const post = vi.fn<CompanySignInPost>(async (body) => {
      if (body.action === "code") return { ok: true, status: 202, body: { ok: true } };
      return {
        ok: true,
        status: 200,
        body: { signIn: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: "2026-10-18T20:10:00.000Z" } },
      };
    });
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(CompanySignInPanel, {
      target,
      props: {
        role: "admin",
        companyUid: "cmp_indigo",
        preview: {
          now: NOW,
          view: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: "2026-10-18T20:10:00.000Z" },
        },
        client: createCompanySignInClient({ companyUid: "cmp_indigo", role: "admin", post }),
      },
    }) as Record<string, unknown>;
    flushSync();
    const input = target.querySelector<HTMLInputElement>("[data-testid='company-signin-code']")!;
    input.value = CODE;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    (target.querySelector("[data-testid='company-signin-submit']") as HTMLButtonElement).click();
    flushSync();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-signin-notice']")?.textContent).toBe(SIGNIN_COPY.finishing));
    expect(target.textContent).not.toContain(CODE);
  });

  it("does not call the route for a member", async () => {
    const post = vi.fn<CompanySignInPost>(async () => ({ ok: true, status: 200, body: {} }));
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(CompanySignInPanel, {
      target,
      props: {
        role: "member",
        companyUid: "cmp_indigo",
        client: createCompanySignInClient({ companyUid: "cmp_indigo", role: "member", post }),
      },
    }) as Record<string, unknown>;
    flushSync();
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
    expect(target.querySelector("[data-testid='company-signin-new-link']")).toBeNull();
    expect(target.textContent).toContain(SIGNIN_COPY.unavailable);
  });
});

describe("sign-in preview slot", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
  });

  it("mounts the card in the box detail slot Lane A can find", () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(CompanyOutpostSignInPreview, { target, props: { state: "expired" } }) as Record<string, unknown>;
    flushSync();
    const slot = target.querySelector(`[data-testid='${COMPANY_OUTPOST_BOX_DETAIL_SIGNIN_SLOT}']`);
    expect(slot?.id).toBe(COMPANY_OUTPOST_BOX_DETAIL_SIGNIN_SLOT);
    expect(slot?.querySelector("[data-testid='company-signin-card']")?.getAttribute("data-phase")).toBe("expired");
    expect(target.textContent).toContain(SIGNIN_COPY.expired);
  });
});

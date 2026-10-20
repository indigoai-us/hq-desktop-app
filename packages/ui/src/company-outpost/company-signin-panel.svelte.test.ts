// @vitest-environment happy-dom
// Panel tests run the product path: no preview, a real client built by the
// panel from companyUid, outpostId and role, and a fake transport.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CompanySignInPanel from "./CompanySignInPanel.svelte";
import { SIGNIN_COPY } from "./company-signin-model.js";
import type { CompanySignInPost, CompanySignInPostResult, CompanySignInRequest } from "./company-signin-client.js";

const URL_A = "https://claude.ai/oauth/authorize?box=a";
const URL_B = "https://claude.ai/oauth/authorize?box=b";
const CODE = "EXAMPLE-NOT-A-REAL-CODE";
const NOW = Date.parse("2026-10-18T20:00:00.000Z");
const MONEY_WORDS = /bill|pric|payer|pays|paid|payment|charg|subscri|invoice|stripe|usd|\$\s?\d|a month|per month|\/mo\b|plan/i;

type Reply = CompanySignInPostResult | Promise<CompanySignInPostResult>;

function status(signIn: Record<string, unknown>): CompanySignInPostResult {
  return { ok: true, status: 200, body: { signIn } };
}
const accepted: CompanySignInPostResult = { ok: true, status: 202, body: { ok: true } };
const waitingA = () => status({ signedIn: false, state: "awaiting_sign_in", loginUrl: URL_A });
const waitingB = () => status({ signedIn: false, state: "awaiting_sign_in", loginUrl: URL_B });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** A transport that answers from a function and records every request. */
function transport(answer: (body: CompanySignInRequest) => Reply) {
  const calls: CompanySignInRequest[] = [];
  const post = vi.fn<CompanySignInPost>(async (body) => {
    calls.push(body);
    return answer(body);
  });
  return { post, calls };
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;
let hiddenFlag = false;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  hiddenFlag = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hiddenFlag });
  target = document.createElement("div");
  document.body.appendChild(target);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  target.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  flushSync();
}

function mountPanel(props: { role: "owner" | "admin" | "member"; companyUid: string; outpostId?: string; post: CompanySignInPost }) {
  const live = $state(props);
  component = mount(CompanySignInPanel, { target, props: live }) as Record<string, unknown>;
  flushSync();
  return live;
}

const q = (id: string) => target.querySelector<HTMLElement>(`[data-testid='company-signin-${id}']`);
const phase = () => q("card")?.getAttribute("data-phase");
const button = (id: string) => q(id) as HTMLButtonElement | null;

function typeCode(value: string) {
  const input = q("code") as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

describe("company sign-in panel: switching company, box or role", () => {
  it("builds its requests from companyUid and outpostId", async () => {
    const { post, calls } = transport(() => waitingA());
    mountPanel({ role: "admin", companyUid: "cmp_a", outpostId: "opc_a", post });
    await settle();
    expect(calls[0]).toEqual({ companyUid: "cmp_a", outpostId: "opc_a", action: "status" });
  });

  it("goes from a signed-in box to an unsigned one with a full reload", async () => {
    const { post, calls } = transport((body) =>
      body.outpostId === "opc_a" ? status({ signedIn: true, state: "signed_in" }) : waitingB());
    const props = mountPanel({ role: "admin", companyUid: "cmp_a", outpostId: "opc_a", post });
    await settle();
    expect(phase()).toBe("signed_in");

    props.outpostId = "opc_b";
    flushSync();
    await settle();
    expect(calls.at(-1)).toEqual({ companyUid: "cmp_a", outpostId: "opc_b", action: "status" });
    expect(phase()).toBe("awaiting_code");
    expect(q("open")?.getAttribute("href")).toBe(URL_B);
    expect(target.textContent).not.toContain(SIGNIN_COPY.signedIn);
  });

  it("never shows box A's link or code field under box B, and drops A's late answer", async () => {
    const lateA = deferred<CompanySignInPostResult>();
    const firstB = deferred<CompanySignInPostResult>();
    let aReads = 0;
    const { post, calls } = transport((body) => {
      if (body.outpostId === "opc_a") {
        aReads += 1;
        return aReads === 1 ? waitingA() : lateA.promise;
      }
      return firstB.promise;
    });
    const props = mountPanel({ role: "admin", companyUid: "cmp_a", outpostId: "opc_a", post });
    await settle();
    expect(q("open")?.getAttribute("href")).toBe(URL_A);
    typeCode(CODE);

    await settle(15_000); // A's poll goes out and hangs
    props.outpostId = "opc_b";
    flushSync();
    expect(q("open")).toBeNull();
    expect(q("code")).toBeNull();
    expect(phase()).toBe("loading");

    lateA.resolve(waitingA());
    await settle();
    expect(q("open")).toBeNull();
    expect(target.textContent).not.toContain(CODE);

    firstB.resolve(waitingB());
    await settle();
    expect(q("open")?.getAttribute("href")).toBe(URL_B);
    expect((q("code") as HTMLInputElement).value).toBe("");
    expect(calls.filter((c) => c.action === "code")).toHaveLength(0);
  });

  it("does not carry not available from one company to the next", async () => {
    const { post } = transport((body) =>
      body.companyUid === "cmp_a" ? { ok: false, status: 503, code: "billing_required" } : waitingB());
    const props = mountPanel({ role: "admin", companyUid: "cmp_a", post });
    await settle();
    expect(phase()).toBe("not_available");

    props.companyUid = "cmp_b";
    flushSync();
    await settle();
    expect(phase()).toBe("awaiting_code");
    expect(target.textContent).not.toContain(SIGNIN_COPY.notAvailable);
  });

  it("resets when the role changes to member and never calls the route as a member", async () => {
    const { post, calls } = transport(() => waitingA());
    const props = mountPanel({ role: "admin", companyUid: "cmp_a", post });
    await settle();
    expect(q("open")).not.toBeNull();
    const before = calls.length;

    props.role = "member";
    flushSync();
    await settle(60_000);
    expect(calls.length).toBe(before);
    expect(q("open")).toBeNull();
    expect(q("code")).toBeNull();
    expect(q("new-link")).toBeNull();
    expect(target.textContent).toContain(SIGNIN_COPY.unavailable);
  });

  it("stops its poll timer on unmount", async () => {
    const { post, calls } = transport(() => status({ signedIn: false, state: "awaiting_box" }));
    mountPanel({ role: "admin", companyUid: "cmp_a", post });
    await settle(5_000);
    expect(calls.length).toBe(2);
    await unmount(component!);
    component = null;
    await settle(60_000);
    expect(calls.length).toBe(2);
  });
});

describe("company sign-in panel: one call at a time", () => {
  it("blocks New sign-in link, Refresh and poll ticks while a code is in flight", async () => {
    const exchange = deferred<CompanySignInPostResult>();
    const { post, calls } = transport((body) => (body.action === "code" ? exchange.promise : waitingA()));
    mountPanel({ role: "admin", companyUid: "cmp_a", post });
    await settle();
    typeCode(CODE);
    button("submit")!.click();
    flushSync();

    expect(button("submit")!.textContent?.trim()).toBe(SIGNIN_COPY.submitting);
    expect(button("new-link")!.disabled).toBe(true);
    expect(button("refresh")!.disabled).toBe(true);
    button("new-link")!.click();
    button("refresh")!.click();
    await settle(45_000);
    expect(calls.map((c) => c.action)).toEqual(["status", "code"]);

    exchange.resolve(accepted);
    await settle();
    expect(calls.map((c) => c.action)).toEqual(["status", "code", "status"]);
  });

  it("blocks Refresh and a second New sign-in link while a regenerate is in flight, and hides the old link at once", async () => {
    const regen = deferred<CompanySignInPostResult>();
    const { post, calls } = transport((body) => (body.action === "regenerate" ? regen.promise : waitingA()));
    mountPanel({ role: "admin", companyUid: "cmp_a", post });
    await settle();
    button("new-link")!.click();
    flushSync();

    expect(q("open")).toBeNull();
    expect(q("code")).toBeNull();
    expect(button("new-link")!.textContent?.trim()).toBe(SIGNIN_COPY.requestingLink);
    expect(button("new-link")!.disabled).toBe(true);
    expect(button("refresh")!.disabled).toBe(true);
    button("refresh")!.click();
    button("new-link")!.click();
    await settle(45_000);
    expect(calls.map((c) => c.action)).toEqual(["status", "regenerate"]);

    regen.resolve(accepted);
    await settle();
    // The read after regenerate still carries the old link: it stays hidden.
    expect(calls.map((c) => c.action)).toEqual(["status", "regenerate", "status"]);
    expect(phase()).toBe("preparing");
    expect(target.textContent).not.toContain(URL_A);
  });

  it("shows Refreshing... while a manual read is out, with every action disabled", async () => {
    let reads = 0;
    const slow = deferred<CompanySignInPostResult>();
    const { post } = transport(() => (++reads === 1 ? waitingA() : slow.promise));
    mountPanel({ role: "admin", companyUid: "cmp_a", post });
    await settle();
    typeCode(CODE);
    button("refresh")!.click();
    flushSync();
    expect(button("refresh")!.textContent?.trim()).toBe(SIGNIN_COPY.refreshing);
    expect(button("new-link")!.disabled).toBe(true);
    expect(button("submit")!.disabled).toBe(true);
    slow.resolve(waitingA());
    await settle();
    expect(button("refresh")!.textContent?.trim()).toBe(SIGNIN_COPY.refresh);
    expect(button("new-link")!.disabled).toBe(false);
  });
});

describe("company sign-in panel: failures after the first load", () => {
  it("shows a failed New sign-in link as one line with Refresh, and clears it on the next good read", async () => {
    const { post } = transport((body) =>
      body.action === "regenerate" ? { ok: false, status: 500, code: "internal" } : waitingA());
    mountPanel({ role: "admin", companyUid: "cmp_a", post });
    await settle();
    button("new-link")!.click();
    await settle();
    expect(phase()).toBe("failed");
    expect(q("detail")?.textContent).toBe(SIGNIN_COPY.unreachable);
    expect(button("refresh")).not.toBeNull();
    expect(q("code")).toBeNull();
    expect(target.textContent).not.toContain("internal");

    button("refresh")!.click();
    await settle();
    expect(phase()).toBe("awaiting_code");
    expect(q("detail")).toBeNull();
  });

  it("shows an unreachable poll while a link is on screen, hides the link, and recovers", async () => {
    let reads = 0;
    const { post } = transport(() => {
      reads += 1;
      return reads === 2 ? { ok: false, status: null, code: "network" } : waitingA();
    });
    mountPanel({ role: "admin", companyUid: "cmp_a", post });
    await settle();
    expect(phase()).toBe("awaiting_code");
    await settle(15_000);
    expect(phase()).toBe("failed");
    expect(q("detail")?.textContent).toBe(SIGNIN_COPY.unreachable);
    expect(q("open")).toBeNull();
    expect(q("code")).toBeNull();
    await settle(15_000);
    expect(phase()).toBe("awaiting_code");
  });
});

describe("company sign-in panel: polling", () => {
  it("pauses while the window is hidden and resumes when it is shown", async () => {
    const { post, calls } = transport(() => status({ signedIn: false, state: "awaiting_box" }));
    mountPanel({ role: "admin", companyUid: "cmp_a", post });
    await settle();
    hiddenFlag = true;
    await settle(60_000);
    expect(calls.length).toBe(1);
    hiddenFlag = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(calls.length).toBe(2);
    await settle(5_000);
    expect(calls.length).toBe(3);
  });

  it("never overlaps reads when a read is slower than the interval", async () => {
    let open = 0;
    let most = 0;
    const { post } = transport(async () => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((r) => setTimeout(r, 8_000));
      open -= 1;
      return status({ signedIn: false, state: "awaiting_box" });
    });
    mountPanel({ role: "admin", companyUid: "cmp_a", post });
    await settle(60_000);
    expect(most).toBe(1);
  });

  it("marks the link expired over time and stops polling", async () => {
    const expiresAt = new Date(NOW + 20_000).toISOString();
    const { post, calls } = transport(() =>
      status({ signedIn: false, state: "awaiting_sign_in", loginUrl: URL_A, loginUrlExpiresAt: expiresAt }));
    mountPanel({ role: "admin", companyUid: "cmp_a", post });
    await settle();
    expect(phase()).toBe("awaiting_code");
    await settle(30_000);
    expect(phase()).toBe("expired");
    expect(q("open")).toBeNull();
    const count = calls.length;
    await settle(120_000);
    expect(calls.length).toBe(count);
  });

  it("hides the code field while an accepted code finishes, then says it is still finishing", async () => {
    const { post, calls } = transport((body) => (body.action === "code" ? accepted : waitingA()));
    mountPanel({ role: "admin", companyUid: "cmp_a", post });
    await settle();
    typeCode(CODE);
    button("submit")!.click();
    await settle();
    expect(q("notice")?.textContent).toBe(SIGNIN_COPY.finishing);
    expect(phase()).toBe("finishing");
    expect(q("code")).toBeNull();
    expect(q("open")).toBeNull();
    expect(q("new-link")).toBeNull();

    const before = calls.length;
    await settle(3_000);
    expect(calls.length).toBe(before + 1);

    await settle(120_000);
    expect(q("notice")?.textContent).toBe(SIGNIN_COPY.stillFinishing);
    expect(target.textContent).not.toContain(SIGNIN_COPY.expired);
    expect(q("code")).toBeNull();
    expect(button("refresh")).not.toBeNull();
    expect(button("new-link")).not.toBeNull();
    expect(calls.filter((c) => c.action === "code")).toHaveLength(1);
  });
});

describe("company sign-in panel: codes and links", () => {
  it("sends a wrong code once, then shows one line and an empty field, and never logs the code", async () => {
    const logs: string[] = [];
    for (const method of ["log", "info", "debug", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
    }
    const { post, calls } = transport((body) =>
      body.action === "code" ? { ok: false, status: 400, code: "invalid_login_code", message: `no ${CODE}` } : waitingA());
    mountPanel({ role: "admin", companyUid: "cmp_a", outpostId: "opc_a", post });
    await settle();
    typeCode(CODE);
    button("submit")!.click();
    await settle();
    expect(q("error")?.textContent).toBe(SIGNIN_COPY.rejected);
    expect(calls.filter((c) => c.action === "code")).toEqual([
      { companyUid: "cmp_a", outpostId: "opc_a", action: "code", code: CODE },
    ]);
    expect((q("code") as HTMLInputElement).value).toBe("");
    expect(target.textContent).not.toContain(CODE);
    expect(logs.join("\n")).not.toContain(CODE);
  });

  it("drops the old link when an admin asks for a new one", async () => {
    let regenerated = false;
    const { post, calls } = transport((body) => {
      if (body.action === "regenerate") {
        regenerated = true;
        return accepted;
      }
      return regenerated ? status({ signedIn: false, state: "awaiting_sign_in" }) : waitingA();
    });
    mountPanel({ role: "admin", companyUid: "cmp_a", post });
    await settle();
    button("new-link")!.click();
    await settle();
    expect(phase()).toBe("preparing");
    expect(target.textContent).not.toContain(URL_A);
    expect(JSON.stringify(calls)).not.toContain(URL_A);
  });

  it("does not call the route for a member", async () => {
    const { post } = transport(() => ({ ok: true, status: 200, body: {} }));
    mountPanel({ role: "member", companyUid: "cmp_a", post });
    await settle(60_000);
    expect(post).not.toHaveBeenCalled();
    expect(q("new-link")).toBeNull();
    expect(target.textContent).toContain(SIGNIN_COPY.unavailable);
  });
});

describe("company sign-in panel: not available yet", () => {
  it("switches to the neutral state on billing_required, keeps Refresh, and shows no billing words", async () => {
    const { post } = transport(() => ({ ok: false, status: 503, code: "billing_required" }));
    mountPanel({ role: "admin", companyUid: "cmp_a", post });
    await settle();
    expect(phase()).toBe("not_available");
    expect(target.textContent).toContain(SIGNIN_COPY.notAvailable);
    expect(target.textContent).not.toMatch(MONEY_WORDS);
    expect(button("refresh")).not.toBeNull();
    expect(q("new-link")).toBeNull();
  });

  it("re-checks every 60 seconds after a New sign-in link comes back not available, and recovers on a good read", async () => {
    let eligible = false;
    const { post, calls } = transport((body) => {
      if (body.action === "regenerate") return { ok: false, status: 402, code: "payment_required" };
      return eligible ? waitingB() : waitingA();
    });
    mountPanel({ role: "admin", companyUid: "cmp_a", post });
    await settle();
    button("new-link")!.click();
    await settle();
    expect(phase()).toBe("not_available");
    const count = calls.length;
    await settle(59_000);
    expect(calls.length).toBe(count);
    eligible = true;
    await settle(1_000);
    expect(calls.length).toBe(count + 1);
    expect(phase()).toBe("awaiting_code");
    expect(q("open")?.getAttribute("href")).toBe(URL_B);
  });
});

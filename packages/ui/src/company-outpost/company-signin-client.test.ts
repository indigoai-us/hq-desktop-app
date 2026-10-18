import { describe, expect, it, vi } from "vitest";
import { SIGNIN_COPY } from "./company-signin-model.js";
import { createCompanySignInClient, type CompanySignInPost } from "./company-signin-client.js";

const URL = "https://claude.ai/oauth/authorize?example=1";
const CODE = "EXAMPLE-NOT-A-REAL-CODE";

function client(post: CompanySignInPost, role: "admin" | "member" = "admin") {
  return createCompanySignInClient({
    companyUid: "cmp_indigo",
    outpostId: "opc_main",
    role,
    post,
  });
}

describe("company sign-in client", () => {
  it("reads status from POST /outpost/company/signin", async () => {
    const post = vi.fn<CompanySignInPost>(async () => ({
      ok: true,
      status: 200,
      body: { signIn: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: "2026-10-18T20:10:00.000Z" } },
    }));
    const result = await client(post).read();
    expect(post).toHaveBeenCalledWith({
      companyUid: "cmp_indigo",
      outpostId: "opc_main",
      action: "status",
    });
    expect(result).toEqual({
      ok: true,
      view: {
        signedIn: false,
        state: "awaiting_sign_in",
        loginUrl: URL,
        loginUrlExpiresAt: "2026-10-18T20:10:00.000Z",
      },
    });
  });

  it("invalidates the current link by the regenerate action and does not send the old url", async () => {
    const post = vi.fn<CompanySignInPost>(async (body) => {
      if (body.action === "regenerate") return { ok: true, status: 202, body: { ok: true } };
      return { ok: true, status: 200, body: { signIn: { signedIn: false, state: "awaiting_sign_in" } } };
    });
    const api = client(post);
    expect(await api.regenerate()).toEqual({ ok: true });
    expect(post).toHaveBeenCalledWith({
      companyUid: "cmp_indigo",
      outpostId: "opc_main",
      action: "regenerate",
    });
    expect(JSON.stringify(post.mock.calls)).not.toContain(URL);
    expect(await api.read()).toMatchObject({ ok: true, view: { loginUrl: undefined } });
  });

  it("sends a code on the contract route and never logs it or returns it", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const post = vi.fn<CompanySignInPost>(async () => ({ ok: true, status: 202, body: { ok: true } }));
    const result = await client(post).submitCode(CODE);
    expect(result).toEqual({ ok: true });
    expect(post).toHaveBeenCalledWith({
      companyUid: "cmp_indigo",
      outpostId: "opc_main",
      action: "code",
      code: CODE,
    });
    const logged = [spy, err, warn, info, debug].flatMap((s) => s.mock.calls.flat().map((v) => String(v)));
    expect(logged.join("\n")).not.toContain(CODE);
    expect(JSON.stringify(result)).not.toContain(CODE);
    vi.restoreAllMocks();
  });

  it("maps a rejected code to one reason and does not echo the code", async () => {
    const post = vi.fn<CompanySignInPost>(async () => ({
      ok: false,
      status: 400,
      code: "invalid_login_code",
      message: `rejected ${CODE}`,
    }));
    const result = await client(post).submitCode(CODE);
    expect(result).toEqual({ ok: false, reason: "rejected" });
    expect(JSON.stringify(result)).not.toContain(CODE);
  });

  it("does not call the route for an empty code", async () => {
    const post = vi.fn<CompanySignInPost>(async () => ({ ok: true, status: 202, body: {} }));
    expect(await client(post).submitCode("   ")).toEqual({ ok: false, reason: "rejected" });
    expect(post).not.toHaveBeenCalled();
  });

  it("maps a dead connection to unreachable", async () => {
    const post = vi.fn<CompanySignInPost>(async () => ({ ok: false, status: null, code: "network" }));
    expect(await client(post).read()).toEqual({ ok: false, reason: "unreachable" });
  });

  it("refuses member writes before any request", async () => {
    const post = vi.fn<CompanySignInPost>(async () => ({ ok: true, status: 200, body: {} }));
    const api = client(post, "member");
    expect(await api.regenerate()).toEqual({ ok: false, reason: "not_admin" });
    expect(await api.submitCode(CODE)).toEqual({ ok: false, reason: "not_admin" });
    expect(await api.read()).toEqual({ ok: true, view: { signedIn: false, state: "unknown" } });
    expect(post).not.toHaveBeenCalled();
    expect(SIGNIN_COPY.notAdmin).toMatch(/owners and admins/);
  });

  it("maps a replaced link to link_changed", async () => {
    const post = vi.fn<CompanySignInPost>(async () => ({ ok: false, status: 409, code: "signin_box_changed" }));
    expect(await client(post).submitCode(CODE)).toEqual({ ok: false, reason: "link_changed" });
  });

  it("maps admin_required and a box that has not started", async () => {
    const denied = vi.fn<CompanySignInPost>(async () => ({ ok: false, status: 403, code: "admin_required" }));
    expect(await client(denied).regenerate()).toEqual({ ok: false, reason: "not_admin" });
    const early = vi.fn<CompanySignInPost>(async () => ({ ok: false, status: 409, code: "signin_not_started" }));
    expect(await client(early).regenerate()).toEqual({ ok: false, reason: "not_ready" });
  });
});

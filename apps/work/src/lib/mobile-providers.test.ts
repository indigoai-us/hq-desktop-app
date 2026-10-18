import { describe, expect, it, vi } from "vitest";

import {
  MICROSOFT_EMAIL_INVALID,
  MICROSOFT_EMAIL_REQUIRED,
  MICROSOFT_PERSONAL_PROVIDER,
  MICROSOFT_RESOLVE_NETWORK,
  MICROSOFT_RESOLVE_UNEXPECTED,
  MOBILE_SIGNIN_PROVIDERS,
  resolveMicrosoftIdentityProvider,
} from "./mobile-providers";

const API = "https://api.example.test/";
const WORK_EMAIL = "Person@Contoso.example";
const WORK_PROVIDER = "MsOrg87489d4600af47338b7bafe9bd";

function respond(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("phone sign-in providers", () => {
  it("offers Google and Microsoft", () => {
    expect(MOBILE_SIGNIN_PROVIDERS).toEqual(["Google", "Microsoft"]);
  });
});

describe("resolveMicrosoftIdentityProvider", () => {
  it("sends a work email to its MsOrg provider, never MicrosoftPersonal", async () => {
    const fetchImpl = respond(200, { status: "enabled", providerName: WORK_PROVIDER });
    await expect(
      resolveMicrosoftIdentityProvider(` ${WORK_EMAIL} `, { apiBase: API, fetchImpl }),
    ).resolves.toBe(WORK_PROVIDER);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/v1/signin/microsoft-org/resolve");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ email: "person@contoso.example" });
    // The route is unauthenticated; nothing from a session goes with it.
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(init.credentials).toBe("omit");
  });

  it("sends personal and generic mailboxes to MicrosoftPersonal", async () => {
    for (const status of ["personal", "not-microsoft"]) {
      await expect(
        resolveMicrosoftIdentityProvider("me@outlook.com", {
          apiBase: API,
          fetchImpl: respond(200, { status }),
        }),
      ).resolves.toBe(MICROSOFT_PERSONAL_PROVIDER);
    }
  });

  it("fails closed when an organisation is not enabled or the name is malformed", async () => {
    for (const body of [
      { status: "enablement-required" },
      { status: "enabled" },
      { status: "enabled", providerName: "MicrosoftPersonal" },
      { status: "enabled", providerName: "MsOrgZZZZZZZZZZZZZZZZZZZZZZZZZZ" },
      { status: "something-new" },
    ]) {
      await expect(
        resolveMicrosoftIdentityProvider(WORK_EMAIL, {
          apiBase: API,
          fetchImpl: respond(200, body),
        }),
      ).rejects.toThrow(MICROSOFT_RESOLVE_UNEXPECTED);
    }
  });

  it("rejects a missing or malformed email without a network call", async () => {
    const fetchImpl = vi.fn();
    await expect(
      resolveMicrosoftIdentityProvider("  ", { apiBase: API, fetchImpl }),
    ).rejects.toThrow(MICROSOFT_EMAIL_REQUIRED);
    for (const email of ["no-at-sign", "@contoso.example", "person@", "a b@c.d"]) {
      await expect(
        resolveMicrosoftIdentityProvider(email, { apiBase: API, fetchImpl }),
      ).rejects.toThrow(MICROSOFT_EMAIL_INVALID);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a 400 as an invalid email and other failures as a connection problem", async () => {
    await expect(
      resolveMicrosoftIdentityProvider(WORK_EMAIL, {
        apiBase: API,
        fetchImpl: respond(400, { error: "bad email" }),
      }),
    ).rejects.toThrow(MICROSOFT_EMAIL_INVALID);
    await expect(
      resolveMicrosoftIdentityProvider(WORK_EMAIL, {
        apiBase: API,
        fetchImpl: respond(503, {}),
      }),
    ).rejects.toThrow(MICROSOFT_RESOLVE_NETWORK);
    await expect(
      resolveMicrosoftIdentityProvider(WORK_EMAIL, {
        apiBase: API,
        fetchImpl: vi.fn(async () => {
          throw new TypeError("Failed to fetch");
        }),
      }),
    ).rejects.toThrow(MICROSOFT_RESOLVE_NETWORK);
  });
});

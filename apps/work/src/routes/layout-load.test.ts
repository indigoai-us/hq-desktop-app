import { afterEach, describe, expect, it, vi } from "vitest";

import { load } from "./+layout";

/**
 * The root layout supplies `data.user`, which `WorkShell` uses as the fallback
 * host identity (and, through it, the tenant partition). It used to be a
 * server load. It is universal now so the static desktop/mobile bundle can run
 * it, which means the web branch has to ask for the session over HTTP —
 * `/api/auth/session` — instead of reading `locals`.
 */

type LoadEvent = Parameters<typeof load>[0];

function event(fetchImpl: typeof fetch): LoadEvent {
  return { fetch: fetchImpl } as unknown as LoadEvent;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("root layout load", () => {
  it("asks the session endpoint for the signed-in user on the web", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ user: { sub: "person-test", email: "a@b.test", name: "A" } }),
    );
    const data = await load(event(fetchMock as unknown as typeof fetch));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/session");
    // Whole-object comparison: layout data reaches WorkShell verbatim, so an
    // extra field appearing here is a leak, not a detail.
    expect(data).toEqual({
      user: { sub: "person-test", email: "a@b.test", name: "A" },
    });
  });

  it("reports no user when the session endpoint rejects the request", async () => {
    // The hook answers an unauthenticated /api/* with a structured 401.
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "Unauthenticated" }, { status: 401 }),
    );
    const data = await load(event(fetchMock as unknown as typeof fetch));
    expect(data).toEqual({ user: null });
  });

  it("reports no user rather than throwing when the response is not JSON", async () => {
    // A misrouted request can return the SPA fallback document. Throwing here
    // would take down the whole shell for a recoverable signed-out state.
    const fetchMock = vi.fn(
      async () =>
        new Response("<!doctype html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const data = await load(event(fetchMock as unknown as typeof fetch));
    expect(data).toEqual({ user: null });
  });

  it("does not call the network at all in a static build", async () => {
    // Desktop and mobile have no /api routes; the native shell supplies
    // identity to WorkShell directly. A fetch here would 404 on every launch.
    vi.stubEnv("TAURI", "1");
    const fetchMock = vi.fn(async () => jsonResponse({ user: { sub: "x" } }));
    const data = await load(event(fetchMock as unknown as typeof fetch));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(data).toEqual({ user: null });
  });
});

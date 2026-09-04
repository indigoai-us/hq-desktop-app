import { describe, expect, it } from "vitest";

import { clientTokenResponse } from "$lib/server/client-token";

describe("GET /api/auth/token response", () => {
  it("returns a no-store 401 when the session has no id_token", async () => {
    const response = clientTokenResponse(null);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "Unauthenticated",
      code: "UNAUTHENTICATED",
    });
  });

  it("delivers the current token only from the authenticated token endpoint", async () => {
    const response = clientTokenResponse("current-id-token");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ idToken: "current-id-token" });
  });
});

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

type ConfigurableHqProClient = typeof import("./hq-pro-client.js") & {
  configureHqProApiUrl?: (configured: string | undefined) => void;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("production hq-pro singleton", () => {
  it("uses the host-supplied public API URL when constructed without options", async () => {
    vi.stubEnv("DEV", false);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/auth/token") {
        return new Response(JSON.stringify({ idToken: "id-token" }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchImpl);

    const client = (await import("./hq-pro-client.js")) as ConfigurableHqProClient;
    client.configureHqProApiUrl?.("https://hqapi.example.test///");

    expect(client.hqProApiUrl()).toBe("https://hqapi.example.test");
    await expect(client.hqProFetch("/v1/identity/whoami")).resolves.toMatchObject({
      status: 200,
    });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "https://hqapi.example.test/v1/identity/whoami",
      expect.objectContaining({ credentials: "omit" }),
    );
  });
});

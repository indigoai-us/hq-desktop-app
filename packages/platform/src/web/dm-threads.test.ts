import { describe, expect, it } from "vitest";

import { WebPlatformAdapter } from "./index.js";

/**
 * GET /v1/notify/dm-threads (hq-pro PR #2813) is the per-user DM peer index
 * the rail merges with the inbound-only inbox. Older servers do not have it,
 * so the failure must carry the HTTP status the shell feature-detects on.
 */
function makeAdapter(serverHasRoute: boolean) {
  const paths: string[] = [];
  const fetchMock: typeof globalThis.fetch = async (input) => {
    const path = String(input).replace("https://api.test", "");
    paths.push(path);
    if (path.split("?")[0] === "/v1/notify/dm-threads" && serverHasRoute) {
      return new Response(
        JSON.stringify({
          threads: [
            {
              peerUid: "prs_jacob",
              lastActivityAt: "2026-09-01T21:38:30.000Z",
              lastEventId: "evt_2",
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
    });
  };
  return {
    adapter: new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: fetchMock,
    }),
    paths,
  };
}

describe("WebPlatformAdapter.notifications.fetchDmThreads", () => {
  it("GETs /v1/notify/dm-threads with the query and returns the page", async () => {
    const { adapter, paths } = makeAdapter(true);
    const res = await adapter.notifications.fetchDmThreads!({ limit: "100" });
    expect(paths).toEqual(["/v1/notify/dm-threads?limit=100"]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({
        threads: [
          {
            peerUid: "prs_jacob",
            lastActivityAt: "2026-09-01T21:38:30.000Z",
            lastEventId: "evt_2",
          },
        ],
      });
    }
  });

  it("omits the query string when no options are given", async () => {
    const { adapter, paths } = makeAdapter(true);
    await adapter.notifications.fetchDmThreads!();
    expect(paths).toEqual(["/v1/notify/dm-threads"]);
  });

  it("surfaces a 404 from a server that predates the route as code http-404", async () => {
    const { adapter } = makeAdapter(false);
    const res = await adapter.notifications.fetchDmThreads!({ limit: "100" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("http-404");
  });
});

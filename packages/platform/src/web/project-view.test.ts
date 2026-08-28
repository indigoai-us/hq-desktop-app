import { describe, expect, it } from "vitest";

import { WebPlatformAdapter } from "./index.js";

describe("getProjectView", () => {
  it("sends companyUid as a query param", async () => {
    const calls: string[] = [];
    const fetchMock: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url.replace("https://api.test", ""));
      return new Response(
        JSON.stringify({ companyUid: "cmp_1", projectId: "p1", stories: [] }),
        { status: 200 },
      );
    };
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: fetchMock,
    });
    const result = await adapter.workMesh.getProjectView("p1", "cmp_1");
    expect(result.ok).toBe(true);
    expect(calls[0]).toBe("/v1/work-mesh/projects/p1?companyUid=cmp_1");
  });
});

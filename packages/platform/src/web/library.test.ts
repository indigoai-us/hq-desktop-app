import { describe, expect, it } from "vitest";

import { WebPlatformAdapter } from "./index.js";

function makeFetch(routes: Record<string, unknown>) {
  return (async (input: RequestInfo | URL) => {
    const path = String(input).replace("https://api.test", "");
    if (path in routes) {
      return new Response(JSON.stringify(routes[path]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

describe("WebPlatformAdapter library (console shelf)", () => {
  it("loads viewer-scoped skills from the shelf across memberships", async () => {
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: makeFetch({
        "/membership/me": [
          {
            companyUid: "cmp_acme",
            slug: "acme",
            companyName: "Acme",
          },
        ],
        "/v1/skills/cmp_acme/shelf": {
          grouped: {
            companyWide: [
              {
                skillUid: "skl_mine",
                name: "Review",
                description: "PRs",
                ownerPersonUid: "prs_me",
                tags: ["eng"],
              },
              {
                skillUid: "skl_hidden",
                name: "Hidden",
                description: "nope",
                ownerPersonUid: "prs_other",
                tags: [],
              },
            ],
            departments: [],
          },
          acls: [],
        },
        "/v1/skills/cmp_acme/me": {
          personUid: "prs_me",
          groupIds: ["grp_cs"],
          isActiveMember: true,
        },
      }),
    });

    const root = await adapter.library.getRoot();
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    expect(root.value).toEqual({
      workers: [],
      skills: [
        {
          name: "Review",
          description: "PRs",
          scope: "company",
          company: "acme",
          path: "cmp_acme/skl_mine",
          allowedTools: [],
          pack: "eng",
        },
      ],
    });

    const detail = await adapter.library.getSkillDetail("cmp_acme/skl_mine");
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.value).toMatchObject({ name: "Review", body: "PRs" });
  });

  it("skips a company whose shelf is missing", async () => {
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: makeFetch({
        "/membership/me": [{ companyUid: "cmp_dark", slug: "dark" }],
      }),
    });
    const root = await adapter.library.getRoot();
    expect(root).toEqual({ ok: true, value: { workers: [], skills: [] } });
  });
});

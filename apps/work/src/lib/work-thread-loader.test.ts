import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Workspace } from "@hq/ui";
import { hqProFetch } from "./hq-pro-client.js";
import { loadWorkThreads } from "./work-thread-loader.js";

vi.mock("./hq-pro-client.js", () => ({ hqProFetch: vi.fn() }));

const roster = [{ cloudUid: "cmp_work" }] as Workspace[];
const inProgressPath =
  "/v1/work-mesh/threads?companyUid=cmp_work&status=in-progress&limit=50";

function threadResponse(title: string): Response {
  return new Response(
    JSON.stringify({
      threads: [
        {
          threadId: "thread_work",
          project: "project_work",
          status: "in-progress",
          title,
        },
      ],
    }),
    { status: 200 },
  );
}

describe("work-thread hq-pro transport", () => {
  beforeEach(() => {
    vi.mocked(hqProFetch).mockReset();
  });

  it("routes work-thread requests through an injected hq-pro transport", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("status=in-progress")
        ? threadResponse("Injected thread")
        : new Response(JSON.stringify({ threads: [] }), { status: 200 }),
    );

    const threads = await loadWorkThreads(roster, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(inProgressPath);
    expect(threads).toEqual([
      expect.objectContaining({ title: "Injected thread" }),
    ]);
    expect(hqProFetch).not.toHaveBeenCalled();
  });

  it("defaults work-thread requests to the browser hq-pro transport", async () => {
    vi.mocked(hqProFetch).mockImplementation(async (input) =>
      String(input).includes("status=in-progress")
        ? threadResponse("Browser thread")
        : new Response(JSON.stringify({ threads: [] }), { status: 200 }),
    );

    const threads = await loadWorkThreads(roster);

    expect(hqProFetch).toHaveBeenCalledWith(inProgressPath);
    expect(threads).toEqual([
      expect.objectContaining({ title: "Browser thread" }),
    ]);
  });
});

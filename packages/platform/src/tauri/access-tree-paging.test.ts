import { describe, expect, it } from "vitest";
import { createSyncPlatformAdapter } from "./sync-adapter.js";

/**
 * The company Grants pane reads GET /files/{co}/acl/tree once per top-level
 * folder, and in pages (limit + cursor) when a folder is over the server's
 * response budget. Without a page the request carries only the prefix.
 */
describe("files.getAccessTree paging", () => {
  function adapterWith(urls: string[], answer: { status: number; body: string }) {
    return createSyncPlatformAdapter({
      fetch: (() => {
        throw new Error("the adapter must not use window.fetch");
      }) as unknown as typeof globalThis.fetch,
      invoke: async (cmd, args) => {
        if (cmd === "hq_pro_fetch") {
          urls.push(String((args as { url?: unknown }).url));
          return answer;
        }
        throw new Error(`unexpected ${cmd}`);
      },
    });
  }

  it("sends only the prefix without a page, and limit and cursor with one", async () => {
    const urls: string[] = [];
    const adapter = adapterWith(urls, { status: 200, body: JSON.stringify({ prefix: "sources/*", direct: [], inherited: [], children: [], nextCursor: null }) });
    await adapter.files!.getAccessTree!("cmp_EXAMPLE", "sources/*");
    await adapter.files!.getAccessTree!("cmp_EXAMPLE", "sources/*", { limit: 200 });
    await adapter.files!.getAccessTree!("cmp_EXAMPLE", "sources/*", { limit: 200, cursor: "MjAw" });
    expect(urls).toEqual([
      "/files/cmp_EXAMPLE/acl/tree?prefix=sources%2F*",
      "/files/cmp_EXAMPLE/acl/tree?prefix=sources%2F*&limit=200",
      "/files/cmp_EXAMPLE/acl/tree?prefix=sources%2F*&limit=200&cursor=MjAw",
    ]);
  });

  it("keeps the server's over-budget code on the failure", async () => {
    const urls: string[] = [];
    const adapter = adapterWith(urls, {
      status: 413,
      body: JSON.stringify({ error: "ACL tree exceeds the response budget; request a smaller page", code: "ACL_TREE_RESPONSE_TOO_LARGE" }),
    });
    const res = await adapter.files!.getAccessTree!("cmp_EXAMPLE", "*");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("ACL_TREE_RESPONSE_TOO_LARGE");
  });
});

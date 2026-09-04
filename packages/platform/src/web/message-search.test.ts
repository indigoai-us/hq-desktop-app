import { describe, expect, it } from "vitest";

import { WebPlatformAdapter } from "./index.js";

function desktopEscapeQuery(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) => {
    const character = String.fromCharCode(byte);
    return /[A-Za-z0-9\-_.~]/.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

/** Mirrors crates/hq-desktop-core/src/message_search.rs:build_search_url. */
function desktopSearchPath(
  q: string,
  opts: { companyUid?: string; limit?: number },
): string {
  let path = `/v1/notify/search?q=${desktopEscapeQuery(q)}`;
  const companyUid = opts.companyUid?.trim();
  if (companyUid) path += `&companyUid=${desktopEscapeQuery(companyUid)}`;
  if (opts.limit != null) path += `&limit=${opts.limit}`;
  return path;
}

describe("WebPlatformAdapter message search", () => {
  it("builds the same request path as the desktop core search builder", async () => {
    const paths: string[] = [];
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: async (input) => {
        paths.push(String(input).replace("https://api.test", ""));
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      },
    });
    const q = "a b&c!()*~é";
    const opts = { companyUid: " cmp acme & ", limit: 100 };

    await adapter.messaging.searchMessages(q, opts);

    expect(paths).toEqual([desktopSearchPath(q, opts)]);
  });
});

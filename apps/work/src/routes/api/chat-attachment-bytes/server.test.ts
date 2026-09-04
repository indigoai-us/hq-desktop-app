import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_CHAT_ATTACHMENT_BYTES } from "@hq/ui";
import { GET } from "./+server.js";

const sourceUrl = "https://bucket.s3.amazonaws.com/chat/attachments/demo.txt";

function event(headers?: Headers): Parameters<typeof GET>[0] {
  return {
    request: new Request("https://work.test/api/chat-attachment-bytes", {
      headers,
    }),
    cookies: { get: () => "id-token" },
  } as unknown as Parameters<typeof GET>[0];
}

describe("GET /api/chat-attachment-bytes", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an upstream declaration above the chat attachment cap", async () => {
    fetchMock.mockResolvedValue(
      new Response("not read", {
        headers: {
          "content-length": String(MAX_CHAT_ATTACHMENT_BYTES + 1),
        },
      }),
    );

    const response = await GET(
      event(new Headers({ "x-hq-source-url": sourceUrl })),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "File is too large",
      code: "SOURCE_TOO_LARGE",
    });
  });

  it("rejects an unreported stream that exceeds the chat attachment cap", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_CHAT_ATTACHMENT_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchMock.mockResolvedValue(
      new Response(body, { headers: { "content-type": "text/plain" } }),
    );

    const response = await GET(
      event(new Headers({ "x-hq-source-url": sourceUrl })),
    );

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  it("returns a normal-sized attachment intact", async () => {
    const source = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    fetchMock.mockResolvedValue(
      new Response(source, {
        headers: { "content-type": "application/octet-stream" },
      }),
    );

    const response = await GET(
      event(new Headers({ "x-hq-source-url": sourceUrl })),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
      Array.from(source),
    );
  });
});

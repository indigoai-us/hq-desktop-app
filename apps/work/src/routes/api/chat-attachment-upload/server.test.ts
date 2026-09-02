import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEB_CHAT_ATTACHMENT_MAX_BYTES } from "@hq/ui";
import { PUT } from "./+server.js";

const uploadUrl =
  "https://bucket.s3.amazonaws.com/chat/attachments/demo-upload.txt";

function event(
  request: Request,
  idToken: string | null | undefined = "id-token",
): Parameters<typeof PUT>[0] {
  return {
    request,
    cookies: { get: () => idToken },
  } as unknown as Parameters<typeof PUT>[0];
}

function uploadRequest(
  body: BodyInit,
  headers: HeadersInit = {},
): Request {
  return new Request("https://work.test/api/chat-attachment-upload", {
    method: "PUT",
    headers: new Headers({ "x-hq-upload-url": uploadUrl, ...headers }),
    body,
  });
}

function streamedUploadRequest(
  chunks: Uint8Array[],
  headers: HeadersInit = {},
): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request("https://work.test/api/chat-attachment-upload", {
    method: "PUT",
    headers: new Headers({ "x-hq-upload-url": uploadUrl, ...headers }),
    body,
    duplex: "half",
  } as RequestInit);
}

function requestThatMustNotReadBody(headers: HeadersInit): {
  request: Request;
  bodyWasRead: () => boolean;
} {
  let bodyRead = false;
  return {
    request: {
      headers: new Headers(headers),
      get body() {
        bodyRead = true;
        return new ReadableStream<Uint8Array>();
      },
    } as Request,
    bodyWasRead: () => bodyRead,
  };
}

describe("PUT /api/chat-attachment-upload", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards a body at the web chat attachment limit", async () => {
    const response = await PUT(
      event(
        uploadRequest(new Uint8Array(WEB_CHAT_ATTACHMENT_MAX_BYTES), {
          "content-length": String(WEB_CHAT_ATTACHMENT_MAX_BYTES),
        }),
      ),
    );

    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, options] = fetchMock.mock.calls[0]!;
    expect(target).toBe(uploadUrl);
    expect(options?.method).toBe("PUT");
    expect((options?.body as ArrayBuffer).byteLength).toBe(
      WEB_CHAT_ATTACHMENT_MAX_BYTES,
    );
  });

  it("rejects a declared body one byte over the web limit without an upstream upload", async () => {
    const response = await PUT(
      event(
        uploadRequest(new Uint8Array(WEB_CHAT_ATTACHMENT_MAX_BYTES + 1), {
          "content-length": String(WEB_CHAT_ATTACHMENT_MAX_BYTES + 1),
        }),
      ),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Upload is too large",
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a chunked body over the web limit without an upstream upload", async () => {
    const response = await PUT(
      event(
        streamedUploadRequest([
          new Uint8Array(WEB_CHAT_ATTACHMENT_MAX_BYTES),
          new Uint8Array([0]),
        ]),
      ),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Upload is too large",
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a body that exceeds a lying content-length without an upstream upload", async () => {
    const response = await PUT(
      event(
        streamedUploadRequest(
          [
            new Uint8Array(WEB_CHAT_ATTACHMENT_MAX_BYTES),
            new Uint8Array([0]),
          ],
          { "content-length": "1" },
        ),
      ),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Upload is too large",
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing cookie without reading the request body", async () => {
    const { request, bodyWasRead } = requestThatMustNotReadBody({
      "x-hq-upload-url": uploadUrl,
    });

    const response = await PUT(event(request, null));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Unauthenticated",
      code: "UNAUTHENTICATED",
    });
    expect(bodyWasRead()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid upload URL without reading the request body", async () => {
    const { request, bodyWasRead } = requestThatMustNotReadBody({
      "x-hq-upload-url": "https://example.com/not-a-vault-object",
    });

    const response = await PUT(event(request));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Upload URL is not a vault object",
      code: "UPLOAD_URL_INVALID",
    });
    expect(bodyWasRead()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

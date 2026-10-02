import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachmentPreviewKind,
  canUseWebAttachmentProxy,
  isNetworkFetchError,
  parseCsv,
  readAttachmentResponse,
} from "./attachment-preview.js";

const TRANSFER_TIMEOUT_MS = 300_000;

async function settleWithin<T>(promise: Promise<T>) {
  return Promise.race([
    promise.then(
      (value) => ({ settled: true as const, value }),
      (error: unknown) => ({ settled: true as const, error }),
    ),
    new Promise<{ settled: false }>((resolve) =>
      setTimeout(() => resolve({ settled: false }), 100),
    ),
  ]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("attachmentPreviewKind", () => {
  it("classifies images, pdfs, text, and sheets", () => {
    expect(
      attachmentPreviewKind({ name: "a.png", contentType: "image/png" }),
    ).toBe("image");
    expect(
      attachmentPreviewKind({
        name: "notes.pdf",
        contentType: "application/pdf",
      }),
    ).toBe("pdf");
    expect(
      attachmentPreviewKind({
        name: "readme.md",
        contentType: "text/markdown",
      }),
    ).toBe("markdown");
    expect(
      attachmentPreviewKind({ name: "log.txt", contentType: "text/plain" }),
    ).toBe("text");
    expect(
      attachmentPreviewKind({ name: "grid.csv", contentType: "text/csv" }),
    ).toBe("sheet");
    expect(
      attachmentPreviewKind({
        name: "book.xlsx",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ).toBe("sheet");
    expect(attachmentPreviewKind({ name: "source.gif", contentType: "" })).toBe(
      "image",
    );
  });
});

describe("parseCsv", () => {
  it("parses quoted commas", () => {
    expect(parseCsv('name,note\n"Ada, Lovelace","hi""there"')).toEqual([
      ["name", "note"],
      ["Ada, Lovelace", 'hi"there'],
    ]);
  });
});

describe("canUseWebAttachmentProxy", () => {
  it("is only for hosted web, never desktop vite", () => {
    expect(canUseWebAttachmentProxy("https://work.hq.computer")).toBe(true);
    expect(canUseWebAttachmentProxy("http://127.0.0.1:1420")).toBe(false);
    expect(canUseWebAttachmentProxy("http://localhost:5173")).toBe(true);
  });
});

describe("isNetworkFetchError", () => {
  it("treats WebKit Load failed like Failed to fetch", () => {
    expect(isNetworkFetchError(new Error("Load failed"))).toBe(true);
    expect(isNetworkFetchError(new Error("Failed to fetch"))).toBe(true);
    expect(
      isNetworkFetchError(new DOMException("deadline", "TimeoutError")),
    ).toBe(true);
    expect(isNetworkFetchError(new Error("Upload failed for a.pdf"))).toBe(
      false,
    );
  });
});

describe("readAttachmentResponse deadlines", () => {
  it("falls back to the proxy when the direct response body times out", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    vi.stubGlobal("window", {
      location: { origin: "https://work.hq.computer" },
    });
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_input, init) => {
        init?.signal?.addEventListener(
          "abort",
          () =>
            bodyController?.error(
              new DOMException("deadline", "TimeoutError"),
            ),
          { once: true },
        );
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodyController = controller;
              controller.enqueue(new Uint8Array([1]));
            },
          }),
        );
      })
      .mockResolvedValueOnce(new Response("proxy bytes"));
    vi.stubGlobal("fetch", fetchMock);

    const operation = readAttachmentResponse("https://files.example.test/a");
    timeout.abort();
    const result = await settleWithin(operation);

    expect(result.settled).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://files.example.test/a",
      { signal: timeout.signal },
    );
    expect(AbortSignal.timeout).toHaveBeenCalledWith(TRANSFER_TIMEOUT_MS);
    if (!result.settled) throw new Error("request did not settle");
    if ("error" in result) throw result.error;
    expect(await result.value.text()).toBe("proxy bytes");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/chat-attachment-bytes", {
      headers: { "x-hq-source-url": "https://files.example.test/a" },
      signal: timeout.signal,
    });
  });

  it("surfaces the proxy timeout after awaiting the final request", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    vi.stubGlobal("window", {
      location: { origin: "https://work.hq.computer" },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementationOnce((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("deadline", "TimeoutError"));
            return;
          }
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("deadline", "TimeoutError")),
            { once: true },
          );
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const operation = readAttachmentResponse("https://files.example.test/a");
    await Promise.resolve();
    timeout.abort();
    const result = await settleWithin(operation);

    expect(result.settled).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/chat-attachment-bytes", {
      headers: { "x-hq-source-url": "https://files.example.test/a" },
      signal: timeout.signal,
    });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(TRANSFER_TIMEOUT_MS);
    expect(result).toMatchObject({
      settled: true,
      error: expect.objectContaining({ name: "TimeoutError" }),
    });
  });
});

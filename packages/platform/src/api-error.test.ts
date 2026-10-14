import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_ERROR_COPY,
  classifyApiError,
  friendlyApiError,
  scrubTransportFailure,
} from "./api-error.js";

const RAW =
  "Network error: error sending request for url (https://hqapi.getindigo.ai/v1/agents/mobile-roster)";

describe("friendlyApiError (QA-080)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps transport failures to the connection sentence and logs the raw text", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const copy = friendlyApiError({ ok: false, code: "invoke", message: RAW });
    expect(copy).toBe(API_ERROR_COPY.offline);
    expect(copy).not.toContain("http");
    expect(JSON.stringify(log.mock.calls)).toContain("mobile-roster");
  });

  it("classifies status codes", () => {
    expect(classifyApiError({ code: "http-401", message: "nope" })).toBe("signedOut");
    expect(classifyApiError({ code: "http-403", message: "nope" })).toBe("forbidden");
    expect(classifyApiError({ code: "http-503", message: "Service Unavailable" })).toBe("server");
    expect(classifyApiError({ code: "http-504", message: "Gateway Timeout" })).toBe("server");
    expect(classifyApiError("Not signed in")).toBe("signedOut");
  });

  it("passes through server sentences written for people", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(friendlyApiError({ code: "http-402", message: "Your plan allows 3 bots." })).toBe(
      "Your plan allows 3 bots.",
    );
    expect(friendlyApiError({}, "Could not load.")).toBe("Could not load.");
  });

  it("never shows a raw URL even when unclassified", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(friendlyApiError("GET /v1/x failed")).toBe(API_ERROR_COPY.server);
    expect(friendlyApiError("boom at https://example.com/a")).toBe(API_ERROR_COPY.server);
  });
});

describe("scrubTransportFailure", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rewrites transport failures at the adapter and keeps 4xx server text", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const scrubbed = scrubTransportFailure({ ok: false as const, code: "invoke", message: RAW });
    expect(scrubbed).toMatchObject({ code: "network", message: API_ERROR_COPY.offline });
    const refusal = { ok: false as const, code: "http-403", message: "Application pending" };
    expect(scrubTransportFailure(refusal)).toBe(refusal);
    expect(
      scrubTransportFailure({ ok: false as const, code: "http-503", message: "Service Unavailable" }).message,
    ).toBe(API_ERROR_COPY.server);
  });
});

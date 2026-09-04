import { describe, expect, it } from "vitest";

import {
  firstParam,
  normalizeCallback,
  searchParamsToSignIn,
} from "./callback.js";

describe("normalizeCallback (same-origin guard)", () => {
  const origin = "https://work.hq.computer";

  it("honors same-origin paths", () => {
    expect(normalizeCallback({ callbackUrl: "/" }, origin)).toBe("/");
    expect(normalizeCallback({ callbackUrl: "/chat" }, origin)).toBe("/chat");
    expect(normalizeCallback({ callbackUrl: "/board" }, origin)).toBe(
      "/board",
    );
    expect(
      normalizeCallback({ callbackUrl: "/projects?tab=files" }, origin),
    ).toBe("/projects?tab=files");
    expect(normalizeCallback({ callbackUrl: "/a#frag" }, origin)).toBe(
      "/a#frag",
    );
    expect(normalizeCallback({ callbackUrl: "/projects/123" }, origin)).toBe(
      "/projects/123",
    );
  });

  it("falls back to / when absent", () => {
    expect(normalizeCallback({}, origin)).toBe("/");
  });

  it("falls back to / with an invalid origin", () => {
    expect(normalizeCallback({ callbackUrl: "/board" }, "not a URL")).toBe(
      "/",
    );
  });

  it("rejects values URL parsing resolves off-origin", () => {
    expect(
      normalizeCallback(
        searchParamsToSignIn(
          new URLSearchParams("callbackUrl=/%09/evil.com"),
        ),
        origin,
      ),
    ).toBe("/");
    expect(
      normalizeCallback(
        searchParamsToSignIn(
          new URLSearchParams("callbackUrl=/%0A/evil.com"),
        ),
        origin,
      ),
    ).toBe("/");
    expect(
      normalizeCallback(
        searchParamsToSignIn(
          new URLSearchParams("callbackUrl=/%0D/evil.com"),
        ),
        origin,
      ),
    ).toBe("/");
    expect(normalizeCallback({ callbackUrl: "/\t\\evil.com" }, origin)).toBe(
      "/",
    );
    expect(normalizeCallback({ callbackUrl: "//evil.com" }, origin)).toBe("/");
    expect(normalizeCallback({ callbackUrl: "/\\evil.com" }, origin)).toBe("/");
    expect(normalizeCallback({ callbackUrl: "https://evil.com" }, origin)).toBe(
      "/",
    );
    expect(normalizeCallback({ callbackUrl: "http://evil.com" }, origin)).toBe(
      "/",
    );
    expect(
      normalizeCallback({ callbackUrl: "javascript:alert(1)" }, origin),
    ).toBe("/");
    expect(normalizeCallback({ callbackUrl: "data:text/html,x" }, origin)).toBe(
      "/",
    );
    expect(normalizeCallback({ callbackUrl: "evil.com" }, origin)).toBe("/");
  });

  it("prefers callbackUrl, then return, then return-to", () => {
    expect(
      normalizeCallback(
        { callbackUrl: "/a", return: "/b", "return-to": "/c" },
        origin,
      ),
    ).toBe("/a");
    expect(normalizeCallback({ return: "/b", "return-to": "/c" }, origin)).toBe(
      "/b",
    );
    expect(normalizeCallback({ "return-to": "/c" }, origin)).toBe("/c");
  });

  it("firstParam unwraps array-valued params", () => {
    expect(firstParam(["/a", "/b"])).toBe("/a");
    expect(firstParam("/a")).toBe("/a");
    expect(firstParam(undefined)).toBeUndefined();
  });
});

describe("searchParamsToSignIn", () => {
  it("maps URLSearchParams into a SignInSearchParams object", () => {
    const params = new URLSearchParams(
      "idp=Google&callbackUrl=/chat&error=AccessDenied",
    );
    expect(searchParamsToSignIn(params)).toEqual({
      idp: "Google",
      provider: undefined,
      callbackUrl: "/chat",
      return: undefined,
      "return-to": undefined,
      error: "AccessDenied",
    });
  });
});

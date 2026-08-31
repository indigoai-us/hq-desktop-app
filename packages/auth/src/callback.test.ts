import { describe, expect, it } from "vitest";

import {
  firstParam,
  normalizeCallback,
  searchParamsToSignIn,
} from "./callback.js";

describe("normalizeCallback (same-origin guard)", () => {
  it("honors a single-slash absolute path", () => {
    expect(normalizeCallback({ callbackUrl: "/chat" })).toBe("/chat");
    expect(normalizeCallback({ callbackUrl: "/projects/123" })).toBe(
      "/projects/123",
    );
  });

  it("falls back to / when absent", () => {
    expect(normalizeCallback({})).toBe("/");
  });

  it("rejects protocol-relative and off-origin values", () => {
    expect(normalizeCallback({ callbackUrl: "//evil.com" })).toBe("/");
    expect(normalizeCallback({ callbackUrl: "https://evil.com" })).toBe("/");
    expect(normalizeCallback({ callbackUrl: "/\\evil.com" })).toBe("/");
    expect(normalizeCallback({ callbackUrl: "evil.com" })).toBe("/");
  });

  it("prefers callbackUrl, then return, then return-to", () => {
    expect(
      normalizeCallback({ callbackUrl: "/a", return: "/b", "return-to": "/c" }),
    ).toBe("/a");
    expect(normalizeCallback({ return: "/b", "return-to": "/c" })).toBe("/b");
    expect(normalizeCallback({ "return-to": "/c" })).toBe("/c");
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

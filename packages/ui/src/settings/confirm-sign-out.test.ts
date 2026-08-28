import { afterEach, describe, expect, it, vi } from "vitest";

import { confirmSignOut } from "./confirm-sign-out.js";

describe("confirmSignOut", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false when the user cancels", () => {
    vi.stubGlobal("confirm", () => false);
    expect(confirmSignOut()).toBe(false);
  });

  it("returns true when the user confirms", () => {
    vi.stubGlobal("confirm", () => true);
    expect(confirmSignOut()).toBe(true);
  });
});

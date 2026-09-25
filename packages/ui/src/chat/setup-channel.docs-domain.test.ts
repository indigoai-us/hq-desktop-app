// Source-contract test: wave 1 of getindigo.ai deprecation.
// Asserts every help/docs link in SETUP_URLS points at docs.hq.computer.
// This test was added first (failing) before the constant was updated,
// so the failure appears in history before the fix.

import { describe, expect, it } from "vitest";
import { SETUP_URLS } from "./setup-channel";

describe("getindigo.ai deprecation wave 1: docs links", () => {
  it("SETUP_URLS.docs points at docs.hq.computer", () => {
    expect(SETUP_URLS.docs).toBe("https://docs.hq.computer");
  });
});

import { describe, expect, it } from "vitest";

import {
  base64ByteLength,
  stripDataUrlPrefix,
  AVATAR_MAX_BYTES,
} from "./avatar-image.js";

describe("avatar-image helpers", () => {
  it("strips a data: URI prefix to raw base64", () => {
    expect(stripDataUrlPrefix("data:image/jpeg;base64,QUJD")).toBe("QUJD");
    // Already-raw base64 is returned unchanged.
    expect(stripDataUrlPrefix("QUJD")).toBe("QUJD");
  });

  it("computes decoded byte length accounting for padding", () => {
    expect(base64ByteLength("")).toBe(0);
    expect(base64ByteLength("QUJD")).toBe(3); // "ABC"
    expect(base64ByteLength("QUJDRA==")).toBe(4); // "ABCD"
  });

  it("keeps the server ceiling in sync with the documented 192KB", () => {
    expect(AVATAR_MAX_BYTES).toBe(192 * 1024);
  });
});

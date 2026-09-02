import { describe, expect, it } from "vitest";
import { localDevBearer } from "./local-dev-bearer.js";

describe("localDevBearer", () => {
  it("prefers the cookie token and never reads the machine file", () => {
    expect(
      localDevBearer({
        cookieToken: "cookie-token",
        dev: true,
        meshFlag: "1",
      }),
    ).toBe("cookie-token");
  });

  it("stays closed when the local-mesh flag is off", () => {
    expect(
      localDevBearer({
        cookieToken: null,
        dev: true,
        meshFlag: undefined,
      }),
    ).toBeNull();
    expect(
      localDevBearer({
        cookieToken: null,
        dev: false,
        meshFlag: "1",
      }),
    ).toBeNull();
  });
});

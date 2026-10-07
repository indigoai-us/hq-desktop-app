// OWNER-R28: one compact formatter; thousands roll over to the next unit.
import { describe, expect, it } from "vitest";
import { compactNumber, exactNumber } from "./compact-number";

describe("OWNER-R28 compactNumber", () => {
  it("keeps numbers under 1,000 plain", () => {
    expect(compactNumber(0)).toBe("0");
    expect(compactNumber(7)).toBe("7");
    expect(compactNumber(999)).toBe("999");
  });

  it("uses K, M, B and T with three significant digits and no trailing zeros", () => {
    expect(compactNumber(1_000)).toBe("1K");
    expect(compactNumber(1_500)).toBe("1.5K");
    expect(compactNumber(238_980_000)).toBe("239M");
    expect(compactNumber(3_970_000_000)).toBe("3.97B");
    expect(compactNumber(96_572_100_000)).toBe("96.6B");
    expect(compactNumber(1_200_000)).toBe("1.2M");
    expect(compactNumber(2_000_000_000_000)).toBe("2T");
  });

  it("never prints 1,000 or more in front of a unit, even after rounding", () => {
    expect(compactNumber(999.6)).toBe("1K");
    expect(compactNumber(999_950)).toBe("1M");
    expect(compactNumber(999_999)).toBe("1M");
    expect(compactNumber(999_950_000)).toBe("1B");
    expect(compactNumber(999_950_000_000)).toBe("1T");
    for (const n of [9_999, 99_999, 999_499, 12_345_678_901, 96_572_100_000]) {
      expect(compactNumber(n)).not.toMatch(/\d{4}[KMBT]$/);
    }
  });

  it("takes a precision option and handles negatives and junk", () => {
    expect(compactNumber(238_980_000, { significant: 5 })).toBe("238.98M");
    expect(compactNumber(-1_500)).toBe("-1.5K");
    expect(compactNumber(Number.NaN)).toBe("");
  });

  it("gives the exact value for hover text", () => {
    expect(exactNumber(96_572_100_000)).toBe("96,572,100,000");
  });
});

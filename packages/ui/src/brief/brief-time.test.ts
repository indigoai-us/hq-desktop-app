import { describe, expect, it } from "vitest";
import { partOfDay } from "./brief-time.js";

describe("partOfDay", () => {
  it("greets by the local clock: Morning from 5 AM, Afternoon from noon, Evening from 5 PM", () => {
    const at = (h: number, m = 0) => partOfDay(new Date(2026, 9, 16, h, m));
    expect(at(5)).toBe("Morning");
    expect(at(11, 59)).toBe("Morning");
    expect(at(12)).toBe("Afternoon");
    expect(at(16, 59)).toBe("Afternoon");
    expect(at(17)).toBe("Evening");
    // Owner report, 2026-10-16: "Morning, Corey." at 7:35 PM.
    expect(at(19, 35)).toBe("Evening");
    expect(at(0, 30)).toBe("Evening");
    expect(at(4, 59)).toBe("Evening");
  });
});

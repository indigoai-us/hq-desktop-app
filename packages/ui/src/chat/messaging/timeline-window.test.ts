import { describe, expect, it } from "vitest";
import { takeNewestWindow } from "./timeline-window";

describe("takeNewestWindow", () => {
  it("keeps a short thread intact", () => {
    const rows = [1, 2, 3];
    expect(takeNewestWindow(rows, { limit: 40 })).toEqual({
      hidden: 0,
      rows: [1, 2, 3],
    });
  });

  it("drops older messages and keeps the newest window", () => {
    const rows = Array.from({ length: 80 }, (_, i) => i + 1);
    const got = takeNewestWindow(rows, { limit: 40 });
    expect(got.hidden).toBe(40);
    expect(got.rows).toEqual(rows.slice(40));
    expect(got.rows[0]).toBe(41);
    expect(got.rows.at(-1)).toBe(80);
  });

  it("Show earlier raises extra without losing the newest rows", () => {
    const rows = Array.from({ length: 80 }, (_, i) => i + 1);
    const got = takeNewestWindow(rows, { limit: 40, extra: 40 });
    expect(got.hidden).toBe(0);
    expect(got.rows).toEqual(rows);
  });
});

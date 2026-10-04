import { describe, expect, it } from "vitest";
import { isRecord } from "./is-record.js";

describe("isRecord", () => {
  it("accepts plain and null-prototype objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ value: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  const rejectedValues: [string, unknown][] = [
    ["arrays", []],
    ["null", null],
    ["undefined", undefined],
    ["numbers", 1],
    ["strings", "value"],
    ["functions", () => undefined],
  ];

  it.each(rejectedValues)("rejects %s", (_label, value) => {
    expect(isRecord(value)).toBe(false);
  });
});

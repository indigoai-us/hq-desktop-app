import { describe, expect, it } from "vitest";
import { countLabel, LIST_PAGE_SIZE, pageRows } from "./list-paging";

describe("list paging", () => {
  const rows = Array.from({ length: 123 }, (_, i) => i);

  it("shows short lists whole", () => {
    const page = pageRows(rows.slice(0, 7), 1);
    expect(page.rows).toHaveLength(7);
    expect(page.remaining).toBe(0);
    expect(page.next).toBe(0);
  });

  it("pages long lists by 50 and reports what is left", () => {
    expect(LIST_PAGE_SIZE).toBe(50);
    const first = pageRows(rows, 1);
    expect(first.rows).toHaveLength(50);
    expect(first.total).toBe(123);
    expect(first.remaining).toBe(73);
    expect(first.next).toBe(50);
    const last = pageRows(rows, 3);
    expect(last.rows).toHaveLength(123);
    expect(last.remaining).toBe(0);
    expect(pageRows(rows, 2).next).toBe(23);
  });

  it("always paints at least one page", () => {
    expect(pageRows(rows, 0).rows).toHaveLength(50);
    expect(pageRows(rows, Number.NaN).rows).toHaveLength(50);
  });

  it("labels a section with its real count", () => {
    expect(countLabel("Secrets", 10)).toBe("Secrets · 10");
  });
});

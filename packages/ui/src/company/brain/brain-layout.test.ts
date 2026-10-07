// Owner ask (2026-10-06): "tree list should be as narrow as left sidepane. doc
// viewer should take up most of space". The Brain list column starts at the
// sidebar's width and keeps its own dragged width per page on this machine.

import { describe, expect, it } from "vitest";
import {
  BRAIN_LIST_MAX,
  BRAIN_LIST_MIN,
  clampListWidth,
  listWidthKey,
  readListWidth,
  saveListWidth,
  sidebarWidth,
} from "./brain-layout.js";

function memory(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("Brain list width", () => {
  it("defaults to the sidebar's saved width, else its 260px default", () => {
    expect(readListWidth("knowledge", memory())).toBe(260);
    expect(readListWidth("policies", memory({ "hq.sidebar.width": "300" }))).toBe(300);
    // An out-of-range sidebar value falls back to the sidebar default.
    expect(sidebarWidth(memory({ "hq.sidebar.width": "9000" }))).toBe(260);
  });

  it("saves per page and reads each page back on its own", () => {
    const store = memory({ "hq.sidebar.width": "280" });
    saveListWidth("skills", 340, store);
    saveListWidth("workers", 220, store);
    expect(store.data.get(listWidthKey("skills"))).toBe("340");
    expect(readListWidth("skills", store)).toBe(340);
    expect(readListWidth("workers", store)).toBe(220);
    expect(readListWidth("knowledge", store)).toBe(280);
  });

  it("clamps saved and dragged widths to the allowed range", () => {
    const store = memory();
    saveListWidth("policies", 5000, store);
    expect(readListWidth("policies", store)).toBe(BRAIN_LIST_MAX);
    saveListWidth("policies", 10, store);
    expect(readListWidth("policies", store)).toBe(BRAIN_LIST_MIN);
    expect(clampListWidth(Number.NaN)).toBe(260);
    // A hand-edited out-of-range value is ignored.
    expect(readListWidth("knowledge", memory({ [listWidthKey("knowledge")]: "12" }))).toBe(260);
  });

  it("does not throw when storage refuses the write", () => {
    const store = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(() => saveListWidth("knowledge", 300, store)).not.toThrow();
    } finally {
      console.warn = warn;
    }
  });
});

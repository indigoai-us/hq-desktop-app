import { describe, expect, it } from "vitest";
import {
  displayHqRoot,
  LAUNCH_HQ_ROOT_KEY,
  readRememberedHqRoot,
  rememberHqRoot,
} from "./launch-folder.js";

function memory() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

describe("launch HQ root memory", () => {
  it("remembers the HQ root and reads it back", () => {
    const storage = memory();
    expect(readRememberedHqRoot(storage)).toBe("");
    rememberHqRoot("  /Users/corey/Documents/HQ  ", storage);
    expect(storage.getItem(LAUNCH_HQ_ROOT_KEY)).toBe("/Users/corey/Documents/HQ");
    expect(readRememberedHqRoot(storage)).toBe("/Users/corey/Documents/HQ");
  });

  it("ignores a blank path", () => {
    const storage = memory();
    rememberHqRoot("   ", storage);
    expect(storage.getItem(LAUNCH_HQ_ROOT_KEY)).toBeNull();
  });

  it("shows a home-relative folder", () => {
    expect(displayHqRoot("/Users/corey/Documents/HQ", "/Users/corey")).toBe(
      "~/Documents/HQ",
    );
    expect(displayHqRoot("/opt/HQ", "/Users/corey")).toBe("/opt/HQ");
  });
});

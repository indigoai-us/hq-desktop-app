import { describe, expect, it } from "vitest";

import { FIRST_RUN_DEV_OFF, FIRST_RUN_DEV_SWITCHES, readFirstRunDevSwitches } from "./dev-switches.js";

describe("first-run dev switches", () => {
  it("are off in a build that did not set them (this test build, and every release build)", () => {
    expect(FIRST_RUN_DEV_SWITCHES).toEqual({ force: false, dry: false });
    expect(readFirstRunDevSwitches(null)).toBe(FIRST_RUN_DEV_OFF);
    expect(readFirstRunDevSwitches({})).toEqual({ force: false, dry: false });
  });

  it("turn on only for a truthy value, each on its own", () => {
    expect(readFirstRunDevSwitches({ VITE_HQ_DEV_FIRST_RUN_FORCE: "1" })).toEqual({ force: true, dry: false });
    expect(readFirstRunDevSwitches({ VITE_HQ_DEV_FIRST_RUN_DRY: "true" })).toEqual({ force: false, dry: true });
    expect(readFirstRunDevSwitches({ VITE_HQ_DEV_FIRST_RUN_FORCE: " YES ", VITE_HQ_DEV_FIRST_RUN_DRY: "1" })).toEqual({
      force: true,
      dry: true,
    });
    for (const value of ["", "0", "false", "no", "off", 1, true]) {
      expect(readFirstRunDevSwitches({ VITE_HQ_DEV_FIRST_RUN_FORCE: value, VITE_HQ_DEV_FIRST_RUN_DRY: value })).toEqual({
        force: false,
        dry: false,
      });
    }
  });
});

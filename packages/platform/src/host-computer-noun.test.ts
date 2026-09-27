import { describe, expect, it } from "vitest";

import {
  hostComputerNoun,
  thisComputerNoun,
  yourComputerNoun,
} from "./host-computer-noun.js";

describe("hostComputerNoun", () => {
  it("names a Mac when the host reports macOS", () => {
    expect(hostComputerNoun({ tauri: true, osPlatform: "macos" })).toBe("Mac");
    expect(thisComputerNoun({ tauri: true, osPlatform: "macos" })).toBe(
      "this Mac",
    );
    expect(yourComputerNoun({ tauri: true, osPlatform: "macos" })).toBe(
      "your Mac",
    );
  });

  it("names a PC when the host reports Windows", () => {
    expect(hostComputerNoun({ tauri: true, osPlatform: "windows" })).toBe("PC");
    expect(thisComputerNoun({ tauri: true, osPlatform: "windows" })).toBe(
      "this PC",
    );
    expect(yourComputerNoun({ tauri: true, osPlatform: "windows" })).toBe(
      "your PC",
    );
  });

  it("uses the neutral 'computer' for Linux or an unknown OS", () => {
    expect(hostComputerNoun({ tauri: true, osPlatform: "linux" })).toBe(
      "computer",
    );
    expect(hostComputerNoun({ tauri: true, osPlatform: null })).toBe(
      "computer",
    );
    expect(hostComputerNoun({ tauri: false, osPlatform: null })).toBe(
      "computer",
    );
    expect(thisComputerNoun({ tauri: true, osPlatform: "linux" })).toBe(
      "this computer",
    );
  });
});

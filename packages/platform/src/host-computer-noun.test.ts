import { describe, expect, it } from "vitest";

import {
  hostComputerNoun,
  primaryEnterKeyHint,
  subscribeHostComputerNoun,
  thisComputerNoun,
  yourComputerNoun,
  type HostComputerNoun,
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

describe("hostComputerNoun in a native shell with no OS probe (apps/sync)", () => {
  const MAC_WEBVIEW =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  const WINDOWS_WEBVIEW =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
  const LINUX_WEBVIEW = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15";

  it("reads the webview's user-agent when the shell never reports its OS", () => {
    expect(hostComputerNoun({ tauri: true, osPlatform: null }, MAC_WEBVIEW)).toBe("Mac");
    expect(hostComputerNoun({ tauri: true, osPlatform: null }, WINDOWS_WEBVIEW)).toBe("PC");
    expect(hostComputerNoun({ tauri: true, osPlatform: null }, LINUX_WEBVIEW)).toBe("computer");
    expect(hostComputerNoun({ tauri: true, osPlatform: null }, IPAD)).toBe("computer");
    expect(hostComputerNoun({ tauri: true, osPlatform: null }, "")).toBe("computer");
  });

  it("lets a reported OS win over the user-agent", () => {
    expect(hostComputerNoun({ tauri: true, osPlatform: "linux" }, MAC_WEBVIEW)).toBe("computer");
    expect(hostComputerNoun({ tauri: true, osPlatform: "windows" }, MAC_WEBVIEW)).toBe("PC");
  });

  it("keeps the neutral noun in a plain browser", () => {
    expect(hostComputerNoun({ tauri: false, osPlatform: null }, MAC_WEBVIEW)).toBe("computer");
  });
});

describe("subscribeHostComputerNoun (probe lands after mount)", () => {
  /**
   * The Windows persona's `verify-install-003` report caught the exact bug
   * this suite guards: the New bot panel read "on this computer" on Windows
   * because `apps/sync` does not inject `__HQ_HOST_OS__` synchronously and
   * the Tauri OS plugin's fallback resolves a moment later. The panel's
   * initial synchronous read got "computer"; the subscription flips it to
   * "PC" as soon as the probe lands.
   */
  it("calls the subscriber immediately with the current value", () => {
    const seen: HostComputerNoun[] = [];
    const dispose = subscribeHostComputerNoun((n) => seen.push(n), {
      read: () => "Mac",
    });
    expect(seen).toEqual(["Mac"]);
    // Already specific → poller never schedules.
    dispose();
  });

  it("keeps polling on a neutral read and emits a specific value once the probe lands", () => {
    const reads: HostComputerNoun[] = ["computer", "computer", "PC", "PC"];
    let i = 0;
    const scheduled: Array<() => void> = [];
    const seen: HostComputerNoun[] = [];
    const dispose = subscribeHostComputerNoun((n) => seen.push(n), {
      read: () => reads[Math.min(i++, reads.length - 1)],
      schedule: (fn) => {
        scheduled.push(fn);
        return scheduled.length as unknown as number;
      },
      cancel: () => {},
    });
    // Initial synchronous emission with the neutral value.
    expect(seen).toEqual(["computer"]);
    // The poller re-reads: still neutral, no new emission (dedupe).
    scheduled[0]!();
    expect(seen).toEqual(["computer"]);
    // Probe lands: emits "PC" and stops.
    scheduled[1]!();
    expect(seen).toEqual(["computer", "PC"]);
    // The subscription is done — no further schedules to run.
    expect(scheduled).toHaveLength(2);
    dispose();
  });

  it("stops after maxAttempts even if the probe never lands", () => {
    const scheduled: Array<() => void> = [];
    const seen: HostComputerNoun[] = [];
    subscribeHostComputerNoun((n) => seen.push(n), {
      read: () => "computer",
      maxAttempts: 3,
      schedule: (fn) => {
        scheduled.push(fn);
        return scheduled.length as unknown as number;
      },
      cancel: () => {},
    });
    // Run every scheduled attempt.
    while (scheduled.length > 0) {
      const next = scheduled.shift()!;
      next();
    }
    // Only the initial emission — no repeats because the value never changed.
    expect(seen).toEqual(["computer"]);
  });

  it("cancels the pending timer when the subscriber disposes", () => {
    const cancelled: number[] = [];
    const dispose = subscribeHostComputerNoun(() => {}, {
      read: () => "computer",
      schedule: (_fn, _ms) => 42,
      cancel: (h) => cancelled.push(h),
    });
    dispose();
    expect(cancelled).toEqual([42]);
  });
});

describe("primaryEnterKeyHint", () => {
  it("shows the Mac symbol on macOS", () => {
    expect(primaryEnterKeyHint({ tauri: true, osPlatform: "macos" })).toBe("⌘↵");
  });

  it("names Ctrl+Enter on Windows so a PC user sees a key they can press", () => {
    expect(primaryEnterKeyHint({ tauri: true, osPlatform: "windows" })).toBe("Ctrl+Enter");
  });

  it("falls back to Ctrl+Enter on Linux and unknown platforms", () => {
    expect(primaryEnterKeyHint({ tauri: true, osPlatform: "linux" })).toBe("Ctrl+Enter");
    expect(primaryEnterKeyHint({ tauri: true, osPlatform: null })).toBe("Ctrl+Enter");
    expect(primaryEnterKeyHint({ tauri: false, osPlatform: null })).toBe("Ctrl+Enter");
  });
});

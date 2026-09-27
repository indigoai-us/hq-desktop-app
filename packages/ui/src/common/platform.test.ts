import { describe, expect, it } from "vitest";
import { hostDeviceNoun, isMacUserAgent, isWindowsUserAgent } from "./platform";

// Representative user-agent strings from the three hosts this app ships to.
const MAC_WKWEBVIEW =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const WINDOWS_WEBVIEW2 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0";
const LINUX_WEBKITGTK =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

describe("isMacUserAgent", () => {
  it("detects the macOS WKWebView host", () => {
    expect(isMacUserAgent(MAC_WKWEBVIEW)).toBe(true);
  });

  it("rejects Windows — no activation policy, so the Dock row must stay hidden", () => {
    expect(isMacUserAgent(WINDOWS_WEBVIEW2)).toBe(false);
  });

  it("rejects Linux", () => {
    expect(isMacUserAgent(LINUX_WEBKITGTK)).toBe(false);
  });

  it("rejects an empty user-agent rather than defaulting to mac", () => {
    expect(isMacUserAgent("")).toBe(false);
  });
});

describe("isWindowsUserAgent", () => {
  it("detects the Windows WebView2 host", () => {
    expect(isWindowsUserAgent(WINDOWS_WEBVIEW2)).toBe(true);
  });

  it("rejects macOS", () => {
    expect(isWindowsUserAgent(MAC_WKWEBVIEW)).toBe(false);
  });

  it("rejects Linux", () => {
    expect(isWindowsUserAgent(LINUX_WEBKITGTK)).toBe(false);
  });

  it("rejects an empty user-agent rather than defaulting to windows", () => {
    expect(isWindowsUserAgent("")).toBe(false);
  });
});

describe("hostDeviceNoun", () => {
  it("says Mac on a macOS host — this is the one place the word survives", () => {
    expect(hostDeviceNoun(MAC_WKWEBVIEW)).toBe("Mac");
  });

  it("says PC on a Windows host, never Mac", () => {
    expect(hostDeviceNoun(WINDOWS_WEBVIEW2)).toBe("PC");
  });

  it("falls back to the generic 'computer' on Linux or an unrecognised host", () => {
    expect(hostDeviceNoun(LINUX_WEBKITGTK)).toBe("computer");
    expect(hostDeviceNoun("")).toBe("computer");
  });
});

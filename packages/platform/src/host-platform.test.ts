import { describe, expect, it } from "vitest";
import {
  ANDROID_CAPABILITIES,
  HOST_PLATFORMS,
  IOS_CAPABILITIES,
  TAURI_CAPABILITIES,
  WEB_CAPABILITIES,
  capabilitiesFor,
  isMobile,
  readHostProbe,
  resolveHostPlatform,
  type Capabilities,
  type HostPlatform,
} from "./index.js";

/**
 * The whole point of the mobile target is that there is ONE Svelte source and
 * platform divergence is a switch, not a forked file. That only holds if the
 * platform value itself is resolved in exactly one place and every consumer
 * asks for capabilities rather than sniffing globals. These tests pin that.
 */

describe("resolveHostPlatform", () => {
  it("is web when no Tauri runtime is present", () => {
    expect(resolveHostPlatform({ tauri: false, osPlatform: null })).toBe("web");
  });

  it("is web even if an OS hint leaks in without a Tauri runtime", () => {
    // A browser on an iPhone is still the WEB target: it has no native shell,
    // so it must not inherit mobile-native capabilities.
    expect(resolveHostPlatform({ tauri: false, osPlatform: "ios" })).toBe("web");
  });

  it("is ios under Tauri on iOS", () => {
    expect(resolveHostPlatform({ tauri: true, osPlatform: "ios" })).toBe("ios");
  });

  it("is android under Tauri on Android", () => {
    expect(resolveHostPlatform({ tauri: true, osPlatform: "android" })).toBe(
      "android",
    );
  });

  it.each(["macos", "windows", "linux"])(
    "is desktop under Tauri on %s",
    (osPlatform) => {
      expect(resolveHostPlatform({ tauri: true, osPlatform })).toBe("desktop");
    },
  );

  it("falls back to desktop when Tauri is present but the OS is unknown", () => {
    // A native shell we cannot identify is still a native shell. Guessing
    // "web" here would strip capabilities the host actually has.
    expect(resolveHostPlatform({ tauri: true, osPlatform: null })).toBe(
      "desktop",
    );
  });
});

describe("readHostProbe", () => {
  it("reports no Tauri for a bare browser window", () => {
    expect(readHostProbe({}).tauri).toBe(false);
  });

  it("detects the Tauri v2 internals global", () => {
    expect(readHostProbe({ __TAURI_INTERNALS__: {} }).tauri).toBe(true);
  });

  it("detects the legacy __TAURI__ global", () => {
    expect(readHostProbe({ __TAURI__: {} }).tauri).toBe(true);
  });

  it("prefers the OS the native shell injected at startup", () => {
    // apps/work/src-tauri injects __HQ_HOST_OS__ from Rust's compile-time
    // target. That is authoritative: it cannot disagree with the binary that
    // is actually running, whereas a plugin global depends on plugin wiring.
    const probe = readHostProbe({
      __TAURI_INTERNALS__: {},
      __HQ_HOST_OS__: "Android",
      __TAURI_OS_PLUGIN_INTERNALS__: { platform: "ios" },
    });
    expect(probe).toEqual({ tauri: true, osPlatform: "android" });
  });

  it("treats an injected blank OS as unknown rather than as a platform", () => {
    const probe = readHostProbe({ __TAURI_INTERNALS__: {}, __HQ_HOST_OS__: "  " });
    expect(probe.osPlatform).toBeNull();
  });

  it("falls back to the OS plugin platform and lowercases it", () => {
    const probe = readHostProbe({
      __TAURI_INTERNALS__: {},
      __TAURI_OS_PLUGIN_INTERNALS__: { platform: "IOS" },
    });
    expect(probe).toEqual({ tauri: true, osPlatform: "ios" });
  });

  it("does not invent an OS when the plugin global is absent", () => {
    expect(readHostProbe({ __TAURI_INTERNALS__: {} }).osPlatform).toBeNull();
  });
});

describe("capabilitiesFor", () => {
  it("covers every declared host platform", () => {
    // Exhaustiveness guard: adding a HostPlatform variant without a capability
    // table must fail here rather than silently degrade the UI at runtime.
    for (const platform of HOST_PLATFORMS) {
      expect(capabilitiesFor(platform), platform).toBeDefined();
    }
  });

  it("maps each platform to its own table", () => {
    expect(capabilitiesFor("web")).toBe(WEB_CAPABILITIES);
    expect(capabilitiesFor("desktop")).toBe(TAURI_CAPABILITIES);
    expect(capabilitiesFor("ios")).toBe(IOS_CAPABILITIES);
    expect(capabilitiesFor("android")).toBe(ANDROID_CAPABILITIES);
  });

  it("returns tables that declare every capability key", () => {
    const keys = Object.keys(WEB_CAPABILITIES).sort();
    for (const platform of HOST_PLATFORMS) {
      expect(Object.keys(capabilitiesFor(platform)).sort(), platform).toEqual(
        keys,
      );
    }
  });
});

describe("mobile capabilities", () => {
  const mobileTables: Array<[HostPlatform, Readonly<Capabilities>]> = [
    ["ios", IOS_CAPABILITIES],
    ["android", ANDROID_CAPABILITIES],
  ];

  it.each(mobileTables)(
    "%s has no local-machine capabilities",
    (_platform, caps) => {
      expect(caps.localFiles).toBe(false);
      expect(caps.agentLaunch).toBe(false);
      expect(caps.canSync).toBe(false);
      expect(caps.canLaunchApps).toBe(false);
      expect(caps.canManagePackages).toBe(false);
      expect(caps.canSpawnSessions).toBe(false);
      expect(caps.canInstallLocally).toBe(false);
      expect(caps.localWorkMeshCache).toBe(false);
    },
  );

  it.each(mobileTables)("%s has no desktop chrome", (_platform, caps) => {
    // Phones have no tray and no OS-drawn window controls over the app chrome,
    // so the titlebar must not inset for traffic lights.
    expect(caps.trayAndWindow).toBe(false);
    expect(caps.hasWindowControls).toBe(false);
  });

  it.each(mobileTables)("%s can raise native notifications", (_p, caps) => {
    expect(caps.osNotifications).toBe(true);
  });

  it("does not self-update — app stores own the update path", () => {
    expect(IOS_CAPABILITIES.canSelfUpdate).toBe(false);
    expect(ANDROID_CAPABILITIES.canSelfUpdate).toBe(false);
  });
});

describe("isMobile", () => {
  it("is true only for the phone targets", () => {
    expect(isMobile("ios")).toBe(true);
    expect(isMobile("android")).toBe(true);
    expect(isMobile("web")).toBe(false);
    expect(isMobile("desktop")).toBe(false);
  });
});

describe("existing platform tables are unchanged", () => {
  it("web keeps its previous shape", () => {
    expect(WEB_CAPABILITIES.localFiles).toBe(false);
    expect(WEB_CAPABILITIES.osNotifications).toBe(true);
    expect(WEB_CAPABILITIES.hasWindowControls).toBe(false);
  });

  it("desktop keeps its previous shape", () => {
    expect(TAURI_CAPABILITIES.localFiles).toBe(true);
    expect(TAURI_CAPABILITIES.trayAndWindow).toBe(true);
    expect(TAURI_CAPABILITIES.hasWindowControls).toBe(true);
  });
});

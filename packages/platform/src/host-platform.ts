/**
 * Host platform resolution — the single place the app decides which of the
 * four targets it is running on.
 *
 * Web, desktop and mobile share ONE Svelte source. Divergence is expressed as
 * a branch on the value produced here (or, preferably, on a capability flag
 * derived from it) rather than by forking a component per platform. Nothing
 * outside this module should poke at `window.__TAURI__` to work out where it
 * is; that is how per-platform drift starts.
 */

import type { HostPlatform } from "./capabilities.js";

/**
 * The two facts the resolution actually depends on, separated from where they
 * are read so the switch below is testable without a DOM.
 */
export interface HostProbe {
  /** A Tauri (native shell) runtime is present. */
  tauri: boolean;
  /** Lowercased OS identifier from Tauri's os plugin, or null if unknown. */
  osPlatform: string | null;
}

/** The subset of the global object we read. Keeps the probe injectable. */
export interface HostGlobals {
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: unknown;
  /**
   * Injected by our own native shell (apps/work/src-tauri) from Rust's
   * compile-time target triple. Authoritative, because it cannot disagree with
   * the binary that is actually running.
   */
  __HQ_HOST_OS__?: unknown;
  __TAURI_OS_PLUGIN_INTERNALS__?: { platform?: unknown; os_type?: unknown };
}

function normalizeOs(value: unknown): string | null {
  // Deliberately `|| null` rather than a nullish check: an OS plugin that
  // reports an empty or whitespace string is "unknown", not a platform named "".
  return typeof value === "string" ? value.trim().toLowerCase() || null : null;
}

function defaultGlobals(): HostGlobals {
  return typeof globalThis === "undefined" ? {} : (globalThis as HostGlobals);
}

/** Read the live host facts off the global object. */
export function readHostProbe(win: HostGlobals = defaultGlobals()): HostProbe {
  // Tauri v2 exposes __TAURI_INTERNALS__; the v1-era __TAURI__ global is still
  // injected by some host configurations, so accept either as evidence of a
  // native shell.
  const tauri =
    win.__TAURI_INTERNALS__ !== undefined || win.__TAURI__ !== undefined;
  const osInternals = win.__TAURI_OS_PLUGIN_INTERNALS__;
  const osPlatform =
    normalizeOs(win.__HQ_HOST_OS__) ??
    normalizeOs(osInternals?.platform) ??
    normalizeOs(osInternals?.os_type);
  return { tauri, osPlatform };
}

/**
 * Resolve the host platform from a probe.
 *
 * Note the ordering: the presence of a native shell is checked BEFORE the OS.
 * A browser running on an iPhone reports an iOS-ish environment but has no
 * native shell, so it is the `web` target and must not inherit mobile-native
 * capabilities.
 */
export function resolveHostPlatform(
  probe: HostProbe = readHostProbe(),
): HostPlatform {
  if (!probe.tauri) return "web";
  switch (probe.osPlatform) {
    case "ios":
      return "ios";
    case "android":
      return "android";
    case "macos":
    case "windows":
    case "linux":
      return "desktop";
    default:
      // A native shell we cannot identify is still a native shell. Falling back
      // to "web" here would strip capabilities the host genuinely has.
      return "desktop";
  }
}

/**
 * Which transport the shell talks through: the native command bridge, or the
 * network.
 *
 * The distinction is NOT "is there a native shell". A phone runs one, but
 * `apps/work/src-tauri` is a wrapper with two jobs — host the webview and
 * report the OS — and exposes no commands at all. Routing it to the Sync
 * command adapter is why the first mobile build answered every request with
 * "Cannot read properties of undefined (reading 'invoke')" and rendered
 * "Couldn't load conversations." on an otherwise working shell.
 *
 * A phone also has no HQ checkout, which is why `MOBILE_CAPABILITIES` already
 * says no local files, no sync daemon and no local work-mesh cache. Its data
 * comes from hq-pro over HTTPS, exactly like the web app's.
 */

import type { HostPlatform } from "@hq/platform";

export type WorkRuntime = "desktop" | "web";

export function workRuntimeFor(platform: HostPlatform): WorkRuntime {
  return platform === "desktop" ? "desktop" : "web";
}

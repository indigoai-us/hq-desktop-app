/**
 * Plain-language name for the computer HQ is running on, so onboarding copy
 * does not tell a Windows user we are checking "your Mac".
 *
 * `resolveHostPlatform` collapses macOS/Windows/Linux into one `desktop` value,
 * which is right for capability flags and wrong for the words a person reads.
 * This tiny helper reads the same probe and picks the noun.
 *
 * Never hallucinate a brand: an unknown or missing probe returns the neutral
 * "computer", so the sentence still reads.
 */

import { readHostProbe, type HostProbe } from "./host-platform.js";

export type HostComputerNoun = "Mac" | "PC" | "computer";

/**
 * The everyday name for the box HQ is on: "Mac" for macOS, "PC" for Windows,
 * "computer" for anything else (Linux, unknown, or a probe that hasn't landed
 * yet).
 */
export function hostComputerNoun(
  probe: HostProbe = readHostProbe(),
): HostComputerNoun {
  switch (probe.osPlatform) {
    case "macos":
      return "Mac";
    case "windows":
      return "PC";
    default:
      return "computer";
  }
}

/**
 * "this Mac" / "this PC" / "this computer" - the demonstrative form used in
 * onboarding sentences ("Setup runs on this ___").
 */
export function thisComputerNoun(
  probe: HostProbe = readHostProbe(),
): string {
  return `this ${hostComputerNoun(probe)}`;
}

/**
 * "your Mac" / "your PC" / "your computer" - the possessive form used when the
 * sentence is about the person's machine ("checking your ___").
 */
export function yourComputerNoun(
  probe: HostProbe = readHostProbe(),
): string {
  return `your ${hostComputerNoun(probe)}`;
}

/**
 * Subscribe to `hostComputerNoun` and receive an update once the OS probe
 * lands. On desktop shells that do not inject `__HQ_HOST_OS__` synchronously
 * (`apps/sync` is one — its Tauri window uses the async `tauri-plugin-os`
 * fallback), the first synchronous read returns the neutral "computer" noun,
 * so a Windows person's first render of the New bot panel briefly says
 * "on this computer" instead of "on this PC".
 *
 * This helper fires the callback immediately with whatever the current probe
 * reports, then polls at `intervalMs` until either the noun becomes specific
 * ("Mac" or "PC") or `maxAttempts` is reached — whichever is first. Returns
 * a disposer so a component `$effect` can tear it down on unmount.
 *
 * Non-desktop callers (web, mobile) still get the initial value on the first
 * tick and the poller stops on the first attempt if the probe is already
 * specific. Kept in `@hq/platform` so a test can inject a fake probe.
 */
export function subscribeHostComputerNoun(
  callback: (noun: HostComputerNoun) => void,
  opts: {
    intervalMs?: number;
    maxAttempts?: number;
    read?: () => HostComputerNoun;
    schedule?: (fn: () => void, ms: number) => number;
    cancel?: (handle: number) => void;
  } = {},
): () => void {
  const read = opts.read ?? (() => hostComputerNoun());
  const intervalMs = opts.intervalMs ?? 100;
  const maxAttempts = opts.maxAttempts ?? 40;
  const schedule =
    opts.schedule ??
    ((fn, ms) => setTimeout(fn, ms) as unknown as number);
  const cancel = opts.cancel ?? ((handle) => clearTimeout(handle));

  let attempts = 0;
  let handle: number | null = null;
  let disposed = false;
  let lastNoun: HostComputerNoun | null = null;

  function emit(next: HostComputerNoun): void {
    if (disposed) return;
    if (next === lastNoun) return;
    lastNoun = next;
    callback(next);
  }

  emit(read());
  if (lastNoun !== "computer") return () => {};

  function tick(): void {
    if (disposed) return;
    attempts += 1;
    const next = read();
    emit(next);
    if (next !== "computer") return;
    if (attempts >= maxAttempts) return;
    handle = schedule(tick, intervalMs);
  }

  handle = schedule(tick, intervalMs);

  return () => {
    disposed = true;
    if (handle !== null) cancel(handle);
  };
}

/**
 * Platform-appropriate label for the "primary modifier + Enter" shortcut a
 * form's submit affordance advertises. "⌘↵" on macOS, "Ctrl+Enter" on Windows
 * and Linux. Kept as a single helper so a wizard's hint never renames the key
 * on the machine it is running on.
 */
export function primaryEnterKeyHint(
  probe: HostProbe = readHostProbe(),
): string {
  return probe.osPlatform === "macos" ? "⌘↵" : "Ctrl+Enter";
}

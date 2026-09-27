/**
 * Onboarding-only platform reader.
 *
 * The wizard needs the host OS to tell the truth about how long setup takes
 * ("Building your workspace" can run for 5+ minutes on Windows), but the
 * wizard boots before the shared platform probe is populated: the `main`
 * Tauri window that renders it does not inject `__HQ_HOST_OS__` and does not
 * mount the OS plugin. Rather than take a Tauri-plugin dependency for one
 * subtitle, this helper reads the webview's own `navigator.userAgent`, which
 * inside Tauri reflects the underlying host.
 *
 * Pure: takes the UA string, returns a plain-language name. Callers pass
 * `navigator.userAgent` at render time; tests inject fixture strings.
 */

export type OnboardingHostOs = "windows" | "macos" | "linux" | "unknown";

/** Plain-language name for the machine, from an onboarding-side OS read. */
export type OnboardingHostNoun = "Mac" | "PC" | "computer";

/**
 * Pick the everyday computer noun the wizard shows. The wizard runs in the
 * `main` Tauri window before the OS plugin lands, so it cannot use the shared
 * `@hq/platform` probe. Callers pass the UA-derived OS from
 * `readOnboardingHostOs`; anything not macOS or Windows falls back to the
 * neutral "computer" so a Linux user or a not-ready UA never gets the wrong
 * brand.
 */
export function hostComputerNounFor(os: OnboardingHostOs): OnboardingHostNoun {
  if (os === "windows") return "PC";
  if (os === "macos") return "Mac";
  return "computer";
}

/** "this Mac" / "this PC" / "this computer" for the wizard. */
export function thisComputerNounFor(os: OnboardingHostOs): string {
  return `this ${hostComputerNounFor(os)}`;
}

/** "your Mac" / "your PC" / "your computer" for the wizard. */
export function yourComputerNounFor(os: OnboardingHostOs): string {
  return `your ${hostComputerNounFor(os)}`;
}

/** OS family read from a user-agent string. */
export function readOnboardingHostOs(userAgent: string | null | undefined): OnboardingHostOs {
  const ua = (userAgent ?? "").toLowerCase();
  if (!ua) return "unknown";
  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac os x") || ua.includes("macintosh")) return "macos";
  if (ua.includes("linux") && !ua.includes("android")) return "linux";
  return "unknown";
}

/**
 * Plain-language reassurance under the "Getting your HQ ready" heading. Two
 * short sentences: what to expect for time, and the one truth about Windows
 * (where the Node install + antivirus scan is measurably longer). Never a
 * fake progress bar. Neutral wording when we can't identify the OS, so a
 * Linux user or a botched probe still gets a sensible line.
 */
export function setupExpectationCopy(os: OnboardingHostOs): string {
  switch (os) {
    case "windows":
      return "This usually takes a few minutes. On Windows it can take longer: antivirus scans and background installs run behind the scenes. HQ keeps going even if the line below sits on the same step for a while.";
    case "macos":
      return "This usually takes a couple of minutes. Each step below shows what HQ is doing and how long it has been running.";
    default:
      return "This usually takes a few minutes. Each step below shows what HQ is doing and how long it has been running.";
  }
}

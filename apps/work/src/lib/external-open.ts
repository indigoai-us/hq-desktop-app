/**
 * Browser handoffs from Work's untrusted channel content.
 *
 * This boundary parses every value and allows only credential-free HTTPS URLs.
 * That stops channel content from forwarding script, local-file, custom
 * local-app, or credential-smuggling URLs to window.open or Tauri's shell.
 *
 * Work links include deploy previews, git diffs, and attachments on arbitrary
 * hosts, so this general handoff has no host restriction. Host restrictions
 * belong at narrower source contracts, such as calendar-derived meeting links.
 */
import { tauriInvoke } from "./tauri-invoke.js";

export const WORK_EXTERNAL_LINK_REFUSAL_MESSAGE =
  "This external link is not approved for HQ Work.";

/** Return a normalized HTTPS URL approved for an external Work handoff. */
export function approvedWorkExternalUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password
  ) {
    return null;
  }
  return parsed.toString();
}

/**
 * Open an approved handoff in the platform's external browser. Tauri keeps
 * using its native shell boundary; hosted web preserves window protections.
 */
export function openWorkExternalUrl(
  raw: string,
  runtime: "desktop" | "web",
): void {
  const url = approvedWorkExternalUrl(raw);
  if (!url) throw new Error(WORK_EXTERNAL_LINK_REFUSAL_MESSAGE);
  if (runtime === "desktop") {
    void tauriInvoke("plugin:shell|open", { path: url, with: null }).catch(
      () => {},
    );
    return;
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

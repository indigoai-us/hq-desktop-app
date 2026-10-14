import { describe, expect, it } from "vitest";
import * as flags from "./flags.js";
import { LEGACY_TO_REGISTRY } from "./flags.js";
import desktopAppSource from "../../ui/src/shell/DesktopApp.svelte?raw";

// DesktopApp reads every *_FLAG constant it imports through the hq-flags
// registry (hasFeature, subscribeFeature, hasCompanyFeature, or the rail
// gates). A flag missing from LEGACY_TO_REGISTRY skips the registry and lands
// on the legacy fallback, which for most flags is GET /v1/identity/features,
// a route hq-pro does not serve. That is how desktop.first-run-found-apps-v1
// stayed off for everyone.

// Flags DesktopApp reads that are intentionally fallback-only (no registry
// row). Each entry needs a comment saying why. Empty today.
const FALLBACK_ONLY_FLAGS: ReadonlySet<string> = new Set<string>([]);

const DESKTOP_REGISTRY_FLAGS = [
  "CLAUDE_PROVIDER_FLAG",
  "DESKTOP_AGENT_CREATION_FLAG",
  "FIRST_RUN_FOUND_APPS_FLAG",
  "HUMAN_ONLY_CONVERSATIONS_FLAG",
  "RAIL_ATLAS_FLAG",
  "RAIL_BRIEF_FLAG",
  "RAIL_DEPLOYMENTS_ACTIONS_FLAG",
  "RAIL_OUTPOST_FLAG",
  "RAIL_TELEMETRY_FLAG",
  "RAIL_WORKFORCE_LIMITS_FLAG",
  "READY_FIRST_ACTION_FLAG",
  "VISUAL_FIRST_RUN_FLAG",
] as const;

function flagConstantsIn(source: string): string[] {
  return [...new Set(source.match(/\b[A-Z][A-Z0-9_]*_FLAG\b/g) ?? [])].sort();
}

describe("DesktopApp registry flags", () => {
  it("lists every flag constant DesktopApp reads", () => {
    expect(flagConstantsIn(desktopAppSource)).toEqual([...DESKTOP_REGISTRY_FLAGS].sort());
  });

  it.each(DESKTOP_REGISTRY_FLAGS)("%s resolves from the flag registry", (name) => {
    const value = (flags as Record<string, unknown>)[name];
    expect(typeof value).toBe("string");
    if (FALLBACK_ONLY_FLAGS.has(name)) return;
    expect(Object.keys(LEGACY_TO_REGISTRY)).toContain(value);
  });
});

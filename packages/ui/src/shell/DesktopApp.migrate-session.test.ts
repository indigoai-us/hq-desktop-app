import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * US-017B source contract: DesktopApp wires migrate through workMesh.migrateSession
 * only. No organize/correct/rebind client path may set destinationCompanyUid.
 */
const here = dirname(fileURLToPath(import.meta.url));
const shellSrc = readFileSync(join(here, "DesktopApp.svelte"), "utf8");
const popoverSrc = readFileSync(
  join(here, "../chat/ChannelStatusPopover.svelte"),
  "utf8",
);
const atlasSrc = readFileSync(join(here, "../atlas/AtlasPage.svelte"), "utf8");

describe("DesktopApp migrate session source contract", () => {
  it("shell owns MigrateSessionDialog and calls workMesh.migrateSession", () => {
    expect(shellSrc).toContain("MigrateSessionDialog");
    expect(shellSrc).toContain("adapter.workMesh.migrateSession");
    expect(shellSrc).toContain("canMigrateCompanySession");
    expect(shellSrc).toContain("digestMigratePayload");
    expect(shellSrc).toContain("onmigratesession");
    expect(shellSrc).not.toMatch(/organizeSession|correctSession|rebindSession/);
  });

  it("popover and Atlas raise intent only — no confirm dialog inside", () => {
    expect(popoverSrc).toContain("onmigratesession");
    expect(popoverSrc).toContain("Move to another company");
    expect(popoverSrc).not.toContain("MigrateSessionDialog");
    expect(popoverSrc).not.toContain("workMesh.migrateSession");
    expect(atlasSrc).toContain("onmigratesession");
    expect(atlasSrc).toContain("Move to another company");
    expect(atlasSrc).not.toContain("MigrateSessionDialog");
    expect(atlasSrc).not.toContain("workMesh.migrateSession");
  });

  it("destinationCompanyUid appears only on the migrate submit path in the shell", () => {
    const hits = [...shellSrc.matchAll(/destinationCompanyUid/g)];
    expect(hits.length).toBeGreaterThan(0);
    expect(shellSrc).toContain("destinationCompanyUid: dest");
    expect(popoverSrc.match(/destinationCompanyUid/g) ?? []).toEqual([]);
    expect(atlasSrc.match(/destinationCompanyUid/g) ?? []).toEqual([]);
  });
});

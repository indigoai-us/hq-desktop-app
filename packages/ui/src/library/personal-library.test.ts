import { describe, expect, it } from "vitest";
import {
  activeGrants,
  filesForSection,
  libraryFolderTree,
  personalLibraryFixture,
  sharedGrantPreview,
} from "./personal-library.js";
import { deploymentFromApp, filterDeployments, formatViews, loadDeployments, progressFor } from "./personal-deployments.js";
import { deployAppsFixture, FIXTURE_CALLER_SUB } from "./personal-deployments.fixture.js";

describe("personal library (US-031)", () => {
  it("shows the selected shared file in the preview model", () => {
    const cache = personalLibraryFixture();
    const active = activeGrants(cache.grants);
    expect(active).toHaveLength(3);
    const selected = sharedGrantPreview(cache.grants, "billing");
    expect(selected?.name).toBe("agent-billing-seams.md");
    expect(selected?.preview).toContain("Agent billing seams");
    expect(selected?.access).toBe("read");
  });

  it("nests files under expandable folders", () => {
    const tree = libraryFolderTree(personalLibraryFixture().files);
    const personal = tree.find((node) => node.name === "personal");
    expect(personal?.file).toBeNull();
    expect(personal?.children.some((child) => child.name === "projects")).toBe(true);
    const knowledge = personal?.children.find((child) => child.name === "knowledge");
    expect(knowledge?.children.some((child) => child.file?.id === "voice")).toBe(true);
  });

  it("keeps starred files as a subset of my files", () => {
    const cache = personalLibraryFixture();
    expect(filesForSection(cache, "mine").length).toBeGreaterThan(
      filesForSection(cache, "starred").length,
    );
  });
});

describe("personal deployments (US-031)", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  const scopes = [
    { id: "personal", label: "Personal" },
    { id: "indigo", label: "Indigo" },
  ];

  it("maps raw hq-deploy apps and keeps null views as unavailable", () => {
    const row = deploymentFromApp(
      { id: "x", name: "app-x", subdomain: "app-x", url: "https://app-x.indigo-hq.com", status: "active", active: true, accessMode: "company", ownerId: "me", views30d: null, lastVisitAt: "2026-10-02T11:57:00Z", createdAt: "2026-10-01T12:00:00Z" },
      { id: "indigo", label: "Indigo" },
      "me",
      now,
    )!;
    expect(row.views30d).toBeNull();
    expect(formatViews(row.views30d)).toBe("—");
    expect(row.access).toBe("Company");
    expect(row.lastVisit).toBe("3m ago");
    expect(row.byYou).toBe(true);
    expect(row.host).toBe(".indigo-hq.com");
    expect(row.detail).toBe("deployed 1d ago by you");
    expect(row.scope).toBe("company");
  });

  it("marks deactivated apps and falls back to legacy access flags", () => {
    const row = deploymentFromApp(
      { id: "y", subdomain: "app-y", active: false, passwordProtected: true },
      { id: "personal", label: "Personal" },
      null,
      now,
    )!;
    expect(row.status).toBe("deactivated");
    expect(row.access).toBe("Password");
    expect(row.scopeLabel).toBe("Personal");
    expect(row.byYou).toBe(false);
  });

  it("merges every scope and survives one failing scope", async () => {
    const load = await loadDeployments(
      async (scope) => {
        if (scope === "indigo") throw new Error("offline");
        return deployAppsFixture(scope, now);
      },
      scopes,
      now,
    );
    expect(load.failed).toEqual(["indigo"]);
    expect(load.cache.rows.map((r) => r.name)).toEqual(["cut30-week-41", "rail-idea-v1", "telemetry-sep-export"]);
  });

  it("filters real rows by status, scope and owner", async () => {
    const { cache } = await loadDeployments(async (scope) => deployAppsFixture(scope, now), scopes, now);
    const rows = cache.rows;
    expect(rows).toHaveLength(6);
    expect(filterDeployments(rows, "sleeping", "").map((r) => r.name)).toEqual(["telemetry-sep-export"]);
    expect(filterDeployments(rows, "deactivated", "").map((r) => r.name)).toEqual(["rail-idea-v1"]);
    expect(filterDeployments(rows, "scope-company", "")).toHaveLength(3);
    expect(filterDeployments(rows, "by-you", "").some((r) => r.name === "indigo-standup-report")).toBe(false);
    expect(filterDeployments(rows, "all", "cut30").map((r) => r.name)).toEqual(["cut30-week-41"]);
    expect(rows.every((r) => r.byYou === (r.name !== "indigo-standup-report"))).toBe(true);
    expect(FIXTURE_CALLER_SUB).toBeTruthy();
  });

  it("keeps the old build serving while a real row is deploying", () => {
    const row = { ...deploymentFromApp({ id: "d", subdomain: "d", status: "deploying" }, scopes[0]!, null, now)!, step: 3, liveVersion: "v4", nextVersion: "v5" };
    const progress = progressFor(row);
    expect(progress.step).toBe(3);
    expect(progress.serving).toBe("v4");
    expect(progress.swapped).toBe(false);
  });
});

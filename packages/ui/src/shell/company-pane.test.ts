import { describe, expect, it } from "vitest";

import {
  COMPANY_PANE_ROW_IDS,
  companyPageId,
  companyPagePlaceholderForPage,
  companyPaneModel,
  companyRowDestination,
  companyRowForPage,
} from "./company-pane.js";
import { activeRailItemId } from "./app-rail.js";
import { flattenSections } from "./sidepane-models.js";

const summary = { board: 7, activity: { last7d: 12 }, deployments: 3, secrets: 0 };

describe("company sidepane (console-rail US-007)", () => {
  it("lists all 15 rows in the decided groups with Company settings in the footer", () => {
    const model = companyPaneModel({ uid: "co_indigo", label: "Indigo", liveCount: 4 }, null, null);
    const rows = flattenSections(model.sections);
    expect(rows.filter((i) => i.type === "section").map((i) => i.type === "section" && i.label)).toEqual([
      "People",
      "Brain",
      "Files and connect",
    ]);
    expect(rows.flatMap((i) => (i.type === "row" ? [i.row.label] : []))).toEqual([
      "Atlas", "Projects", "Activity", "Goals",
      "Team", "Bots",
      "Knowledge", "Policies", "Skills", "Workers",
      "Vault", "Integrations", "Secrets", "Deployments",
    ]);
    expect(model.footerRow?.label).toBe("Company settings");
    expect(COMPANY_PANE_ROW_IDS).toHaveLength(15);
  });

  it("fills row counts from the cached summary and the live count on Atlas", () => {
    const model = companyPaneModel({ uid: "co", label: "Indigo", liveCount: 4 }, summary, "projects");
    const byId = new Map(model.sections.flatMap((s) => s.rows).map((r) => [r.id, r]));
    expect(byId.get("projects")?.count).toBe(7);
    expect(byId.get("activity")?.count).toBe(12);
    expect(byId.get("deployments")?.count).toBe(3);
    expect(byId.get("secrets")?.count).toBeUndefined();
    expect(byId.get("atlas")?.count).toBe(4);
    expect(byId.get("atlas")?.live).toBe(true);
    expect(model.liveCount).toBe(4);
    expect(model.selectedId).toBe("projects");
  });

  it("routes every row to a company page with a placeholder until it is built", () => {
    for (const id of COMPANY_PANE_ROW_IDS) {
      const dest = companyRowDestination(id, "co");
      expect(dest).toEqual({ kind: "extra", page: companyPageId(id), companyUid: "co" });
      expect(companyRowForPage(companyPageId(id))).toBe(id);
      const placeholder = companyPagePlaceholderForPage(companyPageId(id));
      expect(placeholder?.id).toBe(id);
      expect(placeholder?.story).toMatch(/^US-\d{3}$/);
    }
    expect(companyPagePlaceholderForPage("company-page-nope")).toBeNull();
    expect(companyRowForPage("rail-telemetry")).toBeNull();
  });

  it("keeps the company tile selected on company pages", () => {
    expect(
      activeRailItemId({
        view: "extra",
        tenantCompanyId: "co",
        extraPageId: companyPageId("workers"),
        settingsSection: null,
      }),
    ).toBe("company:co");
  });
});

import { describe, expect, it } from "vitest";

import {
  COMPANY_PANE_ROW_IDS,
  companyPageId,
  companyPagePlaceholderForPage,
  companyPaneModel,
  companyProjectsDestination,
  companyProjectsFocus,
  companyRowDestination,
  companyRowForPage,
} from "./company-pane.js";
import { activeRailItemId } from "./app-rail.js";
import { flattenSections } from "./sidepane-models.js";

const summary = { board: 7, activity: { last7d: 12 }, deployments: 3, secrets: 0 };

describe("company sidepane (console-rail US-007)", () => {
  // OWNER-R24: Groups and Grants sit under People, a Settings heading holds
  // General, Brand and Billing, and there is no Company settings footer.
  it("lists every row in the decided groups, Settings last, and no footer (OWNER-R24)", () => {
    const model = companyPaneModel({ uid: "co_indigo", label: "Indigo", liveCount: 4 }, null, null, {}, true);
    const rows = flattenSections(model.sections);
    expect(rows.filter((i) => i.type === "section").map((i) => i.type === "section" && i.label)).toEqual([
      "People",
      "Brain",
      "Files and connect",
      "Settings",
    ]);
    expect(rows.flatMap((i) => (i.type === "row" ? [i.row.label] : []))).toEqual([
      "Atlas", "Projects", "Activity",
      "Team", "Bots", "Groups", "Grants",
      "Knowledge", "Policies", "Skills", "Workers",
      "Vault", "Integrations", "Secrets", "Deployments",
      "General", "Brand", "Billing",
    ]);
    expect(model.footerRow).toBeNull();
    expect(COMPANY_PANE_ROW_IDS).toHaveLength(18);
  });

  it("hides Grants and Billing from people who cannot open them (OWNER-R24)", () => {
    const model = companyPaneModel({ uid: "co", label: "Indigo", liveCount: 0 }, null, null, {}, false);
    const ids = model.sections.flatMap((s) => s.rows.map((r) => r.id));
    expect(ids).not.toContain("grants");
    expect(ids).not.toContain("billing");
    expect(ids).toContain("groups");
    expect(ids).toContain("general");
    expect(ids).toContain("brand");
  });

  it("old Company settings routes redirect to the pane they pointed at (OWNER-R24)", () => {
    expect(companyRowForPage("company-page-company-settings")).toBe("general");
    expect(companyRowForPage("company-page-workforce")).toBe("billing");
    expect(companyRowDestination("company-settings", "co")).toEqual({ kind: "extra", page: "company-page-general", companyUid: "co" });
  });

  it("drops Goals from the sidebar and sends saved Goals links to Atlas", () => {
    expect(COMPANY_PANE_ROW_IDS).not.toContain("goals");
    expect(companyRowForPage("company-page-goals")).toBe("atlas");
    expect(companyPageId("goals")).toBe("company-page-atlas");
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
      expect(placeholder?.story).toMatch(/^(US-\d{3}|OWNER-R24)$/);
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

describe("companyPaneCounts with a partial summary (US-039)", () => {
  it("reads missing counts as zero instead of throwing", async () => {
    const { companyPaneCounts } = await import("./company-pane.js");
    expect(companyPaneCounts({} as never)).toEqual({
      projects: 0,
      activity: 0,
      deployments: 0,
      secrets: 0,
    });
  });
});

describe("company pane project count scope (QA-006)", () => {
  it("labels the Projects count as the company board so it is not read as the local page count", () => {
    const model = companyPaneModel({ uid: "co", label: "Indigo", liveCount: 0 }, summary, null);
    const row = model.sections.flatMap((s) => s.rows).find((r) => r.id === "projects");
    expect(row?.count).toBe(7);
    expect(row?.countScope).toBe("7 on the company board");
  });
});

describe("companyProjectsDestination", () => {
  it("opens the company Projects row, optionally on one project and tab", () => {
    expect(companyProjectsDestination("co_a")).toEqual({ kind: "extra", page: "company-page-projects", companyUid: "co_a" });
    const dest = companyProjectsDestination("co_a", "billing v2", "tasks");
    expect(dest).toEqual({ kind: "extra", page: "company-page-projects", companyUid: "co_a", param: "project=billing+v2&tab=tasks" });
    expect(dest.kind === "extra" && companyProjectsFocus(dest.param)).toEqual({ project: "billing v2", tab: "tasks" });
  });

  it("reads no focus from an empty or unrelated param", () => {
    expect(companyProjectsFocus(null)).toBeNull();
    expect(companyProjectsFocus("")).toBeNull();
    expect(companyProjectsFocus("tab=tasks")).toBeNull();
    expect(companyProjectsFocus("project=x&tab=bogus")).toEqual({ project: "x", tab: null });
  });
});

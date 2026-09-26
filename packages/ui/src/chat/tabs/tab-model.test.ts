import { describe, expect, it } from "vitest";

import {
  COMPANY_CHANNEL_TABS,
  companyChannelTabsFor,
  isCompanyTabSurfaceId,
} from "./tab-model.js";

describe("COMPANY_CHANNEL_TABS", () => {
  it("lists Projects right after Chat", () => {
    expect(COMPANY_CHANNEL_TABS.map((t) => t.id)).toEqual([
      "chat",
      "projects",
    ]);
    expect(COMPANY_CHANNEL_TABS[1]).toEqual({ id: "projects", label: "Projects" });
  });

  it("is offered by companyChannelTabsFor", () => {
    const tabs = companyChannelTabsFor();
    expect(tabs.map((t) => t.id)).toContain("projects");
  });

  it("is not a company-tab-endpoint surface", () => {
    expect(isCompanyTabSurfaceId("projects")).toBe(false);
    expect(isCompanyTabSurfaceId("chat")).toBe(false);
    expect(isCompanyTabSurfaceId("office")).toBe(false);
  });
});

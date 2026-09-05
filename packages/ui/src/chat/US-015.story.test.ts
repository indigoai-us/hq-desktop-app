/**
 * US-015: company channel tabs + Team tab.
 */
import { describe, expect, it } from "vitest";
import {
  COMPANY_CHANNEL_TABS,
  needsInlineConfirm,
  parseCompanyTab,
} from "./tabs/tab-model.js";
import { parseLifecycleCard } from "./messaging/channelMessageModels.js";

describe("US-015: Company channel tabs and the Team tab", () => {
  it("exposes Chat · Atlas · Team · Integrations · Settings in that order", () => {
    expect(COMPANY_CHANNEL_TABS.map((t) => t.label)).toEqual([
      "Chat",
      "Atlas",
      "Team",
      "Integrations",
      "Settings",
    ]);
  });

  it("parses tab_row cards from the tabs GET payload", () => {
    const model = parseCompanyTab({
      tab: "team",
      companyUid: "cmp_acme",
      viewer: { canAct: true, role: "owner" },
      sections: [
        {
          id: "humans",
          title: "Humans · 1",
          rows: [
            {
              v: 1,
              type: "lifecycle_card",
              cardId: "team:invite",
              kind: "tab_row",
              companyUid: "cmp_acme",
              state: "open",
              fields: [
                { id: "email", label: "Invite by email", control: "text" },
              ],
              actions: [{ id: "invite", label: "Invite", style: "primary" }],
              viewer: { canAct: true },
            },
          ],
        },
      ],
    });
    expect(model?.sections[0]?.rows[0]?.cardKind).toBe("tab_row");
    expect(model?.sections[0]?.rows[0]?.cardId).toBe("team:invite");
  });

  it("requires inline confirm for remove and owner role changes", () => {
    const row = parseLifecycleCard({
      v: 1,
      type: "lifecycle_card",
      cardId: "team:agent:agt_1",
      kind: "tab_row",
      companyUid: "cmp_a",
      state: "open",
      fields: [{ id: "role", label: "Role", control: "select", value: "member" }],
      actions: [{ id: "remove", label: "Remove", style: "secondary" }],
      viewer: { canAct: true },
    });
    if (!row) throw new Error("row");
    expect(needsInlineConfirm(row, "remove", {})).toBe(true);
    expect(needsInlineConfirm(row, "set_role", { role: "owner" })).toBe(true);
    expect(needsInlineConfirm(row, "invite", {})).toBe(false);
  });
});

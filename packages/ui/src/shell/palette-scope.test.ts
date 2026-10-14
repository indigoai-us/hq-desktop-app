import { describe, expect, it } from "vitest";

import {
  PALETTE_SCOPE_IDS,
  conversationPaletteSection,
  createAsNewItems,
  itemInPaletteScope,
  nextPaletteScope,
  paletteScopeLabel,
} from "./palette-rows.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

function row(patch: Partial<ConversationRow>): ConversationRow {
  return {
    id: "ch:1",
    kind: "channel",
    title: "atlas",
    companyUid: "cmp_indigo",
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
    ...patch,
  } as ConversationRow;
}

describe("US-020 palette scopes", () => {
  it("chips are Indigo, All companies, Personal, Vault only and tab walks them", () => {
    expect(PALETTE_SCOPE_IDS).toEqual(["company", "all", "personal", "vault"]);
    expect(paletteScopeLabel("company", "Indigo")).toBe("Indigo");
    expect(paletteScopeLabel("all", "Indigo")).toBe("All companies");
    expect(paletteScopeLabel("personal", "Indigo")).toBe("Personal");
    expect(paletteScopeLabel("vault", "Indigo")).toBe("Vault only");
    expect(nextPaletteScope("company")).toBe("all");
    expect(nextPaletteScope("vault")).toBe("company");
    expect(nextPaletteScope("company", -1)).toBe("vault");
  });

  it("company scope hides other companies; vault is files only", () => {
    const indigo = {
      section: "channels" as const,
      companyUid: "cmp_indigo",
    };
    const other = {
      section: "channels" as const,
      companyUid: "cmp_other",
    };
    const file = { section: "files" as const, companyUid: "cmp_indigo" };
    expect(itemInPaletteScope(indigo, "company", "cmp_indigo")).toBe(true);
    expect(itemInPaletteScope(other, "company", "cmp_indigo")).toBe(false);
    expect(itemInPaletteScope(other, "all", "cmp_indigo")).toBe(true);
    expect(itemInPaletteScope(file, "vault", "cmp_indigo")).toBe(true);
    expect(itemInPaletteScope(indigo, "vault", "cmp_indigo")).toBe(false);
  });

  it("people, channels, and projects land in their sections", () => {
    expect(conversationPaletteSection(row({ kind: "dm", companyUid: null }))).toBe(
      "people",
    );
    expect(conversationPaletteSection(row({ kind: "channel" }))).toBe("channels");
  });

  it("no matches yield Create as new rows", () => {
    const rows = createAsNewItems("stripe webhook", "Indigo", {
      askName: "deacon",
    });
    expect(rows.map((r) => r.kind)).toEqual([
      "project",
      "channel",
      "note",
      "ask",
      "search-all",
    ]);
    expect(rows[0]?.label).toContain("stripe webhook");
    expect(rows[1]?.label).toContain("#stripe-webhook");
    expect(rows.find((r) => r.section === "create")).toBeTruthy();
    expect(createAsNewItems("   ", "Indigo")).toEqual([]);
  });
});

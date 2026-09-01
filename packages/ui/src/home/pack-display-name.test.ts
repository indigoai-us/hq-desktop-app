import { describe, expect, it } from "vitest";
import {
  PACK_DISPLAY_NAMES,
  packDisplayName,
  prettifyPackName,
} from "./pack-display-name";

describe("prettifyPackName", () => {
  it("strips hq-pack- and title-cases", () => {
    expect(prettifyPackName("hq-pack-client-service")).toBe("Client Service");
    expect(prettifyPackName("hq-pack-design-engineering")).toBe(
      "Design Engineering",
    );
    expect(prettifyPackName("hq-pack-work-mesh")).toBe("Work Mesh");
  });

  it("keeps minor words lowercase except when leading", () => {
    expect(prettifyPackName("hq-pack-tools-for-the-team")).toBe(
      "Tools for the Team",
    );
    expect(prettifyPackName("the-pack")).toBe("The Pack");
  });

  it("handles an hq- prefix and underscores", () => {
    expect(prettifyPackName("hq_agent_browser")).toBe("Agent Browser");
  });

  it("returns empty string for empty / whitespace input", () => {
    expect(prettifyPackName("")).toBe("");
    expect(prettifyPackName("   ")).toBe("");
  });

  it("returns empty string for separator-only garbage", () => {
    expect(prettifyPackName("---")).toBe("");
    expect(prettifyPackName("___")).toBe("");
  });
});

describe("packDisplayName precedence", () => {
  it("prefers a trimmed explicit displayName", () => {
    expect(
      packDisplayName({
        name: "hq-pack-impeccable",
        displayName: "Custom Brand Name",
      }),
    ).toBe("Custom Brand Name");
    expect(
      packDisplayName({
        name: "hq-pack-crm",
        displayName: "  Hosted CRM  ",
      }),
    ).toBe("Hosted CRM");
  });

  it("falls through whitespace / null displayName to the curated map", () => {
    expect(
      packDisplayName({ name: "hq-pack-crm", displayName: "   " }),
    ).toBe("CRM");
    expect(packDisplayName({ name: "hq-pack-crm", displayName: null })).toBe(
      "CRM",
    );
    expect(packDisplayName({ name: "gstack" })).toBe("gStack");
    expect(PACK_DISPLAY_NAMES.crm).toBe("CRM");
  });

  it("derives a title-cased name when the slug is not curated", () => {
    expect(packDisplayName({ name: "hq-pack-client-service" })).toBe(
      "Client Service",
    );
    expect(packDisplayName({ name: "hq-pack-design-engineering" })).toBe(
      "Design Engineering",
    );
    expect(packDisplayName({ name: "hq-pack-work-mesh" })).toBe("Work Mesh");
  });

  it("falls back to the raw name and never returns blank for a non-empty name", () => {
    expect(packDisplayName({ name: "---" })).toBe("---");
    expect(packDisplayName({ name: "___" })).toBe("___");
    expect(packDisplayName({ name: "   " })).toBe("   ");
    expect(packDisplayName({ name: "---" })).not.toBe("");
  });
});

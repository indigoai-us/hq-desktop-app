import { describe, expect, it } from "vitest";
import {
  hasProvenance,
  mergeProvenance,
  normalizeProvenance,
  provenanceView,
  responsiblePerson,
} from "./provenance";

describe("work provenance normalization", () => {
  it("normalizes modern nested provenance and legacy aliases without fabricating values", () => {
    expect(
      normalizeProvenance({
        provenance: {
          owner: { displayName: "Maya Chen" },
          assignee: { email: "ada@example.com" },
          creator: { name: "Corey" },
          origin: "Linear import",
        },
      }),
    ).toEqual({
      owner: "Maya Chen",
      assignee: "ada@example.com",
      creator: "Corey",
      origin: "Linear import",
    });

    expect(
      normalizeProvenance({
        owner_name: "  Priya  ",
        assigned_to: { handle: "@jules" },
        createdByName: "Lee",
        source: "  local PRD  ",
      }),
    ).toEqual({
      owner: "Priya",
      assignee: "@jules",
      creator: "Lee",
      origin: "local PRD",
    });
  });

  it("falls through field-by-field and ignores blank or opaque objects", () => {
    expect(
      normalizeProvenance(
        { owner: " ", creator: { uid: "opaque-only" }, origin: "" },
        { owner: "Nora", creator: { email: "nora@example.com" }, source: "HQ" },
      ),
    ).toEqual({
      owner: "Nora",
      assignee: null,
      creator: "nora@example.com",
      origin: "HQ",
    });
  });

  it("merges local-first provenance with a cloud fallback independently", () => {
    const local = normalizeProvenance({ owner: "Maya", origin: "Local PRD" });
    const cloud = normalizeProvenance({
      creator: "Corey",
      origin: "Cloud board",
    });
    expect(mergeProvenance(local, cloud)).toEqual({
      owner: "Maya",
      assignee: null,
      creator: "Corey",
      origin: "Local PRD",
    });
    expect(hasProvenance(mergeProvenance(undefined, cloud))).toBe(true);
    expect(hasProvenance(normalizeProvenance({}))).toBe(false);
  });
});

describe("work provenance display", () => {
  it("shows every asserted role and the asserted source", () => {
    const value = normalizeProvenance({
      owner: "Maya",
      assignee: "Ada",
      creator: "Corey",
      origin: "Linear",
    });
    expect(provenanceView(value, "story")).toEqual({
      people: [
        { role: "Assignee", label: "Ada" },
        { role: "Owner", label: "Maya" },
        { role: "Created by", label: "Corey" },
      ],
      origin: "Source Linear",
      ariaLabel: "Assignee Ada · Owner Maya · Created by Corey · Source Linear",
    });
    expect(responsiblePerson(value, "story")).toBe("Ada");
    expect(responsiblePerson(value, "project")).toBe("Maya");
  });

  it("uses honest fallbacks when no person or source exists", () => {
    expect(provenanceView(undefined, "project")).toEqual({
      people: [],
      origin: "Unknown source",
      ariaLabel: "Unknown source",
    });
    expect(responsiblePerson(undefined, "project")).toBe("Unassigned");
  });

  it("uses creator as the responsibility fallback without relabeling them as owner", () => {
    const value = normalizeProvenance({ creator: "Corey" });
    expect(provenanceView(value, "project").people).toEqual([
      { role: "Created by", label: "Corey" },
    ]);
    expect(responsiblePerson(value, "project")).toBe("Corey");
  });

  it("keeps a project assignee truthful instead of dropping or relabeling them", () => {
    const value = normalizeProvenance({ assignee: "Ada" });
    expect(provenanceView(value, "project").people).toEqual([
      { role: "Assignee", label: "Ada" },
    ]);
    expect(responsiblePerson(value, "project")).toBe("Ada");
  });

  it("distinguishes a failed attribution lookup from genuinely unknown attribution", () => {
    expect(provenanceView(undefined, "project", true)).toEqual({
      people: [],
      origin: "Attribution unavailable",
      ariaLabel: "Attribution unavailable",
    });
    expect(provenanceView(undefined, "project").origin).toBe("Unknown source");
    expect(
      provenanceView(
        normalizeProvenance({ origin: "Local PRD" }),
        "project",
        true,
      ).origin,
    ).toBe("Source Local PRD");
  });
});

import { describe, expect, it } from "vitest";
import { displayTitle } from "./display-title.js";

describe("QA-056 displayTitle", () => {
  it("shows the alias of an aliased wiki link", () => {
    expect(
      displayTitle(
        "Build Your Own AGI — Print [[ontology/entities/project/content-production-workflow|Production Pipeline]]",
      ),
    ).toBe("Build Your Own AGI — Print Production Pipeline");
  });

  it("handles several wiki links in one title", () => {
    expect(
      displayTitle(
        "[[ontology/entities/company/indigo|getindigo.ai]] — Domain ↔ [[ontology/entities/company/vercel|Vercel]] Project Map",
      ),
    ).toBe("getindigo.ai — Domain ↔ Vercel Project Map");
  });

  it("uses the humanised last path segment when there is no alias", () => {
    expect(displayTitle("See [[ontology/entities/project/content-production-workflow]]")).toBe(
      "See content production workflow",
    );
    expect(displayTitle("[[notes/team_roster.md#Leads]]")).toBe("team roster");
  });

  it("collapses markdown links to their text", () => {
    expect(displayTitle("Read [the guide](https://example.com/guide) first")).toBe(
      "Read the guide first",
    );
  });

  it("leaves plain titles alone", () => {
    expect(displayTitle("Quarterly plan")).toBe("Quarterly plan");
  });
});

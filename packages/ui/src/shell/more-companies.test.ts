import { describe, expect, it } from "vitest";

import {
  moreCompaniesSections,
  pinCompany,
  replacePinnedCompany,
  unpinCompany,
} from "./more-companies.js";
import type { MoreCompany } from "./more-companies.js";

function company(uid: string, name: string, slug = uid): MoreCompany {
  return { uid, name, slug, liveCount: 0 };
}

const roster: MoreCompany[] = [
  company("co_in", "Indigo", "indigo"),
  company("co_lr", "LiveRecover", "liverecover"),
  company("co_sa", "Sender Agency", "sender"),
  company("co_rc", "Restore Colorado", "restore"),
  ...Array.from({ length: 4 }, (_, i) => company(`co_${i}`, `Extra ${i}`, `extra-${i}`)),
];

describe("more companies (US-005)", () => {
  it("filters by name and slug without dropping the section counts", () => {
    const view = moreCompaniesSections(
      roster,
      ["co_in", "co_lr"],
      ["co_sa", "co_rc"],
      "restore",
    );
    expect(view.pinned).toEqual([]);
    expect(view.recent.map((c) => c.uid)).toEqual(["co_rc"]);
    expect(view.all).toEqual([]);
    expect(view.matchCount).toBe(1);
    expect(view.pinnedCount).toBe(2);

    const bySlug = moreCompaniesSections(roster, [], [], "sender");
    expect(bySlug.all.map((c) => c.name)).toEqual(["Sender Agency"]);
  });

  it("lists pinned, then recent that are not pinned, then the rest", () => {
    const view = moreCompaniesSections(
      roster,
      ["co_in", "co_lr"],
      ["co_in", "co_sa"],
      "",
    );
    expect(view.pinned.map((c) => c.uid)).toEqual(["co_in", "co_lr"]);
    expect(view.recent.map((c) => c.uid)).toEqual(["co_sa"]);
    expect(view.all.map((c) => c.uid)).not.toContain("co_in");
    expect(view.all.map((c) => c.uid)).not.toContain("co_sa");
    expect(view.matchCount).toBe(roster.length);
  });

  it("asks which tile to replace when a seventh company is pinned", () => {
    const six = ["a", "b", "c", "d", "e", "f"];
    expect(pinCompany(six, "g")).toEqual({ status: "replace", ids: six });
    expect(pinCompany(["a", "b"], "c")).toEqual({
      status: "pinned",
      ids: ["a", "b", "c"],
    });
    expect(pinCompany(six, "a").status).toBe("unchanged");
    const replaced = replacePinnedCompany(six, "c", "g");
    expect(replaced).toEqual(["a", "b", "g", "d", "e", "f"]);
    expect(replaced).toHaveLength(6);
    expect(unpinCompany(replaced, "g")).toEqual(["a", "b", "d", "e", "f"]);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  entriesFromDirectory,
  filterPickerEntries,
  loadPickerRoster,
  readPickerRoster,
} from "./people-picker.js";

describe("people picker company roster (QA-054)", () => {
  it("lists every company member, not only DM contacts, and searches name and email", async () => {
    const listCompanyMembers = vi.fn(async (companyUid: string) => ({
      contacts: [
        { personUid: "prs_corey", displayName: "Corey Epstein", email: "corey@vyg.ai" },
        { personUid: "prs_amy", displayName: "Amy", email: "amy@getindigo.ai" },
      ].map((row) => ({ ...row, companyUid: companyUid === "cmp_indigo" ? undefined : companyUid })),
    }));
    const api = { listCompanyMembers, listContacts: vi.fn() };

    expect(readPickerRoster("cmp_indigo")).toEqual([]);
    const roster = await loadPickerRoster(api, "cmp_indigo");
    expect(listCompanyMembers).toHaveBeenCalledWith("cmp_indigo");
    expect(api.listContacts).not.toHaveBeenCalled();
    expect(readPickerRoster("cmp_indigo")).toEqual(roster);

    const entries = entriesFromDirectory({ rows: [], contacts: [], roster });
    expect(filterPickerEntries(entries, "", "cmp_indigo").map((e) => e.id)).toEqual([
      "prs_corey",
      "prs_amy",
    ]);
    expect(filterPickerEntries(entries, "Corey", "cmp_indigo").map((e) => e.id)).toEqual(["prs_corey"]);
    expect(filterPickerEntries(entries, "amy@getindigo", "cmp_indigo").map((e) => e.id)).toEqual(["prs_amy"]);
    expect(filterPickerEntries(entries, "", "cmp_other")).toEqual([]);
  });

  it("falls back to company-scoped contacts and keeps the cache when a refresh fails", async () => {
    const listContacts = vi.fn(async () => ({
      contacts: [{ personUid: "prs_eric", displayName: "Eric", email: "eric@vyg.ai" }],
    }));
    const first = await loadPickerRoster({ listContacts }, "cmp_amass");
    expect(listContacts).toHaveBeenCalledWith({ companyUid: "cmp_amass" });
    expect(first[0].companyUid).toBe("cmp_amass");

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = { listContacts: vi.fn(async () => { throw new Error("offline"); }) };
    expect(await loadPickerRoster(failing, "cmp_amass")).toEqual(first);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

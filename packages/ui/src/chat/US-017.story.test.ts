import { describe, expect, it } from "vitest";
import { CREATE_MENU_ITEMS, createMenuHasCompany } from "./create-menu.js";
import {
  channelPathPreview,
  entriesFromDirectory,
  filterPickerEntries,
  groupPickerEntries,
  togglePickerId,
} from "./people-picker.js";
import type { ConversationRow } from "./sidebar-model.js";

describe("US-017 create menu and people picker", () => {
  it("offers New message, New channel, and New agent with the storyboard shortcuts", () => {
    expect(CREATE_MENU_ITEMS.map((item) => [item.label, item.keys])).toEqual([
      ["New message", "Mod+Shift+K"],
      ["New channel", "Mod+Shift+N"],
      ["New bot", "Mod+Alt+N"],
    ]);
    expect(createMenuHasCompany()).toBe(false);
  });

  it("groups People, Groups, Agents, and Guests and toggles selection", () => {
    const row: ConversationRow = {
      id: "dm:prs_eric",
      kind: "dm",
      title: "Eric Barbosa",
      companyUid: "cmp_indigo",
      unreadDot: false,
      lastActivityAt: 1,
      pinned: false,
      personUid: "prs_eric",
      email: "eric@vyg.ai",
    };
    const entries = entriesFromDirectory({
      rows: [row],
      contacts: [{ personUid: "agt_deacon", displayName: "deacon", companyUid: "cmp_indigo" }],
      groups: [{
        id: "grp_eng",
        kind: "group",
        name: "engineering",
        detail: "5 people",
        meta: "",
        live: false,
        companyUid: "cmp_indigo",
      }],
      guests: [{
        id: "gst_yousuf",
        kind: "guest",
        name: "Yousuf",
        detail: "guest",
        meta: "has read",
        live: false,
        companyUid: "cmp_indigo",
      }],
    });
    expect(groupPickerEntries(entries).map((section) => section.label)).toEqual([
      "People",
      "Groups",
      "Bots",
      "Guests",
    ]);
    expect(togglePickerId(["prs_eric"], "agt_deacon")).toEqual(["prs_eric", "agt_deacon"]);
    expect(togglePickerId(["prs_eric"], "prs_eric")).toEqual([]);
  });

  it("narrows channel member choices to the selected company (QA-018)", () => {
    const entries = entriesFromDirectory({
      rows: [],
      contacts: [
        { personUid: "prs_eric", displayName: "Eric", companyUid: "cmp_indigo" },
        { personUid: "prs_eric", displayName: "Eric", companyUid: "cmp_amass" },
        { personUid: "prs_amy", displayName: "Amy", companyUid: "cmp_amass" },
        { personUid: "agt_sender", displayName: "sender bot", companyUid: "cmp_sender" },
        { personUid: "prs_loose", displayName: "Loose", companyUid: null },
      ],
    });
    const names = (uid: string) =>
      filterPickerEntries(entries, "", uid).map((entry) => entry.name).sort();
    expect(names("cmp_indigo")).toEqual(["Eric"]);
    expect(names("cmp_amass")).toEqual(["Amy", "Eric"]);
    expect(names("cmp_sender")).toEqual(["sender bot"]);
  });

  it("previews the channel path from the company label and the typed name", () => {
    expect(channelPathPreview("Indigo", "Cost Desktop Push")).toBe(
      "companies/indigo/channels/cost-desktop-push",
    );
  });
});

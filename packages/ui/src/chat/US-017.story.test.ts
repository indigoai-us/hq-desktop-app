import { describe, expect, it } from "vitest";
import { CREATE_MENU_ITEMS, createMenuHasCompany } from "./create-menu.js";
import {
  channelPathPreview,
  entriesFromDirectory,
  groupPickerEntries,
  togglePickerId,
} from "./people-picker.js";
import type { ConversationRow } from "./sidebar-model.js";

describe("US-017 create menu and people picker", () => {
  it("offers New message, New channel, and New agent with the storyboard shortcuts", () => {
    expect(CREATE_MENU_ITEMS.map((item) => [item.label, item.keys])).toEqual([
      ["New message", "Mod+N"],
      ["New channel", "Mod+Shift+N"],
      ["New agent", "Mod+Alt+N"],
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
      "Agents",
      "Guests",
    ]);
    expect(togglePickerId(["prs_eric"], "agt_deacon")).toEqual(["prs_eric", "agt_deacon"]);
    expect(togglePickerId(["prs_eric"], "prs_eric")).toEqual([]);
  });

  it("previews the channel path from the company label and the typed name", () => {
    expect(channelPathPreview("Indigo", "Cost Desktop Push")).toBe(
      "companies/indigo/channels/cost-desktop-push",
    );
  });
});

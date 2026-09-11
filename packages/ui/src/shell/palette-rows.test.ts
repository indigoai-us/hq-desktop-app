/**
 * ⌘K palette rows: every row type renders a HUMAN label and a HUMAN detail.
 *
 * The palette used to map `detail: row.companyUid ?? "channel"`, so a channel
 * row's secondary line was a raw `cmp_01KQ2RYAH…` uid, and `label: row.title`
 * fell through to a bare `chn_…` / `prs_…` id whenever the name had not
 * resolved. Each row type below is covered twice: the resolved case and the
 * id-only case.
 */

import { describe, expect, it } from "vitest";

import type { ConversationRow, ScopeCompany } from "../chat/sidebar-model.js";
import {
  looksLikeRawId,
  mergePaletteRows,
  paletteConversationItems,
  paletteRowDetail,
  paletteRowKeywords,
  paletteRowLabel,
} from "./palette-rows.js";

const INDIGO = "cmp_01KQ2RYAHXHDPCTY9GPQPTH3DG";
const COMPANIES: ScopeCompany[] = [{ companyUid: INDIGO, label: "Indigo" }];
const CTX = { companies: COMPANIES };

function row(patch: Partial<ConversationRow>): ConversationRow {
  return {
    id: "ch:chn_x",
    kind: "channel",
    title: "",
    companyUid: null,
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
    ...patch,
  } as ConversationRow;
}

describe("looksLikeRawId", () => {
  it("recognises HQ principal and resource uids", () => {
    expect(looksLikeRawId("chn_01KWGKH0H5C8D8YC7XWZTQPTX6")).toBe(true);
    expect(looksLikeRawId("prs_01KQ695MZHZBYFMVMPRTGFW34B")).toBe(true);
    expect(looksLikeRawId("agt_01ABCDEFGHIJK")).toBe(true);
    expect(looksLikeRawId(INDIGO)).toBe(true);
  });

  it("does not mistake real names for ids", () => {
    expect(looksLikeRawId("hq-dev")).toBe(false);
    expect(looksLikeRawId("HQ Visual Explorer")).toBe(false);
    expect(looksLikeRawId("Corey Epstein")).toBe(false);
    expect(looksLikeRawId("")).toBe(false);
  });
});

describe("company channel rows", () => {
  const hqDev = row({
    id: "ch:chn_01KWGKH0H5C8D8YC7XWZTQPTX6",
    kind: "channel",
    title: "hq-dev",
    channelId: "chn_01KWGKH0H5C8D8YC7XWZTQPTX6",
    channelScope: "company",
    companyUid: INDIGO,
    memberCount: 8,
  });

  it("renders #name and 'Company · company channel'", () => {
    expect(paletteRowLabel(hqDev, CTX)).toBe("#hq-dev");
    expect(paletteRowDetail(hqDev, CTX)).toBe("Indigo · company channel");
  });

  it("never doubles an already-hashed server name", () => {
    expect(paletteRowLabel(row({ ...hqDev, title: "#hq-dev" }), CTX)).toBe(
      "#hq-dev",
    );
  });

  it("omits an unresolvable company rather than showing its uid", () => {
    const detail = paletteRowDetail(hqDev, { companies: [] });
    expect(detail).toBe("company channel");
    expect(detail).not.toContain("cmp_");
  });

  it("falls back to a PREFIXED id when no name resolved", () => {
    const bare = row({
      id: "ch:chn_01KWGKH0H5C8D8YC7XWZTQPTX6",
      kind: "channel",
      title: "chn_01KWGKH0H5C8D8YC7XWZTQPTX6",
      channelId: "chn_01KWGKH0H5C8D8YC7XWZTQPTX6",
      channelScope: "company",
      companyUid: INDIGO,
    });
    const label = paletteRowLabel(bare, CTX);
    expect(label).toBe("Channel · chn_01KWGK…");
    expect(label.startsWith("Channel · ")).toBe(true);
    expect(paletteRowDetail(bare, CTX)).toBe("Indigo · company channel");
  });
});

describe("project channel rows", () => {
  const provisioned = row({
    id: "ch:chn_proj",
    kind: "channel",
    title: "Project free-plan-limits 6a0efa1b",
    channelId: "chn_proj",
    channelScope: "project",
    projectId: "free-plan-limits",
    companyUid: INDIGO,
  });

  it("prefers a resolved project title over the provisioned slug name", () => {
    expect(
      paletteRowLabel(provisioned, {
        ...CTX,
        projectTitles: [{ id: "free-plan-limits", title: "Free plan limits" }],
      }),
    ).toBe("#Free plan limits");
  });

  it("labels the kind as a project channel", () => {
    expect(paletteRowDetail(provisioned, CTX)).toBe(
      "Indigo · project channel",
    );
  });

  it("falls back to the server name when no project title is known", () => {
    expect(paletteRowLabel(provisioned, CTX)).toBe(
      "#Project free-plan-limits 6a0efa1b",
    );
  });
});

describe("agent channel rows", () => {
  const agentChannel = row({
    id: "ch:chn_agent",
    kind: "channel",
    title: "Atlas",
    channelId: "chn_agent",
    channelScope: "company",
    companyUid: INDIGO,
    members: [{ personUid: "agt_01ATLAS0000", displayName: "Atlas" }],
  });

  it("names the agent and says it is an agent channel", () => {
    expect(paletteRowLabel(agentChannel, CTX)).toBe("#Atlas");
    expect(paletteRowDetail(agentChannel, CTX)).toBe("Indigo · agent channel");
  });
});

describe("personal channel rows", () => {
  it("says personal channel and carries no company", () => {
    const personal = row({
      id: "ch:chn_setup",
      kind: "channel",
      title: "welcome",
      channelId: "setup",
      channelScope: "personal",
      companyUid: null,
    });
    expect(paletteRowLabel(personal, CTX)).toBe("#welcome");
    expect(paletteRowDetail(personal, CTX)).toBe("personal channel");
  });
});

describe("person DM rows", () => {
  const person = row({
    id: "dm:prs_01KQ695MZHZBYFMVMPRTGFW34B",
    kind: "dm",
    title: "Jacob Miller",
    personUid: "prs_01KQ695MZHZBYFMVMPRTGFW34B",
    email: "jacob@getindigo.ai",
    companyUid: null,
  });

  it("renders the display name with the email as context", () => {
    expect(paletteRowLabel(person, CTX)).toBe("Jacob Miller");
    expect(paletteRowDetail(person, CTX)).toBe("jacob@getindigo.ai · person");
  });

  it("uses the email as the label when no display name resolved", () => {
    expect(
      paletteRowLabel(row({ ...person, title: "" }), CTX),
    ).toBe("jacob@getindigo.ai");
  });

  it("falls back to a PREFIXED person uid when nothing resolved", () => {
    const bare = row({ ...person, title: "", email: null });
    expect(paletteRowLabel(bare, CTX)).toBe("Person · prs_01KQ69…");
    expect(paletteRowDetail(bare, CTX)).toBe("person");
  });

  it("treats a uid-shaped title as unresolved", () => {
    const uidTitled = row({
      ...person,
      title: "prs_01KQ695MZHZBYFMVMPRTGFW34B",
      email: null,
    });
    expect(paletteRowLabel(uidTitled, CTX)).toBe("Person · prs_01KQ69…");
  });
});

describe("agent DM rows", () => {
  const agent = row({
    id: "dm:agt_01ATLAS0000",
    kind: "dm",
    title: "Atlas",
    personUid: "agt_01ATLAS0000",
    companyUid: INDIGO,
  });

  it("says agent, not person", () => {
    expect(paletteRowLabel(agent, CTX)).toBe("Atlas");
    expect(paletteRowDetail(agent, CTX)).toBe("Indigo · agent");
  });

  it("falls back to a PREFIXED agent uid", () => {
    const bare = row({ ...agent, title: "" });
    expect(paletteRowLabel(bare, CTX)).toBe("Agent · agt_01ATLA…");
    expect(paletteRowDetail(bare, CTX)).toBe("Indigo · agent");
  });
});

describe("group DM rows", () => {
  const group = row({
    id: "ch:chn_group",
    kind: "group",
    title: "Stefan, Hassaan",
    channelId: "chn_group",
    memberCount: 3,
    members: [
      { personUid: "prs_stefan", displayName: "Stefan" },
      { personUid: "prs_hassaan", displayName: "Hassaan" },
    ],
  });

  it("renders the participants and a member count", () => {
    expect(paletteRowLabel(group, CTX)).toBe("Stefan, Hassaan");
    expect(paletteRowDetail(group, CTX)).toBe("group · 3 members");
  });

  it("falls back to a member count, never a bare id", () => {
    const unnamed = row({ ...group, title: "" });
    expect(paletteRowLabel(unnamed, CTX)).toBe("Group · 3 members");
  });

  it("falls back to a PREFIXED id with no roster at all", () => {
    const empty = row({
      id: "ch:chn_group",
      kind: "group",
      title: "",
      channelId: "chn_group",
    });
    expect(paletteRowLabel(empty, CTX)).toBe("Group · chn_group");
  });
});

describe("no palette row ever displays a bare identifier", () => {
  it("holds across every row type, including id-only rows", () => {
    const rows: ConversationRow[] = [
      row({ id: "ch:a", kind: "channel", title: "chn_01AAAAAAAAAA", channelId: "chn_01AAAAAAAAAA", channelScope: "company", companyUid: INDIGO }),
      row({ id: "ch:b", kind: "channel", title: "", channelId: "chn_01BBBBBBBBBB", channelScope: "project", projectId: "p", companyUid: INDIGO }),
      row({ id: "dm:c", kind: "dm", title: "prs_01CCCCCCCCCC", personUid: "prs_01CCCCCCCCCC" }),
      row({ id: "dm:d", kind: "dm", title: "", personUid: "agt_01DDDDDDDDDD" }),
      row({ id: "ch:e", kind: "group", title: "", channelId: "chn_01EEEEEEEEEE" }),
    ];
    for (const item of paletteConversationItems(rows, CTX)) {
      // A label may CONTAIN an elided id, but only behind a human prefix.
      expect(looksLikeRawId(item.label)).toBe(false);
      expect(looksLikeRawId(item.detail)).toBe(false);
      expect(item.detail).not.toMatch(/\bcmp_/);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("keywords keep ids searchable without showing them", () => {
  it("collects every identifier on the row", () => {
    const keywords = paletteRowKeywords(
      row({
        id: "ch:chn_01KWGKH0H5C8D8YC7XWZTQPTX6",
        kind: "channel",
        title: "hq-dev",
        channelId: "chn_01KWGKH0H5C8D8YC7XWZTQPTX6",
        channelScope: "company",
        companyUid: INDIGO,
        projectId: null,
        members: [{ personUid: "agt_01ATLAS0000", displayName: "Atlas" }],
      }),
    );
    expect(keywords).toContain("chn_01KWGKH0H5C8D8YC7XWZTQPTX6");
    expect(keywords).toContain(INDIGO);
    expect(keywords).toContain("agt_01ATLAS0000");
  });

  it("keeps a person's email and uid", () => {
    const keywords = paletteRowKeywords(
      row({
        id: "dm:prs_1",
        kind: "dm",
        title: "Jacob",
        personUid: "prs_1",
        email: "jacob@getindigo.ai",
      }),
    );
    expect(keywords).toContain("prs_1");
    expect(keywords).toContain("jacob@getindigo.ai");
  });

  it("does not repeat a value", () => {
    const keywords = paletteRowKeywords(
      row({ id: "ch:x", kind: "channel", title: "x", channelId: "x" }),
    );
    expect(keywords.split(" ").filter((k) => k === "x")).toHaveLength(1);
  });
});

describe("mergePaletteRows", () => {
  it("unions the live rail with the cached rows so neither surface can lag", () => {
    const live = [row({ id: "ch:live", kind: "channel", title: "live" })];
    const cached = [row({ id: "ch:cached", kind: "channel", title: "cached" })];
    expect(mergePaletteRows(live, cached).map((r) => r.id)).toEqual([
      "ch:live",
      "ch:cached",
    ]);
  });

  it("keeps the richer row when both sides carry the same conversation", () => {
    const thin = row({
      id: "ch:chn_1",
      kind: "channel",
      title: "hq-dev",
      channelId: "chn_1",
    });
    const rich = row({
      id: "ch:chn_1",
      kind: "channel",
      title: "hq-dev",
      channelId: "chn_1",
      companyUid: INDIGO,
      membership: "joined",
      memberCount: 8,
    });
    expect(mergePaletteRows([thin], [rich])[0]?.companyUid).toBe(INDIGO);
    // And the live row wins when the cached one adds nothing.
    expect(mergePaletteRows([rich], [thin])[0]?.companyUid).toBe(INDIGO);
  });

  it("never duplicates a conversation", () => {
    const same = row({ id: "ch:dupe", kind: "channel", title: "dupe" });
    expect(mergePaletteRows([same], [same])).toHaveLength(1);
  });

  it("tolerates empty inputs", () => {
    expect(mergePaletteRows()).toEqual([]);
    expect(mergePaletteRows([], [])).toEqual([]);
  });
});

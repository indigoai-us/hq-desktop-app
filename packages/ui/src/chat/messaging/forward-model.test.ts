import { describe, expect, it } from "vitest";
import type { ConversationRow } from "../sidebar-model.js";
import type { MentionTarget } from "../mentions.js";
import {
  adminCompaniesOf,
  buildForwardCandidates,
  buildForwardHttpRequest,
  filterForwardCandidates,
  forwardConfirmation,
  forwardErrorMessage,
  forwardPreview,
  forwardSourceFrom,
  parseForwardResponse,
  showCompanyControl,
  type ForwardErrorCode,
} from "./forward-model.js";

function row(extra: Partial<ConversationRow>): ConversationRow {
  return {
    id: "x",
    kind: "channel",
    title: "t",
    companyUid: null,
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
    ...extra,
  } as ConversationRow;
}

const rows: ConversationRow[] = [
  row({ id: "dm:prs_ana", kind: "dm", title: "Ana", personUid: "prs_ana" }),
  row({ id: "dm:agt_bot", kind: "dm", title: "Helper", personUid: "agt_bot" }),
  row({ id: "ch:ch_a", kind: "channel", title: "team-a", channelId: "ch_a", companyUid: "cmp_a" }),
  row({ id: "ch:ch_b", kind: "channel", title: "team-b", channelId: "ch_b", companyUid: "cmp_b" }),
  row({ id: "ch:ch_g", kind: "group", title: "Ana, Bo", channelId: "ch_g" }),
  row({ id: "ch:ch_browse", kind: "channel", title: "browse", channelId: "ch_browse", companyUid: "cmp_a", browseOnly: true }),
  row({ id: "ch:ch_inv", kind: "channel", title: "invited", channelId: "ch_inv", companyUid: "cmp_a", membership: "invited" }),
];
const contacts: MentionTarget[] = [
  { participantUid: "prs_cy", participantType: "human", displayName: "Cy", companyUid: "cmp_a" },
  { participantUid: "prs_di", participantType: "human", displayName: "Di", companyUid: "cmp_b" },
  { participantUid: "prs_ana", participantType: "human", displayName: "Ana dup", companyUid: "cmp_a" },
  { participantUid: "here", participantType: "broadcast" as never, displayName: "here" },
];

describe("buildForwardCandidates", () => {
  it("lists only sidebar rows and contacts in the source company scope", () => {
    const ids = buildForwardCandidates(rows, contacts, "cmp_a", "cmp_a").map((c) => c.id);
    expect(ids).toEqual(["dm:prs_ana", "dm:agt_bot", "ch:ch_a", "ch:ch_g", "dm:prs_cy"]);
  });

  it("never lists browse-only or invited channels, other companies, or @here", () => {
    const ids = buildForwardCandidates(rows, contacts, "cmp_a", "cmp_a").map((c) => c.id);
    expect(ids).not.toContain("ch:ch_browse");
    expect(ids).not.toContain("ch:ch_inv");
    expect(ids).not.toContain("ch:ch_b");
    expect(ids).not.toContain("dm:prs_di");
    expect(ids).not.toContain("dm:here");
  });

  it("switches to another company's rows only, without company-less rows", () => {
    const ids = buildForwardCandidates(rows, contacts, "cmp_b", "cmp_a").map((c) => c.id);
    expect(ids).toEqual(["ch:ch_b", "dm:prs_di"]);
  });

  it("types people, bots, channels, and groups", () => {
    const byId = Object.fromEntries(
      buildForwardCandidates(rows, contacts, "cmp_a", "cmp_a").map((c) => [c.id, c.kind]),
    );
    expect(byId).toMatchObject({ "dm:prs_ana": "person", "dm:agt_bot": "bot", "ch:ch_a": "channel", "ch:ch_g": "group" });
  });

  it("keeps contacts to the source company when no company is chosen", () => {
    const ids = buildForwardCandidates(rows, contacts, null, "cmp_a").map((c) => c.id);
    expect(ids).toContain("dm:prs_cy");
    expect(ids).not.toContain("dm:prs_di");
    expect(ids).not.toContain("ch:ch_b");
  });

  it("returns nothing from nothing (no other source)", () => {
    expect(buildForwardCandidates([], [], "cmp_a", "cmp_a")).toEqual([]);
  });
});

describe("filterForwardCandidates", () => {
  it("filters by name, case-insensitive", () => {
    const all = buildForwardCandidates(rows, contacts, "cmp_a", "cmp_a");
    expect(filterForwardCandidates(all, "TEAM").map((c) => c.id)).toEqual(["ch:ch_a"]);
    expect(filterForwardCandidates(all, "  ")).toHaveLength(all.length);
  });
});

describe("company control", () => {
  const companies = [
    { cloudUid: "cmp_a", displayName: "A", role: "owner" },
    { cloudUid: "cmp_b", displayName: "B", role: "admin" },
    { cloudUid: "cmp_c", displayName: "C", role: "member" },
  ];
  it("shows for an owner/admin of more than one company that includes the source", () => {
    const admin = adminCompaniesOf(companies);
    expect(admin.map((c) => c.uid)).toEqual(["cmp_a", "cmp_b"]);
    expect(showCompanyControl(admin, "cmp_a")).toBe(true);
  });
  it("hides for an admin of one company, or when the source company is not administered", () => {
    expect(showCompanyControl(adminCompaniesOf([companies[0], companies[2]]), "cmp_a")).toBe(false);
    expect(showCompanyControl(adminCompaniesOf(companies), "cmp_c")).toBe(false);
    expect(showCompanyControl(adminCompaniesOf(null), "cmp_a")).toBe(false);
  });
});

describe("preview", () => {
  it("has the sender, the first lines, and the artifact title", () => {
    const src = forwardSourceFrom(
      { eventId: "e1", createdAt: "", body: "one\ntwo\nthree\nfour", details: "# Plan\nstep" },
      "prs_ana",
      "cmp_a",
      "Ana",
    );
    const p = forwardPreview(src);
    expect(p.senderName).toBe("Ana");
    expect(p.lines).toEqual(["one", "two", "three"]);
    expect(p.artifactLabel).toBe("Details: Plan");
  });
  it("labels a prompt card", () => {
    const src = forwardSourceFrom({ eventId: "e1", createdAt: "", body: "b", prompt: "Do the thing" }, "c", null, "");
    expect(forwardPreview(src).artifactLabel).toBe("Prompt: Do the thing");
    expect(src.senderName).toBe("Someone");
  });
});

describe("buildForwardHttpRequest", () => {
  const forwardOf = { conversationId: "prs_ana", eventId: "e1" };
  it("sends a DM forward to /v1/notify/dm with toPersonUid, note as body, and forwardOf", () => {
    const req = buildForwardHttpRequest({
      destination: { id: "dm:agt_bot", kind: "bot", name: "Helper", companyUid: null, principalUid: "agt_bot" },
      forwardOf,
      note: "  fyi ",
    });
    expect(req).toEqual({ path: "/v1/notify/dm", body: { toPersonUid: "agt_bot", body: "fyi", forwardOf } });
  });
  it("sends a channel or group forward to the channel route with ack and fileAccess", () => {
    const req = buildForwardHttpRequest({
      destination: { id: "ch:c/1", kind: "channel", name: "t", companyUid: "cmp_b", channelId: "c/1" },
      forwardOf,
      note: "",
      fileAccess: "omit",
      acknowledgeCrossCompany: true,
    });
    expect(req.path).toBe("/v1/notify/channels/c%2F1/messages");
    expect(req.body).toEqual({ body: "", forwardOf, fileAccess: "omit", acknowledgeCrossCompany: true });
  });
  it("never sets acknowledgeCrossCompany unless asked", () => {
    const req = buildForwardHttpRequest({
      destination: { id: "ch:c", kind: "channel", name: "t", companyUid: null, channelId: "c" },
      forwardOf,
      note: "",
    });
    expect("acknowledgeCrossCompany" in req.body).toBe(false);
  });
});

describe("parseForwardResponse", () => {
  it("reads success and omittedAttachments", () => {
    expect(parseForwardResponse(201, JSON.stringify({ eventId: "e9", omittedAttachments: 2 }))).toEqual({
      ok: true,
      omittedAttachments: 2,
      eventId: "e9",
    });
  });
  it("coerces non-array file fields to arrays", () => {
    const r = parseForwardResponse(
      409,
      JSON.stringify({ code: "FORWARD_FILE_ACCESS_REQUIRED", files: "a.pdf", notShareable: { name: "x" } }),
    );
    if (r.ok) throw new Error("expected failure");
    expect(r.files).toEqual([]);
    expect(r.notShareable).toEqual([]);
  });
  it("reads company refs on the ack 409", () => {
    const r = parseForwardResponse(
      409,
      JSON.stringify({ code: "CROSS_COMPANY_ACK_REQUIRED", sourceCompany: { uid: "cmp_a", name: "A" }, destinationCompany: null }),
    );
    if (r.ok) throw new Error("expected failure");
    expect(r.sourceCompany).toEqual({ uid: "cmp_a", name: "A" });
    expect(r.destinationCompany).toBeNull();
  });
  it("maps unknown codes and non-JSON bodies to UNKNOWN", () => {
    const r = parseForwardResponse(500, "<html>boom</html>");
    expect(!r.ok && r.code).toBe("UNKNOWN");
  });
});

describe("forwardErrorMessage", () => {
  const codes: ForwardErrorCode[] = [
    "FORWARD_SOURCE_NOT_FOUND", "INVALID_FORWARD_OF", "INVALID_FILE_ACCESS", "FORWARD_FILES_NOT_ALLOWED",
    "FORWARD_BODY_TOO_LARGE", "FORWARD_DETAILS_TOO_LARGE", "FORWARD_PROMPT_TOO_LARGE", "FORWARD_NOT_SCHEDULABLE",
    "FORWARD_NOT_CONNECTED", "CROSS_COMPANY_FORBIDDEN", "CROSS_COMPANY_ACK_REQUIRED", "FORWARD_FILE_ACCESS_REQUIRED",
    "FORWARD_FILE_SHARE_FORBIDDEN", "FORWARD_FILE_GRANT_FAILED", "NETWORK", "UNKNOWN",
  ];
  for (const code of codes) {
    it(`${code} is a plain sentence, never the server text`, () => {
      const msg = forwardErrorMessage(
        { ok: false, code, status: 400, files: [], notShareable: [] },
        { destinationName: "Ana" },
      );
      expect(msg).toMatch(/^[A-Z].*\.$/);
      expect(msg).not.toMatch(/[{}]|_[A-Z]|FORWARD|CROSS/);
    });
  }
});

describe("forwardConfirmation", () => {
  it("names the destination and omitted files", () => {
    expect(forwardConfirmation("Ana", 0)).toBe("Forwarded to Ana.");
    expect(forwardConfirmation("#team", 1)).toBe("Forwarded to #team. 1 file not included.");
  });
});

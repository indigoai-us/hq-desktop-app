import { describe, expect, it } from "vitest";
import { MARKETPLACE_COVER_HOST } from "../avatars/csp-image-src";
import type { ConversationRow } from "../chat/sidebar-model";
import { paletteConversationItems, paletteRowIconUrl } from "./palette-rows";

const ICON = `https://${MARKETPLACE_COVER_HOST}/branding/cmp_acme/favicon.png?X-Amz-Signature=mock`;
const COMPANIES = [
  { companyUid: "cmp_acme", label: "Acme", iconUrl: ICON },
  { companyUid: "cmp_beta", label: "Beta" },
];

function row(over: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: "ch:chn_1",
    kind: "channel",
    title: "general",
    companyUid: "cmp_acme",
    channelId: "chn_1",
    channelScope: "company",
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
    ...over,
  };
}

describe("paletteRowIconUrl", () => {
  it("resolves a company channel from the company roster", () => {
    expect(paletteRowIconUrl(row(), { companies: COMPANIES })).toBe(ICON);
  });

  it("prefers the row's own server-stamped icon over the roster", () => {
    const fresh = ICON.replace("favicon.png", "favicon.ico");
    expect(
      paletteRowIconUrl(row({ iconUrl: fresh }), { companies: COMPANIES }),
    ).toBe(fresh);
  });

  it("returns null for a company with no icon", () => {
    expect(
      paletteRowIconUrl(row({ companyUid: "cmp_beta" }), {
        companies: COMPANIES,
      }),
    ).toBeNull();
  });

  it("returns null for project, personal, dm and group rows", () => {
    // These are not company channels; implying a company mark would be wrong.
    expect(
      paletteRowIconUrl(row({ channelScope: "project" }), {
        companies: COMPANIES,
      }),
    ).toBeNull();
    expect(
      paletteRowIconUrl(row({ channelScope: "personal" }), {
        companies: COMPANIES,
      }),
    ).toBeNull();
    expect(
      paletteRowIconUrl(
        row({ kind: "dm", personUid: "prs_x", channelScope: undefined }),
        { companies: COMPANIES },
      ),
    ).toBeNull();
    expect(
      paletteRowIconUrl(row({ kind: "group" }), { companies: COMPANIES }),
    ).toBeNull();
  });

  it("returns null with no context at all", () => {
    expect(paletteRowIconUrl(row())).toBeNull();
  });
});

describe("paletteConversationItems — iconUrl", () => {
  it("stamps iconUrl on each item without disturbing label or detail", () => {
    const [item] = paletteConversationItems([row()], {
      companies: COMPANIES,
    });
    expect(item?.iconUrl).toBe(ICON);
    expect(item?.label).toBe("#general");
    expect(item?.detail).toBe("Acme · company channel");
    // Raw ids stay searchable but unrendered.
    expect(item?.keywords).toContain("cmp_acme");
  });

  it("stamps null for rows with no company icon", () => {
    const [item] = paletteConversationItems(
      [row({ kind: "dm", personUid: "prs_x", channelScope: undefined })],
      { companies: COMPANIES },
    );
    expect(item?.iconUrl).toBeNull();
  });
});

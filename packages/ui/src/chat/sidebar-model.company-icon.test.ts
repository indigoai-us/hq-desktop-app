import { describe, expect, it } from "vitest";
import { MARKETPLACE_COVER_HOST } from "../avatars/csp-image-src";
import type { Channel } from "./channels";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import {
  directoryRowToChannel,
  isStrictlyRicherConversationRow,
  normalizeChannel,
  type ConversationRow,
} from "./sidebar-model";

const ICON = `https://${MARKETPLACE_COVER_HOST}/branding/cmp_acme/favicon.png?X-Amz-Signature=mock`;

function dirRow(over: Partial<ChannelDirectoryRow> = {}): ChannelDirectoryRow {
  return {
    channelId: "chn_1",
    scope: "company",
    companyUid: "cmp_acme",
    name: "general",
    lastActivityAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

function channel(over: Partial<Channel> = {}): Channel {
  return {
    channelId: "chn_1",
    name: "general",
    scope: "company",
    companyUid: "cmp_acme",
    ...over,
  };
}

describe("directoryRowToChannel — iconUrl", () => {
  it("carries the server's icon onto the channel", () => {
    expect(directoryRowToChannel(dirRow({ iconUrl: ICON })).iconUrl).toBe(ICON);
  });

  it("keeps a previously known icon when the row OMITS the field", () => {
    // An older server (or a delta that does not restate it) must not blank the
    // icon the client already has.
    const prev = channel({ iconUrl: ICON });
    expect(directoryRowToChannel(dirRow(), prev).iconUrl).toBe(ICON);
  });

  it("CLEARS the icon when the row states null", () => {
    // Explicit null means the company no longer has an icon (website removed),
    // and that must take effect without a reload.
    const prev = channel({ iconUrl: ICON });
    const next = directoryRowToChannel(dirRow({ iconUrl: null }), prev);
    expect(next.iconUrl).toBeNull();
  });

  it("leaves iconUrl absent when neither row nor prev has one", () => {
    expect(directoryRowToChannel(dirRow()).iconUrl).toBeUndefined();
  });

  it("replaces a stale icon with a newly resolved one", () => {
    const fresh = ICON.replace("favicon.png", "favicon.ico");
    const prev = channel({ iconUrl: ICON });
    expect(directoryRowToChannel(dirRow({ iconUrl: fresh }), prev).iconUrl).toBe(
      fresh,
    );
  });
});

describe("normalizeChannel — iconUrl", () => {
  it("keeps the icon on a company-scoped row", () => {
    expect(normalizeChannel(channel({ iconUrl: ICON })).iconUrl).toBe(ICON);
  });

  it("drops the icon on personal and group rows", () => {
    // Those rows have no company identity, so a company mark would be a lie.
    expect(
      normalizeChannel(
        channel({ scope: "personal", companyUid: null, iconUrl: ICON }),
      ).iconUrl,
    ).toBeUndefined();
    expect(
      normalizeChannel(channel({ scope: "group", iconUrl: ICON })).iconUrl,
    ).toBeUndefined();
  });

  it("keeps the icon on a project-scoped row's data (the rail decides display)", () => {
    // The model carries it; only the RAIL restricts the mark to company scope,
    // so a future surface can use a project channel's company icon.
    expect(
      normalizeChannel(channel({ scope: "project", iconUrl: ICON })).iconUrl,
    ).toBe(ICON);
  });
});

describe("isStrictlyRicherConversationRow — iconUrl is metadata", () => {
  const base: ConversationRow = {
    id: "ch:chn_1",
    kind: "channel",
    title: "general",
    companyUid: "cmp_acme",
    channelId: "chn_1",
    channelScope: "company",
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
  };

  it("treats a row that ADDS an icon as strictly richer", () => {
    expect(
      isStrictlyRicherConversationRow({ ...base, iconUrl: ICON }, base),
    ).toBe(true);
  });

  it("does NOT treat a row that drops a known icon as richer", () => {
    // Otherwise the shell could oscillate between an iconful live row and an
    // iconless stub.
    expect(
      isStrictlyRicherConversationRow(base, { ...base, iconUrl: ICON }),
    ).toBe(false);
  });
});

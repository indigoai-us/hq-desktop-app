import { describe, expect, it } from "vitest";
import { MARKETPLACE_COVER_HOST } from "../avatars/csp-image-src";
import {
  buildCompanyIconMap,
  companyIconUrl,
  workspacesFromMembershipRows,
} from "./company-display-map";

const ICON = `https://${MARKETPLACE_COVER_HOST}/branding/cmp_acme/favicon.png?X-Amz-Signature=mock`;

describe("buildCompanyIconMap", () => {
  it("keys the icon by BOTH uid and slug", () => {
    const map = buildCompanyIconMap([
      { companyUid: "cmp_acme", companySlug: "acme", iconUrl: ICON },
    ]);
    expect(map.get("cmp_acme")).toBe(ICON);
    expect(map.get("acme")).toBe(ICON);
  });

  it("accepts the membership / companies / workspaces envelopes", () => {
    for (const raw of [
      { memberships: [{ companyUid: "cmp_acme", iconUrl: ICON }] },
      { companies: [{ companyUid: "cmp_acme", iconUrl: ICON }] },
      { workspaces: [{ cloudUid: "cmp_acme", iconUrl: ICON }] },
    ]) {
      expect(buildCompanyIconMap(raw).get("cmp_acme")).toBe(ICON);
    }
  });

  it("omits companies with no icon rather than storing an empty string", () => {
    const map = buildCompanyIconMap([
      { companyUid: "cmp_none" },
      { companyUid: "cmp_blank", iconUrl: "   " },
      { companyUid: "cmp_null", iconUrl: null },
    ]);
    expect(map.size).toBe(0);
    expect(map.get("cmp_none")).toBeUndefined();
  });

  it("returns an empty map for junk input", () => {
    expect(buildCompanyIconMap(null).size).toBe(0);
    expect(buildCompanyIconMap(undefined).size).toBe(0);
    expect(buildCompanyIconMap("nope").size).toBe(0);
    expect(buildCompanyIconMap(42).size).toBe(0);
  });
});

describe("companyIconUrl", () => {
  const map = buildCompanyIconMap([
    { companyUid: "cmp_acme", iconUrl: ICON },
  ]);

  it("resolves a known company", () => {
    expect(companyIconUrl("cmp_acme", map)).toBe(ICON);
  });

  it("returns null for an unknown company and for no company", () => {
    expect(companyIconUrl("cmp_other", map)).toBeNull();
    expect(companyIconUrl(null, map)).toBeNull();
    expect(companyIconUrl(undefined, map)).toBeNull();
    expect(companyIconUrl("", map)).toBeNull();
  });

  it("uses the fallback only when the map has no hit", () => {
    const other = ICON.replace("cmp_acme", "cmp_beta");
    expect(companyIconUrl("cmp_acme", map, other)).toBe(ICON);
    expect(companyIconUrl("cmp_beta", map, other)).toBe(other);
    expect(companyIconUrl("cmp_beta", map, "  ")).toBeNull();
  });
});

describe("workspacesFromMembershipRows — icon passthrough", () => {
  it("carries iconUrl + brand from a bare membership row", () => {
    // Regression: the membership-row branch used to drop brand entirely, which
    // left the switcher and header with no icon on the /membership/me path.
    const [ws] = workspacesFromMembershipRows([
      {
        companyUid: "cmp_acme",
        companySlug: "acme",
        companyName: "Acme",
        role: "owner",
        status: "active",
        iconUrl: ICON,
        brand: { website: "https://acme.test/" },
      },
    ]);
    expect(ws?.iconUrl).toBe(ICON);
    expect(ws?.brand).toEqual({ website: "https://acme.test/" });
    expect(ws?.kind).toBe("company");
  });

  it("carries iconUrl from a real workspace row", () => {
    const [ws] = workspacesFromMembershipRows([
      {
        cloudUid: "cmp_acme",
        slug: "acme",
        displayName: "Acme",
        kind: "company",
        state: "synced",
        iconUrl: ICON,
      },
    ]);
    expect(ws?.iconUrl).toBe(ICON);
  });

  it("omits iconUrl when the row has none, and never invents one", () => {
    const [ws] = workspacesFromMembershipRows([
      { companyUid: "cmp_acme", companyName: "Acme" },
    ]);
    expect(ws?.iconUrl).toBeUndefined();
  });

  it("leaves the personal workspace without an icon", () => {
    const [ws] = workspacesFromMembershipRows([
      {
        cloudUid: "prs_me",
        slug: "me",
        displayName: "Corey",
        kind: "personal",
        state: "personal",
      },
    ]);
    expect(ws?.kind).toBe("personal");
    expect(ws?.iconUrl).toBeUndefined();
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  digestMigratePayload,
  migrateDestinationCompanies,
  migrateDigestPayload,
  newMigrateOperationId,
  normalizeMigrateDestination,
} from "./session-migrate.js";

describe("session migrate digest", () => {
  it("matches hq-pro migrateDigestPayload + sha256 hex", async () => {
    const parts = {
      sessionId: "sess_1",
      sourceCompanyUid: "cmp_a",
      destinationCompanyUid: "cmp_b",
      destination: { projectId: "proj_1" },
      expectedVersion: 0,
    };
    const canonical = migrateDigestPayload(parts);
    expect(canonical).toBe(
      JSON.stringify({
        sessionId: "sess_1",
        sourceCompanyUid: "cmp_a",
        destinationCompanyUid: "cmp_b",
        destination: { projectId: "proj_1" },
        expectedVersion: 0,
      }),
    );
    const digest = await digestMigratePayload(parts);
    expect(digest).toBe(
      createHash("sha256").update(canonical).digest("hex"),
    );
  });

  it("omits empty destination keys", () => {
    expect(
      migrateDigestPayload({
        sessionId: "s",
        sourceCompanyUid: "a",
        destinationCompanyUid: "b",
        destination: {},
        expectedVersion: 0,
      }),
    ).toContain('"destination":{}');
  });

  it("prefixes operation ids with op_", () => {
    expect(newMigrateOperationId().startsWith("op_")).toBe(true);
  });
});

describe("migrateDestinationCompanies", () => {
  it("excludes source, personal, guest, and inactive rows", () => {
    expect(
      migrateDestinationCompanies(
        [
          {
            slug: "src",
            cloudUid: "cmp_src",
            role: "admin",
            displayName: "Source",
          },
          {
            slug: "dst",
            cloudUid: "cmp_dst",
            role: "member",
            displayName: "Dest",
          },
          {
            slug: "guest-co",
            cloudUid: "cmp_guest",
            role: "guest",
            displayName: "Guest Co",
          },
          {
            slug: "pending",
            cloudUid: "cmp_pending",
            role: "admin",
            membershipStatus: "pending",
            displayName: "Pending",
          },
          {
            slug: "me",
            kind: "personal",
            cloudUid: "cmp_personal",
            role: "owner",
            displayName: "Personal",
          },
        ],
        "cmp_src",
      ),
    ).toEqual([{ uid: "cmp_dst", label: "Dest" }]);
  });
});

describe("normalizeMigrateDestination", () => {
  it("returns empty destination when optional ids omitted", () => {
    expect(normalizeMigrateDestination({})).toEqual({});
    expect(normalizeMigrateDestination(null)).toEqual({});
  });
});

import { describe, expect, it } from "vitest";

import { parseWorkFeed } from "./live-sidebar.js";

describe("parseWorkFeed snapshot envelopes", () => {
  it("reads the canonical contractVersion-2 items snapshot", () => {
    const items = parseWorkFeed({
      contractVersion: 2,
      snapshot: true,
      items: [
        {
          projectId: "alpha",
          companyUid: "cmp_alpha",
          lastActivityAt: "2026-08-18T10:00:00.000Z",
          createdAt: "2026-08-01T10:00:00.000Z",
          threadStatus: "in-progress",
          progressSummary: "Shipping the rail",
          ownerUid: "prs_alpha",
          threadId: "thr_alpha",
        },
        {
          project_id: "beta",
          companyUid: "cmp_beta",
          lastActivityAt: "2026-08-19T10:00:00.000Z",
          id: "thr_beta",
        },
      ],
      open: [
        {
          projectId: "alpha",
          threadStatus: "stale legacy status",
        },
      ],
      changed: [{ projectId: "legacy-only" }],
    });

    expect(items).toEqual([
      {
        projectId: "alpha",
        companyUid: "cmp_alpha",
        lastActivityAt: "2026-08-18T10:00:00.000Z",
        createdAt: "2026-08-01T10:00:00.000Z",
        threadStatus: "in-progress",
        progressSummary: "Shipping the rail",
        ownerUid: "prs_alpha",
        threadId: "thr_alpha",
      },
      {
        projectId: "beta",
        companyUid: "cmp_beta",
        lastActivityAt: "2026-08-19T10:00:00.000Z",
        createdAt: null,
        threadStatus: null,
        progressSummary: null,
        ownerUid: null,
        threadId: "thr_beta",
      },
    ]);
  });

  it("reads the legacy bare-array form", () => {
    expect(
      parseWorkFeed([
        {
          projectId: "legacy-array",
          companyUid: "cmp_legacy",
          lastActivityAt: "2026-08-20T10:00:00.000Z",
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        projectId: "legacy-array",
        companyUid: "cmp_legacy",
      }),
    ]);
  });
});

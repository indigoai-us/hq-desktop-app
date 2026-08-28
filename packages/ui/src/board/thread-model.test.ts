import { describe, expect, it } from "vitest";

import { parseThreadResource } from "./board-api";
import { buildCompanyScopes } from "./company-scopes";
import {
  normalizeThread,
  normalizeThreadStatus,
  normalizeThreads,
  threadsForCompany,
  upsertThread,
} from "./thread-model";

describe("thread-model (US-008 work-mesh threads)", () => {
  it("normalizes wire threads absent-safely", () => {
    const t = normalizeThread({
      threadId: "T-1",
      companyUid: "cmp_a",
      project: "hq-app-v2-web-first",
      status: "progress",
      storyId: "US-008",
      updatedAt: "2026-08-14T10:00:00Z",
      note: "porting board",
    });
    expect(t).toMatchObject({
      threadId: "T-1",
      companyUid: "cmp_a",
      project: "hq-app-v2-web-first",
      status: "progress",
      storyId: "US-008",
      note: "porting board",
    });
    expect(normalizeThread(null)).toBeNull();
    expect(normalizeThread({})).toBeNull();
    expect(normalizeThread("nope")).toBeNull();
  });

  it("reads THREAD_META-style nested meta and fallback company", () => {
    const t = normalizeThread(
      {
        id: "T-2",
        meta: { title: "Fabric review", project: "mesh", status: "blocked" },
      },
      "cmp_fallback",
    );
    expect(t).toMatchObject({
      threadId: "T-2",
      companyUid: "cmp_fallback",
      title: "Fabric review",
      project: "mesh",
      status: "blocked",
    });
  });

  it("normalizes status aliases and unknowns", () => {
    expect(normalizeThreadStatus("in_progress")).toBe("progress");
    expect(normalizeThreadStatus("in-progress")).toBe("progress");
    expect(normalizeThreadStatus("claimed")).toBe("start");
    expect(normalizeThreadStatus("completed")).toBe("done");
    expect(normalizeThreadStatus("started")).toBe("start");
    expect(normalizeThreadStatus("weird")).toBe("unknown");
    expect(normalizeThreadStatus(undefined)).toBe("unknown");
  });

  it("reads ownerUid + threadStatus from hq-pro THREAD_META", () => {
    const t = normalizeThread({
      threadId: "T-mesh",
      companyUid: "cmp_indigo",
      projectId: "work-mesh-testing",
      threadStatus: "in-progress",
      ownerUid: "agt_deacon",
      progressSummary: "US-008 · wiring status popover",
      lastActivityAt: "2026-08-16T17:00:00Z",
    });
    expect(t).toMatchObject({
      project: "work-mesh-testing",
      status: "progress",
      actor: "agt_deacon",
      storyId: "US-008",
      note: "US-008 · wiring status popover",
    });
  });

  it("parses rollup shapes: {threads:[...]}, bare array, junk", () => {
    expect(
      normalizeThreads({ threads: [{ threadId: "a" }, { bogus: true }] }),
    ).toHaveLength(1);
    expect(normalizeThreads([{ threadId: "b" }])).toHaveLength(1);
    expect(normalizeThreads(null)).toEqual([]);
    expect(normalizeThreads("x")).toEqual([]);
  });

  it("upserts reconciled thread detail by (companyUid, threadId)", () => {
    const base = normalizeThreads([
      { threadId: "T-1", companyUid: "c1", status: "start" },
      { threadId: "T-1", companyUid: "c2", status: "start" },
    ]);
    const detail = normalizeThread({
      threadId: "T-1",
      companyUid: "c1",
      status: "done",
    });
    const next = upsertThread(base, detail!);
    expect(next).toHaveLength(2);
    expect(next.find((t) => t.companyUid === "c1")?.status).toBe("done");
    expect(next.find((t) => t.companyUid === "c2")?.status).toBe("start");

    const appended = upsertThread(
      base,
      normalizeThread({ threadId: "T-9", companyUid: "c1" })!,
    );
    expect(appended).toHaveLength(3);
  });

  it("filters + sorts company threads newest-first", () => {
    const threads = normalizeThreads([
      { threadId: "old", companyUid: "c1", updatedAt: "2026-08-01T00:00:00Z" },
      { threadId: "new", companyUid: "c1", updatedAt: "2026-08-14T00:00:00Z" },
      { threadId: "other", companyUid: "c2" },
    ]);
    expect(threadsForCompany(threads, "c1").map((t) => t.threadId)).toEqual([
      "new",
      "old",
    ]);
  });
});

describe("parseThreadResource", () => {
  it("parses MeshClient thread resources incl. multi-segment ids", () => {
    expect(parseThreadResource("thread:cmp_a:T-1")).toEqual({
      companyUid: "cmp_a",
      threadId: "T-1",
    });
    expect(parseThreadResource("thread:cmp_a:proj/T-1")).toEqual({
      companyUid: "cmp_a",
      threadId: "proj/T-1",
    });
    expect(parseThreadResource("work:prs_x")).toBeNull();
    expect(parseThreadResource("thread:only")).toBeNull();
  });
});

describe("buildCompanyScopes (US-008 AC4)", () => {
  it("builds per-company scopes and flags dropped companies visibly", () => {
    const scopes = buildCompanyScopes(
      [
        { companyUid: "cmp_a", name: "Alpha" },
        { companyUid: "cmp_b", name: "Beta" },
      ],
      ["cmp_b"],
    );
    expect(scopes).toEqual([
      { companyUid: "cmp_a", label: "Alpha", realtimeDropped: false },
      { companyUid: "cmp_b", label: "Beta", realtimeDropped: true },
    ]);
  });

  it("surfaces dropped companies missing from memberships — never silent", () => {
    const scopes = buildCompanyScopes(
      [{ companyUid: "cmp_a", name: "A" }],
      ["cmp_ghost"],
    );
    expect(scopes.map((s) => s.companyUid)).toContain("cmp_ghost");
    expect(
      scopes.find((s) => s.companyUid === "cmp_ghost")?.realtimeDropped,
    ).toBe(true);
  });

  it("dedupes and tolerates null/absent memberships", () => {
    expect(buildCompanyScopes(null)).toEqual([]);
    expect(
      buildCompanyScopes([
        { companyUid: "c" },
        { companyUid: "c", name: "dup" },
        { slug: "" },
      ]),
    ).toHaveLength(1);
  });
});

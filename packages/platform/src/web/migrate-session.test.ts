import { describe, expect, it } from "vitest";

import type {
  MigrateSessionRequest,
  WorkMeshApi,
} from "../adapter.js";
import { WebPlatformAdapter, WEB_PATHS } from "./index.js";

/** Compile-time: migrateSession is the only cross-company rebind on WorkMeshApi. */
type AssertTrue<T extends true> = T;
type _HasMigrate = AssertTrue<
  "migrateSession" extends keyof WorkMeshApi ? true : false
>;
type _NoOrganize = AssertTrue<
  "organizeSession" extends keyof WorkMeshApi ? false : true
>;
type _NoCorrect = AssertTrue<
  "correctSession" extends keyof WorkMeshApi ? false : true
>;
type _NoRebind = AssertTrue<
  "rebindSession" extends keyof WorkMeshApi ? false : true
>;
type _DestOnMigrateBody = AssertTrue<
  "destinationCompanyUid" extends keyof MigrateSessionRequest ? true : false
>;

void 0 as unknown as [
  _HasMigrate,
  _NoOrganize,
  _NoCorrect,
  _NoRebind,
  _DestOnMigrateBody,
];

describe("workMesh.migrateSession", () => {
  it("POSTs the migrate body to the encoded session path", async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> =
      [];
    const fetchMock: typeof globalThis.fetch = async (input, init) => {
      calls.push({
        url: String(input).replace("https://api.test", ""),
        method: String(init?.method ?? "GET"),
        body: typeof init?.body === "string" ? init.body : null,
      });
      return new Response(
        JSON.stringify({
          sessionId: "sess 1",
          receipt: { status: "committed" },
        }),
        { status: 200 },
      );
    };
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: fetchMock,
    });
    const body: MigrateSessionRequest = {
      operationId: "op_abc",
      digest: "deadbeef",
      sourceCompanyUid: "cmp_src",
      destinationCompanyUid: "cmp_dst",
      destination: {},
      expectedVersion: 0,
    };
    const result = await adapter.workMesh.migrateSession("sess 1", body);
    expect(result.ok).toBe(true);
    expect(WEB_PATHS.workMeshSessionMigrate("sess 1")).toBe(
      "/v1/work-mesh/sessions/sess%201/migrate",
    );
    expect(calls).toEqual([
      {
        url: "/v1/work-mesh/sessions/sess%201/migrate",
        method: "POST",
        body: JSON.stringify(body),
      },
    ]);
  });

  it("is the only WorkMeshApi / adapter path that rebinds across companies", () => {
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: async () => new Response("{}", { status: 200 }),
    });
    // INVARIANT: migrateSession is the ONLY method on the work-mesh surface
    // that may rebind a session's company. Every other entry below is a
    // read-only projection — it takes companyUid as a SCOPE it must already be
    // authorized for, and never writes it.
    //
    // This list is exhaustive on purpose: adding a work-mesh method makes this
    // test fail until someone adds it here, which is the moment to ask "does
    // this rebind company or session?". If the answer is yes, it does not
    // belong on this adapter — extend migrateSession instead.
    //
    // Verified read-only when added (PR #687, work mesh activity in project
    // channels): listProjectThreads and listThreadEvents both go through the
    // adapter's private `get()` (HTTP GET, no body) and hit hq-pro read
    // handlers that ENFORCE the company boundary rather than cross it —
    // handleListEvents 403s when the thread's companyUid does not match the
    // requested one.
    const workMeshKeys = Object.keys(adapter.workMesh).sort();
    expect(workMeshKeys).toEqual([
      "getProjectView",
      "listProjectThreads",
      "listThreadEvents",
      "migrateSession",
      "readLocalSnapshot",
    ]);
    expect(workMeshKeys).not.toContain("organizeSession");
    expect(workMeshKeys).not.toContain("correctSession");
    expect(workMeshKeys).not.toContain("rebindSession");

    expect(typeof WEB_PATHS.workMeshSessionMigrate).toBe("function");
    // destinationCompanyUid is typed on MigrateSessionRequest — web posts the
    // opaque body and never names the field in WEB_PATHS / routing helpers.
    expect(
      Object.keys(WEB_PATHS).filter((k) => k.includes("destinationCompany")),
    ).toEqual([]);
    expect("destinationCompanyUid" satisfies keyof MigrateSessionRequest).toBe(
      "destinationCompanyUid",
    );
  });
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { WebPlatformAdapter, WEB_PATHS } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));

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
    const body = {
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
    const adapterSrc = readFileSync(join(here, "../adapter.ts"), "utf8");
    const webSrc = readFileSync(join(here, "./index.ts"), "utf8");
    const workMeshBlock = adapterSrc.slice(
      adapterSrc.indexOf("export interface WorkMeshApi"),
      adapterSrc.indexOf("export interface PlatformAdapter"),
    );
    expect(workMeshBlock).toContain("migrateSession");
    expect(workMeshBlock).not.toMatch(/organizeSession|correctSession|rebindSession/);
    expect(webSrc).toContain("workMeshSessionMigrate");
    // destinationCompanyUid is typed only on MigrateSessionRequest — web posts the opaque body.
    expect(webSrc.match(/destinationCompanyUid/g) ?? []).toEqual([]);
    expect(adapterSrc.match(/destinationCompanyUid/g)?.length).toBe(1);
  });
});

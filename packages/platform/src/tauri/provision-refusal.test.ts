/**
 * A member who may not add bots gets 403 from the provision-options read,
 * and for a company with the New Bot flow the body names the people to ask.
 * The adapters must hand that on (review A-C3: the code and the list were
 * dropped, and the New Bot screen showed a dead button).
 */
import { describe, expect, it } from "vitest";

import { TauriPlatformAdapter } from "./index.js";
import { createSyncPlatformAdapter } from "./sync-adapter.js";
import { createAgentsAdminsFromBody, withCreateAgentsAdmins } from "./provision-refusal.js";

const REFUSAL_BODY = JSON.stringify({
  error: "Forbidden: createAgents capability required",
  code: "CREATE_AGENTS_NOT_ALLOWED",
  admins: [
    { personUid: "prs_corey", displayName: "Corey" },
    { personUid: "prs_dana", displayName: " Dana " },
  ],
});

const invokeRefused = async (cmd: string) => {
  if (cmd === "hq_pro_fetch") return { status: 403, body: REFUSAL_BODY };
  throw new Error(`unexpected command ${cmd}`);
};

const EXPECTED = {
  ok: false,
  code: "CREATE_AGENTS_NOT_ALLOWED",
  status: 403,
  message: "Forbidden: createAgents capability required",
  admins: [
    { personUid: "prs_corey", displayName: "Corey" },
    { personUid: "prs_dana", displayName: "Dana" },
  ],
};

describe("provision-options refusal", () => {
  it("keeps the code, the status and the people to ask on the Sync adapter", async () => {
    const adapter = createSyncPlatformAdapter({ invoke: invokeRefused, requestPolicy: { throttle: null } });
    await expect(adapter.agents.getProvisionOptions("cmp_acme")).resolves.toMatchObject(EXPECTED);
  });

  it("keeps the code, the status and the people to ask on the Tauri adapter", async () => {
    const adapter = new TauriPlatformAdapter({ invoke: invokeRefused });
    await expect(adapter.agents.getProvisionOptions("cmp_acme")).resolves.toMatchObject(EXPECTED);
  });

  it("answers a plain 403 with its status and no list", async () => {
    const adapter = createSyncPlatformAdapter({
      invoke: async () => ({ status: 403, body: '{"error":"Forbidden: createAgents capability required"}' }),
      requestPolicy: { throttle: null },
    });
    const result = await adapter.agents.getProvisionOptions("cmp_acme");
    expect(result).toMatchObject({ ok: false, code: "http-403", status: 403 });
    expect("admins" in result).toBe(false);
  });

  it("returns the options unchanged when the read succeeds", async () => {
    const adapter = createSyncPlatformAdapter({
      invoke: async () => ({ status: 200, body: '{"options":[],"catalogVersion":"v1","defaultInstanceType":"t4g.medium"}' }),
      requestPolicy: { throttle: null },
    });
    await expect(adapter.agents.getProvisionOptions("cmp_acme")).resolves.toEqual({
      ok: true,
      value: { options: [], catalogVersion: "v1", defaultInstanceType: "t4g.medium" },
    });
  });

  it("reads only well-formed rows, and never more than ten", () => {
    expect(createAgentsAdminsFromBody(null)).toEqual([]);
    expect(createAgentsAdminsFromBody("not json")).toEqual([]);
    expect(createAgentsAdminsFromBody('{"admins":"Corey"}')).toEqual([]);
    expect(
      createAgentsAdminsFromBody(
        JSON.stringify({ admins: [null, "Corey", { personUid: "prs_1" }, { displayName: "No uid" }, { personUid: "prs_2", displayName: "Lee" }] }),
      ),
    ).toEqual([{ personUid: "prs_2", displayName: "Lee" }]);
    const many = Array.from({ length: 30 }, (_, i) => ({ personUid: `prs_${i}`, displayName: `Person ${i}` }));
    expect(createAgentsAdminsFromBody(JSON.stringify({ admins: many }))).toHaveLength(10);
    // A success is never given a list.
    expect(withCreateAgentsAdmins({ ok: true, value: 1 }, REFUSAL_BODY)).toEqual({ ok: true, value: 1 });
  });
});

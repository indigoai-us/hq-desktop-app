/**
 * hard-stop-readiness US-018: every client parser reads hq-pro's plan-limit
 * refusal as a readable sentence plus the server's upgrade link.
 *
 * Fixtures are the exact shapes hq-pro emits: the hard-stop body built by
 * `evaluatePlanHardStopFromInputs` (with and without the `code` US-004 adds),
 * the legacy membership block, and the legacy personal presign item.
 */
import { describe, expect, it, vi } from "vitest";

import {
  PLAN_LIMIT_EXCEEDED,
  PLAN_LIMIT_REACHED,
  PLAN_UPGRADE_HOSTS,
  approvedPlanUpgradeUrl,
  describePlanLimitResource,
  hqProFailure,
  isPlanLimitFailure,
  parseHqProErrorBody,
} from "./plan-limit.js";
import { createSyncPlatformAdapter } from "./tauri/sync-adapter.js";
import { TauriPlatformAdapter } from "./tauri/index.js";
import { WebPlatformAdapter } from "./web/index.js";

const UPGRADE_URL = "https://hq.computer/companies/acme/billing?upgrade=1";

/** `evaluatePlanHardStopFromInputs` for files.create on an over-storage company. */
const HARD_STOP_BODY = {
  error: "plan_limit_reached",
  code: "PLAN_LIMIT_EXCEEDED",
  status: 402,
  blocked: "files.create",
  resources: [
    { resource: "storageBytes", used: 10_995_116_278, limit: 10_737_418_240 },
  ],
  message: "New files are paused while Acme is over its Starter limits.",
  fixOptions: { storageBytes: 10_737_418_240 },
  upgradeUrl: UPGRADE_URL,
};

/** Same body before US-004 adds `code` (hq-pro main today). */
const { code: _omitCode, ...HARD_STOP_BODY_WITHOUT_CODE } = HARD_STOP_BODY;

/** membership.ts legacy block (members.create). */
const LEGACY_MEMBERSHIP_BODY = {
  code: "PLAN_LIMIT_EXCEEDED",
  resource: "users",
  used: 5,
  limit: 5,
  requiredPlan: "team",
  upgradeUrl: "https://hq.computer/billing",
};

/** personalPresignSkipError — one item inside a 200 presign `results[]`. */
const LEGACY_PERSONAL_PRESIGN_ITEM = {
  key: "knowledge/notes.md",
  op: "put",
  error: "New files are paused while your personal HQ is over its limits.",
  code: "PLAN_LIMIT_REACHED",
  upgradeUrl: "https://hq.computer/billing",
};

const STORAGE_SENTENCE =
  "New files are paused while Acme is over its Starter limits. Storage: 10.2 GB of 10 GB used.";

describe("parseHqProErrorBody", () => {
  it("uses the hard-stop message, names the over resource, and keeps the link", () => {
    const parsed = parseHqProErrorBody(
      402,
      JSON.stringify(HARD_STOP_BODY),
      "POST /v1/files/presign failed",
    );
    expect(parsed).toEqual({
      code: PLAN_LIMIT_EXCEEDED,
      message: STORAGE_SENTENCE,
      planLimit: true,
      upgradeUrl: UPGRADE_URL,
    });
  });

  it("recognises the body by its error token when code is absent", () => {
    const parsed = parseHqProErrorBody(
      402,
      JSON.stringify(HARD_STOP_BODY_WITHOUT_CODE),
      "fallback",
    );
    expect(parsed.code).toBe(PLAN_LIMIT_EXCEEDED);
    expect(parsed.message).toBe(STORAGE_SENTENCE);
    expect(parsed.message).not.toContain("plan_limit_reached");
    expect(parsed.upgradeUrl).toBe(UPGRADE_URL);
  });

  it("reads the legacy membership block", () => {
    const parsed = parseHqProErrorBody(
      402,
      JSON.stringify(LEGACY_MEMBERSHIP_BODY),
      "fallback",
    );
    expect(parsed).toEqual({
      code: PLAN_LIMIT_EXCEEDED,
      message: "Your plan limit is reached. Members: 5 of 5 used.",
      planLimit: true,
      upgradeUrl: "https://hq.computer/billing",
    });
  });

  it("reads the legacy personal presign item", () => {
    const parsed = parseHqProErrorBody(
      200,
      JSON.stringify(LEGACY_PERSONAL_PRESIGN_ITEM),
      "fallback",
    );
    expect(parsed).toEqual({
      code: PLAN_LIMIT_REACHED,
      message: LEGACY_PERSONAL_PRESIGN_ITEM.error,
      planLimit: true,
      upgradeUrl: "https://hq.computer/billing",
    });
  });

  it("keeps the error text of ordinary failures", () => {
    expect(
      parseHqProErrorBody(403, '{"error":"Forbidden","code":"ACL_DENIED"}', "x"),
    ).toEqual({ code: "ACL_DENIED", message: "Forbidden", planLimit: false });
    expect(parseHqProErrorBody(500, "<html>oops</html>", "GET /x failed")).toEqual(
      { code: "http-500", message: "GET /x failed", planLimit: false },
    );
    // API Gateway's generic body keeps the status default (channel delete
    // relies on it to say the route is unsupported).
    expect(parseHqProErrorBody(404, '{"message":"Not Found"}', "x")).toEqual({
      code: "http-404",
      message: "x",
      planLimit: false,
    });
  });

  it("keeps a feature gate's own code and does not call it a limit", () => {
    const parsed = parseHqProErrorBody(
      402,
      JSON.stringify({
        code: "MEETING_PLAN_REQUIRED",
        error: "Meetings need the Team plan",
        upgradeUrl: UPGRADE_URL,
      }),
      "x",
    );
    expect(parsed).toEqual({
      code: "MEETING_PLAN_REQUIRED",
      message: "Meetings need the Team plan",
      planLimit: false,
      upgradeUrl: UPGRADE_URL,
    });
  });

  it("drops an upgrade link on a host hq-pro never returns", () => {
    const parsed = parseHqProErrorBody(
      402,
      JSON.stringify({
        ...HARD_STOP_BODY,
        upgradeUrl: "https://app.indigo-hq.com/billing/upgrade",
      }),
      "x",
    );
    expect(parsed.planLimit).toBe(true);
    expect(parsed).not.toHaveProperty("upgradeUrl");
  });
});

describe("approvedPlanUpgradeUrl", () => {
  it("allows exactly the host hq-pro returns", () => {
    expect(PLAN_UPGRADE_HOSTS).toEqual(["hq.computer"]);
    for (const url of [
      "https://hq.computer/billing",
      "https://hq.computer/billing/upgrade",
      "https://hq.computer/companies/acme/billing?upgrade=1",
      "https://hq.computer/signin?callbackUrl=%2Fapi%2Fcompanies%2Fcmp_1%2Fbilling%2Fupgrade",
    ]) {
      expect(approvedPlanUpgradeUrl(url)).toBe(new URL(url).toString());
    }
  });

  it.each([
    ["the retired app host", "https://app.indigo-hq.com/billing/upgrade"],
    ["the marketing host", "https://hqforwork.com/pricing"],
    ["a lookalike host", "https://hq.computer.example.com/billing"],
    ["a subdomain", "https://evil.hq.computer/billing"],
    ["plain http", "http://hq.computer/billing"],
    ["credentials", "https://user:pw@hq.computer/billing"],
    ["a custom port", "https://hq.computer:8443/billing"],
    ["a local scheme", "file:///etc/passwd"],
    ["garbage", "not a url"],
  ])("rejects %s", (_name, url) => {
    expect(approvedPlanUpgradeUrl(url)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(approvedPlanUpgradeUrl(undefined)).toBeNull();
    expect(approvedPlanUpgradeUrl(42)).toBeNull();
  });
});

describe("describePlanLimitResource", () => {
  it("formats each limit the hard stops arm on", () => {
    expect(describePlanLimitResource({ resource: "users", used: 6, limit: 5 })).toBe(
      "Members: 6 of 5 used.",
    );
    expect(describePlanLimitResource({ resource: "secrets", used: 10, limit: 10 })).toBe(
      "Secrets: 10 of 10 used.",
    );
    expect(
      describePlanLimitResource({ resource: "integrations", used: 1, limit: 1 }),
    ).toBe("Integrations: 1 of 1 used.");
    expect(
      describePlanLimitResource({ resource: "storageBytes", used: null, limit: null }),
    ).toBe("Storage: limit reached.");
  });
});

describe("hqProFailure / isPlanLimitFailure", () => {
  it("only carries upgradeUrl when present", () => {
    const withLink = hqProFailure(
      parseHqProErrorBody(402, JSON.stringify(HARD_STOP_BODY), "x"),
    );
    expect(withLink).toEqual({
      ok: false,
      reason: "error",
      code: PLAN_LIMIT_EXCEEDED,
      message: STORAGE_SENTENCE,
      upgradeUrl: UPGRADE_URL,
    });
    expect(isPlanLimitFailure(withLink)).toBe(true);
    const plain = hqProFailure(parseHqProErrorBody(500, "", "boom"));
    expect(Object.keys(plain)).not.toContain("upgradeUrl");
    expect(isPlanLimitFailure(plain)).toBe(false);
  });
});

describe("adapters map the 402 body instead of the error token", () => {
  const integrity = { checksumSha256: "c", contentSha256: "d" };
  const expected = {
    ok: false,
    reason: "error",
    code: PLAN_LIMIT_EXCEEDED,
    message: STORAGE_SENTENCE,
    upgradeUrl: UPGRADE_URL,
  };

  it("Sync (Tauri) adapter hq_pro_fetch path", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "hq_pro_fetch") {
        return { status: 402, body: JSON.stringify(HARD_STOP_BODY) };
      }
      throw new Error(`unexpected command ${cmd}`);
    });
    const adapter = createSyncPlatformAdapter({
      invoke,
      fetch: (() => {
        throw new Error("production must not use window.fetch");
      }) as unknown as typeof globalThis.fetch,
      requestPolicy: { throttle: null, sleep: async () => {} },
    });
    const result = await adapter.files.presignVaultPut(
      "cmp_acme",
      "chat/attachments/chan/chn_1/f/report.pdf",
      "application/pdf",
      integrity,
    );
    expect(result).toEqual(expected);
  });

  it("web adapter", async () => {
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: async () =>
        new Response(JSON.stringify(HARD_STOP_BODY), { status: 402 }),
    });
    const result = await adapter.files.presignVaultPut(
      "cmp_acme",
      "k",
      "application/pdf",
      integrity,
    );
    expect(result).toEqual(expected);
  });

  it("legacy Tauri adapter", async () => {
    const adapter = new TauriPlatformAdapter({
      invoke: async (cmd: string) => {
        if (cmd === "hq_pro_fetch") {
          return { status: 402, body: JSON.stringify(LEGACY_MEMBERSHIP_BODY) };
        }
        throw new Error(`unexpected command ${cmd}`);
      },
    });
    const result = await adapter.identity.updateProfile({ displayName: "A" });
    expect(result).toEqual({
      ok: false,
      reason: "error",
      code: PLAN_LIMIT_EXCEEDED,
      message: "Your plan limit is reached. Members: 5 of 5 used.",
      upgradeUrl: "https://hq.computer/billing",
    });
  });
});

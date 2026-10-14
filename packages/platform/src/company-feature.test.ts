/**
 * `identity.hasCompanyFeature`: one company's value for a flag.
 *
 * The person-only `hasFeature` gate asks `/v1/flags/resolve` with no company,
 * so it cannot answer for a company flag. This read names the company, asks
 * once, and fails closed: only an exact `true` in a valid snapshot is on.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_AGENT_CREATION_FLAG,
  LEGACY_TO_REGISTRY,
  createHqProFlagFetch,
  resolveCompanyFeature,
} from "./flags.js";
import { TauriPlatformAdapter } from "./tauri/index.js";
import { createSyncPlatformAdapter } from "./tauri/sync-adapter.js";
import { WebPlatformAdapter } from "./web/index.js";

const FLAG = DESKTOP_AGENT_CREATION_FLAG;
const COMPANY = "cmp_01KQ2RYAHXHDPCTY9GPQPTH3DG";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

/** An `invoke` that answers `hq_pro_fetch` with one fixed response. */
function invokeAnswering(
  calls: Invocation[],
  answer: unknown | (() => unknown),
): (cmd: string, args?: Record<string, unknown>) => Promise<unknown> {
  return async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd !== "hq_pro_fetch") throw new Error(`unexpected ${cmd}`);
    return typeof answer === "function" ? (answer as () => unknown)() : answer;
  };
}

function snapshot(flags: Record<string, unknown>): {
  status: number;
  body: string;
} {
  return { status: 200, body: JSON.stringify({ version: 7, flags }) };
}

async function read(answer: unknown | (() => unknown)): Promise<{
  value: boolean;
  calls: Invocation[];
}> {
  const calls: Invocation[] = [];
  const value = await resolveCompanyFeature(
    createHqProFlagFetch(invokeAnswering(calls, answer)),
    FLAG,
    COMPANY,
  );
  return { value, calls };
}

describe("resolveCompanyFeature", () => {
  it("is true when the company's snapshot holds the flag as true", async () => {
    const { value, calls } = await read(snapshot({ [FLAG]: true }));
    expect(value).toBe(true);
    // One request, to the resolve route, naming the company.
    expect(calls).toEqual([
      {
        cmd: "hq_pro_fetch",
        args: {
          url: `/v1/flags/resolve?companyUid=${COMPANY}`,
          method: "GET",
          body: null,
        },
      },
    ]);
  });

  it("is false when the company's snapshot holds the flag as false", async () => {
    const { value, calls } = await read(snapshot({ [FLAG]: false }));
    expect(value).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("is false when the snapshot has no such key", async () => {
    const { value } = await read(snapshot({ "agents.claude-provider": true }));
    expect(value).toBe(false);
  });

  it("is false for a 400 (a company uid the route rejects)", async () => {
    const { value, calls } = await read({
      status: 400,
      // A body that would read as on must not count when the status is not 200.
      body: JSON.stringify({ version: 7, flags: { [FLAG]: true } }),
    });
    expect(value).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("is false for a 403 (the person is not a member of the company)", async () => {
    const { value } = await read({
      status: 403,
      body: JSON.stringify({ error: "forbidden" }),
    });
    expect(value).toBe(false);
  });

  it("is false for any other status, including a 304 and a 500", async () => {
    expect((await read({ status: 304, body: "" })).value).toBe(false);
    expect((await read({ status: 500, body: "boom" })).value).toBe(false);
    expect(
      (
        await read({
          status: 201,
          body: JSON.stringify({ version: 7, flags: { [FLAG]: true } }),
        })
      ).value,
    ).toBe(false);
  });

  it("is false for a malformed body", async () => {
    // Not JSON at all.
    expect((await read({ status: 200, body: "<html>" })).value).toBe(false);
    // JSON, but not a snapshot: no version.
    expect(
      (await read({ status: 200, body: JSON.stringify({ flags: { [FLAG]: true } }) }))
        .value,
    ).toBe(false);
    // A flags map that is not a map.
    expect(
      (await read({ status: 200, body: JSON.stringify({ version: 7, flags: [FLAG] }) }))
        .value,
    ).toBe(false);
    // An empty body.
    expect((await read({ status: 200, body: "" })).value).toBe(false);
  });

  it("is false unless the value is exactly true", async () => {
    // A non-boolean anywhere in the map makes the whole body unrecognised,
    // the same rule the registry client applies.
    expect((await read(snapshot({ [FLAG]: "true" }))).value).toBe(false);
    expect((await read(snapshot({ [FLAG]: 1 }))).value).toBe(false);
    expect((await read(snapshot({ [FLAG]: null }))).value).toBe(false);
  });

  it("is false, and does not reject, when the request throws", async () => {
    const { value, calls } = await read(() => {
      throw new Error("Not signed in: no session");
    });
    expect(value).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("is false when the request does not answer in time", async () => {
    vi.useFakeTimers();
    try {
      const calls: Invocation[] = [];
      const pending = resolveCompanyFeature(
        createHqProFlagFetch(
          invokeAnswering(calls, () => new Promise<unknown>(() => {})),
        ),
        FLAG,
        COMPANY,
        { timeoutMs: 2_000 },
      );
      let settled: boolean | null = null;
      void pending.then((value) => {
        settled = value;
      });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("encodes the company uid as a query value", async () => {
    const calls: Invocation[] = [];
    await resolveCompanyFeature(
      createHqProFlagFetch(invokeAnswering(calls, snapshot({ [FLAG]: true }))),
      FLAG,
      "cmp_a&flag=x #y",
    );
    expect(calls[0]?.args?.url).toBe(
      "/v1/flags/resolve?companyUid=cmp_a%26flag%3Dx%20%23y",
    );
  });

  it("asks nothing and is false without a flag or a company", async () => {
    const calls: Invocation[] = [];
    const fetchFn = createHqProFlagFetch(
      invokeAnswering(calls, snapshot({ [FLAG]: true })),
    );
    expect(await resolveCompanyFeature(fetchFn, FLAG, "  ")).toBe(false);
    expect(await resolveCompanyFeature(fetchFn, "", COMPANY)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("does not read a key inherited from the object prototype", async () => {
    const calls: Invocation[] = [];
    const value = await resolveCompanyFeature(
      createHqProFlagFetch(invokeAnswering(calls, snapshot({}))),
      "constructor",
      COMPANY,
    );
    expect(value).toBe(false);
  });
});

describe("identity.hasCompanyFeature", () => {
  it("is in the registry table only for the rail's company-scoped hasFeature read", () => {
    // On the rail `hasFeature(flag, { companyUid })` reads this flag for one
    // company (the direct create), so the table carries it. A read with no
    // company still says nothing about a company; the tests below hold
    // `hasCompanyFeature` to the company's own answer.
    expect(LEGACY_TO_REGISTRY[FLAG]).toBe(FLAG);
  });

  it("sync adapter asks the resolve route for that company and returns its value", async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: invokeAnswering(calls, snapshot({ [FLAG]: true })),
    });
    await expect(
      adapter.identity.hasCompanyFeature?.(FLAG, COMPANY),
    ).resolves.toBe(true);
    expect(calls.map((call) => call.args?.url)).toEqual([
      `/v1/flags/resolve?companyUid=${COMPANY}`,
    ]);
  });

  it("sync adapter is false for a company without the flag and for a refusal", async () => {
    const off = createSyncPlatformAdapter({
      invoke: invokeAnswering([], snapshot({ [FLAG]: false })),
    });
    await expect(off.identity.hasCompanyFeature?.(FLAG, COMPANY)).resolves.toBe(
      false,
    );
    const refused = createSyncPlatformAdapter({
      invoke: invokeAnswering([], { status: 403, body: "{}" }),
    });
    await expect(
      refused.identity.hasCompanyFeature?.(FLAG, COMPANY),
    ).resolves.toBe(false);
  });

  it("sync adapter asks once per call: it keeps no cache of its own", async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: invokeAnswering(calls, snapshot({ [FLAG]: true })),
    });
    await adapter.identity.hasCompanyFeature?.(FLAG, COMPANY);
    await adapter.identity.hasCompanyFeature?.(FLAG, COMPANY);
    expect(calls).toHaveLength(2);
  });

  it("TauriPlatformAdapter asks the resolve route for that company", async () => {
    const calls: Invocation[] = [];
    const adapter = new TauriPlatformAdapter({
      invoke: invokeAnswering(calls, snapshot({ [FLAG]: true })),
    });
    await expect(
      adapter.identity.hasCompanyFeature?.(FLAG, COMPANY),
    ).resolves.toBe(true);
    expect(calls.map((call) => call.args?.url)).toEqual([
      `/v1/flags/resolve?companyUid=${COMPANY}`,
    ]);
    const down = new TauriPlatformAdapter({
      invoke: invokeAnswering([], { status: 503, body: "down" }),
    });
    await expect(
      down.identity.hasCompanyFeature?.(FLAG, COMPANY),
    ).resolves.toBe(false);
  });

  it("web adapter is false and asks the network nothing", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      headers: { Authorization: "Bearer test-token" },
    });
    await expect(
      adapter.identity.hasCompanyFeature?.(FLAG, COMPANY),
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

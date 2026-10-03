// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OUTPOST_PATHS, type AdapterResult, type Json } from "@hq/platform";
import OutpostPage from "./OutpostPage.svelte";
import { createOutpostRefresher, OUTPOST_SETUP_URL, type OutpostReadApi } from "./outpost-live.js";
import { EMPTY_INTERPOLATION, writeOutpostCache } from "./outpost-model.js";
import { noOutpost } from "./outpost-live.js";

const T0 = Date.parse("2026-10-02T18:00:00Z");

// Shapes follow hq-pro: StatusResponse from POST /outpost/status and
// { statuses: toPublicJobStatus(...)[] } from GET /outpost/jobs/status.
const STATUS = {
  userId: "u-1",
  instanceName: "hq-outpost-u1",
  staticIp: "203.0.113.7",
  region: "us-west-2",
  state: "ready",
  rcPort: 7777,
  instanceState: "running",
  platform: "ec2",
  rootVolumeSizeGb: 40,
  diskUsedPercent: 31,
  diskTelemetryUpdatedAt: new Date(T0 - 4 * 60_000).toISOString(),
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: new Date(T0 - 30 * 60_000).toISOString(),
};
const JOBS = {
  statuses: [
    {
      owner_id: "u-1",
      job_id: "nightly-digest",
      readiness: "ready",
      last_run_at: new Date(T0 - 2 * 3_600_000).toISOString(),
      last_exit: 0,
      next_actions: [],
      updated_at: new Date(T0 - 2 * 3_600_000).toISOString(),
      cache_guidance_seconds: 30,
    },
    {
      owner_id: "u-1",
      job_id: "crm-refresh",
      readiness: "blocked",
      last_run_at: new Date(T0 - 7 * 60_000).toISOString(),
      last_exit: 1,
      failure_class: "secrets",
      next_actions: ["add CRM_TOKEN to the vault"],
      updated_at: new Date(T0 - 7 * 60_000).toISOString(),
      cache_guidance_seconds: 30,
    },
  ],
};

const ok = (value: Json): AdapterResult<Json> => ({ ok: true, value });

function api(status: AdapterResult<Json>, jobs: AdapterResult<Json> = ok(JOBS as unknown as Json)) {
  return {
    getMyOutpostStatus: vi.fn(async () => status),
    listMyOutpostJobs: vi.fn(async () => jobs),
  } satisfies OutpostReadApi;
}

describe("Outpost live read (QA-069)", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    writeOutpostCache("personal", { ...noOutpost(null), provisioned: null });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function mountWith(props: Record<string, unknown>) {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(OutpostPage, { target, props });
    flushSync();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    return target;
  }

  it("requests the caller's own status and job rows from hq-pro", () => {
    expect(OUTPOST_PATHS.status).toBe("/outpost/status");
    expect(OUTPOST_PATHS.jobsStatus).toBe("/outpost/jobs/status");
  });

  it("maps real status and job rows into the page", async () => {
    const client = api(ok(STATUS as unknown as Json));
    const target = await mountWith({ api: client });
    expect(client.getMyOutpostStatus).toHaveBeenCalledTimes(1);
    expect(client.listMyOutpostJobs).toHaveBeenCalledTimes(1);
    expect(target.querySelector("[data-testid='outpost-online']")?.textContent).toBe("Online");
    const host = target.querySelector("[data-testid='outpost-host']")?.textContent ?? "";
    expect(host).toContain("hq-outpost-u1");
    expect(host).toContain("us-west-2");
    expect(host).toContain("40 GB disk");
    const results = [...target.querySelectorAll("[data-testid='job-last-result']")].map((n) => n.textContent);
    expect(results).toEqual(["ok · 2h ago · exit 0", "failed · 7m ago · exit 1"]);
    const runs = [...target.querySelectorAll("[data-testid='run-when']")].map((n) => n.textContent);
    expect(runs[0]).toContain("7m ago");
    expect(runs[1]).toContain("2h ago");
    expect(target.querySelector("[data-testid='outpost-offline-banner']")).toBeNull();
  });

  it("shows Offline from the real instance state", async () => {
    const target = await mountWith({ api: api(ok({ ...STATUS, instanceState: "stopped" } as unknown as Json)) });
    expect(target.querySelector("[data-testid='outpost-online']")?.textContent).toBe("Offline");
    const banner = (target.querySelector("[data-testid='outpost-offline-banner']")?.textContent ?? "").replace(/\s+/g, " ");
    expect(banner).toContain("No report since");
    expect(banner).not.toMatch(EMPTY_INTERPOLATION);
  });

  it("shows No Outpost yet with a set-up link when hq-pro has no row", async () => {
    const open = vi.fn();
    const target = await mountWith({
      api: api({ ok: false, reason: "error", code: "http-404", message: "not found" }),
      openExternal: open,
    });
    expect(target.querySelector("[data-testid='outpost-empty']")?.textContent).toContain("No Outpost yet");
    (target.querySelector("[data-testid='outpost-setup']") as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledWith(OUTPOST_SETUP_URL);
    expect(target.querySelectorAll("[data-testid='job-last-result']")).toHaveLength(0);
  });

  it("shows No scheduled jobs and No runs yet for a box with no job rows", async () => {
    const target = await mountWith({ api: api(ok(STATUS as unknown as Json), ok({ statuses: [] })) });
    expect(target.querySelector("[data-testid='outpost-no-jobs']")?.textContent).toBe("No scheduled jobs");
    expect(target.querySelector("[data-testid='outpost-no-runs']")?.textContent).toBe("No runs yet");
  });

  it("rejects instead of inventing data when the client is missing or a read fails", async () => {
    await expect(createOutpostRefresher(null)()).rejects.toThrow("no Outpost API");
    await expect(
      createOutpostRefresher(api({ ok: false, reason: "error", code: "http-500" }))(),
    ).rejects.toThrow("http-500");
  });

  it("ships no sample Outpost names in production code", () => {
    const root = join(__dirname, "..");
    const banned = ["attio-call-sync", "standup-brief", "knowledge-pulse", "corey-outpost", "SHA256:4kq9"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|svelte)$/.test(name) && !/\.(test|fixture)\./.test(name) && path.includes("outpost")) {
          const text = readFileSync(path, "utf8");
          for (const word of banned) if (text.includes(word)) offenders.push(`${path}: ${word}`);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

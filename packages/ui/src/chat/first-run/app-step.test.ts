import { describe, expect, it, vi } from "vitest";

import {
  appStepCopy,
  appSummary,
  appsForKind,
  catalogEntries,
  createAppConnectRunner,
  type AppConnectResult,
  type FirstRunApp,
} from "./app-step.js";
import { FIRST_RUN_BANNED_DASHES } from "./visual-first-run.js";

const ENTRIES = [
  { name: "Granola", domain: "granola.ai", authClass: "none" as const, entryId: "e1" },
  { name: "Fathom", domain: "https://www.fathom.video/", authClass: "oauth" as const },
  { name: "Loom", domain: "loom.com", authClass: "key" as const },
  { name: "Zoom", domain: "zoom.us" },
  { name: "Linear", domain: "linear.app", authClass: "oauth" as const },
  { name: "Jira", domain: "atlassian.com" },
  { name: "Asana", domain: "asana.com" },
  { name: "Notion", domain: "notion.so" },
  { name: "Sentry", domain: "sentry.io" },
  { name: "Granola again", domain: "granola.ai" },
  { name: "No domain" },
  { name: "Bad", domain: "/etc/passwd" },
];

describe("catalog filter (the catalog has no category: filtered here)", () => {
  it("lists note takers for Note taker, keyless first, one per domain", () => {
    expect(appsForKind(ENTRIES, "notes").map((a) => a.domain)).toEqual(["fathom.video", "granola.ai", "zoom.us", "loom.com"]);
    expect(appsForKind(ENTRIES, "notes").find((a) => a.domain === "granola.ai")).toEqual({
      domain: "granola.ai",
      name: "Granola",
      description: "",
      entryId: "e1",
      authClass: "none",
    });
  });

  it("lists trackers for Project management and nothing else", () => {
    expect(appsForKind(ENTRIES, "projects").map((a) => a.name)).toEqual(["Asana", "Jira", "Linear"]);
  });

  it("reads the catalog envelope and ignores anything else", () => {
    expect(catalogEntries({ ok: true, entries: ENTRIES })).toHaveLength(ENTRIES.length);
    expect(catalogEntries(null)).toEqual([]);
    expect(catalogEntries({ entries: "x" })).toEqual([]);
  });
});

describe("copy", () => {
  it("names the assistant and the company, without dashes", () => {
    for (const kind of ["notes", "projects"] as const) {
      const copy = appStepCopy(kind, "Pickles", "Acme");
      expect(copy.copy).toContain("Pickles");
      expect(copy.copy).toContain("Acme");
      for (const text of Object.values(copy)) for (const dash of FIRST_RUN_BANNED_DASHES) expect(text).not.toContain(dash);
    }
    expect(appSummary({ name: "Granola", domain: "granola.ai" }, true)).toBe("Granola, connected");
    expect(appSummary(null, true)).toBe("Skipped");
    expect(appSummary(null, false)).toBe("Not set up");
  });
});

describe("one connect at a time", () => {
  const app = (domain: string, authClass: FirstRunApp["authClass"] = "none"): FirstRunApp => ({
    domain,
    name: domain,
    description: "",
    entryId: null,
    authClass,
  });

  it("shows connecting at once, ignores repeat presses and other apps, and stops after one is connected", async () => {
    let resolve!: (r: AppConnectResult) => void;
    const run = vi.fn(() => new Promise<AppConnectResult>((r) => (resolve = r)));
    const runner = createAppConnectRunner(run, () => undefined);
    runner.connect(app("granola.ai"));
    expect(runner.current()).toEqual({ state: "connecting", domain: "granola.ai" });
    runner.connect(app("granola.ai"));
    runner.connect(app("zoom.us"));
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    resolve({ ok: true });
    await vi.waitFor(() => expect(runner.current().state).toBe("connected"));
    runner.connect(app("zoom.us"));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("never starts a key app (it needs a pasted key)", () => {
    const run = vi.fn(async (): Promise<AppConnectResult> => ({ ok: true }));
    const runner = createAppConnectRunner(run, () => undefined);
    runner.connect(app("loom.com", "key"));
    expect(runner.current()).toEqual({ state: "idle" });
    expect(run).not.toHaveBeenCalled();
  });

  it("a failure keeps its reason and Retry runs the same app again; a throw is a plain sentence", async () => {
    const run = vi
      .fn<() => Promise<AppConnectResult>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ok: true });
    const runner = createAppConnectRunner(run, () => undefined);
    runner.connect(app("linear.app"));
    await vi.waitFor(() =>
      expect(runner.current()).toEqual({ state: "failed", domain: "linear.app", reason: "Could not connect that app. Try again.", retry: true }),
    );
    runner.retry();
    await vi.waitFor(() => expect(runner.current().state).toBe("connected"));
    expect(run).toHaveBeenCalledTimes(2);
  });
});

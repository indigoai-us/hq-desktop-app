import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeStageId,
  allSettled,
  buildInitialStages,
  buildStagesFromManifest,
  countSettledStages,
  createSetupProgressTracker,
  failedRequiredStages,
  resetSetupProgressTracker,
  setupRetryAttempt,
  setupRetrySubStatusText,
  trackSetupProgress,
  friendlySetupBands,
  isContentRetryEligible,
  isHardStageTimeoutMessage,
  isStageSkipEligible,
  isTransientSetupStageFailure,
  resumeStartStageFromManifest,
  setStageStatus,
  setupAutoRetryDelayMs,
  setupCompletionResult,
  setupNeedsAttention,
  setupProgressPercent,
  setupStageRecoveryAction,
  stageAutoRetryLimit,
  stageCommandInvocations,
  stageSkipThresholdMs,
  stageTimeoutMs,
  StageTimeoutError,
  STAGE_LABELS,
  STAGE_ORDER,
  UPGRADE_STAGE_ORDER,
  setupStageOrder,
  DEFAULT_STAGE_SKIP_THRESHOLD_MS,
  DEFAULT_STAGE_TIMEOUT_MS,
  withTimeout,
  type StageId,
  type StageState,
} from "./onboarding-setup";

describe("onboarding setup stages", () => {
  it("skips HQ extract when the folder is already an HQ", () => {
    expect(setupStageOrder(true)).toEqual(UPGRADE_STAGE_ORDER);
    expect(setupStageOrder(true)).toEqual(["mesh"]);
    expect(setupStageOrder(false)).toContain("content");
    expect(setupStageOrder(false).at(-1)).toBe("mesh");
  });

  it("builds the initial stage list in order with all stages pending", () => {
    const stages = buildInitialStages();

    expect(stages).toHaveLength(STAGE_ORDER.length);
    expect(stages.map((stage) => stage.id)).toEqual(STAGE_ORDER);
    expect(stages.map((stage) => stage.label)).toEqual(
      STAGE_ORDER.map((id) => STAGE_LABELS[id]),
    );
    expect(stages.every((stage) => stage.status === "pending")).toBe(true);
  });

  it("settles only when every stage is ok or failed", () => {
    const pending = buildInitialStages();
    const running = setStageStatus(pending, "deps", "running");
    const settled: StageState[] = STAGE_ORDER.map((id, index) => ({
      id,
      label: STAGE_LABELS[id],
      status: index % 2 === 0 ? "ok" : "failed",
      error: index % 2 === 0 ? null : "non-fatal failure",
    }));

    expect(allSettled(pending)).toBe(false);
    expect(allSettled(running)).toBe(false);
    expect(allSettled(settled)).toBe(true);
  });

  it("applies status transitions without mutating other stages", () => {
    const stages = buildInitialStages();
    const running = setStageStatus(stages, "git-init", "running");
    const failed = setStageStatus(
      running,
      "git-init",
      "failed",
      "missing command",
    );

    expect(stages.find((stage) => stage.id === "git-init")?.status).toBe(
      "pending",
    );
    expect(running.find((stage) => stage.id === "git-init")).toMatchObject({
      status: "running",
      error: null,
    });
    expect(failed.find((stage) => stage.id === "git-init")).toMatchObject({
      status: "failed",
      error: "missing command",
    });
    expect(failed.find((stage) => stage.id === "deps")?.status).toBe("pending");
  });
});

describe("install manifest resume state", () => {
  it("resumes at the first incomplete manifest stage", () => {
    const manifest = {
      schemaVersion: 1,
      installerVersion: "0.0.0-test",
      installPath: "/tmp/HQ",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: null,
      steps: {
        content: { status: "ok" as const },
        deps: { status: "failed" as const, error: "node failed" },
      },
    };

    expect(resumeStartStageFromManifest(manifest)).toBe("deps");
    expect(buildStagesFromManifest(manifest).slice(0, 3)).toMatchObject([
      { id: "content", status: "ok" },
      { id: "deps", status: "pending" },
      { id: "initial-sync", status: "pending" },
    ]);
  });
});

describe("setup attention summary", () => {
  it("does not ask for attention when required stages all succeed", () => {
    const stages: StageState[] = buildInitialStages().map((stage) => ({
      ...stage,
      status: "ok",
    }));

    expect(setupNeedsAttention(stages)).toBe(false);
    expect(failedRequiredStages(stages)).toEqual([]);
  });

  it("reports failed required stages with their labels and messages", () => {
    const stages = setStageStatus(
      buildInitialStages().map((stage) => ({ ...stage, status: "ok" })),
      "content",
      "failed",
      "template download failed",
    );

    expect(setupNeedsAttention(stages)).toBe(true);
    expect(failedRequiredStages(stages)).toEqual([
      {
        id: "content",
        label: STAGE_LABELS.content,
        message: "template download failed",
      },
    ]);
    expect(setupCompletionResult(stages)).toMatchObject({
      needsAttention: true,
      failedStages: [
        {
          id: "content",
          label: STAGE_LABELS.content,
          message: "template download failed",
        },
      ],
    });
  });

  it("uses an honest fallback message when a required failure has no detail", () => {
    const stages = setStageStatus(buildInitialStages(), "deps", "failed", null);

    expect(failedRequiredStages(stages)).toEqual([
      {
        id: "deps",
        label: STAGE_LABELS.deps,
        message: "Stage failed with no detail recorded.",
      },
    ]);
  });
});

describe("setup progress percent", () => {
  it("creeps toward the next stage while a stage is running", () => {
    expect(
      setupProgressPercent({
        settledCount: 2,
        totalStages: 10,
        hasRunningStage: true,
        stageCreep: 0.5,
      }),
    ).toBe(25);
  });

  it("does not creep without an active running stage", () => {
    expect(
      setupProgressPercent({
        settledCount: 2,
        totalStages: 10,
        hasRunningStage: false,
        stageCreep: 0.5,
      }),
    ).toBe(20);
  });

  it("returns 100 once all stages are settled", () => {
    expect(
      setupProgressPercent({
        settledCount: STAGE_ORDER.length,
        totalStages: STAGE_ORDER.length,
        hasRunningStage: false,
        stageCreep: 0,
        allDone: true,
      }),
    ).toBe(100);
  });
});

describe("friendly setup bands", () => {
  it("marks the first band active at the start", () => {
    expect(friendlySetupBands(0)).toEqual([
      { label: "Laying the groundwork", status: "active" },
      { label: "Building your workspace", status: "pending" },
      {
        label: "Bringing in your AI workers and workflows",
        status: "pending",
      },
      { label: "Making it yours", status: "pending" },
      { label: "Syncing across your devices", status: "pending" },
    ]);
  });

  it("maps each 20 percent band to done, active, and pending states", () => {
    expect(friendlySetupBands(42).map((band) => band.status)).toEqual([
      "done",
      "done",
      "active",
      "pending",
      "pending",
    ]);
  });

  it("marks every band done at completion and clamps out-of-range values", () => {
    expect(friendlySetupBands(100).map((band) => band.status)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
    ]);
    expect(friendlySetupBands(150).map((band) => band.status)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
    ]);
    expect(friendlySetupBands(-12).map((band) => band.status)).toEqual([
      "active",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
  });
});

describe("stage skip affordance", () => {
  it("uses legacy-length thresholds for skip eligibility", () => {
    expect(stageSkipThresholdMs("git-init")).toBe(
      DEFAULT_STAGE_SKIP_THRESHOLD_MS,
    );
    expect(stageSkipThresholdMs("content")).toBeGreaterThan(
      DEFAULT_STAGE_SKIP_THRESHOLD_MS,
    );
    expect(stageSkipThresholdMs("deps")).toBeGreaterThan(
      DEFAULT_STAGE_SKIP_THRESHOLD_MS,
    );
  });

  it("only enables skip for the active stage after its threshold", () => {
    const threshold = stageSkipThresholdMs("deps");

    expect(
      isStageSkipEligible({
        activeStageId: "deps",
        stageId: "deps",
        elapsedMs: threshold - 1,
      }),
    ).toBe(false);
    expect(
      isStageSkipEligible({
        activeStageId: "content",
        stageId: "deps",
        elapsedMs: threshold,
      }),
    ).toBe(false);
    expect(
      isStageSkipEligible({
        activeStageId: "deps",
        stageId: "deps",
        elapsedMs: threshold,
        setupDone: true,
      }),
    ).toBe(false);
    expect(
      isStageSkipEligible({
        activeStageId: "deps",
        stageId: "deps",
        elapsedMs: threshold,
      }),
    ).toBe(true);
  });
});

describe("content retry eligibility", () => {
  it("enables retry for failed content or a stalled active content fetch only", () => {
    const failed = setStageStatus(
      buildInitialStages(),
      "content",
      "failed",
      "boom",
    ).find((stage) => stage.id === "content");
    expect(
      isContentRetryEligible({
        contentStage: failed,
        activeStageId: null,
      }),
    ).toBe(true);

    const running = setStageStatus(
      buildInitialStages(),
      "content",
      "running",
    ).find((stage) => stage.id === "content");
    expect(
      isContentRetryEligible({
        contentStage: running,
        activeStageId: "content",
        progress: { stalled: true },
      }),
    ).toBe(true);
    expect(
      isContentRetryEligible({
        contentStage: running,
        activeStageId: "content",
        progress: { stalled: false },
      }),
    ).toBe(false);
    expect(
      isContentRetryEligible({
        contentStage: running,
        activeStageId: "deps",
        progress: { stalled: true },
      }),
    ).toBe(false);
  });
});

describe("automatic setup recovery", () => {
  it("bounds auto-retry attempts to transient setup failures", () => {
    expect(stageAutoRetryLimit("content")).toBe(2);
    expect(stageAutoRetryLimit("git-init")).toBe(0);

    expect(
      isTransientSetupStageFailure({
        stageId: "content",
        message: "Template download stalled before receiving more data.",
      }),
    ).toBe(true);
    expect(
      isTransientSetupStageFailure({
        stageId: "packages",
        message: "npm registry timeout fetching package",
      }),
    ).toBe(true);
    expect(
      isTransientSetupStageFailure({
        stageId: "content",
        message: "template tarball not found (404)",
      }),
    ).toBe(false);
    expect(
      isTransientSetupStageFailure({
        stageId: "deps",
        message: "permission denied writing toolchain",
      }),
    ).toBe(false);
  });

  it("uses exponential backoff for automatic retries", () => {
    expect(setupAutoRetryDelayMs(0)).toBe(1000);
    expect(setupAutoRetryDelayMs(1)).toBe(1000);
    expect(setupAutoRetryDelayMs(2)).toBe(2000);
    expect(setupAutoRetryDelayMs(10)).toBe(8000);
  });

  it("plans retry, skip, or final failure without user interaction", () => {
    expect(
      setupStageRecoveryAction({
        stageId: "content",
        message: "network error downloading template: connection reset",
        retryCount: 0,
      }),
    ).toEqual({
      kind: "retry",
      delayMs: 1000,
      nextRetryCount: 1,
      message: "network error downloading template: connection reset",
    });

    expect(
      setupStageRecoveryAction({
        stageId: "content",
        message: "Template download stalled before receiving more data.",
        retryCount: 2,
      }),
    ).toEqual({
      kind: "fail",
      message: "Template download stalled before receiving more data.",
    });

    const hardTimeout = "This step took too long (over 390s) and was skipped.";
    expect(isHardStageTimeoutMessage(hardTimeout)).toBe(true);
    expect(
      setupStageRecoveryAction({
        stageId: "indexing",
        message: hardTimeout,
        retryCount: 0,
      }),
    ).toEqual({ kind: "skip", message: hardTimeout });
  });
});

describe("stage timeouts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives content/deps/indexing longer budgets and everything else the default", () => {
    expect(stageTimeoutMs("content")).toBeGreaterThan(DEFAULT_STAGE_TIMEOUT_MS);
    expect(stageTimeoutMs("deps")).toBeGreaterThan(DEFAULT_STAGE_TIMEOUT_MS);
    expect(stageTimeoutMs("indexing")).toBeGreaterThan(
      DEFAULT_STAGE_TIMEOUT_MS,
    );
    expect(stageTimeoutMs("git-init")).toBe(DEFAULT_STAGE_TIMEOUT_MS);
    expect(stageTimeoutMs("menubar")).toBe(DEFAULT_STAGE_TIMEOUT_MS);
  });

  it("resolves when the work settles before the timeout", async () => {
    const promise = withTimeout(
      Promise.resolve("done"),
      1000,
      () => new Error("should not fire"),
    );
    await expect(promise).resolves.toBe("done");
  });

  it("rejects with the timeout error when the work hangs past the budget", async () => {
    // A promise that never settles — models a hung `hq reindex`.
    const hung = new Promise<void>(() => {});
    const guarded = withTimeout(
      hung,
      90_000,
      () => new StageTimeoutError("indexing", 90_000),
    );
    const assertion = expect(guarded).rejects.toBeInstanceOf(StageTimeoutError);
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
  });

  it("propagates the underlying rejection without waiting for the timeout", async () => {
    const failing = Promise.reject(new Error("backend blew up"));
    await expect(
      withTimeout(failing, 90_000, () => new Error("timeout")),
    ).rejects.toThrow("backend blew up");
  });

  it("disables the timeout when ms is not positive", async () => {
    await expect(
      withTimeout(Promise.resolve("ok"), 0, () => new Error("nope")),
    ).resolves.toBe("ok");
  });

  it("runs the timeout cancellation hook before rejecting", async () => {
    const hung = new Promise<void>(() => {});
    const onTimeoutCancel = vi.fn();
    const guarded = withTimeout(
      hung,
      90_000,
      () => new StageTimeoutError("deps", 90_000),
      onTimeoutCancel,
    );
    const assertion = expect(guarded).rejects.toBeInstanceOf(StageTimeoutError);
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
    expect(onTimeoutCancel).toHaveBeenCalledTimes(1);
  });
});

describe("stage command invocations", () => {
  it("adds Claude settings PATH configuration after dependency install", () => {
    expect(stageCommandInvocations("deps", { installPath: "/tmp/hq" })).toEqual(
      [
        { command: "install_deps", required: true },
        {
          command: "configure_claude_settings_path",
          args: { hqPath: "/tmp/hq" },
          required: false,
        },
      ],
    );
  });

  it("skips the Claude settings follow-up until an install path is resolved", () => {
    expect(stageCommandInvocations("deps", { installPath: null })).toEqual([
      { command: "install_deps", required: true },
    ]);
  });
});

describe("setup progress never moves backward", () => {
  const BAND_RANK: Record<string, number> = { pending: 0, active: 1, done: 2 };

  /** The displayed-progress pipeline the setup surfaces read, in order. */
  function createVisit(order: StageId[] = STAGE_ORDER) {
    const tracker = createSetupProgressTracker();
    let stages = buildInitialStages(order);
    const percents: number[] = [];
    const bandRanks: number[][] = [];

    function sample(stageCreep = 0): number {
      const percent = trackSetupProgress(
        tracker,
        setupProgressPercent({
          settledCount: countSettledStages(stages),
          totalStages: order.length,
          hasRunningStage: activeStageId(stages) !== null,
          stageCreep,
          allDone: allSettled(stages),
        }),
      );
      percents.push(percent);
      bandRanks.push(
        friendlySetupBands(percent).map((band) => BAND_RANK[band.status]!),
      );
      return percent;
    }

    return {
      get stages() {
        return stages;
      },
      set(id: StageId, status: StageState["status"], error: string | null = null) {
        stages = setStageStatus(stages, id, status, error);
      },
      rebuild() {
        stages = buildInitialStages(order);
      },
      restart() {
        resetSetupProgressTracker(tracker);
      },
      sample,
      expectMonotonic() {
        for (let i = 1; i < percents.length; i += 1) {
          expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1]!);
        }
        for (let i = 1; i < bandRanks.length; i += 1) {
          const previous = bandRanks[i - 1]!;
          for (const [band, rank] of bandRanks[i]!.entries()) {
            expect(rank).toBeGreaterThanOrEqual(previous[band]!);
          }
        }
      },
      percents,
    };
  }

  it("keeps a retrying stage active and unsettled instead of pending", () => {
    const visit = createVisit();
    visit.set("content", "ok");
    visit.set("deps", "running");
    const running = visit.sample(0.9);

    visit.set("deps", "retrying", "network timeout while fetching the registry");
    expect(countSettledStages(visit.stages)).toBe(1);
    expect(activeStageId(visit.stages)).toBe("deps");
    expect(allSettled(visit.stages)).toBe(false);
    expect(failedRequiredStages(visit.stages)).toEqual([]);
    expect(visit.sample(0.9)).toBe(running);
    visit.expectMonotonic();
  });

  it("holds the displayed percent when the stage list is rebuilt mid-visit", () => {
    const visit = createVisit();
    visit.set("content", "ok");
    visit.set("deps", "ok");
    visit.set("initial-sync", "running");
    const beforeRebuild = visit.sample(0.8);
    expect(beforeRebuild).toBeGreaterThan(25);

    visit.rebuild();
    expect(visit.sample()).toBe(beforeRebuild);
    visit.expectMonotonic();
  });

  it("starts over only when the visit does", () => {
    const visit = createVisit();
    visit.set("content", "ok");
    visit.set("deps", "running");
    expect(visit.sample(0.5)).toBeGreaterThan(10);

    visit.restart();
    visit.rebuild();
    expect(visit.sample()).toBe(0);
  });

  it("still counts a stage that will not be retried as settled", () => {
    const stages = setStageStatus(
      buildInitialStages(),
      "git-init",
      "failed",
      "Stage failed with no detail recorded.",
    );

    expect(countSettledStages(stages)).toBe(1);
    expect(activeStageId(stages)).toBeNull();
    expect(failedRequiredStages(stages).map((stage) => stage.id)).toEqual([
      "git-init",
    ]);
  });

  it("numbers a retry attempt against the stage's own budget", () => {
    expect(setupRetryAttempt("content", 1)).toEqual({ attempt: 2, of: 3 });
    expect(setupRetryAttempt("content", 2)).toEqual({ attempt: 3, of: 3 });
    expect(setupRetryAttempt("deps", 9)).toEqual({ attempt: 2, of: 2 });
    expect(setupRetrySubStatusText(setupRetryAttempt("content", 1))).toBe(
      "Retrying — attempt 2 of 3…",
    );
  });
});

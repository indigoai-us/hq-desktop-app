import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRecordingTracker,
  SDK_CRASH_CMD,
  stopRecordingIfActive,
} from "./recording-tracker.mjs";

// Run with: `node --test` (from sidecar/recall-sdk-bridge). Uses the Node
// built-in test runner so the sidecar has zero dev-dependencies — the menubar
// CI gate (npm run build = vite build) doesn't bundle the sidecar, so we keep
// these tests self-contained and runnable on demand.
//
// Regression for the "Stopping…" hang: when the Recall SDK server process
// SIGABRT-loops mid-recording it never fires `recording-ended`, so the bridge
// never emits `recording:ended` and the UI is stranded forever. The tracker
// lets the bridge synthesize a terminal `recording:error` for every in-flight
// recording on a fatal SDK event. These tests pin that behaviour without
// booting the real SDK.

describe("createRecordingTracker", () => {
  it("tracks started recordings and clears ended ones", () => {
    const t = createRecordingTracker();
    t.started("win-1");
    t.started("win-2");
    assert.deepEqual(t.activeWindowIds().sort(), ["win-1", "win-2"]);

    t.ended("win-1");
    assert.deepEqual(t.activeWindowIds(), ["win-2"]);
  });

  it("ignores empty / non-string window ids", () => {
    const t = createRecordingTracker();
    t.started("");
    t.started(undefined);
    t.started(null);
    assert.deepEqual(t.activeWindowIds(), []);
  });

  it("drainOnFatal emits one recording:error per in-flight recording", () => {
    const t = createRecordingTracker();
    t.started("win-1");
    t.started("win-2");

    const events = t.drainOnFatal("Recording engine crashed: SIGABRT");

    assert.deepEqual(events, [
      {
        type: "recording:error",
        cmd: SDK_CRASH_CMD,
        windowId: "win-1",
        message: "Recording engine crashed: SIGABRT",
      },
      {
        type: "recording:error",
        cmd: SDK_CRASH_CMD,
        windowId: "win-2",
        message: "Recording engine crashed: SIGABRT",
      },
    ]);
  });

  it("drainOnFatal is idempotent — error+shutdown a crash fires only emits once", () => {
    const t = createRecordingTracker();
    t.started("win-1");

    const first = t.drainOnFatal("crash");
    const second = t.drainOnFatal("crash again");

    assert.equal(first.length, 1);
    assert.deepEqual(second, []); // already drained; no double-fire
    assert.deepEqual(t.activeWindowIds(), []);
  });

  it("drainOnFatal with no active recordings emits nothing", () => {
    const t = createRecordingTracker();
    assert.deepEqual(t.drainOnFatal("crash"), []);
  });

  it("falls back to a default message when no reason is given", () => {
    const t = createRecordingTracker();
    t.started("win-1");
    const [event] = t.drainOnFatal("");
    assert.equal(event.message, "Recording engine stopped unexpectedly");
  });

  it("a normally-ended recording is not failed by a later crash", () => {
    const t = createRecordingTracker();
    t.started("win-1");
    t.ended("win-1"); // clean stop confirmed by the SDK
    assert.deepEqual(t.drainOnFatal("later crash"), []);
  });
});

describe("stopRecordingIfActive", () => {
  it("issues stopRecording when the closing window is actively recording", async () => {
    const t = createRecordingTracker();
    t.started("win-1");
    const calls = [];
    const sdk = {
      stopRecording: async (arg) => {
        calls.push(arg.windowId);
      },
    };

    const stopped = await stopRecordingIfActive(t, sdk, "win-1");

    assert.equal(stopped, true);
    assert.deepEqual(calls, ["win-1"]);
    // Tracker is NOT cleared here — the SDK's recording-ended event owns that.
    assert.deepEqual(t.activeWindowIds(), ["win-1"]);
  });

  it("is a no-op when the closing window isn't recording", async () => {
    const t = createRecordingTracker();
    let called = false;
    const sdk = {
      stopRecording: async () => {
        called = true;
      },
    };

    const stopped = await stopRecordingIfActive(t, sdk, "win-unknown");

    assert.equal(stopped, false);
    assert.equal(called, false);
  });

  it("ignores empty / non-string window ids", async () => {
    const t = createRecordingTracker();
    t.started("win-1");
    const sdk = { stopRecording: async () => {} };
    assert.equal(await stopRecordingIfActive(t, sdk, ""), false);
    assert.equal(await stopRecordingIfActive(t, sdk, undefined), false);
  });
});

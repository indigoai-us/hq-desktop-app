import { describe, expect, it } from "vitest";

import {
  applyWakingCheckFailure,
  applyWakingStatus,
  awaitingHello,
  beginWakingSession,
  recordWakingCheckFailure,
  recordWakingHello,
  recordWakingHelloAsked,
  helloRequestKey,
  markWakingHelloAsking,
  reopenWakingSession,
  resumeWakingSession,
  SIGN_IN_CONFIRM_LATE_MS,
  SIGN_IN_CONFIRM_SLOW_MS,
  signInConfirmMessage,
  US001_MEDIAN_WAKING_ESTIMATE_MS,
  WAKING_ESTIMATE_MS,
  WAKING_NUDGE_FAST_WINDOW_MS,
  WAKING_NUDGE_MS,
  WAKING_NUDGE_SLOW_MS,
  WAKING_POLL_FAILING_LONG_MS,
  WAKING_POLL_FAILING_MS,
  WAKING_POLL_FAST_WINDOW_MS,
  WAKING_POLL_MS,
  WAKING_POLL_SLOW_MS,
  wakingBotGone,
  wakingNudgeIntervalMs,
  wakingPollDelayMs,
  wakingStatusLine,
  wakingStopFromFailure,
} from "./waking-model";

const STARTED = 1_700_000_000_000;

function session() {
  return beginWakingSession({
    agentUid: "agt_nova",
    channelId: "chn_nova",
    companyUid: "cmp_acme",
    name: "Nova",
    now: STARTED,
  });
}

describe("waking model", () => {
  it("never counts down from US-001's median, which was mostly waiting", () => {
    // Regression (owner walkthrough 2026-10-02): the screen opened with
    // "About 21 minutes left."
    expect(US001_MEDIAN_WAKING_ESTIMATE_MS).toBe(1_244_000);
    expect(WAKING_ESTIMATE_MS).toBeLessThanOrEqual(180_000);
    expect(wakingStatusLine(session(), STARTED)).toBe("Starting up. About 3 minutes left.");
    expect(wakingStatusLine(session(), STARTED + 130_000)).toBe("Starting up. About a minute left.");
  });

  const CODEX_PAIRING = { url: "https://auth.openai.com/codex/device", code: "TEST-CODE" };
  const signInStep = (status: string) => ({ phase: "waiting", steps: [{ name: "runtime", status: "done" }, { name: "codex-auth", status }] });

  it("keeps the approval on screen when a status read comes back without the code", () => {
    // Regression (owner walkthrough 2026-10-02): the approval left the screen
    // before the sign-in was finished. The server reads the code on a
    // best-effort basis and answers pairing: null when that read fails.
    const asked = applyWakingStatus(session(), { agent: { provider: "codex" }, setupState: signInStep("waiting"), pairing: CODEX_PAIRING }, STARTED + 150_000);
    const emptyRead = applyWakingStatus(asked, { agent: { provider: "codex" }, setupState: signInStep("waiting"), pairing: null }, STARTED + 153_000);
    expect(emptyRead.approval).toMatchObject({ provider: "codex", code: "TEST-CODE" });
    expect(wakingStatusLine(emptyRead, STARTED + 153_000)).toBe("One thing from you.");
    expect(emptyRead.signedInAt ?? null).toBeNull();
  });

  it("takes the machine's own codex-auth: ok as the sign-in, even while the step is still pending", () => {
    // Live (owner, 2026-10-03, "Super Duper"): under the chat-first setup
    // order the codex-auth step runs after the runtime install. The person
    // had signed in twice; the heartbeat said codex-auth: ok; the step said
    // pending; the screen kept saying "We don't see it yet."
    const asked = applyWakingStatus(session(), { agent: { provider: "codex" }, setupState: signInStep("pending"), pairing: CODEX_PAIRING }, STARTED + 150_000);
    expect(asked.approval).not.toBeNull();
    const machineOk = {
      agent: { provider: "codex", runtime: { lastHeartbeat: { at: "2026-10-03T19:28:08.085Z", components: { "codex-auth": "ok", sync: "unknown" } } } },
      setupState: { phase: "waiting", stepOrder: "chat-first", chatReady: false, steps: [{ name: "runtime-install", status: "running" }, { name: "codex-auth", status: "pending" }] },
      pairing: CODEX_PAIRING,
    };
    const signedIn = applyWakingStatus(asked, machineOk, STARTED + 200_000);
    expect(signedIn.approval).toBeNull();
    expect(signedIn.signedInAt).toBe(STARTED + 200_000);
    expect(signedIn.phase).toBe("waking");
    // The server's live check counts too, before any heartbeat carries it.
    const liveCheck = {
      agent: { provider: "codex", runtime: { lastHeartbeat: { components: { "codex-auth": "unknown" } } } },
      setupState: signInStep("pending"),
      brainSignIn: { codex: { signedIn: true, verifiedAt: "2026-10-03T20:47:30.000Z" } },
      pairing: null,
    };
    expect(applyWakingStatus(asked, liveCheck, STARTED + 200_000).signedInAt).toBe(STARTED + 200_000);
    // A heartbeat that says anything else leaves the step rule in charge.
    const notYet = {
      agent: { provider: "codex", runtime: { lastHeartbeat: { components: { "codex-auth": "unknown" } } } },
      setupState: signInStep("pending"),
      pairing: CODEX_PAIRING,
    };
    expect(applyWakingStatus(asked, notYet, STARTED + 200_000).signedInAt ?? null).toBeNull();
  });

  it("keeps saying it is checking for two minutes after 'I've signed in' before asking the person to look again", () => {
    // Live (owner, 2026-10-03, "Big Nuts"): the machine reports the sign-in
    // on its next heartbeat, 60 to 90 seconds later; "We don't see it yet" at
    // twenty seconds read as a failure.
    expect(signInConfirmMessage(0, "Codex")).toBe("Checking your sign-in.");
    expect(signInConfirmMessage(SIGN_IN_CONFIRM_SLOW_MS, "Codex")).toBe(
      "Checking your sign-in. The bot's machine reports it within a minute or two.",
    );
    expect(signInConfirmMessage(SIGN_IN_CONFIRM_LATE_MS - 1, "Codex")).toMatch(/^Checking your sign-in\./);
    expect(signInConfirmMessage(SIGN_IN_CONFIRM_LATE_MS, "Codex")).toBe(
      "We still don't see it. Make sure you finished on the Codex page, then check again.",
    );
    expect(SIGN_IN_CONFIRM_LATE_MS).toBeGreaterThanOrEqual(90_000);
  });

  it("says the sign-in worked and starts a fresh estimate for the rest", () => {
    const asked = applyWakingStatus(session(), { agent: { provider: "codex" }, setupState: signInStep("waiting"), pairing: CODEX_PAIRING }, STARTED + 150_000);
    // Ten minutes of the person being away moves nothing.
    const stillAsked = applyWakingStatus(asked, { agent: { provider: "codex" }, setupState: signInStep("waiting"), pairing: CODEX_PAIRING }, STARTED + 750_000);
    expect(stillAsked.progress).toBe(asked.progress);

    const signedIn = applyWakingStatus(stillAsked, { setupState: signInStep("done"), pairing: null }, STARTED + 760_000);
    expect(signedIn.approval).toBeNull();
    expect(signedIn.signedInAt).toBe(STARTED + 760_000);
    expect(wakingStatusLine(signedIn, STARTED + 760_000)).toBe("You're signed in. Finishing up. About a minute left.");
    expect(wakingStatusLine(signedIn, STARTED + 830_000)).toMatch(/^You're signed in\. Finishing up\. This is taking longer than usual\./);
    expect(wakingStatusLine(signedIn, STARTED + 760_000)).not.toMatch(/taking longer/i);
    expect(signedIn.progress).toBeGreaterThan(stillAsked.progress);
    expect(signedIn.progress).toBeLessThan(100);
  });

  const CHAT_READY = {
    setupState: {
      phase: "waiting",
      steps: [
        { name: "codex-auth", status: "done" },
        { name: "sync", status: "done" },
        { name: "channels", status: "done" },
        { name: "audit", status: "waiting" },
        { name: "runtime-install", status: "pending" },
      ],
    },
  };

  it("does not wait for the company file download before the bot can talk", () => {
    // Regression (owner, 2026-10-02): "The goal of this is speed to live."
    // The final check waits on the company file download, which the server
    // runs in the background; the waking screen must not wait for it.
    const canChat = applyWakingStatus(session(), CHAT_READY, STARTED + 190_000);
    expect(canChat.chatReadyAt).toBe(STARTED + 190_000);
    expect(awaitingHello(canChat)).toBe(true);
    expect(canChat.approval).toBeNull();
  });

  it("takes the person to chat only once the bot's first message is there", () => {
    // Regression (owner walkthrough 2026-10-02): the person was taken to the
    // conversation, wrote twice, and the bot did not answer. "The new bot
    // needs to be able to reply immediately ... once we take the user there."
    const canChat = applyWakingStatus(session(), CHAT_READY, STARTED + 190_000);
    expect(canChat.phase).toBe("waking");
    expect(canChat.progress).toBeLessThan(100);
    expect(wakingStatusLine(canChat, STARTED + 190_000)).toBe(
      "Almost there. Nova is writing its first message to you.",
    );

    const asked = recordWakingHelloAsked(canChat, STARTED + 191_000);
    const still = applyWakingStatus(asked, CHAT_READY, STARTED + 220_000);
    expect(still.phase).toBe("waking");
    expect(still.helloAskedAt).toBe(STARTED + 191_000);

    const spoke = recordWakingHello(still, STARTED + 225_000);
    expect(spoke.phase).toBe("ready");
    expect(spoke.progress).toBe(100);
    expect(wakingStatusLine(spoke, STARTED + 225_000)).toBe("Nova is live. Opening chat…");
  });

  it("stops holding for the first message after a bounded wait", () => {
    const canChat = applyWakingStatus(session(), CHAT_READY, STARTED + 190_000);
    const before = applyWakingStatus(canChat, CHAT_READY, STARTED + 190_000 + 89_000);
    const after = applyWakingStatus(canChat, CHAT_READY, STARTED + 190_000 + 90_000);
    expect(before.phase).toBe("waking");
    expect(after.phase).toBe("ready");
    expect(after.progress).toBe(100);
  });

  it("does not claim a sign-in the person never did", () => {
    const signedIn = applyWakingStatus(session(), { setupState: signInStep("done") }, STARTED + 140_000);
    expect(wakingStatusLine(signedIn, STARTED + 140_000)).toBe("Finishing up. About a minute left.");
  });

  it("lets fixtures set their own estimate", () => {
    const fixture = beginWakingSession({ agentUid: "agt_nova", channelId: "chn_nova", companyUid: "cmp_acme", name: "Nova", now: STARTED, estimateMs: 10_000 });
    expect(wakingStatusLine(fixture, STARTED + 9_999)).not.toMatch(/taking longer/i);
    expect(wakingStatusLine(fixture, STARTED + 10_001)).toMatch(/taking longer/i);
  });

  it("keeps server setup labels out of the person-facing estimate", () => {
    const next = applyWakingStatus(session(), { setupState: { phase: "runtime" } }, STARTED + 10_000);
    expect(wakingStatusLine(next, STARTED + 10_000)).toMatch(/about/i);
    expect(wakingStatusLine(next, STARTED + 10_000)).not.toMatch(/identity|membership|vault|runtime|sync|channels|audit/i);
  });

  it("shows reconnecting only after three consecutive status failures", () => {
    const once = recordWakingCheckFailure(session(), STARTED + 1_000);
    const twice = recordWakingCheckFailure(once, STARTED + 2_000);
    const three = recordWakingCheckFailure(twice, STARTED + 3_000);
    expect(wakingStatusLine(twice, STARTED + 3_000)).not.toMatch(/reconnecting/i);
    expect(wakingStatusLine(three, STARTED + 3_000)).toMatch(/reconnecting/i);
  });

  it("uses the long-running and failure copy without exposing a server reason", () => {
    expect(wakingStatusLine(session(), STARTED + WAKING_ESTIMATE_MS + 1)).toMatch(/taking longer than usual/i);
    const failed = applyWakingStatus(session(), { setupState: { phase: "failed", reason: "audit failed" } });
    expect(wakingStatusLine(failed)).toBe("We couldn't start this bot.");
  });

  it("marks the ring complete only once the bot is ready and has spoken", () => {
    const waiting = applyWakingStatus(session(), { setupState: { phase: "creating" } }, STARTED + 20_000);
    const canChat = applyWakingStatus(waiting, { setupState: { phase: "ready" } }, STARTED + 30_000);
    const ready = recordWakingHello(canChat, STARTED + 40_000);
    expect(waiting.progress).toBeLessThan(100);
    expect(canChat.progress).toBeLessThan(100);
    expect(ready.progress).toBe(100);
  });

  it("shows an approval only while the server returns a current pairing", () => {
    const pending = applyWakingStatus(session(), {
      agent: { provider: "grok" },
      setupState: { phase: "creating" },
      pairing: { url: "https://accounts.x.ai/device", code: "TEST-CODE", capturedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(wakingStatusLine(pending)).toBe("One thing from you.");
    expect(pending.approval).toMatchObject({ provider: "grok" });

    const complete = applyWakingStatus(pending, { setupState: { phase: "ready" } });
    expect(complete.approval).toBeNull();
  });

  describe("a bot that is gone or out of reach (review A-I4)", () => {
    it("stops on a status that says the bot is being taken down, with its own line", () => {
      const removing = applyWakingStatus(session(), { setupState: { phase: "deprovisioning", steps: [{ name: "codex-auth", status: "done" }, { name: "sync", status: "done" }] } }, STARTED + 9_000);
      expect(removing).toMatchObject({ phase: "stopped", stopped: "removing", approval: null });
      expect(wakingStatusLine(removing, STARTED + 9_000)).toBe("Nova is being removed.");
      expect(wakingBotGone(removing)).toBe(true);

      const removed = applyWakingStatus(session(), { agent: { setupState: { phase: "deprovisioned" } } }, STARTED + 9_000);
      expect(removed).toMatchObject({ phase: "stopped", stopped: "removed" });
      expect(wakingStatusLine(removed, STARTED + 9_000)).toBe("Nova was removed.");
    });

    it("stops on a refused status read only once it has been refused twice in a row", () => {
      // One 404 right after the create can be a read that ran ahead of the
      // write. The second one in a row is the bot being gone.
      const once = applyWakingCheckFailure(session(), { ok: false, reason: "error", code: "http-404" }, STARTED + 3_000);
      expect(once).toMatchObject({ phase: "waking", consecutiveCheckFailures: 1, stopSignals: 1 });
      const twice = applyWakingCheckFailure(once, { ok: false, reason: "error", code: "http-404" }, STARTED + 6_000);
      expect(twice).toMatchObject({ phase: "stopped", stopped: "removed" });
      expect(wakingStatusLine(twice, STARTED + 6_000)).toBe("Nova was removed.");

      // A good read in between starts the count again.
      const recovered = applyWakingStatus(once, { setupState: { phase: "creating" } }, STARTED + 6_000);
      expect(recovered.stopSignals).toBe(0);
      expect(applyWakingCheckFailure(recovered, { ok: false, code: "http-404" }, STARTED + 9_000).phase).toBe("waking");
    });

    it.each([
      [{ ok: false, code: "http-404" }, "removed", "Nova was removed."],
      [{ ok: false, code: "AGENT_NOT_FOUND", status: 404 }, "removed", "Nova was removed."],
      [{ ok: false, code: "http-403" }, "no-access", "You no longer have access to Nova."],
      [{ ok: false, code: "FORBIDDEN" }, "no-access", "You no longer have access to Nova."],
      [{ ok: false, code: "SOMETHING", status: 403 }, "no-access", "You no longer have access to Nova."],
      [{ ok: false, code: "http-401" }, "signed-out", "You're signed out of HQ. Sign in again, then open Nova from the list."],
    ])("reads %j as %s", (failure, stopped, line) => {
      expect(wakingStopFromFailure(failure)).toBe(stopped);
      const stoppedSession = applyWakingCheckFailure(applyWakingCheckFailure(session(), failure, STARTED), failure, STARTED + 3_000);
      expect(stoppedSession).toMatchObject({ phase: "stopped", stopped });
      expect(wakingStatusLine(stoppedSession, STARTED + 3_000)).toBe(line);
    });

    it("keeps waiting through failures that say nothing about the bot", () => {
      let current = session();
      for (const failure of [{ ok: false, code: "http-500" }, { ok: false, code: "http-504" }, { ok: false, code: "network" }, null, "boom"]) {
        expect(wakingStopFromFailure(failure)).toBeNull();
        current = applyWakingCheckFailure(current, failure, STARTED + 3_000);
        expect(current.phase).toBe("waking");
      }
      expect(current.consecutiveCheckFailures).toBe(5);
      expect(wakingStatusLine(current, STARTED + 3_000)).toBe("Reconnecting. Your bot is still waking up.");
      // A refusal after ordinary failures still needs to be seen twice.
      expect(applyWakingCheckFailure(current, { ok: false, code: "http-404" }, STARTED + 6_000).phase).toBe("waking");
    });

    it("does not call a signed-out app a bot that is gone", () => {
      expect(wakingBotGone({ phase: "stopped", stopped: "signed-out" })).toBe(false);
      expect(wakingBotGone({ phase: "stopped", stopped: "no-access" })).toBe(true);
      expect(wakingBotGone({ phase: "waking", stopped: null })).toBe(false);
    });

    it("waits again when a screen that stopped for a signed-out app is opened (review item 4)", () => {
      const stopped = {
        ...session(),
        phase: "stopped" as const,
        stopped: "signed-out" as const,
        stopSignals: 2,
        consecutiveCheckFailures: 2,
        signedInAt: STARTED + 30_000,
        helloAskedAt: STARTED + 40_000,
        chatReadyAt: STARTED + 40_000,
      };
      const reopened = reopenWakingSession(stopped, STARTED + 60_000);
      expect(reopened).toMatchObject({
        phase: "waking",
        stopped: null,
        stopSignals: 0,
        consecutiveCheckFailures: 0,
        // What is known about the bot is kept.
        startedAt: STARTED,
        signedInAt: STARTED + 30_000,
        helloAskedAt: STARTED + 40_000,
        chatReadyAt: STARTED + 40_000,
      });
      // One more 401 does not stop it at once: it takes two in a row again.
      expect(applyWakingCheckFailure(reopened, { ok: false, code: "http-401" }, STARTED + 61_000).phase).toBe("waking");
    });

    it("leaves every other session as it is when it is opened", () => {
      for (const stop of ["removed", "removing", "no-access"] as const) {
        const gone = { ...session(), phase: "stopped" as const, stopped: stop };
        expect(reopenWakingSession(gone, STARTED + 60_000)).toBe(gone);
      }
      const waiting = session();
      expect(reopenWakingSession(waiting, STARTED + 60_000)).toBe(waiting);
      const failed = { ...session(), phase: "failed" as const };
      expect(reopenWakingSession(failed, STARTED + 60_000)).toBe(failed);
    });

    it("starts clean again when a stopped or failed bot is retried", () => {
      const stopped = { ...session(), phase: "stopped" as const, stopped: "signed-out" as const, stopSignals: 2 };
      expect(resumeWakingSession(stopped, STARTED + 60_000)).toMatchObject({ phase: "waking", stopped: null, stopSignals: 0 });
    });
  });

  describe("how often the screen asks (review A-I7)", () => {
    it("reads the status every 3 seconds for half an hour, then every 15", () => {
      expect(wakingPollDelayMs(session(), STARTED)).toBe(WAKING_POLL_MS);
      expect(wakingPollDelayMs(session(), STARTED + WAKING_POLL_FAST_WINDOW_MS)).toBe(WAKING_POLL_MS);
      expect(wakingPollDelayMs(session(), STARTED + WAKING_POLL_FAST_WINDOW_MS + 1)).toBe(WAKING_POLL_SLOW_MS);
      expect(WAKING_POLL_SLOW_MS).toBeGreaterThanOrEqual(15_000);
    });

    it("starts the fast stretch again when the screen is opened and when the sign-in is seen", () => {
      const old = STARTED + 5 * 60 * 60_000;
      expect(wakingPollDelayMs(session(), old)).toBe(WAKING_POLL_SLOW_MS);
      // Opened just now: the person is watching.
      expect(wakingPollDelayMs(session(), old, old - 1_000)).toBe(WAKING_POLL_MS);
      expect(wakingNudgeIntervalMs(session(), old, old - 1_000)).toBe(WAKING_NUDGE_MS);
      // Signed in just now: the rest moves fast.
      const signedIn = { ...session(), signedInAt: old - 2_000 };
      expect(wakingPollDelayMs(signedIn, old)).toBe(WAKING_POLL_MS);
      expect(wakingNudgeIntervalMs(signedIn, old)).toBe(WAKING_NUDGE_MS);
    });

    it("asks for a re-check every 12 seconds for ten minutes, then once a minute", () => {
      expect(wakingNudgeIntervalMs(session(), STARTED)).toBe(WAKING_NUDGE_MS);
      expect(wakingNudgeIntervalMs(session(), STARTED + WAKING_NUDGE_FAST_WINDOW_MS)).toBe(WAKING_NUDGE_MS);
      expect(wakingNudgeIntervalMs(session(), STARTED + WAKING_NUDGE_FAST_WINDOW_MS + 1)).toBe(WAKING_NUDGE_SLOW_MS);
      expect(WAKING_NUDGE_SLOW_MS).toBe(60_000);
    });

    it("spaces out reads that keep failing, whatever the stretch", () => {
      expect(wakingPollDelayMs({ ...session(), consecutiveCheckFailures: 2 }, STARTED)).toBe(WAKING_POLL_MS);
      expect(wakingPollDelayMs({ ...session(), consecutiveCheckFailures: 3 }, STARTED)).toBe(WAKING_POLL_FAILING_MS);
      expect(wakingPollDelayMs({ ...session(), consecutiveCheckFailures: 10 }, STARTED)).toBe(WAKING_POLL_FAILING_LONG_MS);
    });

    it("comes to far fewer requests in an hour than one every 3 and 12 seconds", () => {
      const hour = 60 * 60_000;
      let reads = 0;
      for (let at = 0; at < hour; at += wakingPollDelayMs(session(), STARTED + at)) reads += 1;
      let nudges = 0;
      for (let at = 0; at < hour; at += wakingNudgeIntervalMs(session(), STARTED + at)) nudges += 1;
      expect(reads).toBeLessThanOrEqual(725);
      expect(nudges).toBeLessThanOrEqual(101);
    });
  });

  it("resumes the exact same bot after retrying", () => {
    const retried = resumeWakingSession({ ...session(), phase: "failed", chatReadyAt: STARTED + 5_000 }, STARTED + 10_000);
    expect(retried.chatReadyAt).toBeNull();
    expect(retried).toMatchObject({ agentUid: "agt_nova", channelId: "chn_nova", phase: "waking", consecutiveCheckFailures: 0 });
  });
});

describe("the hello request is marked before it is sent (review item 8)", () => {
  it("has one key per bot", () => {
    expect(helloRequestKey(" agt_nova ")).toBe("new-bot-hello-agt_nova");
  });

  it("marks the session with the time and the key, once", () => {
    const first = markWakingHelloAsking(session(), STARTED + 50_000);
    expect(first).toMatchObject({ helloAskingAt: STARTED + 50_000, helloKey: "new-bot-hello-agt_nova" });
    // Not asked yet: the request has only begun.
    expect(first.helloAskedAt ?? null).toBeNull();

    // A later screen marks nothing new: it is the same request.
    const again = markWakingHelloAsking({ ...first, helloKey: "kept-key" }, STARTED + 90_000);
    expect(again).toMatchObject({ helloAskingAt: STARTED + 50_000, helloKey: "kept-key" });
  });

  it("counts the request from when it was begun", () => {
    const marked = markWakingHelloAsking(session(), STARTED + 50_000);
    expect(recordWakingHelloAsked(marked, STARTED + 58_000).helloAskedAt).toBe(STARTED + 50_000);
    // Without a mark, from when it is recorded, as before.
    expect(recordWakingHelloAsked(session(), STARTED + 58_000).helloAskedAt).toBe(STARTED + 58_000);
  });
});

// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  FIXTURE_INITIAL_ROW,
  FIXTURE_PINS,
  FIXTURE_SETTINGS_PROFILE,
  createFixtureChatSidebarApi,
  createFixtureNotificationsApi,
  fixtureBoardFor,
  fixtureChannelStatusFor,
  fixtureFilesFor,
  fixtureMessagesFor,
  fixtureReactionsFor,
  seedFixturePins,
} from "./fixtures.js";

describe("shared v2 display fixtures", () => {
  it("opens on the designed agent-orchestrator channel", () => {
    expect(FIXTURE_INITIAL_ROW.title).toBe("agent-orchestrator");
    expect(FIXTURE_INITIAL_ROW.channelId).toBe("agent-orchestrator");
    expect(FIXTURE_INITIAL_ROW.memberCount).toBe(7);
  });

  it("injects the run-complete card + reactions for the default channel", () => {
    const messages = fixtureMessagesFor(FIXTURE_INITIAL_ROW);
    const run = messages.find((m) => m.eventId === "ao-run-complete");
    expect(run?.systemEvent).toMatchObject({
      type: "run_complete",
      title: "Nightly triage sweep — complete",
    });
    const reactions = fixtureReactionsFor(FIXTURE_INITIAL_ROW);
    expect(reactions["ao-run-complete"]?.map((r) => r.emoji)).toEqual([
      "👍",
      "🎉",
    ]);
  });

  it("supplies Board, Files, and member-status fixtures for the default channel", () => {
    const board = fixtureBoardFor(FIXTURE_INITIAL_ROW);
    expect(board?.columns.map((c) => c.id)).toEqual([
      "queued",
      "in_progress",
      "review",
      "done",
    ]);
    expect(fixtureFilesFor(FIXTURE_INITIAL_ROW).length).toBeGreaterThan(0);
    const status = fixtureChannelStatusFor(FIXTURE_INITIAL_ROW);
    expect(status?.liveAgents?.[0]?.progressPercent).toBe(62);
  });

  it("returns directory + notification feeds without throwing", async () => {
    const sidebar = createFixtureChatSidebarApi();
    const directory = await sidebar.fetchChannelDirectory(null);
    expect(directory.rows?.some((r) => r.channelId === "hq-desktop")).toBe(
      true,
    );
    const inbox = createFixtureNotificationsApi();
    const feed = await inbox.fetchNotifications({
      limit: 20,
      cursor: null,
      unreadOnly: false,
    });
    expect(
      (feed as { notifications: unknown[] }).notifications.length,
    ).toBeGreaterThan(0);
  });

  it("authors the designed PINNED set and settings profile", () => {
    expect(FIXTURE_PINS).toEqual([
      "ch:hq-desktop",
      "ch:hq-sync",
      "ch:creative-pipeline",
      "ch:book-tracker",
    ]);
    expect(FIXTURE_SETTINGS_PROFILE.email).toBe("corey@getindigo.ai");
    expect(typeof seedFixturePins).toBe("function");
  });
});

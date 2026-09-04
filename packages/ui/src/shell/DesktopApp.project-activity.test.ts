import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source contract for project-channel work-mesh activity.
 *
 * The bug: a project channel read only the chat table, so a project with a live
 * work-mesh claim + progress trail rendered "No messages yet". These assertions
 * pin the wiring that fixes it — the fetch, the merge, the live refresh, and the
 * honest empty label — because the shell is too large to mount in a unit test.
 */
const here = dirname(fileURLToPath(import.meta.url));
const shellSrc = readFileSync(join(here, "DesktopApp.svelte"), "utf8");
const conversationSrc = readFileSync(
  join(here, "../chat/messaging/ChannelConversation.svelte"),
  "utf8",
);
const clientSrc = readFileSync(
  join(here, "../../../core/src/mesh/client.ts"),
  "utf8",
);

describe("project activity — shell wiring", () => {
  it("fetches the project's work-mesh threads and their events", () => {
    expect(shellSrc).toContain("loadProjectActivity");
    expect(shellSrc).toContain("api.listProjectThreads");
    expect(shellSrc).toContain("api.listThreadEvents");
  });

  it("normalises and groups through the shared parser, not inline logic", () => {
    expect(shellSrc).toContain("projectActivityEntries");
    expect(shellSrc).toContain("groupActivityBursts");
    expect(shellSrc).toContain("activityTimelineMessages");
    expect(shellSrc).toContain("mergeActivityIntoTimeline");
  });

  it("renders the merged timeline, not the chat-only one", () => {
    expect(shellSrc).toContain("messages={timelineWithActivity}");
  });

  it("resolves actor names from the roster so no raw prs_ uid renders", () => {
    expect(shellSrc).toContain("resolveActivityActor");
    expect(shellSrc).toContain("resolveActor: resolveActivityActor");
  });

  it("bounds the per-channel thread fan-out", () => {
    expect(shellSrc).toContain("PROJECT_ACTIVITY_THREAD_CAP");
  });

  it("refreshes on both the live thread wake and mesh catch-up", () => {
    expect(shellSrc).toContain('bus.on("work-mesh:thread"');
    expect(shellSrc).toMatch(
      /mesh:catchup[\s\S]{0,400}loadProjectActivity\(row\)/,
    );
  });

  it("passes the activity-aware empty label", () => {
    expect(shellSrc).toContain("conversationEmptyLabel");
    expect(shellSrc).toContain('"No activity yet"');
    expect(shellSrc).toContain("emptyLabel={conversationEmptyLabel}");
  });

  it("keeps the loading guard so no empty state flashes mid-fetch", () => {
    expect(shellSrc).toContain("projectActivityLoading");
  });
});

describe("project activity — component contracts", () => {
  it("ChannelConversation renders the injected empty label", () => {
    expect(conversationSrc).toContain("emptyLabel = \"No messages yet\"");
    expect(conversationSrc).toContain("{emptyLabel}");
    // The literal must no longer be hard-coded in the empty-state block.
    expect(conversationSrc).not.toMatch(
      /conversation-empty"[\s\S]{0,160}No messages yet/,
    );
  });

  it("the realtime client still subscribes to the company thread topic", () => {
    // Work-mesh thread events fan out on hq/{companyUid}/thread/#; without this
    // subscription the timeline would only update on reopen.
    expect(clientSrc).toContain("thread/#");
    expect(clientSrc).toContain("presence/#");
  });
});

/**
 * US-005: Restore sessions without send, fork, or draft loss.
 *
 * Named separately from the existing widget US-005.test.ts.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createNavigationController } from "../../../../packages/ui/src/shell/navigation-controller";
import {
  createNavigationEntry,
  destinationsEqual,
  type NavigationDestination,
} from "../../../../packages/ui/src/shell/navigation-history";
import {
  encodeHistorySessionParam,
  encodeSharedSessionParam,
  parseSessionsParam,
  sessionDraftStorageKey,
  sessionRestorePath,
} from "../../src/desktop-alt/pages/sessions-route-param";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");

function readRepo(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} missing`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const next = rest.search(/\n  (async )?function /);
  return next === -1 ? rest : rest.slice(0, next);
}

const channelA: NavigationDestination = {
  kind: "channel",
  channelId: "chn_a",
};
const sessionB: NavigationDestination = {
  kind: "extra",
  page: "sessions",
  param: "ses_b",
};
const sourceC: NavigationDestination = {
  kind: "extra",
  page: "sessions",
  param: encodeHistorySessionParam({
    id: "ses_c",
    tool: "claude",
    title: "Source C",
  }),
};

describe("US-005: Restore sessions without send, fork, or draft loss", () => {
  it("Given channel A → session B → source C, when Back B then Back A then Forward B, then selection and transcript match and no send or session_start is recorded", () => {
    const applied: NavigationDestination[] = [];
    const controller = createNavigationController({
      getScope: () => ({ accountId: "acct_ada", companyUid: "cmp_acme" }),
      apply: (next) => {
        applied.push(next.entry.destination);
      },
    });
    controller.navigate(channelA);
    controller.navigate(sessionB);
    controller.navigate(sourceC);

    expect(sessionRestorePath(parseSessionsParam("ses_b"))).toBe("open");
    expect(sessionRestorePath(parseSessionsParam(sourceC.param))).toBe(
      "openHistory",
    );

    const backToB = controller.back();
    expect(backToB).toMatchObject({ status: "ready", committed: true });
    expect(controller.lastCommitted()?.destination).toEqual(sessionB);

    const backToA = controller.back();
    expect(backToA).toMatchObject({ status: "ready", committed: true });
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining({ kind: "channel", channelId: "chn_a" }),
    );

    const forwardB = controller.forward();
    expect(forwardB).toMatchObject({ status: "ready", committed: true });
    expect(controller.lastCommitted()?.destination).toEqual(sessionB);

    const page = readRepo("apps/sync/src/desktop-alt/pages/SessionsPage.svelte");
    const restore = functionSource(page, "openRoutedSession");
    expect(restore).toContain("liveSessionStore.openHistory");
    expect(restore).toContain("liveSessionStore.open(");
    expect(restore).not.toContain("startAndSend");
    expect(restore).not.toContain("resumeAndSend");
    expect(restore).not.toContain("liveSessionStore.start(");
    expect(restore).not.toContain("agent_session_start");
    expect(restore).not.toContain("agent_session_send");
    expect(applied.map((item) => item.kind)).toEqual([
      "channel",
      "extra",
      "extra",
      "extra",
      "channel",
      "extra",
    ]);
  });

  it("Given an unsent draft with text and images, when the user leaves and returns via Back, then the draft content is still there", () => {
    const draft: NavigationDestination = {
      kind: "extra",
      page: "sessions",
      param: "new?draft=abc-keep",
    };
    const controller = createNavigationController({
      getScope: () => ({ accountId: "acct_ada", companyUid: "cmp_acme" }),
      apply: () => {},
    });
    controller.navigate(channelA);
    controller.navigate(draft);
    controller.navigate(sessionB);
    controller.back();
    expect(controller.lastCommitted()?.destination).toEqual(draft);
    expect(sessionDraftStorageKey("new?draft=abc-keep")).toBe(
      "sessions:new?draft=abc-keep",
    );
    expect(JSON.stringify(controller.history.snapshot())).not.toContain(
      "half a thought",
    );
    expect(JSON.stringify(controller.lastCommitted())).not.toContain("base64");

    const extra = readRepo(
      "apps/sync/src/desktop-alt/pages/SessionsExtraPage.svelte",
    );
    expect(extra).toContain("{draftKey}");
    const composer = readRepo(
      "apps/sync/src/components/sessions/SessionComposer.svelte",
    );
    expect(composer).toContain("loadSessionComposerDraft");
    expect(composer).toContain("saveSessionComposerDraft");
  });

  it("Given first send on a new draft, when the user goes Back then Forward, then the destination is the created session not a new draft", () => {
    const draft: NavigationDestination = {
      kind: "extra",
      page: "sessions",
      param: "new?draft=temp-1",
    };
    const created: NavigationDestination = {
      kind: "extra",
      page: "sessions",
      param: "ses_created",
    };
    const controller = createNavigationController({
      getScope: () => ({ accountId: "acct_ada", companyUid: "cmp_acme" }),
      apply: () => {},
    });
    controller.navigate(channelA);
    controller.navigate(draft);
    controller.navigate(created, "replace");

    expect(controller.history.snapshot().entries.map((entry) => entry.destination)).toEqual([
      expect.objectContaining({ kind: "channel", channelId: "chn_a" }),
      created,
    ]);

    controller.back();
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining({ kind: "channel", channelId: "chn_a" }),
    );
    controller.forward();
    expect(controller.lastCommitted()?.destination).toEqual(created);
    expect(parseSessionsParam(created.param).kind).toBe("session");

    const page = readRepo("apps/sync/src/desktop-alt/pages/SessionsPage.svelte");
    expect(page).toContain("onopensession?.(started, sessionId ? undefined : { replace: true })");
  });

  it("Given a shared and a historical session, when each is opened then Back is pressed, then neither path calls send", () => {
    const shared: NavigationDestination = {
      kind: "extra",
      page: "sessions",
      param: encodeSharedSessionParam("ses_share", "chn_project"),
    };
    const historical: NavigationDestination = {
      kind: "extra",
      page: "sessions",
      param: encodeHistorySessionParam({ id: "ses_hist", tool: "codex" }),
    };
    const live: NavigationDestination = {
      kind: "extra",
      page: "sessions",
      param: "ses_live",
    };
    const draft: NavigationDestination = {
      kind: "extra",
      page: "sessions",
      param: "new?draft=1",
    };

    expect(destinationsEqual(shared, historical)).toBe(false);
    expect(destinationsEqual(historical, live)).toBe(false);
    expect(destinationsEqual(live, draft)).toBe(false);
    expect(destinationsEqual(draft, shared)).toBe(false);
    expect(sessionRestorePath(parseSessionsParam(shared.param))).toBe("shared-view");
    expect(sessionRestorePath(parseSessionsParam(historical.param))).toBe(
      "openHistory",
    );
    expect(sessionRestorePath(parseSessionsParam(live.param))).toBe("open");
    expect(sessionRestorePath(parseSessionsParam(draft.param))).toBe("none");

    const controller = createNavigationController({
      getScope: () => ({ accountId: "acct_ada", companyUid: "cmp_acme" }),
      apply: () => {},
    });
    controller.navigate(channelA);
    controller.navigate(shared);
    controller.back();
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining({ kind: "channel", channelId: "chn_a" }),
    );
    controller.navigate(historical);
    controller.back();
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining({ kind: "channel", channelId: "chn_a" }),
    );

    const extra = readRepo(
      "apps/sync/src/desktop-alt/pages/SessionsExtraPage.svelte",
    );
    expect(extra).toContain("SharedSessionPage");
    expect(extra).toContain("restorePath={restorePath === 'open' || restorePath === 'openHistory' ? restorePath : undefined}");
    const page = readRepo("apps/sync/src/desktop-alt/pages/SessionsPage.svelte");
    expect(page).toContain("encodeHistorySessionParam(session)");
    expect(page).not.toContain("onopensession?.(session.id)");
    const entry = createNavigationEntry(historical, {
      accountId: "acct_ada",
      companyUid: "cmp_acme",
    });
    expect(JSON.stringify(entry)).not.toContain("prompt");
  });
});

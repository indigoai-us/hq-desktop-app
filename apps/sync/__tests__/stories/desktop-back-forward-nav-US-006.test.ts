/**
 * US-006: Restore scroll, lifecycle, and tenant isolation.
 *
 * Named separately from the existing widget US-006.test.ts.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createNavigationController } from "../../../../packages/ui/src/shell/navigation-controller";
import {
  canonicalizeDestination,
  createNavigationEntry,
  createNavigationHistory,
  entryCompanyIsAccessible,
  type NavigationDestination,
  type NavigationScrollState,
} from "../../../../packages/ui/src/shell/navigation-history";
import {
  loadSessionComposerDraft,
  resetSessionComposerDraftsForTests,
  saveSessionComposerDraft,
  setSessionComposerDraftAccount,
} from "../../src/components/sessions/session-composer-drafts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");

function readRepo(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

const channelA: NavigationDestination = {
  kind: "channel",
  channelId: "chn_long",
};
const sessionB: NavigationDestination = {
  kind: "extra",
  page: "sessions",
  param: "ses_live",
};

describe("US-006: Restore scroll, lifecycle, and tenant isolation", () => {
  it("Given a long transcript scrolled to a message id, when the user leaves and returns, then that message is the restore anchor", () => {
    const scroll: NavigationScrollState = {
      kind: "message",
      id: "evt_mid",
      offset: 840,
    };
    let captured: NavigationScrollState | null = scroll;
    const applied: Array<NavigationScrollState | null | undefined> = [];
    const controller = createNavigationController({
      getScope: () => ({ accountId: "acct_ada", companyUid: "cmp_acme" }),
      captureScroll: () => captured,
      apply: (next) => {
        applied.push(next.entry.scroll);
      },
    });
    controller.navigate(channelA);
    controller.navigate(sessionB);
    expect(controller.history.snapshot().entries[0]?.scroll).toEqual(scroll);

    captured = { kind: "pixel", id: null, offset: 12 };
    const back = controller.back();
    expect(back).toMatchObject({ status: "ready", committed: true });
    expect(controller.lastCommitted()?.scroll).toEqual(scroll);
    expect(applied.at(-1)).toEqual(scroll);

    const shell = readRepo("packages/ui/src/shell/DesktopApp.svelte");
    expect(shell).toContain("restoreScroll={pendingRestoreScroll}");
    expect(shell).toContain("scheduleNavigationScrollRestore");
    const conversation = readRepo(
      "packages/ui/src/chat/messaging/ChannelConversation.svelte",
    );
    expect(conversation).toContain("restoreScrollPending");
    expect(conversation).toContain("if (restoreScrollPending) return");
  });

  it("Given new messages arriving on a background session, when the user is viewing another destination, then the stored scroll offset of the first session is unchanged", () => {
    let liveOffset = 640;
    const controller = createNavigationController({
      getScope: () => ({ accountId: "acct_ada", companyUid: "cmp_acme" }),
      captureScroll: () => ({
        kind: "event",
        id: "blk_user_12",
        offset: liveOffset,
      }),
      apply: () => {},
    });
    controller.navigate(sessionB);
    controller.navigate(channelA);
    expect(controller.history.snapshot().entries[0]?.scroll).toEqual({
      kind: "event",
      id: "blk_user_12",
      offset: 640,
    });
    liveOffset = 10_000;
    expect(controller.history.snapshot().entries[0]?.scroll?.offset).toBe(640);

    const page = readRepo("apps/sync/src/desktop-alt/pages/SessionsPage.svelte");
    expect(page).not.toContain("liveSessionStore.close(openedId)");
    expect(page).toContain("liveSessionStore.isOpen(next)");
    expect(page).toContain("liveSessionStore.activate(next)");
    expect(page).toContain("Background buffers stay resident");
  });

  it("Given sign-out then sign-in as another account, when the stack is inspected, then it is empty and no prior-account destination is restorable", () => {
    let accountId = "acct_ada";
    const controller = createNavigationController({
      getScope: () => ({ accountId, companyUid: "cmp_acme" }),
      apply: () => {},
    });
    controller.noteAccount("acct_ada");
    controller.navigate(channelA);
    controller.navigate(sessionB);
    expect(controller.history.snapshot().entries).toHaveLength(2);

    accountId = "acct_bea";
    controller.noteAccount("acct_bea");
    expect(controller.history.snapshot().entries).toEqual([]);
    expect(controller.lastCommitted()).toBeNull();
    expect(controller.back()).toMatchObject({
      status: "rejected",
      committed: false,
    });

    controller.navigate({ kind: "messages" });
    expect(controller.lastCommitted()?.accountId).toBe("acct_bea");
    expect(controller.history.snapshot().entries).toHaveLength(1);

    const historySrc = readRepo("packages/ui/src/shell/navigation-history.ts");
    expect(historySrc).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    const shell = readRepo("packages/ui/src/shell/DesktopApp.svelte");
    expect(shell).toContain("navigation.clear()");
    const host = readRepo("apps/sync/src/desktop-alt/HqWorkWorkShell.svelte");
    expect(host).toContain("navigation.clear()");
    expect(host).toContain("{#key authGeneration}");
  });

  it("Given a destination for a company the user can no longer access, when it is restored, then an unavailable view shows and no concealed content is rendered", () => {
    const allowed = new Set(["cmp_acme"]);
    const hidden = createNavigationEntry(
      { kind: "channel", channelId: "chn_secret" },
      { accountId: "acct_ada", companyUid: "cmp_gone" },
    );
    const visible = createNavigationEntry(channelA, {
      accountId: "acct_ada",
      companyUid: "cmp_acme",
    });
    expect(entryCompanyIsAccessible(hidden, allowed)).toBe(false);
    expect(entryCompanyIsAccessible(visible, allowed)).toBe(true);

    const applied: Array<{ availability: string; channel?: string }> = [];
    const history = createNavigationHistory();
    history.push(visible);
    history.push(hidden);
    const restoring = createNavigationController({
      history,
      getScope: () => ({ accountId: "acct_ada", companyUid: "cmp_gone" }),
      resolve: (destination, context) => {
        if (context.companyUid && !allowed.has(context.companyUid)) {
          return {
            status: "unavailable",
            destination,
            reason: "This destination is no longer available.",
          };
        }
        return { status: "ready", destination };
      },
      apply: (next) => {
        applied.push({
          availability: next.availability,
          channel:
            next.entry.destination.kind === "channel"
              ? next.entry.destination.channelId
              : undefined,
        });
      },
    });
    restoring.back();
    const result = restoring.forward();
    expect(result).toMatchObject({ status: "unavailable", committed: true });
    expect(applied.at(-1)).toEqual({
      availability: "unavailable",
      channel: "chn_secret",
    });

    const shell = readRepo("packages/ui/src/shell/DesktopApp.svelte");
    expect(shell).toContain("DESTINATION_UNAVAILABLE");
    expect(shell).toContain("selectedRow = null");
    expect(shell).toContain("liveTimeline = []");
    expect(shell).toContain('data-testid="navigation-unavailable"');
    const page = readRepo("apps/sync/src/desktop-alt/pages/SessionsPage.svelte");
    expect(page).toContain('data-testid="session-unavailable"');
    expect(page).toContain("sessionCompanyIsAccessible");
    expect(page).toContain("liveSessionStore.companyOf");
    expect(page).toContain("companyMembershipDenied");
    expect(page).toContain("if (liveSessionStore.isOpen(next))");
    expect(page).toContain("liveSessionStore.activate(next)");
  });

  it("Given an extra destination for a company the user can no longer access, when it is restored, then it is unavailable", () => {
    const allowed = new Set(["cmp_acme"]);
    const extraGone = canonicalizeDestination({
      kind: "extra",
      page: "sessions",
      param: "new?company=cmp_gone&draft=1",
    });
    expect(extraGone).toMatchObject({ companyUid: "cmp_gone" });
    const hidden = createNavigationEntry(extraGone, {
      accountId: "acct_ada",
      companyUid: null,
    });
    expect(entryCompanyIsAccessible(hidden, allowed)).toBe(false);

    const applied: Array<{ availability: string; page?: string }> = [];
    const history = createNavigationHistory();
    history.push(
      createNavigationEntry(channelA, {
        accountId: "acct_ada",
        companyUid: "cmp_acme",
      }),
    );
    history.push(hidden);
    history.back();
    const restoring = createNavigationController({
      history,
      getScope: () => ({ accountId: "acct_ada", companyUid: "cmp_gone" }),
      resolve: (destination, context) => {
        const company =
          destination.kind === "extra"
            ? (destination.companyUid ?? context.companyUid)
            : context.companyUid;
        if (company && !allowed.has(company)) {
          return {
            status: "unavailable",
            destination,
            reason: "This destination is no longer available.",
          };
        }
        return { status: "ready", destination };
      },
      apply: (next) => {
        applied.push({
          availability: next.availability,
          page:
            next.entry.destination.kind === "extra"
              ? next.entry.destination.page
              : undefined,
        });
      },
    });
    const result = restoring.forward();
    expect(result).toMatchObject({ status: "unavailable", committed: true });
    expect(applied.at(-1)).toEqual({
      availability: "unavailable",
      page: "sessions",
    });

    restoring.filterAccessible(allowed);
    expect(
      restoring.history
        .snapshot()
        .entries.some((entry) => entry.destination.kind === "extra"),
    ).toBe(false);

    const shell = readRepo("packages/ui/src/shell/DesktopApp.svelte");
    expect(shell).toContain("extraParamCompanyKey");
    expect(shell).toContain("navigation.filterAccessible(allowed)");
    expect(shell).toContain("extraDestination(");
    const host = readRepo("apps/sync/src/desktop-alt/HqWorkWorkShell.svelte");
    expect(host).toContain("companyUid: row.companyUid ?? company");
  });

  it("Given unsent drafts, when the account changes, then prior-account drafts are not restorable", () => {
    resetSessionComposerDraftsForTests();
    const key = "sessions:new?draft=shared";
    setSessionComposerDraftAccount("acct_ada");
    saveSessionComposerDraft(key, { text: "ada secret", images: [] });
    setSessionComposerDraftAccount("acct_bea");
    expect(loadSessionComposerDraft(key)).toEqual({ text: "", images: [] });
    saveSessionComposerDraft(key, { text: "bea draft", images: [] });
    setSessionComposerDraftAccount("acct_ada");
    expect(loadSessionComposerDraft(key)).toEqual({ text: "", images: [] });
    setSessionComposerDraftAccount(null);
    expect(loadSessionComposerDraft(key)).toEqual({ text: "", images: [] });
    resetSessionComposerDraftsForTests();

    const host = readRepo("apps/sync/src/desktop-alt/HqWorkWorkShell.svelte");
    expect(host).toContain("setSessionComposerDraftAccount");
    expect(host).toMatch(
      /configureSessionStarterCache\(null\);\s*setSessionComposerDraftAccount\(null\);/,
    );
    const drafts = readRepo(
      "apps/sync/src/components/sessions/session-composer-drafts.ts",
    );
    expect(drafts).toContain("function scopedKey");
    expect(drafts).toContain("drafts.clear()");
  });
});

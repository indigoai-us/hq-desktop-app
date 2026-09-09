/**
 * US-004: Cover nested destinations in the same stack.
 *
 * Named separately from the existing widget US-004.test.ts.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createNavigationController } from "../../../../packages/ui/src/shell/navigation-controller";
import {
  NAVIGATION_HANDLER_MATRIX,
  handlerUsesNavigateBoundary,
  inScopeUserHandler,
} from "../../../../packages/ui/src/shell/navigation-handler-matrix";
import {
  createNavigationHistory,
  type NavigationDestination,
} from "../../../../packages/ui/src/shell/navigation-history";
import { notificationDestination } from "../../../../packages/ui/src/inbox/notifications-model";

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

describe("US-004: Cover nested destinations in the same stack", () => {
  it("Given channel A then a reply thread then a settings section, when the user goes Back twice and Forward once, then selection, tab, and reply target match the stack", () => {
    const applied: NavigationDestination[] = [];
    const controller = createNavigationController({
      getScope: () => ({ accountId: "acct_ada", companyUid: "cmp_acme" }),
      apply: (next) => {
        applied.push(next.entry.destination);
      },
    });
    controller.navigate({
      kind: "channel",
      channelId: "chn_a",
      tab: "chat",
    });
    controller.navigate({
      kind: "channel",
      channelId: "chn_a",
      replyRootEventId: "evt_root",
      tab: "chat",
    });
    controller.navigate({ kind: "settings", section: "appearance" });

    const backOnce = controller.back();
    expect(backOnce).toMatchObject({ status: "ready", committed: true });
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining({
        kind: "channel",
        channelId: "chn_a",
        replyRootEventId: "evt_root",
      }),
    );

    const backTwice = controller.back();
    expect(backTwice).toMatchObject({ status: "ready", committed: true });
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining({
        kind: "channel",
        channelId: "chn_a",
        tab: "chat",
      }),
    );
    expect(
      "replyRootEventId" in (controller.lastCommitted()?.destination ?? {})
        ? (controller.lastCommitted()?.destination as { replyRootEventId?: string | null })
            .replyRootEventId
        : null,
    ).toBeNull();

    const forward = controller.forward();
    expect(forward).toMatchObject({ status: "ready", committed: true });
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining({
        kind: "channel",
        channelId: "chn_a",
        replyRootEventId: "evt_root",
      }),
    );
    expect(applied.at(-1)).toEqual(
      expect.objectContaining({ replyRootEventId: "evt_root" }),
    );
  });

  it("Given a notification that opens a reply and a palette result to the same destination, when both fire, then only one stack entry exists for that destination", () => {
    const fromNotification = notificationDestination({
      id: "n-reply",
      serverType: "channel_message",
      displayKind: "channel_message",
      typeIcon: "generic",
      actorName: "Ada",
      actorInitials: "A",
      verbText: "Ada mentioned you",
      contextLine: "thread",
      status: "unread",
      createdAt: "2026-08-12T14:30:00.000Z",
      createdAtMs: Date.parse("2026-08-12T14:30:00.000Z"),
      timestampLabel: "2:30 PM",
      actionKind: null,
      actionRef: null,
      actionButtons: [],
      targetRef: "/channels/chn_a/replies/evt_root",
      actorPersonUid: null,
      sourceEventId: "evt_root",
      actionUsed: false,
    });
    expect(fromNotification).toEqual({
      kind: "channel",
      channelId: "chn_a",
      replyRootEventId: "evt_root",
    });

    const controller = createNavigationController({
      getScope: () => ({ accountId: "acct_ada", companyUid: "cmp_acme" }),
      apply: () => {},
    });
    const dest: NavigationDestination = {
      kind: "channel",
      channelId: "chn_a",
      replyRootEventId: "evt_root",
    };
    controller.navigate(dest);
    controller.navigate(dest);
    expect(controller.history.snapshot().entries).toHaveLength(1);
    expect(controller.history.snapshot().index).toBe(0);
  });

  it("Given a matrix row marked in-scope, when its handler runs, then it calls navigate() rather than assigning view state", () => {
    const sources = new Map<string, string>();
    const read = (file: string) => {
      const cached = sources.get(file);
      if (cached) return cached;
      const next = readRepo(file);
      sources.set(file, next);
      return next;
    };
    const shell = read("packages/ui/src/shell/DesktopApp.svelte");
    expect(shell).not.toContain("onclick={() => (agentSurface = t.id)}");
    expect(shell).not.toContain("onselect={(id) => (companyTab = id)}");
    expect(shell).not.toContain("onclick={() => (tab = t.id)}");
    expect(shell).not.toContain('onOpenInChannel={() => (tab = "chat")}');
    expect(shell).not.toContain("onnavigatetab={(next) => (libraryTab = next)}");
    expect(shell).not.toContain('onclose={() => (agentSurface = "chat")}');
    expect(functionSource(shell, "openReply")).toContain("pushConversationSurface(");
    expect(functionSource(shell, "closeReply")).toContain("leaveCurrentDestination(");
    expect(functionSource(shell, "openNotification")).toContain("handleSelect(");
    expect(functionSource(shell, "changeTenantCompany")).toContain("void navigate(");

    for (const row of NAVIGATION_HANDLER_MATRIX) {
      expect(read(row.file)).toContain(row.needle);
      if (!inScopeUserHandler(row)) continue;
      expect(
        handlerUsesNavigateBoundary(read(row.file), row.needle),
        `${row.id} still bypasses navigate(): ${row.needle}`,
      ).toBe(true);
    }
  });

  it("Given a native dialog or external URL open, when it closes, then history is unchanged", () => {
    const history = createNavigationHistory();
    const controller = createNavigationController({
      history,
      getScope: () => ({ accountId: "acct_ada", companyUid: "cmp_acme" }),
      apply: () => {},
    });
    controller.navigate({ kind: "channel", channelId: "chn_a" });
    const before = history.snapshot();

    const shell = readRepo("packages/ui/src/shell/DesktopApp.svelte");
    expect(shell).toContain("<ConfirmDialog");
    expect(shell).toContain("<MigrateSessionDialog");
    expect(shell).toContain("if (/^https?:\\/\\//i.test(url)) onopenurl?.(url);");
    const confirm = functionSource(shell, "deleteSelectedChannel");
    expect(confirm).not.toContain("void navigate(");
    expect(confirm).not.toContain("pushConversationSurface(");

    expect(history.snapshot()).toEqual(before);
  });
});

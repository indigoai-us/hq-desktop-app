<script lang="ts">
  import { dismissable } from "../common/dismissable.js";
  import ReadLoader from "../common/ReadLoader.svelte";
  /**
   * Titlebar notifications popover (console-rail US-011).
   * Paints from the cached inbox. Tabs and grant buttons do not fetch.
   */
  import type { NotificationsApi } from "../chat/chat-api.js";
  import type { NotificationItem } from "./notifications-model.js";
  import {
    hideNotification,
    notificationsCacheSnapshot,
    restoreNotification,
  } from "./notifications-cache.svelte.js";
  import { pushToast } from "../shell/toast-stack.svelte.js";
  import {
    companyInvitesFromWorkspaces,
    isCompanyInviteRequest,
    mergeCompanyInvites,
  } from "./company-invite-requests.js";
  import {
    actionKindForGrant,
    grantLevelFor,
    isAccessRequest,
    isRequestRow,
    itemsForTab,
    metadata,
    type NotificationPanelTab,
  } from "./notifications-panel.js";
  import "../chat/chat-tokens.css";

  type CompanyInviteDecision =
    | { ok: true }
    | { ok: false; message: string; upgradeUrl: string | null };

  interface Props {
    api: NotificationsApi;
    /** Pending company rows from the workspace list already on screen. */
    pendingWorkspaces?: readonly unknown[];
    onclose?: () => void;
    onopen?: (item: NotificationItem) => void;
    onopensettings?: () => void;
    /** Claim the invite, pin when the rail has room, and open Atlas. */
    onacceptcompany?: (item: NotificationItem) => Promise<CompanyInviteDecision>;
  }

  let { api, pendingWorkspaces = [], onclose, onopen, onopensettings, onacceptcompany }: Props = $props();

  let tab = $state<NotificationPanelTab>("all");
  let root = $state<HTMLElement | null>(null);
  let inviteNotes = $state<Record<string, { message: string; upgradeUrl: string | null }>>({});
  let dismissedInviteIds = $state<string[]>([]);

  const snap = $derived(notificationsCacheSnapshot());
  const merged = $derived(
    mergeCompanyInvites(snap.items, companyInvitesFromWorkspaces(pendingWorkspaces)).filter(
      (item) => !dismissedInviteIds.includes(item.id),
    ),
  );
  const rows = $derived(itemsForTab(merged, tab));
  const requestCount = $derived(merged.filter(isRequestRow).length);

  function onWindowPointer(event: PointerEvent): void {
    const target = event.target;
    if (!(target instanceof Node) || !root) return;
    if (root.contains(target)) return;
    if (target instanceof Element && target.closest("[data-testid='titlebar-notifications']")) {
      return;
    }
    onclose?.();
  }

  $effect(() => {
    window.addEventListener("pointerdown", onWindowPointer, true);
    return () => window.removeEventListener("pointerdown", onWindowPointer, true);
  });

  async function decide(item: NotificationItem, decision: "approve" | "deny"): Promise<void> {
    const level = grantLevelFor(item);
    hideNotification(item.id);
    if (decision === "approve") {
      pushToast({
        title: "Access granted",
        detail: `${item.actorName} · ${level}`,
        tone: "ok",
      });
    }
    try {
      await api.runNotificationAction({
        id: item.id,
        actionKind: decision === "approve" ? actionKindForGrant(level) : "deny",
        actionRef: item.actionRef,
      });
    } catch (err) {
      console.error("notifications-popover: grant action failed", err);
      restoreNotification(item.id);
      pushToast({
        title: decision === "approve" ? "Couldn't grant access" : "Couldn't deny request",
        detail: "Try again.",
        tone: "err",
      });
    }
  }

  function dismissInviteRow(id: string): void {
    hideNotification(id);
    if (!dismissedInviteIds.includes(id)) dismissedInviteIds = [...dismissedInviteIds, id];
  }

  function restoreInviteRow(id: string): void {
    restoreNotification(id);
    dismissedInviteIds = dismissedInviteIds.filter((entry) => entry !== id);
  }

  async function acceptInvite(item: NotificationItem): Promise<void> {
    if (!onacceptcompany) return;
    dismissInviteRow(item.id);
    const next = { ...inviteNotes };
    delete next[item.id];
    inviteNotes = next;
    try {
      const result = await onacceptcompany(item);
      if (!result.ok) {
        restoreInviteRow(item.id);
        inviteNotes = { ...inviteNotes, [item.id]: { message: result.message, upgradeUrl: result.upgradeUrl } };
      }
    } catch (err) {
      console.error("notifications-popover: accept invite failed", err);
      restoreInviteRow(item.id);
      inviteNotes = {
        ...inviteNotes,
        [item.id]: { message: "Couldn't join the company. Try again.", upgradeUrl: null },
      };
    }
  }

  async function declineInvite(item: NotificationItem): Promise<void> {
    dismissInviteRow(item.id);
    try {
      await api.ackNotification(item.id);
    } catch (err) {
      if (!item.id.startsWith("company-invite:")) {
        console.error("notifications-popover: decline invite failed", err);
        restoreInviteRow(item.id);
        pushToast({
          title: "Couldn't decline the invite",
          detail: "Try again.",
          tone: "err",
        });
      }
    }
  }
</script>

<div
  class="npop"
  use:dismissable={{ onclose: () => onclose?.(), trap: false, autofocus: false }}
  bind:this={root}
  role="dialog"
  aria-label="Notifications"
  data-testid="notifications-popover"
  data-scroll-budget={metadata.performanceBudget.scrollDroppedFramesPct}
>
  <div class="nhead">
    <b>Notifications</b>
    <div class="tabs" role="tablist">
      <button type="button" class="tab" role="tab" aria-selected={tab === "all"} onclick={() => (tab = "all")}>All</button>
      <button type="button" class="tab" role="tab" aria-selected={tab === "mentions"} onclick={() => (tab = "mentions")}>Mentions</button>
      <button type="button" class="tab" role="tab" aria-selected={tab === "requests"} data-testid="notifications-tab-requests" onclick={() => (tab = "requests")}>
        Requests{#if requestCount > 0}<span class="count">{requestCount}</span>{/if}
      </button>
    </div>
  </div>

  <div class="list">
    {#if !snap.ready}
      <div class="loading" aria-busy="true">
        <ReadLoader testid="notifications-loading" />
      </div>
    {:else if rows.length === 0}
      <div class="empty" data-testid="notifications-empty">
        <div class="tt">{tab === "requests" ? "No open requests" : "You're caught up"}</div>
        <div class="mm">
          {tab === "requests"
            ? "Company invites and access requests show up here."
            : "Mentions, bot completions, and access requests land here. Nothing is waiting on you."}
        </div>
      </div>
    {:else}
      {#each rows as item (item.id)}
        <div class="ni" class:unread={item.status === "unread"} data-testid="notification-row">
          <span class="mini">{item.actorInitials}</span>
          <div>
            <span class="verb">{item.verbText}</span>
            {#if item.contextLine}<span class="m">{item.contextLine}</span>{/if}
            {#if isCompanyInviteRequest(item)}
              <div class="act">
                <button
                  type="button"
                  class="btn"
                  data-testid="notification-accept-invite"
                  onclick={() => void acceptInvite(item)}
                >Accept</button>
                <button
                  type="button"
                  class="btn"
                  data-testid="notification-decline-invite"
                  onclick={() => void declineInvite(item)}
                >Decline</button>
              </div>
              {#if inviteNotes[item.id]}
                <span class="m" data-testid="notification-invite-error">{inviteNotes[item.id].message}</span>
                {#if inviteNotes[item.id].upgradeUrl}
                  <a
                    class="upgrade"
                    data-testid="notification-invite-upgrade"
                    href={inviteNotes[item.id].upgradeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >Review plan</a>
                {/if}
              {/if}
            {:else if isAccessRequest(item)}
              <div class="act">
                <button
                  type="button"
                  class="btn"
                  data-testid="notification-approve"
                  onclick={() => void decide(item, "approve")}
                >Approve</button>
                <button
                  type="button"
                  class="btn"
                  data-testid="notification-deny"
                  onclick={() => void decide(item, "deny")}
                >Deny</button>
              </div>
            {:else}
              <div class="act">
                <button type="button" class="btn" onclick={() => onopen?.(item)}>Open</button>
              </div>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>

  <div class="nfoot">
    <span class="grow"></span>
    {#if onopensettings}
      <button type="button" class="link" onclick={() => onopensettings?.()}>Notification settings</button>
    {/if}
  </div>
</div>

<style>
  .npop {
    position: fixed;
    top: 46px;
    right: 120px;
    z-index: 40;
    width: 380px;
    max-height: 640px;
    display: flex;
    flex-direction: column;
    padding: 8px 8px 6px;
    background: var(--overlay-bg);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-popover);
    box-shadow: var(--v4-shadow-popover);
    color: var(--v4-text-1);
    font-family: var(--font-ui);
  }

  .nhead {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 8px;
  }

  .nhead b {
    font-size: 13px;
    font-weight: 500;
  }

  .tabs {
    margin-left: auto;
    display: flex;
    gap: 2px;
  }

  .tab {
    border: 0;
    background: transparent;
    color: var(--v4-text-3);
    font: 13px/1 var(--font-ui);
    padding: 4px 8px;
    border-radius: 8px;
    cursor: default;
  }

  .tab[aria-selected="true"] {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .count {
    margin-left: 4px;
  }

  .list {
    overflow: auto;
    min-height: 0;
    overscroll-behavior: contain;
  }

  .ni {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr);
    gap: 8px;
    padding: 7px 8px;
    border-radius: 8px;
    font-size: 13px;
    color: var(--v4-text-2);
    line-height: 1.35;
    align-items: start;
  }

  .ni:hover {
    background: var(--v4-hover, var(--v4-active-row));
  }

  .ni.unread {
    color: var(--v4-text-1);
  }

  .mini {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 9px;
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
  }

  .verb {
    font-weight: 500;
  }

  .m {
    display: block;
    margin-top: 2px;
    font-size: 13px;
    font-weight: 400;
    color: var(--v4-text-3);
  }

  .act {
    display: flex;
    gap: 4px;
    margin-top: 6px;
  }

  .btn,
  .link {
    border: 1px solid var(--v4-control-border);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
    border-radius: 6px;
    padding: 2px 8px;
    font: 13px/1.4 var(--font-ui);
    cursor: default;
  }

  .link,
  .upgrade {
    border: 0;
    background: transparent;
    color: var(--v4-text-3);
    padding: 0;
  }

  .upgrade {
    display: inline-block;
    margin-top: 4px;
    font-size: 13px;
    text-decoration: underline;
  }

  .nfoot {
    display: flex;
    gap: 8px;
    padding: 8px 8px 4px;
    border-top: 1px solid var(--v4-rowline, var(--v4-hairline));
    margin-top: 4px;
    font-size: 13px;
  }

  .grow {
    flex: 1;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 34px 24px 30px;
    gap: 6px;
  }

  .tt {
    font-size: 13px;
    font-weight: 500;
    color: var(--v4-text-1);
  }

  .mm {
    font-size: 13px;
    color: var(--v4-text-3);
    line-height: 1.5;
    max-width: 270px;
  }

  .loading {
    padding: 8px;
  }
</style>

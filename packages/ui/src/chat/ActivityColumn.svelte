<script lang="ts">
  // Activity column (hq-message-visibility US-006). A conversation's agent
  // and system messages, in timeline order, in the thread-panel slot beside
  // the people thread. The host passes every agent and system row it has
  // loaded for the conversation; new rows arrive through the host's live
  // path (wake -> re-read), so the column grows without a reload. A two-
  // segment switch picks Agents (default) or System. Reply hands the row to
  // the host, which opens the thread panel in this column's place.
  import type { MessageType } from "@hq/platform";
  import IdentityMark from "./messaging/IdentityMark.svelte";
  import {
    ACTIVITY_SEGMENTS,
    activityRows,
    type ActivitySegment,
  } from "./activity-column.js";
  import "./chat-tokens.css";

  export interface ActivityItem {
    eventId: string;
    type: MessageType;
    fromDisplayName: string;
    fromPersonUid?: string | null;
    body: string;
    createdAt: string;
    cliChip?: boolean;
  }

  interface Props {
    items: readonly ActivityItem[];
    segment: ActivitySegment;
    onsegment: (segment: ActivitySegment) => void;
    onreply?: (eventId: string) => void;
    onclose: () => void;
  }

  let { items, segment, onsegment, onreply, onclose }: Props = $props();

  const shown = $derived(activityRows(items, segment, (m) => m.type));

  let scroller = $state<HTMLDivElement | null>(null);
  // Follow the newest row as the stream grows.
  $effect(() => {
    void shown.length;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });

  function timeLabel(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
</script>

<aside class="activity-column" aria-label="Activity" data-testid="activity-column" data-segment={segment}>
  <header class="activity-head">
    <h3 class="activity-title">Activity</h3>
    <span class="activity-live" data-testid="activity-live"><i aria-hidden="true"></i>live</span>
    <span class="activity-spacer"></span>
    <div class="activity-seg" role="tablist" aria-label="Activity type">
      {#each ACTIVITY_SEGMENTS as s (s.id)}
        <button
          type="button"
          role="tab"
          class:on={segment === s.id}
          aria-selected={segment === s.id}
          data-testid={`activity-segment-${s.id}`}
          onclick={() => onsegment(s.id)}>{s.label}</button
        >
      {/each}
    </div>
    <button
      type="button"
      class="activity-close"
      aria-label="Close activity"
      data-testid="activity-close"
      onclick={onclose}>×</button
    >
  </header>
  <div class="activity-list" bind:this={scroller}>
    {#if shown.length === 0}
      <p class="activity-empty" data-testid="activity-empty">
        {segment === "system" ? "No system messages yet." : "No agent messages yet."}
      </p>
    {:else}
      {#each shown as m (m.eventId)}
        <div class="activity-row" data-testid="activity-row" data-event-id={m.eventId} data-type={m.type}>
          <span class="activity-avatar" aria-hidden="true">
            <IdentityMark
              kind={(m.fromPersonUid ?? "").startsWith("agt_") || m.type === "agent" ? "agent" : "person"}
              label={m.fromDisplayName}
              agentUid={m.fromPersonUid ?? undefined}
              size="small"
            />
          </span>
          <div class="activity-body">
            <div class="activity-meta">
              <span class="activity-from">{m.fromDisplayName}</span>
              {#if m.cliChip}
                <span class="activity-cli" title="Sent from the HQ CLI">CLI</span>
              {/if}
              {#if m.createdAt}
                <time class="activity-ts" datetime={m.createdAt}>{timeLabel(m.createdAt)}</time>
              {/if}
            </div>
            <p class="activity-text">{m.body}</p>
            {#if onreply}
              <button
                type="button"
                class="activity-reply"
                data-testid="activity-reply"
                aria-label={`Reply to ${m.fromDisplayName}`}
                onclick={() => onreply?.(m.eventId)}>Reply</button
              >
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>
</aside>

<style>
  .activity-column {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    border-left: 1px solid var(--line, rgba(255, 255, 255, 0.07));
    background: var(--ground, transparent);
    font: 400 12px/1.4 var(--font-ui);
    color: var(--t1);
  }

  .activity-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line, rgba(255, 255, 255, 0.07));
  }

  .activity-title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--t1);
  }

  .activity-live {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--t3);
    font-size: 11px;
  }

  .activity-live i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ok, #3fb950);
  }

  .activity-spacer {
    flex: 1;
  }

  .activity-seg {
    display: inline-flex;
    padding: 2px;
    border: 1px solid var(--line2);
    border-radius: 7px;
    background: var(--raised);
  }

  .activity-seg button,
  .activity-close,
  .activity-reply {
    border: 0;
    background: transparent;
    color: var(--t2);
    font: inherit;
    cursor: pointer;
  }

  .activity-seg button {
    padding: 2px 8px;
    border-radius: 5px;
    font-size: 11px;
  }

  .activity-seg button.on {
    background: var(--sel, var(--hover));
    color: var(--t1);
  }

  .activity-close {
    padding: 0 4px;
    font-size: 16px;
    line-height: 1;
    color: var(--t3);
  }

  .activity-seg button:focus-visible,
  .activity-close:focus-visible,
  .activity-reply:focus-visible {
    outline: 2px solid var(--border-active);
    outline-offset: 1px;
  }

  .activity-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 10px 12px;
  }

  .activity-empty {
    margin: 8px 0;
    color: var(--t3);
  }

  .activity-row {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }

  .activity-body {
    min-width: 0;
    flex: 1 1 auto;
  }

  .activity-meta {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .activity-from {
    color: var(--t2);
    font-weight: 600;
  }

  .activity-cli {
    padding: 0 5px;
    border: 1px solid var(--line2);
    border-radius: 4px;
    background: var(--raised);
    color: var(--t3);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    line-height: 15px;
  }

  .activity-ts {
    color: var(--t3);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  .activity-text {
    margin: 2px 0 0;
    color: var(--t2);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .activity-reply {
    margin-top: 2px;
    padding: 0;
    font-size: 11px;
    color: var(--t3);
    opacity: 0;
  }

  .activity-row:hover .activity-reply,
  .activity-row:focus-within .activity-reply {
    opacity: 1;
  }
</style>

<script lang="ts">
  // Compact work-mesh row for (1) legacy work-session-event JSON bodies and
  // (2) coalesced work_session systemEvent cards (US-015). Styled like
  // SystemEventLine (sys-line / sys-icon / sys-who / sys-summary). Clicking a
  // legacy activity with details expands a muted key/value block.
  import { formatLastActivity } from "../channel-status-model";
  import type { WorkSessionCardModel } from "./channelMessageModels";
  import { isOpaqueActorId, type WorkSessionActivity } from "./workSessionEvent";

  interface Props {
    /** Legacy JSON work-session-event activity (claim/start/blocked/done). */
    activity?: WorkSessionActivity | null;
    /** Coalesced work_session envelope card. */
    card?: WorkSessionCardModel | null;
    /** Wall-clock time for legacy activity rows. */
    time?: string;
    /** Roster-resolved actor label for cards (overrides opaque uids). */
    actorLabel?: string | null;
  }

  let {
    activity = null,
    card = null,
    time = "",
    actorLabel = null,
  }: Props = $props();

  let expanded = $state(false);

  // Done inserts the story id between "marked" and "done"; other kinds put
  // the id after the verb. Omit the id token when it is null.
  function verbPhrase(row: WorkSessionActivity): string {
    const id = row.storyId;
    if (row.kind === "done") return id ? `marked ${id} done` : "marked done";
    return id ? `${row.verb} ${id}` : row.verb;
  }

  /** Unresolved raw UIDs never render verbatim. */
  const legacyActorLabel = $derived(
    activity
      ? isOpaqueActorId(activity.actor)
        ? "A teammate"
        : activity.actor
      : "",
  );

  const fullLabel = $derived(
    activity
      ? `${legacyActorLabel} ${verbPhrase(activity)}${activity.title ? ` — ${activity.title}` : ""}`
      : "",
  );

  const detailPairs = $derived(
    activity
      ? (
          [
            ["Story", activity.storyTitle],
            ["Summary", activity.summary],
            ["Done criteria", activity.doneCriteria],
            ["Branch", activity.branch],
            ["Runtime", activity.runtime],
          ] as Array<[string, string | null]>
        ).filter((pair): pair is [string, string] => Boolean(pair[1]))
      : [],
  );

  const hasDetails = $derived(detailPairs.length > 0);

  function toggle(): void {
    if (hasDetails) expanded = !expanded;
  }

  const cardActor = $derived.by(() => {
    if (!card) return "A teammate";
    const named = (actorLabel ?? card.principalDisplay ?? "").trim();
    if (named && !isOpaqueActorId(named)) return named;
    const uid = (card.actorUid ?? "").trim();
    if (uid && !isOpaqueActorId(uid)) return uid;
    return "A teammate";
  });

  const cardIsAgent = $derived(card?.actorType === "agent");

  const cardMeta = $derived.by(() => {
    if (!card) return [] as string[];
    const parts: string[] = [];
    if (card.harness) parts.push(card.harness);
    if (card.taskId) parts.push(card.taskId);
    if (card.turnCount != null) {
      parts.push(card.turnCount === 1 ? "1 turn" : `${card.turnCount} turns`);
    }
    if (card.lastTurnAt) {
      parts.push(formatLastActivity(card.lastTurnAt));
    }
    return parts;
  });

  const cardTitle = $derived(
    card ? (card.note ?? card.title ?? "").trim() : "",
  );
</script>

{#if card}
  <div
    class="work-mesh-block"
    data-testid="work-mesh-card"
    data-actor-type={card.actorType}
    role="status"
  >
    <div class="sys-line work-mesh-row work-mesh-card">
      <span class="sys-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle
            cx="8"
            cy="8"
            r="5.5"
            stroke="currentColor"
            stroke-width="1.3"
          />
          <path
            d="M8 4.75v3.5l2.25 1.35"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
          />
        </svg>
      </span>
      <span class="sys-summary" title={[cardActor, ...cardMeta].filter(Boolean).join(" · ")}>
        <span class="sys-who">{cardActor}</span>
        {#if cardIsAgent}
          <span class="agent-mark" aria-label="agent" title="Agent">✦</span>
        {/if}
        {#each cardMeta as part, i (part + String(i))}
          <span class="sys-sep"> · </span><span class="sys-meta">{part}</span>
        {/each}
        {#if cardTitle && cardMeta.length === 0}
          <span class="sys-sep"> — </span><span class="sys-meta">{cardTitle}</span>
        {/if}
      </span>
    </div>
  </div>
{:else if activity}
  <div class="work-mesh-block">
    <button
      type="button"
      class="sys-line work-mesh-row"
      data-testid="work-mesh-row"
      aria-expanded={hasDetails ? expanded : undefined}
      onclick={toggle}
    >
      <span class="sys-icon" aria-hidden="true">
        {#if activity.kind === "blocked"}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M8 2.75 14.2 13.4H1.8L8 2.75Z"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linejoin="round"
            />
            <path d="M8 6.7v3.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            <path d="M8 11.65h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        {:else if activity.kind === "done"}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M3 8.5 6.5 12 13 4.5"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        {:else}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4.5 2.5v8.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            <circle cx="4.5" cy="13" r="1.55" stroke="currentColor" stroke-width="1.4" />
            <circle cx="12" cy="4.5" r="1.55" stroke="currentColor" stroke-width="1.4" />
            <path
              d="M12 6.05a5.15 5.15 0 0 1-5.15 5.15"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
        {/if}
      </span>
      <span class="sys-summary" title={fullLabel}>
        <span class="sys-who">{legacyActorLabel}</span>{` ${verbPhrase(activity)}`}{#if activity.title}{` — ${activity.title}`}{/if}
      </span>
      {#if time}
        <span class="sys-time">{time}</span>
      {/if}
    </button>
    {#if expanded && hasDetails}
      <div class="work-mesh-detail" data-testid="work-mesh-detail">
        {#each detailPairs as [label, value] (label)}
          <div class="detail-row">
            <span class="detail-label">{label}</span>
            <span class="detail-value">{value}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .work-mesh-block {
    width: 100%;
    min-width: 0;
  }

  /* Mirrors SystemEventLine's .sys-line treatment exactly: small, grey,
   * no weight bump, 32px icon gutter, single line. */
  .sys-line {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 12px;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    min-height: 16px;
    margin: 6px 0;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
    font: inherit;
    color: var(--t3, var(--muted, var(--pop-muted)));
    font-size: 11px;
    line-height: 1.45;
    text-align: left;
  }

  .work-mesh-card {
    cursor: default;
  }

  .sys-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 32px;
    width: 32px;
    color: var(--t3, var(--muted-2, var(--pop-muted)));
    opacity: 0.7;
  }

  .sys-who {
    font-weight: 500;
    color: var(--t3, var(--muted-2, var(--pop-muted)));
  }

  .agent-mark {
    margin-left: 4px;
    font-size: 10px;
    opacity: 0.85;
    color: var(--t3, var(--muted-2, var(--pop-muted)));
  }

  .sys-summary {
    color: var(--t3, var(--muted, var(--pop-muted)));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .sys-sep,
  .sys-meta {
    color: var(--t3, var(--muted, var(--pop-muted)));
  }

  .sys-time {
    flex-shrink: 0;
    font-size: 10px;
    font-family: var(--font-mono, inherit);
    color: var(--t3, var(--muted-3, var(--pop-muted)));
    opacity: 0.7;
  }

  .work-mesh-detail {
    margin: 0 0 4px 44px; /* 32px icon gutter + 12px gap */
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .detail-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 11px;
    line-height: 1.45;
  }

  .detail-label {
    flex: 0 0 88px;
    color: var(--t3, var(--muted, var(--pop-muted)));
    opacity: 0.6;
  }

  .detail-value {
    min-width: 0;
    color: var(--t3, var(--muted, var(--pop-muted)));
    overflow-wrap: anywhere;
  }
</style>

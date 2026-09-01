<script lang="ts">
  import { mentionTargetLabel, type MentionTarget } from "../mentions.js";
  import { agentAvatarFor } from "./agent-avatars";

  interface Props {
    hits: MentionTarget[];
    highlight: number;
    onpick: (t: MentionTarget) => void;
  }

  let { hits, highlight, onpick }: Props = $props();
</script>

<div
  class="mention-picker"
  role="listbox"
  aria-label="Mention someone"
  data-testid="mention-picker"
>
  {#if hits.length === 0}
    <div class="mention-empty">No one matches</div>
  {:else}
    {#each hits as hit, index (hit.participantUid)}
      {@const generated =
        hit.participantType === "agent"
          ? agentAvatarFor(hit.participantUid)
          : null}
      <button
        type="button"
        class="mention-row"
        class:selected={index === highlight}
        role="option"
        aria-selected={index === highlight}
        aria-label={mentionTargetLabel(hit)}
        onclick={() => onpick(hit)}
      >
        <span
          class="mention-ava"
          class:agent={hit.participantType === "agent"}
          aria-hidden="true"
          >{#if generated}<img
              class="mention-ava-img"
              src={generated}
              alt=""
            />{:else}{hit.displayName.trim().slice(0, 1).toUpperCase() ||
              "?"}{/if}</span
        >
        <span class="mention-copy">
          <span class="mention-name"
            >{hit.displayName}{#if hit.disambiguator}<span
                class="mention-tag"
                data-testid="mention-disambiguator">{hit.disambiguator}</span
              >{/if}</span
          >
          <span class="mention-sub"
            >{hit.participantType === "agent"
              ? "Agent"
              : hit.email || "Teammate"}</span
          >
        </span>
      </button>
    {/each}
  {/if}
</div>

<style>
  .mention-picker {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 238px;
    margin: 0 0 8px;
    overflow-y: auto;
    padding: 6px;
    border-radius: 14px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: #141418;
    box-shadow: var(--pop-shadow);
  }

  .mention-empty {
    padding: 10px 12px;
    color: var(--t3);
    font-size: 12px;
  }

  .mention-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 46px;
    padding: 6px 8px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .mention-row.selected,
  .mention-row:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .mention-ava {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 14px;
    background: #27272f;
    color: #f4f4f5;
    font-size: 11px;
    font-weight: 700;
  }

  .mention-ava.agent {
    background: #312e81;
    overflow: hidden;
  }

  .mention-ava-img {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    object-fit: cover;
    display: block;
  }

  .mention-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .mention-name {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: #f4f4f5;
    font-size: 13px;
    font-weight: 600;
  }

  /* Tenant disambiguator — only rendered when two survivors share a name, so
     the user can never mention the wrong company's agent by accident. */
  .mention-tag {
    flex: 0 1 auto;
    overflow: hidden;
    max-width: 140px;
    padding: 1px 6px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    color: #c9c9d1;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .mention-sub {
    color: #8b8b95;
    font-size: 11px;
  }
</style>

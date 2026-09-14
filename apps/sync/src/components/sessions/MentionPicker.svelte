<script lang="ts">
  /**
   * The `@` picker — a list of the teammates and fleet agents the composer
   * can mention. Presentation only: the composer decides what is in the list
   * and which row is highlighted; this component paints rows and reports a
   * click or a hover.
   *
   * Anchoring matches the slash-command menu exactly (absolute, bottom 100%
   * of the composer box, full width) so the two popovers occupy the same
   * slot. They never show together: the composer opens the mention picker
   * only for an `@` token under the caret and the slash menu only for a draft
   * that IS a `/command`, and it gives the mention picker precedence.
   */
  import { initials } from './session-types';
  import type { MentionCandidate } from './mentions';

  interface Props {
    candidates: MentionCandidate[];
    highlighted: number;
    onpick?: (candidate: MentionCandidate) => void;
    onhover?: (index: number) => void;
  }

  let { candidates, highlighted, onpick, onhover }: Props = $props();
</script>

<ul
  class="mention-menu"
  role="listbox"
  aria-label="Mention a teammate or agent"
  data-testid="session-mention-menu"
>
  {#each candidates as candidate, index (candidate.uid)}
    <li>
      <button
        type="button"
        role="option"
        aria-selected={index === highlighted}
        class="mention-item"
        class:highlighted={index === highlighted}
        data-testid="session-mention-item"
        data-kind={candidate.kind}
        onmouseenter={() => onhover?.(index)}
        onmousedown={(event) => event.preventDefault()}
        onclick={() => onpick?.(candidate)}
      >
        <span class="avatar" class:agent={candidate.kind === 'agent'} aria-hidden="true">
          {initials(candidate.displayName)}
        </span>
        <span class="name">{candidate.displayName}</span>
        <span class="kind">{candidate.kind === 'agent' ? 'agent' : 'person'}</span>
      </button>
    </li>
  {/each}
</ul>

<style>
  .mention-menu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    right: 0;
    z-index: 5;
    max-height: 240px;
    overflow-y: auto;
    margin: 0;
    padding: 4px;
    list-style: none;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-card);
    background: var(--v4-popover-strong, var(--v4-popover, var(--v4-raised)));
    backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    -webkit-backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    box-shadow: var(--v4-shadow-popover, none);
  }

  .mention-item {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    width: 100%;
    padding: 5px var(--v4-space-2);
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: var(--type-metadata);
    text-align: left;
    cursor: pointer;
  }

  .mention-item.highlighted {
    background: var(--v4-active-row);
  }

  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--v4-control-faint, var(--v4-active-row));
    color: var(--v4-text-2);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .avatar.agent {
    border-radius: 6px;
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kind {
    margin-left: auto;
    flex: none;
    padding: 1px 6px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    color: var(--v4-text-3);
    font-size: 10px;
    line-height: 1.4;
  }
</style>

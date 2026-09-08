<script lang="ts">
  /**
   * "Policies · 32 (4 hard)" — the quiet proof that a session is running
   * under HQ's rules, and the one place to see WHICH rules.
   *
   * The chip sits in the strip next to the phase dot and stays hidden until a
   * hook has actually surfaced a policy (or bound a company): an empty
   * "Policies · 0" would be a claim about nothing. Clicking it opens a compact
   * popover — the bound company first, then the policies grouped Hard /
   * Advisory with their slug and a one-line excerpt. It updates live as more
   * hook notices fold in; the digest it reads is already deduped by slug.
   *
   * Presentation-pure: the digest in, nothing out. Closes on Escape or a
   * click anywhere outside it, the same way the composer's pill menus do.
   */
  import { policyCountLabel, type PolicyDigest, type PolicyEntry } from './policy-digest';

  interface Props {
    digest: PolicyDigest;
  }

  let { digest }: Props = $props();

  let open = $state(false);
  let root = $state<HTMLDivElement | null>(null);

  const hard = $derived(digest.entries.filter((entry) => entry.hard));
  const advisory = $derived(digest.entries.filter((entry) => !entry.hard));
  const visible = $derived(digest.entries.length > 0 || digest.company !== null);
  const label = $derived(policyCountLabel(digest));

  function onWindowClick(event: MouseEvent) {
    if (!open) return;
    const target = event.target;
    if (root && target instanceof Node && root.contains(target)) return;
    open = false;
  }

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) open = false;
  }

  function slugTitle(entry: PolicyEntry): string {
    return entry.excerpt ? `${entry.slug} — ${entry.excerpt}` : entry.slug;
  }
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKeydown} />

{#if visible}
  <div class="policies" bind:this={root} data-testid="session-policies">
    <button
      type="button"
      class="chip"
      aria-haspopup="dialog"
      aria-expanded={open}
      data-testid="session-policies-chip"
      onclick={() => (open = !open)}
    >
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path
          d="M6 1.2 2.2 2.8v3c0 2.3 1.6 4.1 3.8 4.9 2.2-.8 3.8-2.6 3.8-4.9v-3L6 1.2Z"
          stroke="currentColor"
          stroke-width="1.1"
          stroke-linejoin="round"
        />
      </svg>
      <span class="chip-label">Policies · {label}</span>
    </button>

    {#if open}
      <div
        class="popover"
        role="dialog"
        aria-label="Policies applied to this session"
        data-testid="session-policies-popover"
      >
        {#if digest.company}
          <p class="bound" data-testid="session-policies-company">
            Bound to <strong>{digest.company}</strong>
          </p>
        {/if}

        {#if digest.entries.length === 0}
          <p class="none">No policies surfaced yet.</p>
        {/if}

        {#if hard.length > 0}
          <h4 class="group-head">Hard <span class="count">{hard.length}</span></h4>
          <ul class="group" data-testid="session-policies-hard">
            {#each hard as entry (entry.slug)}
              <li class="entry" title={slugTitle(entry)}>
                <code class="slug">{entry.slug}</code>
                {#if entry.excerpt}<span class="excerpt">{entry.excerpt}</span>{/if}
              </li>
            {/each}
          </ul>
        {/if}

        {#if advisory.length > 0}
          <h4 class="group-head">Advisory <span class="count">{advisory.length}</span></h4>
          <ul class="group" data-testid="session-policies-advisory">
            {#each advisory as entry (entry.slug)}
              <li class="entry" title={slugTitle(entry)}>
                <code class="slug">{entry.slug}</code>
                {#if entry.excerpt}<span class="excerpt">{entry.excerpt}</span>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .policies {
    position: relative;
    display: inline-flex;
    flex: none;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill, 999px);
    background: transparent;
    color: var(--v4-text-3);
    font-family: inherit;
    font-size: 11px;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
  }

  .chip:hover,
  .chip[aria-expanded='true'] {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }

  .popover {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 30;
    width: 340px;
    max-height: 60vh;
    overflow-y: auto;
    padding: var(--v4-space-2) var(--v4-space-3);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-card, 10px);
    background: var(--v4-popover-strong, var(--v4-popover, var(--v4-raised)));
    backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    -webkit-backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    box-shadow: var(--v4-shadow-popover, none);
    text-align: left;
    font-size: var(--type-metadata);
    color: var(--v4-text-2);
  }

  .bound {
    margin: 0 0 var(--v4-space-2);
    padding-bottom: var(--v4-space-2);
    border-bottom: 1px solid var(--v4-hairline);
    color: var(--v4-text-2);
  }

  .bound strong {
    font-weight: 600;
    color: var(--v4-text-1);
  }

  .none {
    margin: 0;
    color: var(--v4-text-3);
  }

  .group-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: var(--v4-space-2) 0 4px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--v4-text-3);
  }

  .group-head:first-child {
    margin-top: 0;
  }

  .count {
    font-weight: 500;
    opacity: 0.8;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .entry {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }

  .slug {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    color: var(--v4-text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .excerpt {
    color: var(--v4-text-3);
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

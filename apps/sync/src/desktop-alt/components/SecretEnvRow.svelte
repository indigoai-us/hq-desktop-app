<script lang="ts" module>
  export interface SecretItem {
    key: string;
    upd: string;
    rot: string;
  }

  export interface SecretEnv {
    env: string;
    count: number;
    items: SecretItem[];
  }

  export function isSealedSecretEnv(env: string): boolean {
    return ['prod', 'production'].includes(env.trim().toLowerCase());
  }
</script>

<script lang="ts">
  interface Props {
    secretEnv: SecretEnv;
  }

  let { secretEnv }: Props = $props();

  let expanded = $state(false);

  const pill = $derived(isSealedSecretEnv(secretEnv.env) ? 'sealed' : 'open');
  const rowId = $derived(`secret-env-${slugify(secretEnv.env)}`);

  function toggleExpanded() {
    expanded = !expanded;
  }

  function slugify(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'env';
  }
</script>

<div class="secret-env-row">
  <button
    class="env-button"
    type="button"
    aria-expanded={expanded}
    aria-controls={rowId}
    onclick={toggleExpanded}
  >
    <span class:expanded class="chevron" aria-hidden="true"></span>
    <span class="env-name" title={secretEnv.env}>{secretEnv.env}</span>
    <span class={`env-pill ${pill}`}>{pill}</span>
    <span class="env-count">{secretEnv.count} keys</span>
  </button>

  {#if expanded}
    <div class="secret-tree" id={rowId}>
      {#if secretEnv.items.length > 0}
        <div class="tree-head" aria-hidden="true">
          <span>Key</span>
          <span>Updated</span>
          <span>Rotated</span>
        </div>
        <div class="secret-list">
          {#each secretEnv.items as item, index (`${secretEnv.env}:${item.key}:${index}`)}
            <div class="secret-item">
              <span class="secret-key" title={item.key}>{item.key}</span>
              <time title={item.upd}>{item.upd}</time>
              <time title={item.rot}>{item.rot}</time>
            </div>
          {/each}
        </div>
      {:else}
        <div class="env-empty">No keys in this environment.</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .secret-env-row {
    min-width: 0;
    border-top: 1px solid var(--v4-rowline);
  }

  .secret-env-row:first-child {
    border-top: 0;
  }

  .env-button {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-width: 0;
    padding: 10px 13px;
    border: 0;
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    text-align: left;
    cursor: default;
  }

  .env-button:hover {
    background: var(--v4-active-row);
  }

  .chevron {
    width: 0;
    height: 0;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    border-left: 5px solid var(--v4-text-3);
    justify-self: center;
    transition: transform 120ms cubic-bezier(0.33, 1, 0.68, 1);
  }

  .chevron.expanded {
    transform: rotate(90deg);
  }

  .env-name,
  .secret-key,
  .secret-item time {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .env-name {
    color: var(--v4-text-1);
    font-size: var(--text-base);
    font-weight: 600;
    line-height: 18px;
  }

  .env-pill {
    min-width: 50px;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: var(--text-base);
    font-weight: 600;
    line-height: 15px;
    text-align: center;
  }

  .env-pill.sealed {
    border: 1px solid color-mix(in srgb, var(--v4-error) 24%, var(--v4-hairline));
    background: color-mix(in srgb, var(--v4-error) 12%, transparent);
    color: var(--v4-error);
  }

  .env-pill.open {
    border: 1px solid color-mix(in srgb, var(--v4-ok) 24%, var(--v4-hairline));
    background: color-mix(in srgb, var(--v4-ok) 12%, transparent);
    color: var(--v4-ok);
  }

  .env-count {
    color: var(--v4-text-3);
    font-size: var(--text-base);
    font-weight: 600;
    line-height: 16px;
    white-space: nowrap;
  }

  .secret-tree {
    min-width: 0;
    border-top: 1px solid var(--v4-rowline);
    background: var(--v4-inset);
  }

  .tree-head,
  .secret-item {
    display: grid;
    grid-template-columns: minmax(0, 1.5fr) minmax(120px, 0.75fr) minmax(120px, 0.75fr);
    align-items: center;
    gap: 12px;
    min-width: 0;
    padding: 8px 13px 8px 39px;
  }

  .tree-head {
    color: var(--v4-text-3);
    font-size: var(--text-micro);
    font-weight: 600;
    line-height: 15px;
    text-transform: uppercase;
  }

  .secret-item {
    border-top: 1px solid var(--v4-rowline);
  }

  .secret-key {
    color: var(--v4-text-1);
    font-family: var(--font-mono);
    font-size: var(--text-base);
    font-weight: 600;
    line-height: 16px;
  }

  .secret-item time,
  .env-empty {
    color: var(--v4-text-3);
    font-size: var(--text-base);
    line-height: 16px;
  }

  .env-empty {
    padding: 13px 13px 13px 39px;
  }

  @media (max-width: 760px) {
    .env-button {
      grid-template-columns: 16px minmax(0, 1fr) auto;
      gap: 8px;
    }

    .env-count {
      display: none;
    }

    .tree-head,
    .secret-item {
      grid-template-columns: minmax(0, 1fr);
      gap: 5px;
      padding-left: 37px;
    }

    .tree-head {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .chevron {
      transition: none;
    }
  }
</style>

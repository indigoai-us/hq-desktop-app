<script lang="ts">
  import {
    addPackUrl,
    readPackRegistry,
    removePackUrl,
  } from "./registry.js";
  import { HQ_AGENT_MASCOTS_BASE_URL } from "./types.js";

  interface Props {
    storage?: Pick<Storage, "getItem" | "setItem"> | null;
  }

  let { storage = null }: Props = $props();

  let urls = $state<string[]>([]);
  let draft = $state("");
  let error = $state<string | null>(null);

  $effect(() => {
    urls = readPackRegistry(storage);
  });

  function add(): void {
    const result = addPackUrl(draft, storage);
    if (!result.ok) {
      error = result.error;
      return;
    }
    urls = result.urls;
    draft = "";
    error = null;
  }

  function remove(url: string): void {
    urls = removePackUrl(url, storage);
    error = null;
  }
</script>

<div class="pack-settings" data-testid="avatar-pack-settings">
  <div class="set-row pack-head">
    <div>
      <div class="sn">Avatar packs</div>
      <div class="sd">
        Base URLs that serve pack.json. Generated marks stay available even
        with an empty list. Default: {HQ_AGENT_MASCOTS_BASE_URL}
      </div>
    </div>
  </div>

  <ul class="url-list" data-testid="avatar-pack-url-list">
    {#each urls as url (url)}
      <li class="url-row">
        <span class="url">{url}</span>
        <button
          type="button"
          class="remove"
          data-testid="avatar-pack-url-remove"
          onclick={() => remove(url)}>Remove</button
        >
      </li>
    {/each}
    {#if urls.length === 0}
      <li class="url-empty">No remote packs. Generated marks still appear in the picker.</li>
    {/if}
  </ul>

  <form
    class="add-row"
    onsubmit={(event) => {
      event.preventDefault();
      add();
    }}
  >
    <input
      class="url-input"
      type="url"
      placeholder="https://example.com/my-pack"
      autocomplete="off"
      bind:value={draft}
      data-testid="avatar-pack-url-input"
      aria-label="Pack base URL"
    />
    <button type="submit" class="add" data-testid="avatar-pack-url-add">Add</button>
  </form>
  {#if error}
    <p class="err" role="alert" data-testid="avatar-pack-url-error">{error}</p>
  {/if}
</div>

<style>
  .pack-settings {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
  }

  .pack-head {
    align-items: flex-start;
  }

  .url-list {
    display: flex;
    flex-direction: column;
    gap: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .url-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 0;
    border-top: 1px solid var(--line);
  }

  .url,
  .url-empty {
    min-width: 0;
    overflow: hidden;
    color: var(--t2);
    font: 400 12px/1.45 var(--font-mono, ui-monospace, Menlo, monospace);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .url-empty {
    padding: 8px 0;
    color: var(--t3);
    white-space: normal;
  }

  .remove,
  .add {
    appearance: none;
    margin-left: auto;
    padding: 0;
    border: 0;
    background: none;
    color: var(--t2);
    font: 500 12px/1.45 inherit;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .remove:hover,
  .add:hover {
    color: var(--t1);
  }

  .add-row {
    display: flex;
    gap: 12px;
    align-items: baseline;
    padding-top: 8px;
    border-top: 1px solid var(--line);
  }

  .url-input {
    appearance: none;
    flex: 1;
    min-width: 0;
    padding: 6px 0;
    border: 0;
    border-bottom: 1px solid var(--line);
    background: transparent;
    color: var(--t1);
    font: 400 12px/1.45 var(--font-mono, ui-monospace, Menlo, monospace);
  }

  .url-input:focus-visible,
  .remove:focus-visible,
  .add:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--t1));
    outline-offset: 2px;
  }

  .err {
    margin: 0;
    color: var(--danger, #ff6b6b);
    font-size: 12px;
  }
</style>

<script lang="ts">
  /**
   * Grid picker of avatar packs. Ghost layout: search, pack headings, a
   * 4-column swatch grid, keyboard movement, Save.
   */
  import { cspSafeAvatarSrc, resolvePackItemSrc } from "./parse-pack.js";
  import {
    filterPacks,
    flattenVisible,
    findSelectedRow,
    moveIndex,
    type FlatPickerRow,
  } from "./filter-items.js";
  import { loadRegisteredPacks, type PackFetch } from "./load-pack.js";
  import type { AvatarPack, AvatarSelection } from "./types.js";
  import "../chat/tokens.css";
  import "../chat/chat-tokens.css";

  interface Props {
    agentUid: string;
    currentSrc?: string | null;
    packs?: AvatarPack[] | null;
    loadPacks?: () => Promise<AvatarPack[]>;
    fetchImpl?: PackFetch;
    saving?: boolean;
    error?: string | null;
    onsave?: (selection: AvatarSelection) => void | Promise<void>;
  }

  let {
    agentUid,
    currentSrc = null,
    packs = null,
    loadPacks,
    fetchImpl,
    saving = false,
    error = null,
    onsave,
  }: Props = $props();

  let query = $state("");
  let remotePacks = $state<AvatarPack[] | null>(null);
  let loadError = $state<string | null>(null);
  let loadingRemote = $state(false);
  let selection = $state<AvatarSelection>({ kind: "generated" });
  let cursor = $state(0);
  let broken = $state(new Set<string>());

  function markBroken(key: string): void {
    if (broken.has(key)) return;
    const next = new Set(broken);
    next.add(key);
    broken = next;
  }

  function tileInitials(name: string): string {
    const parts = name.trim().split(/[\s·•/\-]+/).filter(Boolean);
    if (parts.length > 1) {
      return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
    }
    return name.trim().slice(0, 2).toUpperCase() || "•";
  }

  const loaded = $derived(packs ?? remotePacks ?? []);
  const loading = $derived(!packs && (loadingRemote || remotePacks === null));

  $effect(() => {
    if (packs) return;
    let cancelled = false;
    loadingRemote = true;
    const run =
      loadPacks ??
      (async () => {
        const rows = await loadRegisteredPacks({ fetch: fetchImpl });
        return rows.map((row) => row.pack);
      });
    void run()
      .then((next) => {
        if (cancelled) return;
        remotePacks = next;
        loadError = null;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        remotePacks = [];
        loadError =
          err instanceof Error ? err.message : "Could not load avatar packs.";
      })
      .finally(() => {
        if (!cancelled) loadingRemote = false;
      });
    return () => {
      cancelled = true;
    };
  });

  const groups = $derived(filterPacks(loaded, query));
  const rows = $derived(flattenVisible(groups));

  $effect(() => {
    if (cursor >= rows.length) cursor = Math.max(0, rows.length - 1);
  });

  const currentRow = $derived(rows[cursor] ?? null);
  const selectedRow = $derived(findSelectedRow(rows, selection));

  function selectGenerated(): void {
    selection = { kind: "generated" };
  }

  function selectRow(row: FlatPickerRow): void {
    selection = { kind: "item", packId: row.packId, itemId: row.itemId };
    const index = rows.findIndex((entry) => entry.key === row.key);
    if (index >= 0) cursor = index;
  }

  function onGridKeydown(event: KeyboardEvent): void {
    if (rows.length === 0) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      cursor = moveIndex(cursor, 1, rows.length);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      cursor = moveIndex(cursor, -1, rows.length);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      cursor = moveIndex(cursor, 4, rows.length, 4);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      cursor = moveIndex(cursor, -4, rows.length, 4);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const row = rows[cursor];
      if (row) selectRow(row);
    }
  }

  async function save(): Promise<void> {
    await onsave?.(selection);
  }

  const previewSrc = $derived.by(() => {
    const raw =
      selection.kind === "generated"
        ? currentSrc
        : (selectedRow?.src ?? currentSrc);
    return cspSafeAvatarSrc(raw);
  });
</script>

<div class="picker" data-testid="avatar-pack-picker" data-agent-uid={agentUid}>
  <label class="search-label" for="avatar-pack-search">Search avatars</label>
  <input
    id="avatar-pack-search"
    class="search"
    type="search"
    placeholder="Name or tag"
    autocomplete="off"
    bind:value={query}
    data-testid="avatar-pack-search"
  />

  <button
    type="button"
    class="generated"
    class:on={selection.kind === "generated"}
    data-testid="avatar-use-generated"
    aria-pressed={selection.kind === "generated"}
    onclick={selectGenerated}
  >
    Use generated mark
  </button>

  {#if previewSrc}
    <div class="preview" data-testid="avatar-pack-preview">
      <img src={previewSrc} alt="" />
    </div>
  {/if}

  {#if loading}
    <p class="note">Loading packs…</p>
  {:else if loadError}
    <p class="note" role="alert">{loadError}</p>
  {:else if rows.length === 0}
    <p class="note">No avatars match.</p>
  {:else}
    <div
      class="packs"
      role="listbox"
      aria-label="Avatar packs"
      tabindex="0"
      data-testid="avatar-pack-grid"
      onkeydown={onGridKeydown}
    >
      {#each groups as group (group.pack.id)}
        <section class="pack">
          <h3 class="pack-name">{group.pack.name}</h3>
          <p class="pack-meta">{group.pack.author} · {group.pack.version}</p>
          <div class="grid">
            {#each group.items as item (item.id)}
              {@const src = resolvePackItemSrc(group.pack, item)}
              {@const tileSrc = cspSafeAvatarSrc(src)}
              {@const key = `${group.pack.id}:${item.id}`}
              {@const selected =
                selection.kind === "item" &&
                selection.packId === group.pack.id &&
                selection.itemId === item.id}
              {@const focused = currentRow?.key === key}
              {@const failed = !tileSrc || broken.has(key)}
              <button
                type="button"
                class="sw"
                class:on={selected}
                class:focus={focused}
                role="option"
                aria-selected={selected}
                aria-label={item.name}
                data-testid="avatar-pack-item"
                data-pack={group.pack.id}
                data-item={item.id}
                onclick={() =>
                  selectRow({
                    key,
                    packId: group.pack.id,
                    itemId: item.id,
                    packName: group.pack.name,
                    item,
                    src,
                  })}
              >
                {#if tileSrc}
                  <img
                    src={tileSrc}
                    alt=""
                    class:is-broken={broken.has(key)}
                    onerror={() => markBroken(key)}
                  />
                {/if}
                {#if failed}
                  <span class="fallback" data-testid="avatar-pack-item-fallback">
                    {tileInitials(item.name)}
                  </span>
                {/if}
              </button>
            {/each}
          </div>
        </section>
      {/each}
    </div>
  {/if}

  {#if error}
    <p class="err" role="alert" data-testid="avatar-pack-error">{error}</p>
  {/if}

  <button
    type="button"
    class="save"
    data-testid="avatar-pack-save"
    disabled={saving || loading}
    onclick={() => void save()}
  >
    {saving ? "Saving…" : "Save"}
  </button>
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 100%;
    text-align: left;
  }

  .search-label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }

  .search {
    appearance: none;
    width: 100%;
    padding: 8px 0;
    border: 0;
    border-bottom: 1px solid var(--line);
    background: transparent;
    color: var(--t1);
    font: 400 13px/1.45 var(--font-ui, inherit);
  }

  .search:focus-visible {
    outline: none;
    border-bottom-color: var(--t1);
  }

  .generated,
  .save {
    appearance: none;
    align-self: flex-start;
    padding: 0;
    border: 0;
    background: none;
    color: var(--t2);
    font: 500 12px/1.45 var(--font-ui, inherit);
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .generated.on,
  .generated:hover,
  .save:hover {
    color: var(--t1);
  }

  .generated:focus-visible,
  .save:focus-visible,
  .sw:focus-visible,
  .packs:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--t1));
    outline-offset: 2px;
  }

  .save:disabled {
    color: var(--t3);
    cursor: default;
    text-decoration: none;
  }

  .preview {
    position: relative;
    width: 56px;
    height: 56px;
    overflow: hidden;
    border: 1px dashed color-mix(in srgb, var(--t1) 16%, transparent);
  }

  .preview img,
  .sw img {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .sw img.is-broken {
    opacity: 0;
  }

  .note,
  .err,
  .pack-meta {
    margin: 0;
    color: var(--t3);
    font-size: 12px;
  }

  .err {
    color: var(--danger, #ff6b6b);
  }

  .packs {
    display: flex;
    flex-direction: column;
    gap: 22px;
  }

  .pack {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 16px;
    border-top: 1px solid var(--line);
  }

  .pack-name {
    margin: 0;
    color: var(--t2);
    font: 500 12px/1.45 var(--font-ui, inherit);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
  }

  .sw {
    position: relative;
    display: block;
    aspect-ratio: 1;
    min-height: 0;
    padding: 0;
    overflow: hidden;
    border: 1px solid transparent;
    border-radius: 10px;
    background: color-mix(in srgb, var(--t1) 5%, transparent);
    cursor: pointer;
  }

  .fallback {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--t2);
    font: 500 12px/1 var(--font-ui, inherit);
    letter-spacing: 0.02em;
    pointer-events: none;
  }

  .sw.on {
    border-color: var(--t1);
  }

  .sw.focus:not(.on),
  .sw:hover:not(.on) {
    border-color: color-mix(in srgb, var(--t1) 16%, transparent);
  }
</style>

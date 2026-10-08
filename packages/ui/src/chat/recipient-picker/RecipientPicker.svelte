<script module lang="ts">
  let pickerSequence = 0;
</script>

<script lang="ts">
  /**
   * Shared recipient picker for New message, Forward, and Share.
   *
   * The To field and the grouped list are extracted from the Forward picker
   * (feat/dm-forward, US-009 revision): one search field carries the scope
   * chip and the chosen recipients as chips; results are grouped Recent,
   * Channels, People, Bots, with an avatar and presence dot, a subtitle, a
   * type tag (or the host's hint), and a check mark when picked. Avatars use
   * the shared Avatar (photo, bot mascot, colored initials).
   *
   * Keys in the search: ↑/↓ and hover move the highlight; Enter adds the
   * highlighted row (or submits when it is already picked); Backspace on an
   * empty search removes the last chip; ⌥←/⌥→ switch scope; ⌘/Ctrl+Enter
   * submits; Escape closes the scope menu, then the dropdown, then cancels.
   *
   * `presentation="panel"` (dialogs) always shows the list; `"dropdown"` (an
   * inline To field) shows it under the field while typing. The quoted card
   * and footer render only when the host passes `quote` / `onsubmit`.
   * Type follows the console-rail standard: 13px, weight at most 500.
   */
  import type { Snippet } from "svelte";
  import Avatar from "../../common/avatar/Avatar.svelte";
  import RailButton from "../../common/button/RailButton.svelte";
  import {
    RECIPIENT_KIND_LABEL,
    flattenRecipientSections,
    groupRecipients,
    highlightParts,
    nextRecipientScope,
    recipientDisplayName,
    recipientPlaceholder,
    recipientPrimaryLabel,
    removeLastRecipient,
    toggleRecipient,
    type RecipientItem,
    type RecipientPickerMode,
    type RecipientQuote,
    type RecipientScopeOption,
  } from "./recipient-picker-model.js";

  interface Props {
    /** Candidates, already limited to the active scope by the host. */
    items: readonly RecipientItem[];
    mode?: RecipientPickerMode;
    multiple?: boolean;
    /** New message: a channel is a whole conversation (replaces people/bots). */
    channelOpens?: boolean;
    selectedIds?: string[];
    query?: string;
    /** Scope chip inside the search; hidden when `scopes` is empty. */
    scopes?: readonly RecipientScopeOption[];
    scope?: string;
    /** Called with the new selection and the matching items, in pick order. */
    onSelect?: (ids: string[], items: RecipientItem[]) => void;
    onscopechange?: (scope: string) => void;
    presentation?: "panel" | "dropdown";
    /** Field label; null hides it. */
    label?: string | null;
    quote?: RecipientQuote | null;
    loading?: boolean;
    /** Plain-language load failure; never raw transport text. */
    error?: string | null;
    onretry?: () => void;
    /** Offer a "send to this email" row when the query is an unknown email. */
    freeEmail?: boolean;
    emptyText?: string;
    onsubmit?: (ids: string[]) => void;
    oncancel?: () => void;
    /** Keep ⌘↵ → onsubmit but draw no footer (the host owns its footer). */
    hideFooter?: boolean;
    busy?: boolean;
    /** Footer status text: an error or a key hint. */
    status?: string | null;
    header?: Snippet;
    /** Between the list and the footer: a note or first-line composer. */
    children?: Snippet;
    placeholder?: string;
    autofocus?: boolean;
    disabled?: boolean;
    searchEl?: HTMLInputElement | null;
    testid?: string;
    submitTestid?: string;
  }

  let {
    items,
    mode = "message",
    multiple = true,
    channelOpens = false,
    selectedIds = $bindable([]),
    query = $bindable(""),
    scopes = [],
    scope = $bindable(""),
    onSelect,
    onscopechange,
    presentation = "panel",
    label = "To",
    quote = null,
    loading = false,
    error = null,
    onretry,
    freeEmail = false,
    emptyText,
    onsubmit,
    oncancel,
    hideFooter = false,
    busy = false,
    status = null,
    header,
    children,
    placeholder,
    autofocus = false,
    disabled = false,
    searchEl = $bindable(null),
    testid = "recipient-picker",
    submitTestid = "recipient-submit",
  }: Props = $props();

  const uid = `recipient-picker-${++pickerSequence}`;
  const listId = `${uid}-list`;
  const labelId = `${uid}-label`;
  let highlightId = $state<string | null>(null);
  let open = $state(false);
  let scopeOpen = $state(false);

  const emailItem = $derived.by((): RecipientItem | null => {
    const value = query.trim();
    if (!freeEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return null;
    const lower = value.toLowerCase();
    if (items.some((item) => item.subtitle?.toLowerCase() === lower)) return null;
    return { id: `email:${lower}`, kind: "person", name: value, subtitle: "Send to this email", companyUid: null, lastActivityAt: 0 };
  });
  // A picked email row has no item once the query clears; remember it.
  let remembered = $state<RecipientItem[]>([]);
  const known = $derived([...(emailItem ? [emailItem] : []), ...items, ...remembered]);
  const sections = $derived(groupRecipients(items, query));
  const visible = $derived([...(emailItem ? [emailItem] : []), ...flattenRecipientSections(sections)]);
  const selected = $derived(
    selectedIds.map((id) => known.find((item) => item.id === id)).filter((item): item is RecipientItem => !!item),
  );
  const listShown = $derived(presentation === "panel" || (open && query.trim().length > 0));
  const scopeLabel = $derived(scopes.find((option) => option.id === scope)?.label ?? scopes[0]?.label ?? "");
  const canSubmit = $derived(selected.length > 0 && !busy && !disabled);

  $effect(() => {
    // Keep the highlight on a visible row as the query or scope changes.
    if (highlightId && !visible.some((item) => item.id === highlightId)) highlightId = visible[0]?.id ?? null;
    if (!highlightId && visible.length > 0) highlightId = visible[0].id;
  });

  $effect(() => {
    if (autofocus) searchEl?.focus();
  });

  function isSelected(id: string): boolean {
    return selectedIds.includes(id);
  }

  function commit(ids: string[]): void {
    selectedIds = ids;
    onSelect?.(ids, ids.map((id) => known.find((item) => item.id === id)).filter((item): item is RecipientItem => !!item));
  }

  function toggle(item: RecipientItem): void {
    // Resolve the email row before the query clears and the row disappears.
    if (emailItem && item.id === emailItem.id && !remembered.some((k) => k.id === item.id)) {
      remembered = [...remembered, item];
    }
    commit(toggleRecipient(selectedIds, item, { multiple, channelOpens, items: known }));
    highlightId = item.id;
    if (query) query = "";
    if (presentation === "dropdown") open = false;
    searchEl?.focus();
  }

  function remove(id: string): void {
    commit(selectedIds.filter((x) => x !== id));
    searchEl?.focus();
  }

  function changeScope(id: string): void {
    scope = id;
    scopeOpen = false;
    onscopechange?.(id);
    searchEl?.focus();
  }

  function submit(): void {
    if (canSubmit || (hideFooter && onsubmit)) onsubmit?.(selectedIds);
  }

  function optionId(id: string): string {
    return `${uid}-opt-${id.replace(/[^\w-]/g, "_")}`;
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      if (scopeOpen) scopeOpen = false;
      else if (presentation === "dropdown" && open) open = false;
      else if (oncancel) oncancel();
      else return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) return submit();
      const item = visible.find((candidate) => candidate.id === highlightId);
      if (item && listShown && !isSelected(item.id)) toggle(item);
      else submit();
      return;
    }
    if (event.key === "Backspace" && !query && selectedIds.length > 0) {
      event.preventDefault();
      commit(removeLastRecipient(selectedIds));
      return;
    }
    if (event.altKey && (event.key === "ArrowRight" || event.key === "ArrowLeft") && scopes.length > 1) {
      event.preventDefault();
      changeScope(nextRecipientScope(scopes, scope, event.key === "ArrowRight" ? 1 : -1));
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      open = true;
      if (visible.length === 0) return;
      event.preventDefault();
      const at = visible.findIndex((item) => item.id === highlightId);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = at < 0 ? (step > 0 ? 0 : visible.length - 1) : (at + step + visible.length) % visible.length;
      highlightId = visible[next].id;
      document.getElementById(optionId(highlightId))?.scrollIntoView?.({ block: "nearest" });
    }
  }
</script>

{#snippet face(item: RecipientItem, size: number, withPresence: boolean)}
  {#if item.kind === "channel" || item.kind === "group"}
    <span class="rp-tile" class:group={item.kind === "group"} style={`--rp-face:${size}px`} aria-hidden="true">
      {#if item.kind === "channel"}#{:else}
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="6" r="2.2" /><circle cx="11" cy="7" r="1.8" /><path d="M2.5 13c.5-2 2-3 3.5-3s3 1 3.5 3M9.5 12.5c.4-1.4 1.3-2.2 2.5-2.2s2 .8 2.4 2.2" /></svg>
      {/if}
    </span>
  {:else}
    <Avatar
      kind={item.kind === "bot" ? "bot" : "person"}
      name={item.name}
      id={item.principalUid ?? item.id}
      photo={item.avatarUrl ?? null}
      presence={withPresence && item.online ? "online" : null}
      {size}
    />
  {/if}
{/snippet}

{#snippet highlighted(text: string)}
  {#each highlightParts(text, query) as part, i (i)}{#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}
{/snippet}

{#snippet option(item: RecipientItem, section: string)}
  {@const picked = isSelected(item.id)}
  <button
    type="button"
    role="option"
    id={optionId(item.id)}
    class="rp-option"
    class:highlight={item.id === highlightId}
    class:picked
    aria-selected={picked}
    tabindex="-1"
    data-testid="recipient-row"
    data-id={item.id}
    data-kind={item.kind}
    data-section={section}
    onmousedown={(event) => event.preventDefault()}
    onclick={() => toggle(item)}
    onmousemove={() => (highlightId = item.id)}
  >
    {@render face(item, 24, true)}
    <span class="rp-option-copy">
      <span class="rp-option-name">{@render highlighted(recipientDisplayName(item))}</span>
      {#if item.subtitle}<span class="rp-option-sub">{@render highlighted(item.subtitle)}</span>{/if}
    </span>
    <span class="rp-option-kind">{item.hint ?? RECIPIENT_KIND_LABEL[item.kind]}</span>
    <span class="rp-option-check" aria-hidden="true">
      {#if picked}
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
          <path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      {/if}
    </span>
  </button>
{/snippet}

<div class="rp" class:dropdown={presentation === "dropdown"} data-testid={testid} data-mode={mode} aria-busy={loading}>
  {#if header}{@render header()}{/if}

  {#if quote}
    <div class="rp-quote" data-testid="recipient-quote">
      <Avatar kind={quote.authorKind ?? "person"} name={quote.authorName} id={quote.authorId ?? null} photo={quote.authorPhoto ?? null} size={24} />
      <div class="rp-quote-copy">
        <div class="rp-quote-head">
          <span class="rp-quote-name">{quote.authorName}</span>
          {#if quote.time}<span>{quote.time}</span>{/if}
          {#if quote.origin}<span>{quote.origin}</span>{/if}
        </div>
        <div class="rp-quote-body">{quote.body}</div>
      </div>
    </div>
  {/if}

  <div class="rp-to">
    {#if label}<span class="rp-to-label" id={labelId}>{label}</span>{/if}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="rp-field"
      class:disabled
      data-testid="recipient-field"
      onpointerdown={(event) => {
        // A press on the frame's empty space focuses the search.
        if (event.target === event.currentTarget) {
          event.preventDefault();
          searchEl?.focus();
        }
      }}
    >
      {#if scopes.length > 0}
        <div class="rp-scope">
          <button
            type="button"
            class="rp-chip scope"
            data-testid="recipient-scope"
            aria-haspopup="listbox"
            aria-expanded={scopeOpen}
            title="Switch company (⌥← ⌥→)"
            {disabled}
            onclick={(event) => {
              event.stopPropagation();
              scopeOpen = !scopeOpen;
            }}
          >
            <span class="rp-chip-name">{scopeLabel}</span>
            <svg viewBox="0 0 10 10" width="9" height="9" fill="none" aria-hidden="true">
              <path d="M2 3.5l3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
          </button>
          {#if scopeOpen}
            <div class="rp-scope-menu" role="listbox" aria-label="Scope" data-testid="recipient-scope-menu">
              {#each scopes as option (option.id)}
                <button
                  type="button"
                  role="option"
                  class="rp-scope-option"
                  aria-selected={scope === option.id}
                  data-value={option.id}
                  onclick={(event) => {
                    event.stopPropagation();
                    changeScope(option.id);
                  }}>{option.label}</button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      {#each selected as item (item.id)}
        <span class="rp-chip" data-testid="recipient-chip" data-id={item.id}>
          {@render face(item, 16, false)}
          <span class="rp-chip-name">{recipientDisplayName(item)}</span>
          <button
            type="button"
            class="rp-chip-x"
            aria-label={`Remove ${item.name}`}
            data-testid="recipient-chip-remove"
            onclick={(event) => {
              event.stopPropagation();
              remove(item.id);
            }}
          >
            <svg viewBox="0 0 10 10" width="9" height="9" fill="none" aria-hidden="true">
              <path d="M3 3l4 4M7 3L3 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </button>
        </span>
      {/each}
      <input
        bind:this={searchEl}
        bind:value={query}
        class="rp-search"
        type="text"
        role="combobox"
        autocomplete="off"
        spellcheck="false"
        placeholder={placeholder ?? recipientPlaceholder(selected.length)}
        aria-labelledby={label ? labelId : undefined}
        aria-label={label ? undefined : "Recipients"}
        aria-expanded={listShown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={listShown && highlightId ? optionId(highlightId) : undefined}
        data-testid="recipient-query"
        {disabled}
        oninput={() => (open = true)}
        onfocus={() => (open = query.trim().length > 0)}
        onblur={() => {
          if (presentation === "dropdown") open = false;
        }}
        onkeydown={onKey}
      />
    </div>
  </div>

  {#if listShown}
    <div class="rp-list" id={listId} role="listbox" aria-multiselectable={multiple} aria-label="Recipients" data-testid="recipient-list">
      {#if emailItem}
        <div class="rp-section" data-testid="recipient-section" data-section="email">
          {@render option(emailItem, "email")}
        </div>
      {/if}
      {#each sections as section (section.key)}
        <div class="rp-section" data-testid="recipient-section" data-section={section.key}>
          <div class="rp-section-label">{section.label}<span class="rp-count">{section.items.length}</span></div>
          {#each section.items as item (item.id)}
            {@render option(item, section.key)}
          {/each}
        </div>
      {/each}
      {#if error}
        <div class="rp-empty" role="alert">
          <span>{error}</span>
          {#if onretry}<button type="button" class="rp-link" onclick={onretry} disabled={loading}>{loading ? "Retrying…" : "Retry"}</button>{/if}
        </div>
      {:else if loading && visible.length === 0}
        <div class="rp-empty" role="status">Looking up people…</div>
      {:else if visible.length === 0}
        <div class="rp-empty" role="status" data-testid="recipient-empty">
          {emptyText ?? (query.trim() ? "No matches. Try another name." : "No one to show here yet.")}
        </div>
      {/if}
    </div>
  {/if}

  {#if children}<div class="rp-body">{@render children()}</div>{/if}

  {#if onsubmit && !hideFooter}
    <footer class="rp-foot">
      <span class="rp-foot-status">{status ?? ""}</span>
      <RailButton icon="x" type="button" onclick={() => oncancel?.()}>Cancel</RailButton>
      <RailButton
        icon="send"
        variant="primary"
        type="button"
        data-testid={submitTestid}
        disabled={!canSubmit}
        onclick={submit}
      >{busy ? "Sending…" : recipientPrimaryLabel(mode, selected.length)}</RailButton>
    </footer>
  {/if}
</div>

<style>
  .rp {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    color: var(--t1, var(--v4-text-1));
    font-size: 13px;
  }

  .rp-quote {
    display: flex;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--hover, var(--v4-control-faint));
  }
  .rp-quote-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .rp-quote-head { display: flex; gap: 6px; align-items: baseline; color: var(--t3, var(--v4-text-3)); }
  .rp-quote-name { color: var(--t1, var(--v4-text-1)); font-weight: 500; }
  .rp-quote-body {
    color: var(--t2, var(--v4-text-2));
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .rp-to { display: flex; align-items: flex-start; gap: 10px; }
  .rp-to-label { flex: 0 0 auto; padding-top: 7px; color: var(--t3, var(--v4-text-3)); }
  .rp-field {
    flex: 1 1 auto;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    min-width: 0;
    min-height: 32px;
    padding: 3px 6px;
    border: 1px solid var(--overlay-field-border, var(--line2));
    border-radius: 9px;
    background: var(--overlay-field-bg, transparent);
    cursor: text;
  }
  .rp-field:focus-within { border-color: color-mix(in srgb, var(--t1) 28%, transparent); }
  .rp-field.disabled { opacity: 0.55; }
  .rp-search {
    flex: 1 1 120px;
    min-width: 80px;
    padding: 4px 2px;
    border: 0;
    background: transparent;
    color: var(--t1, var(--v4-text-1));
    font: inherit;
    font-size: 13px;
    outline: none;
  }
  .rp-search::placeholder { color: var(--t3, var(--v4-text-3)); }

  .rp-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    height: 22px;
    padding: 0 3px 0 3px;
    border: 0;
    border-radius: 999px;
    background: color-mix(in srgb, var(--t1) 10%, transparent);
    color: var(--t1, var(--v4-text-1));
    font: inherit;
    font-size: 13px;
  }
  .rp-chip.scope {
    padding: 0 7px 0 8px;
    background: color-mix(in srgb, var(--t1) 7%, transparent);
    color: var(--t2, var(--v4-text-2));
    cursor: pointer;
  }
  .rp-chip.scope:hover, .rp-chip.scope[aria-expanded="true"] { color: var(--t1, var(--v4-text-1)); }
  .rp-chip-name { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rp-chip-x {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--t3, var(--v4-text-3));
    cursor: pointer;
  }
  .rp-chip-x:hover { background: color-mix(in srgb, var(--t1) 12%, transparent); color: var(--t1, var(--v4-text-1)); }
  .rp-chip.scope:focus-visible, .rp-chip-x:focus-visible, .rp-link:focus-visible, .rp-scope-option:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--t1) 45%, transparent);
    outline-offset: 1px;
  }

  .rp-scope { position: relative; }
  .rp-scope-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 3;
    display: flex;
    flex-direction: column;
    min-width: 180px;
    padding: 4px;
    border: 1px solid var(--overlay-border);
    border-radius: 10px;
    background: var(--overlay-bg);
    box-shadow: var(--overlay-shadow);
  }
  .rp-scope-option {
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t1, var(--v4-text-1));
    font: inherit;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }
  .rp-scope-option:hover, .rp-scope-option[aria-selected="true"] { background: var(--hover); }

  .rp-list {
    display: flex;
    flex-direction: column;
    min-height: 96px;
    max-height: 280px;
    margin: 0 -6px;
    padding: 0 6px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--t1) 18%, transparent) transparent;
  }
  .dropdown .rp-list {
    position: absolute;
    z-index: 20;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    min-height: 0;
    margin: 0;
    padding: 4px;
    border: 1px solid var(--overlay-border);
    border-radius: 10px;
    background: var(--overlay-bg);
    box-shadow: var(--overlay-shadow);
  }
  .rp-section { display: flex; flex-direction: column; }
  .rp-section-label {
    display: flex;
    gap: 6px;
    padding: 8px 8px 3px;
    color: var(--t3, var(--v4-text-3));
  }
  .rp-section:first-child .rp-section-label { padding-top: 2px; }
  .rp-count { font-variant-numeric: tabular-nums; opacity: 0.7; }
  .rp-option {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 40px;
    padding: 5px 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--t1, var(--v4-text-1));
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .rp-option.highlight { background: var(--hover, color-mix(in srgb, var(--t1) 7%, transparent)); }
  .rp-option-copy { flex: 1 1 auto; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .rp-option-name, .rp-option-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rp-option-sub { color: var(--t3, var(--v4-text-3)); }
  .rp-option-copy mark { background: transparent; color: var(--t1, var(--v4-text-1)); font-weight: 500; }
  .rp-option-kind { flex: 0 0 auto; color: var(--t3, var(--v4-text-3)); white-space: nowrap; }
  .rp-option-check { display: grid; place-items: center; flex: 0 0 14px; width: 14px; height: 14px; color: var(--t1, var(--v4-text-1)); }
  .rp-option.picked .rp-option-name { font-weight: 500; }
  .rp-tile {
    display: inline-grid;
    place-items: center;
    flex: 0 0 var(--rp-face);
    width: var(--rp-face);
    height: var(--rp-face);
    border-radius: 6px;
    background: color-mix(in srgb, var(--t1) 9%, transparent);
    color: var(--t2, var(--v4-text-2));
    font-size: calc(var(--rp-face) * 0.55);
    font-weight: 500;
    line-height: 1;
  }
  .rp-tile.group { border-radius: 999px; }
  .rp-tile svg { width: 70%; height: 70%; fill: none; stroke: currentColor; stroke-width: 1.2; stroke-linecap: round; }

  .rp-empty {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 8px;
    color: var(--t3, var(--v4-text-3));
  }
  .rp-link {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--t1, var(--v4-text-1));
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
  }
  .rp-link:disabled { opacity: 0.6; cursor: default; }

  .rp-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 2px -16px -14px;
    padding: 12px 16px;
    border-top: 1px solid var(--overlay-border);
  }
  .rp-foot-status { flex: 1; min-width: 0; color: var(--t3, var(--v4-text-3)); }
</style>

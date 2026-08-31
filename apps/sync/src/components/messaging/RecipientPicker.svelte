<script module lang="ts">
  let recipientPickerSequence = 0;
</script>

<script lang="ts">
  // Recipient autocomplete for the New Message compose flow (US-010).
  //
  // An email-style input with a dropdown that suggests, in priority order:
  //   (a) known contacts          — list_contacts
  //   (b) per-company members     — list_company_members for each of the
  //                                 caller's companies, grouped "From {name}"
  //   (c) a free-text "Send to {email}" row when the typed string is a valid
  //       email not already in (a) or (b)
  //
  // Matching/grouping/dedupe lives in `src/lib/recipientPicker.ts` (unit-tested);
  // this component owns the data fetches, keyboard handling, and rendering. It
  // emits the chosen recipient via the `onselect` callback and notifies the
  // parent of query changes via `onquerychange`.
  import { invoke } from '@tauri-apps/api/core';
  import { untrack } from 'svelte';
  import {
    buildSuggestions,
    flattenRows,
    resolveTypedRecipient,
    type ContactLike,
    type CompanyInfo,
    type SelectedRecipient,
    type SuggestionGroup,
    type SuggestionRow,
  } from '../../lib/recipientPicker';

  interface ContactsResponse {
    contacts: ContactLike[];
  }
  interface MembershipRow {
    companyUid: string;
    companyName: string | null;
    role: string | null;
    status: string;
  }

  type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

  interface Props {
    // The currently selected recipient (null until one is chosen). Owned by the
    // parent so it can clear the picker after a send.
    selected: SelectedRecipient | null;
    onselect: (recipient: SelectedRecipient | null) => void;
    /** ⌘/Ctrl+↵ pressed while the input is focused — lets the compose sheet
     * send without the user tabbing to the body first. */
    onsubmit?: () => void;
    placeholder?: string;
    disabled?: boolean;
  }

  let {
    selected = $bindable(),
    onselect,
    onsubmit,
    placeholder = 'Type a name or email…',
    disabled = false,
  }: Props = $props();

  let query = $state('');
  let open = $state(false);
  let activeIndex = $state(0);
  const listboxId = `recipient-suggestions-${++recipientPickerSequence}`;

  let contacts = $state<ContactLike[]>([]);
  let companies = $state<CompanyInfo[]>([]);
  let membersByCompany = $state<Record<string, ContactLike[]>>({});
  let contactsStatus = $state<LoadStatus>('idle');
  let companiesStatus = $state<LoadStatus>('idle');
  let memberStatuses = $state<Record<string, LoadStatus>>({});

  const groups = $derived<SuggestionGroup[]>(
    query.trim().length === 0 && !selected
      ? []
      : buildSuggestions({ query, contacts, membersByCompany, companies }),
  );
  const flatRows = $derived<SuggestionRow[]>(flattenRows(groups));
  const membersLoading = $derived(
    Object.values(memberStatuses).some((status) => status === 'loading'),
  );
  const membersFailed = $derived(
    Object.values(memberStatuses).some((status) => status === 'error'),
  );
  const discoveryLoading = $derived(
    contactsStatus === 'idle'
      || contactsStatus === 'loading'
      || companiesStatus === 'idle'
      || companiesStatus === 'loading'
      || membersLoading,
  );
  const discoveryFailed = $derived(
    contactsStatus === 'error' || companiesStatus === 'error' || membersFailed,
  );
  const showDiscoveryPanel = $derived(open && query.trim().length > 0);
  const hasVisibleResults = $derived(groups.length > 0);

  async function loadContacts(): Promise<void> {
    if (contactsStatus === 'loading') return;
    contactsStatus = 'loading';
    try {
      const resp = await invoke<ContactsResponse>('list_contacts');
      contacts = resp.contacts ?? [];
      contactsStatus = 'ready';
    } catch (err) {
      console.error('recipient-picker: list_contacts failed', err);
      // Keep the last trusted directory visible when a refresh fails.
      contactsStatus = 'error';
    }
  }

  async function loadCompanies(): Promise<void> {
    if (companiesStatus === 'loading') return;
    companiesStatus = 'loading';
    try {
      const list = await invoke<MembershipRow[]>('meetings_list_memberships');
      const nextCompanies = (list ?? [])
        .filter((m) => m.status === 'active')
        .map((m) => ({ companyUid: m.companyUid, companyName: m.companyName }));
      const activeCompanyUids = new Set(nextCompanies.map((company) => company.companyUid));
      companies = nextCompanies;
      membersByCompany = Object.fromEntries(
        Object.entries(membersByCompany).filter(([companyUid]) => activeCompanyUids.has(companyUid)),
      );
      memberStatuses = Object.fromEntries(
        Object.entries(memberStatuses).filter(([companyUid]) => activeCompanyUids.has(companyUid)),
      );
      companiesStatus = 'ready';

      // The user may have started typing while memberships were still loading.
      if (query.trim().length > 0) {
        for (const company of nextCompanies) void loadCompanyMembers(company.companyUid);
      }
    } catch (err) {
      console.error('recipient-picker: meetings_list_memberships failed', err);
      // Keep the last trusted memberships visible when a refresh fails.
      companiesStatus = 'error';
    }
  }

  async function loadCompanyMembers(companyUid: string): Promise<void> {
    const status = memberStatuses[companyUid];
    if (status === 'loading' || status === 'ready') return;
    memberStatuses = { ...memberStatuses, [companyUid]: 'loading' };
    try {
      const resp = await invoke<ContactsResponse>('list_company_members', { companyUid });
      membersByCompany = { ...membersByCompany, [companyUid]: resp.contacts ?? [] };
      memberStatuses = { ...memberStatuses, [companyUid]: 'ready' };
    } catch (err) {
      console.error('recipient-picker: list_company_members failed', companyUid, err);
      // Do not clear a previously trusted member list.
      memberStatuses = { ...memberStatuses, [companyUid]: 'error' };
    }
  }

  async function retryDiscovery(): Promise<void> {
    const retries: Promise<void>[] = [];
    if (contactsStatus === 'error') retries.push(loadContacts());
    if (companiesStatus === 'error') retries.push(loadCompanies());
    for (const [companyUid, status] of Object.entries(memberStatuses)) {
      if (status === 'error') retries.push(loadCompanyMembers(companyUid));
    }
    await Promise.all(retries);
  }

  function onInput(value: string): void {
    query = value;
    activeIndex = 0;
    open = true;
    // A new keystroke means the prior selection no longer matches the text.
    if (selected) {
      selected = null;
      onselect(null);
    }
    // Lazily fetch every company's members once the user starts typing so
    // company groups can appear. Cheap: each company is fetched at most once.
    for (const co of companies) void loadCompanyMembers(co.companyUid);
  }

  function choose(row: SuggestionRow): void {
    selected = row.recipient;
    query = row.recipient.displayName || row.recipient.email;
    open = false;
    onselect(row.recipient);
  }

  /** Resolve the currently typed query to a recipient without an explicit
   * click — called by the compose sheet at send time (instance method via
   * bind:this). Mirrors choose() when it resolves so the input, dropdown, and
   * parent selection all reflect the resolved recipient. Conservative rules
   * live in resolveTypedRecipient(); null means "ambiguous or no match". */
  export function resolveTyped(): SelectedRecipient | null {
    if (selected) return selected;
    const resolved = resolveTypedRecipient(flatRows, query);
    if (resolved) {
      selected = resolved;
      query = resolved.displayName || resolved.email;
      open = false;
      onselect(resolved);
    }
    return resolved;
  }

  function onKeydown(e: KeyboardEvent): void {
    // ⌘/Ctrl+↵ from the To field means "send" regardless of dropdown state.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      onsubmit?.();
      return;
    }
    if (!open || flatRows.length === 0) {
      if (e.key === 'ArrowDown') {
        open = true;
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % flatRows.length;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + flatRows.length) % flatRows.length;
    } else if (e.key === 'Enter') {
      // Only intercept Enter when a suggestion is highlighted — otherwise let it
      // bubble (the composer may treat ⌘↵ as send).
      if (!(e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const row = flatRows[activeIndex];
        if (row) choose(row);
      }
    } else if (e.key === 'Escape') {
      open = false;
    }
  }

  // Map a flat index back to a (group, row) so highlight + click line up.
  function isActive(row: SuggestionRow): boolean {
    return flatRows[activeIndex] === row;
  }

  function optionId(row: SuggestionRow): string {
    return `${listboxId}-option-${flatRows.indexOf(row)}`;
  }

  $effect(() => {
    untrack(() => {
      void loadContacts();
      void loadCompanies();
    });
  });

  $effect(() => {
    if (flatRows.length === 0) {
      activeIndex = 0;
    } else if (activeIndex >= flatRows.length) {
      activeIndex = flatRows.length - 1;
    }
  });
</script>

<div class="recipient-picker" aria-busy={discoveryLoading}>
  <input
    class="recipient-input"
    type="text"
    role="combobox"
    aria-expanded={open}
    aria-controls={listboxId}
    aria-activedescendant={open && flatRows[activeIndex] ? optionId(flatRows[activeIndex]) : undefined}
    aria-busy={discoveryLoading}
    aria-autocomplete="list"
    autocomplete="off"
    spellcheck="false"
    {placeholder}
    {disabled}
    value={query}
    oninput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
    onkeydown={onKeydown}
    onfocus={() => (open = query.trim().length > 0)}
  />

  {#if showDiscoveryPanel}
    <div class="suggestions">
      <ul class="suggestion-list" id={listboxId} role="listbox">
        {#each groups as group (group.key)}
          {#if group.label}
            <li class="group-heading" role="presentation">{group.label}</li>
          {/if}
          {#each group.rows as row (group.key + ':' + (row.recipient.personUid ?? row.recipient.email))}
            <li role="presentation">
              <button
                id={optionId(row)}
                type="button"
                class="suggestion"
                class:active={isActive(row)}
                class:freetext={row.freeText}
                role="option"
                aria-selected={isActive(row)}
                onmousedown={(e) => {
                  // mousedown (not click) so it fires before the input blur closes
                  // the list.
                  e.preventDefault();
                  choose(row);
                }}
              >
                <span class="suggestion-primary">{row.primary}</span>
                {#if row.secondary}
                  <span class="suggestion-secondary">{row.secondary}</span>
                {/if}
                {#if !row.freeText && row.recipient.connectionState !== 'active'}
                  <span class="suggestion-tag">{row.recipient.connectionState === 'blocked' ? 'blocked' : 'not connected'}</span>
                {/if}
              </button>
            </li>
          {/each}
        {/each}
      </ul>

      {#if discoveryFailed}
        <div class="discovery-status discovery-error" role="alert">
          <span>
            {hasVisibleResults
              ? 'Some people couldn’t be refreshed. Showing saved results.'
              : 'People couldn’t be loaded.'}
          </span>
          <button
            class="discovery-retry"
            type="button"
            onclick={() => void retryDiscovery()}
            disabled={discoveryLoading}
          >
            {discoveryLoading ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      {:else if discoveryLoading}
        <div class="discovery-status" role="status">Looking up people…</div>
      {:else if !hasVisibleResults}
        <div class="discovery-status" role="status">No matching people.</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Desktop "Company OS" language: hairline-bordered input + dropdown over a
     low-fill surface, one 13px body size with monospace caps for group headings
     and the not-connected tag, accent reserved for the active/hovered option +
     focus ring. Tokens come from the shared desktop alias layer
     (desktop-alt.css). */

  .recipient-picker {
    position: relative;
    width: 100%;
    font-family: var(--font-sans);
  }

  .recipient-input {
    width: 100%;
    box-sizing: border-box;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface-raise);
    color: var(--fg);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: 1.4;
    letter-spacing: -0.006em;
  }

  .recipient-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }

  .recipient-input:disabled {
    opacity: 0.6;
  }

  .suggestions {
    position: absolute;
    z-index: 20;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    padding: var(--space-1);
    max-height: 248px;
    overflow-y: auto;
    border-radius: var(--radius-md);
    border: 1px solid var(--pop-border);
    background: var(--pop-bg);
    backdrop-filter: var(--glass-filter-soft, blur(16px) saturate(112%) contrast(101%));
    -webkit-backdrop-filter: var(--glass-filter-soft, blur(16px) saturate(112%) contrast(101%));
    box-shadow: var(--pop-shadow), inset 0 1px 0 var(--pop-highlight);
    scrollbar-width: thin;
    scrollbar-color: var(--scrollbar-thumb) transparent;
  }

  .suggestion-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .group-heading {
    padding: var(--space-2) var(--space-2) var(--space-1);
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .suggestion {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    width: 100%;
    text-align: left;
    padding: var(--space-2);
    border: none;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font-family: var(--font-sans);
    cursor: pointer;
  }

  .suggestion:hover {
    background: var(--accent-soft);
  }

  .suggestion.active {
    background: transparent;
    box-shadow: inset 0 -1px 0 var(--border-strong);
  }

  .suggestion:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .suggestion.freetext {
    color: var(--muted);
  }

  .suggestion-primary {
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .suggestion.freetext .suggestion-primary {
    color: var(--muted-2);
    font-weight: 400;
  }

  .suggestion-secondary {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .suggestion-tag {
    margin-left: auto;
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 2px var(--space-1);
    border-radius: var(--radius-sm);
    background: var(--surface-raise);
    color: var(--muted-2);
  }

  .discovery-status {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 30px;
    padding: var(--space-2);
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: var(--text-base);
    line-height: 1.35;
  }

  .suggestion-list:empty + .discovery-status {
    border-top: none;
  }

  .discovery-error {
    justify-content: space-between;
  }

  .discovery-retry {
    flex-shrink: 0;
    padding: 2px 0;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .discovery-retry:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .discovery-retry:disabled {
    cursor: default;
    opacity: 0.6;
  }

  @media (prefers-reduced-motion: reduce) {
    .suggestions,
    .suggestion,
    .discovery-retry {
      animation: none;
      transition: none;
    }
  }
</style>

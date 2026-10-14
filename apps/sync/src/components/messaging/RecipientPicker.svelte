<script lang="ts">
  // Recipient autocomplete for the To field (channel invites, US-010).
  // Thin wrapper over the shared @hq/ui RecipientPicker in dropdown form: this
  // file owns the Tauri lookups and maps contacts to candidates; the shared
  // component owns sections, avatars, keyboard flow, and the look.
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
  import { RecipientPicker as SharedRecipientPicker, type RecipientItem } from '@hq/ui';
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

  let contacts = $state<ContactLike[]>([]);
  let companies = $state<CompanyInfo[]>([]);
  let membersByCompany = $state<Record<string, ContactLike[]>>({});
  let contactsStatus = $state<LoadStatus>('idle');
  let companiesStatus = $state<LoadStatus>('idle');
  let memberStatuses = $state<Record<string, LoadStatus>>({});

  const groups = $derived<SuggestionGroup[]>(
    query.trim().length === 0
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
  const hasVisibleResults = $derived(groups.length > 0);
  const discoveryError = $derived(
    discoveryFailed
      ? hasVisibleResults
        ? 'Some people couldn’t be refreshed. Showing saved results.'
        : 'People couldn’t be loaded.'
      : null,
  );

  /** Every known person once, with every company they were seen in. */
  const items = $derived.by((): RecipientItem[] => {
    const byUid = new Map<string, RecipientItem & { companyUids: string[] }>();
    const add = (contact: ContactLike, companyUid: string | null) => {
      const prior = byUid.get(contact.personUid);
      if (prior) {
        if (companyUid && !prior.companyUids.includes(companyUid)) prior.companyUids.push(companyUid);
        return;
      }
      const name = contact.displayName?.trim() || contact.email?.trim() || 'Someone';
      const state = contact.connectionState ?? 'none';
      byUid.set(contact.personUid, {
        id: contact.personUid,
        kind: contact.personUid.startsWith('agt_') ? 'bot' : 'person',
        name,
        companyUid,
        companyUids: companyUid ? [companyUid] : [],
        principalUid: contact.personUid,
        lastActivityAt: 0,
        ...(contact.email && contact.email !== name ? { subtitle: contact.email } : {}),
        // Restored from the Messages-window picker: say when a request is needed.
        hint: state === 'blocked' ? 'blocked' : state === 'active' ? null : 'not connected',
      });
    };
    for (const contact of contacts) add(contact, contact.companyUid ?? null);
    for (const [companyUid, members] of Object.entries(membersByCompany)) {
      for (const member of members) add(member, companyUid);
    }
    // A typed email resolved by resolveTyped() still needs an item for its chip.
    if (selected && !selected.personUid) {
      const id = `email:${selected.email.toLowerCase()}`;
      byUid.set(id, { id, kind: 'person', name: selected.email, companyUid: null, companyUids: [], lastActivityAt: 0 });
    }
    return [...byUid.values()];
  });

  let pickedIds = $state<string[]>([]);
  // Keep the chip in step with a parent that clears or sets `selected`.
  $effect(() => {
    const current = selected;
    untrack(() => {
      const id = current ? (current.personUid ?? `email:${current.email.toLowerCase()}`) : null;
      if (!id) {
        if (pickedIds.length) pickedIds = [];
      } else if (pickedIds[0] !== id) {
        pickedIds = [id];
      }
    });
  });

  function toRecipient(item: RecipientItem): SelectedRecipient {
    if (item.id.startsWith('email:')) {
      return { email: item.name, connectionState: 'none' };
    }
    const all = [...contacts, ...Object.values(membersByCompany).flat()];
    const contact = all.find((c) => c.personUid === item.id);
    return {
      personUid: item.id,
      email: contact?.email ?? item.subtitle ?? '',
      displayName: contact?.displayName ?? item.name,
      connectionState: contact?.connectionState ?? 'none',
    };
  }

  function onSelect(_ids: string[], picked: RecipientItem[]): void {
    const recipient = picked[0] ? toRecipient(picked[0]) : null;
    selected = recipient;
    onselect(recipient);
  }


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
      pickedIds = [resolved.personUid ?? `email:${resolved.email.toLowerCase()}`];
      query = '';
      onselect(resolved);
    }
    return resolved;
  }

  $effect(() => {
    untrack(() => {
      void loadContacts();
      void loadCompanies();
    });
  });

  // Lazily fetch every company's members once the user starts typing so
  // company members can appear. Cheap: each company is fetched at most once.
  $effect(() => {
    if (query.trim().length === 0) return;
    untrack(() => {
      for (const co of companies) void loadCompanyMembers(co.companyUid);
    });
  });
</script>

<div class="recipient-picker" aria-busy={discoveryLoading}>
  <SharedRecipientPicker
    presentation="dropdown"
    multiple={false}
    freeEmail
    {items}
    bind:selectedIds={pickedIds}
    bind:query
    loading={discoveryLoading}
    error={discoveryError}
    onretry={() => void retryDiscovery()}
    {onSelect}
    label={null}
    onsubmit={onsubmit ? () => onsubmit?.() : undefined}
    hideFooter
    placeholder={pickedIds.length ? '' : placeholder}
    {disabled}
  />
</div>

<style>
  .recipient-picker {
    position: relative;
    width: 100%;
  }
</style>

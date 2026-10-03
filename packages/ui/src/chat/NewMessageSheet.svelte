<script lang="ts">
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import PeoplePicker from "./PeoplePicker.svelte";
  import {
    entriesFromDirectory,
    loadPickerRoster,
    readPickerRoster,
    togglePickerId,
    type PeoplePickerEntry,
  } from "./people-picker.js";
  import type { ChatSidebarApi } from "./chat-api.js";
  import type { ConversationRow, DmContactInput, ScopeCompany } from "./sidebar-model.js";

  let {
    api,
    rows,
    contacts,
    companies,
    activeCompanyUid = null,
    scopeLabel = "",
    onclose,
    onopen,
  }: {
    api: ChatSidebarApi;
    rows: readonly ConversationRow[];
    contacts: readonly DmContactInput[];
    companies: readonly ScopeCompany[];
    activeCompanyUid?: string | null;
    scopeLabel?: string;
    onclose: () => void;
    onopen: (row: ConversationRow) => void;
  } = $props();

  let companyUid = $state(activeCompanyUid ?? "");
  // activeCompanyUid is the scope at open; later prop updates should not
  // yank a company the person already picked.
  let query = $state("");
  let selected = $state<string[]>([]);
  let firstLine = $state("");
  let sending = $state(false);
  let error = $state<string | null>(null);

  let roster = $state<DmContactInput[]>([]);
  // Cache-first, then refreshed: the company roster the Team page reads (QA-054).
  $effect(() => {
    const target = companyUid;
    roster = target ? readPickerRoster(target) : [];
    if (!target) return;
    let cancelled = false;
    void loadPickerRoster(api, target).then((fresh) => {
      if (!cancelled) roster = fresh;
    });
    return () => {
      cancelled = true;
    };
  });
  const entries = $derived(entriesFromDirectory({ rows, contacts, roster }));
  const companyLabel = $derived(
    companies.find((company) => company.companyUid === companyUid)?.label ??
      scopeLabel ??
      "Personal",
  );

  function entryById(id: string): PeoplePickerEntry | undefined {
    return entries.find((entry) => entry.id === id);
  }

  function dmRow(entry: PeoplePickerEntry): ConversationRow {
    const existing = rows.find((row) => row.kind === "dm" && row.personUid === entry.id);
    if (existing) return existing;
    return {
      id: `dm:${entry.id}`,
      kind: "dm",
      title: entry.name,
      companyUid: companyUid || entry.companyUid,
      unreadDot: false,
      lastActivityAt: Date.now(),
      pinned: false,
      personUid: entry.id,
    };
  }

  async function send(): Promise<void> {
    if (sending || selected.length === 0) return;
    sending = true;
    error = null;
    const body = firstLine.trim();
    try {
      if (selected.length === 1) {
        const entry = entryById(selected[0]);
        if (!entry) return;
        if (body) await api.sendDm({ toPersonUid: entry.id, body });
        onopen(dmRow(entry));
        return;
      }
      const create = api.createChannel;
      if (!create) {
        error = "This workspace cannot start a group message yet.";
        return;
      }
      const name = selected
        .map((id) => entryById(id)?.name ?? id)
        .slice(0, 3)
        .join(", ");
      const created = await create({
        name,
        scope: companyUid ? "company" : "personal",
        companyUid: companyUid || undefined,
        visibility: "invite",
      });
      const add = api.addChannelMember;
      if (add) {
        for (const id of selected) await add(created.channelId, id);
      }
      if (body) await api.sendChannelMessage({ channelId: created.channelId, body });
      onopen({
        id: `ch:${created.channelId}`,
        kind: "group",
        title: name,
        companyUid: companyUid || null,
        unreadDot: false,
        lastActivityAt: Date.now(),
        pinned: false,
        channelId: created.channelId,
        memberCount: selected.length,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : "Could not send";
    } finally {
      sending = false;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onclose();
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="scrim" data-testid="new-message-scrim" onclick={onclose} role="presentation"></div>
<div
  class="sheet"
  role="dialog"
  aria-label="New message"
  data-testid="new-message-sheet"
>
  <header class="sh">
    New message
    <span class="sub"
      >{#if companyUid}<CompanyLabel name={companyLabel} {companyUid} />{:else}Personal{/if}</span
    >
    <span class="grow"></span>
    <button type="button" class="icon" aria-label="Close" onclick={onclose}>
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" /></svg>
    </button>
  </header>
  <div class="sb">
    <div class="fr">
      <div class="lb">To</div>
      <PeoplePicker
        {entries}
        {selected}
        companyUid={companyUid || null}
        bind:query
        onToggle={(entry) => (selected = togglePickerId(selected, entry.id))}
      />
    </div>
    <div class="fr">
      <div class="lb">Company</div>
      <div>
        <div class="tabs" role="tablist" data-testid="new-message-companies">
          <button
            type="button"
            class="tab"
            role="tab"
            aria-selected={companyUid === ""}
            onclick={() => (companyUid = "")}
          >Personal</button>
          {#each companies as company (company.companyUid)}
            <button
              type="button"
              class="tab"
              role="tab"
              aria-selected={companyUid === company.companyUid}
              onclick={() => (companyUid = company.companyUid)}
            ><CompanyLabel name={company.label} companyUid={company.companyUid} /></button>
          {/each}
        </div>
        <p class="hint">Bots and channels from other companies stay hidden. Personal DMs carry no company context.</p>
      </div>
    </div>
    <div class="fr">
      <div class="lb">First line</div>
      <textarea
        class="ta"
        rows="3"
        bind:value={firstLine}
        data-testid="new-message-body"
        placeholder="Write the first line"
      ></textarea>
    </div>
  </div>
  <footer class="sf">
    <span class="hint">
      {#if error}{error}{:else if selected.length > 1}Two or more recipients create a group · ⌘↵ sends{:else}⌘↵ sends{/if}
    </span>
    <button type="button" class="btn" onclick={onclose}>Cancel</button>
    <button
      type="button"
      class="btn primary"
      data-testid="new-message-send"
      disabled={sending || selected.length === 0}
      onclick={() => void send()}
    >{sending ? "Sending…" : "Send"}</button>
  </footer>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 70; }
  .sheet {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: min(480px, calc(100vw - 32px));
    max-height: calc(100% - 40px);
    display: flex;
    flex-direction: column;
    background: var(--overlay-bg);
    border: 1px solid var(--overlay-border);
    border-radius: 8px;
    z-index: 71;
    color: var(--t1, var(--v4-text-1));
    overflow: hidden;
  }
  .sh {
    height: 52px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px 0 20px;
    border-bottom: 1px solid var(--overlay-border);
    font-size: 13px;
    font-weight: 500;
  }
  .sub { font-size: 13px; font-weight: 400; color: var(--t3, var(--v4-text-3)); }
  .grow { flex: 1; }
  .icon {
    width: 24px; height: 24px; padding: 0; display: grid; place-items: center;
    border: 0; border-radius: 6px; background: transparent; color: var(--t3, var(--v4-text-3));
  }
  .icon:hover { background: var(--hover); color: var(--t1, var(--v4-text-1)); }
  .icon svg { fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; }
  .sb { overflow-x: hidden; overflow-y: auto; min-height: 0; }
  .fr {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr);
    gap: 12px;
    align-items: start;
    padding: 10px 20px;
    border-bottom: 1px solid var(--panel-border, var(--v4-rowline));
  }
  .lb { font-size: 13px; color: var(--t3, var(--v4-text-3)); padding-top: 6px; }
  .tabs {
    display: flex;
    gap: 2px;
    width: max-content;
    max-width: 100%;
    padding: 2px;
    border-radius: 6px;
    border: 1px solid var(--overlay-field-border);
    background: var(--hover, var(--v4-control-faint));
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar { display: none; }
  .tab {
    border: 0;
    background: transparent;
    color: var(--t2, var(--v4-text-2));
    font: inherit;
    font-size: 13px;
    padding: 4px 8px;
    border-radius: 4px;
    flex: 0 0 auto;
    white-space: nowrap;
  }
  .tab[aria-selected="true"] {
    background: var(--v4-active-row, var(--hover));
    color: var(--t1, var(--v4-text-1));
  }
  .hint { font-size: 13px; color: var(--t3, var(--v4-text-3)); line-height: 1.4; margin: 6px 0 0; }
  .ta {
    width: 100%;
    min-height: 60px;
    border: 1px solid var(--overlay-field-border);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 13px;
    padding: 6px 10px;
    resize: vertical;
  }
  .sf {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid var(--overlay-border);
  }
  .sf .hint { flex: 1; margin: 0; }
  .btn {
    border: 1px solid var(--overlay-field-border);
    background: transparent;
    color: inherit;
    border-radius: 6px;
    padding: 6px 10px;
    font: inherit;
    font-size: 13px;
  }
  .btn.primary { background: var(--t1, var(--v4-text-1)); color: var(--overlay-bg); }
  .btn:disabled { opacity: 0.45; }
</style>

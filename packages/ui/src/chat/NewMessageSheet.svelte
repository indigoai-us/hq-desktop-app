<script lang="ts">
  import RecipientPicker from "./recipient-picker/RecipientPicker.svelte";
  import RailIcon from "../common/button/RailIcon.svelte";
  import { recipientItemsFromDirectory } from "./recipient-picker/candidates.js";
  import {
    inRecipientScope,
    type RecipientItem,
    type RecipientScopeOption,
  } from "./recipient-picker/recipient-picker-model.js";
  import { loadPickerRoster, readPickerRoster } from "./people-picker.js";
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
  let selectedIds = $state<string[]>([]);
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
  const allItems = $derived(recipientItemsFromDirectory({ rows, contacts, roster, includeChannels: true }));
  const items = $derived(allItems.filter((item) => inRecipientScope(item, companyUid)));
  const selected = $derived(
    selectedIds
      .map((id) => allItems.find((item) => item.id === id))
      .filter((item): item is RecipientItem => !!item),
  );
  // Personal ("") carries no company context and shows everyone, as before.
  const scopes = $derived<RecipientScopeOption[]>([
    { id: "", label: "Personal" },
    ...companies.map((company) => ({ id: company.companyUid, label: company.label })),
  ]);

  function dmRow(entry: RecipientItem): ConversationRow {
    const uid = entry.principalUid ?? entry.id;
    const existing = rows.find((row) => row.kind === "dm" && row.personUid === uid);
    if (existing) return existing;
    return {
      id: `dm:${uid}`,
      kind: "dm",
      title: entry.name,
      companyUid: companyUid || entry.companyUids?.[0] || null,
      unreadDot: false,
      lastActivityAt: Date.now(),
      pinned: false,
      personUid: uid,
    };
  }

  async function send(): Promise<void> {
    if (sending || selected.length === 0) return;
    sending = true;
    error = null;
    const body = firstLine.trim();
    try {
      const channel = selected.find((entry) => entry.kind === "channel" || entry.kind === "group");
      if (channel) {
        const row = rows.find((candidate) => candidate.id === channel.id);
        if (!row?.channelId) return;
        if (body) await api.sendChannelMessage({ channelId: row.channelId, body });
        onopen(row);
        return;
      }
      if (selected.length === 1) {
        const entry = selected[0];
        if (body) await api.sendDm({ toPersonUid: entry.principalUid ?? entry.id, body });
        onopen(dmRow(entry));
        return;
      }
      const create = api.createChannel;
      if (!create) {
        error = "This workspace cannot start a group message yet.";
        return;
      }
      const name = selected
        .map((entry) => entry.name)
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
        for (const entry of selected) await add(created.channelId, entry.principalUid ?? entry.id);
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
      console.warn("[new-message] send failed", err);
      error = "Could not send. Try again.";
    } finally {
      sending = false;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      onclose();
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.defaultPrevented) {
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
    <span class="grow"></span>
    <button type="button" class="icon" aria-label="Close" onclick={onclose}>
      <RailIcon name="x" size={14} />
    </button>
  </header>
  <div class="sb">
    <RecipientPicker
      mode="message"
      {items}
      {scopes}
      channelOpens
      bind:scope={companyUid}
      bind:selectedIds
      bind:query
      label={null}
      autofocus
      busy={sending}
      status={error ?? (selected.length > 1 ? "Two or more people start a group · ⌘↵ sends" : "⌘↵ sends")}
      onsubmit={() => void send()}
      oncancel={onclose}
      testid="new-message-picker"
      submitTestid="new-message-send"
    >
      <textarea
        class="ta"
        rows="2"
        bind:value={firstLine}
        data-testid="new-message-body"
        aria-label="First line"
        placeholder={selected.length === 1 ? `Message ${selected[0].name}` : "Write the first line (optional)"}
      ></textarea>
    </RecipientPicker>
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 70; }
  .sheet {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: min(520px, calc(100vw - 24px));
    max-height: calc(100% - 40px);
    display: flex;
    flex-direction: column;
    background: var(--overlay-bg);
    border: 1px solid var(--overlay-border);
    box-shadow: var(--overlay-shadow);
    border-radius: 10px;
    z-index: 71;
    color: var(--t1, var(--v4-text-1));
    overflow: hidden;
  }
  .sh {
    height: 48px;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px 0 16px;
    font-size: 13px;
    font-weight: 500;
  }
  .grow { flex: 1; }
  .icon {
    width: 24px; height: 24px; padding: 0; display: grid; place-items: center;
    border: 0; border-radius: 6px; background: transparent; color: var(--t3, var(--v4-text-3));
  }
  .icon:hover { background: var(--hover); color: var(--t1, var(--v4-text-1)); }
  .icon:focus-visible { outline: 2px solid var(--t2, var(--v4-text-2)); outline-offset: 1px; }
  .sb { display: flex; flex-direction: column; min-height: 0; overflow: hidden; padding: 0 16px 14px; }
  .ta {
    box-sizing: border-box;
    display: block;
    width: 100%;
    min-height: 52px;
    border: 1px solid var(--overlay-field-border);
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 13px;
    padding: 7px 10px;
    resize: vertical;
  }
  .ta::placeholder { color: var(--t3, var(--v4-text-3)); }
  .ta:focus-visible { outline: none; border-color: var(--t3, var(--v4-text-3)); }
</style>

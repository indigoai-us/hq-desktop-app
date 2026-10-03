<script lang="ts">
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import PeoplePicker from "./PeoplePicker.svelte";
  import { channelSlug } from "./create-flow.js";
  import {
    channelPathPreview,
    companyFolderSlug,
    entriesFromDirectory,
    loadPickerRoster,
    readPickerRoster,
    togglePickerId,
    type PeoplePickerEntry,
  } from "./people-picker.js";
  import type { Channel } from "./channels.js";
  import type { ChatSidebarApi } from "./chat-api.js";
  import type { ConversationRow, DmContactInput, ScopeCompany } from "./sidebar-model.js";

  let {
    api,
    rows,
    contacts,
    companies,
    groups = [],
    guests = [],
    activeCompanyUid = null,
    onclose,
    aftercreate,
  }: {
    api: ChatSidebarApi;
    rows: readonly ConversationRow[];
    contacts: readonly DmContactInput[];
    companies: readonly ScopeCompany[];
    groups?: readonly PeoplePickerEntry[];
    guests?: readonly PeoplePickerEntry[];
    activeCompanyUid?: string | null;
    onclose: (channelId?: string, hint?: { title: string; companyUid: string | null }) => void;
    aftercreate: (channel: Channel) => void;
  } = $props();

  let name = $state("");
  let companyUid = $state<string>("");
  $effect.pre(() => {
    if (!companyUid) companyUid = activeCompanyUid ?? companies[0]?.companyUid ?? "";
  });
  let purpose = $state("");
  let isPrivate = $state(true);
  let query = $state("");
  let selected = $state<string[]>([]);
  let creating = $state(false);
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
  const entries = $derived(entriesFromDirectory({ rows, contacts, groups, guests, roster }));
  const company = $derived(companies.find((entry) => entry.companyUid === companyUid) ?? null);
  const slug = $derived(channelSlug(name));
  const path = $derived(channelPathPreview(companyFolderSlug(company), name));
  const humans = $derived(selected.filter((id) => !id.startsWith("agt_")).length);

  async function create(): Promise<void> {
    const createChannel = api.createChannel;
    if (!createChannel || creating || !slug) return;
    creating = true;
    error = null;
    try {
      const created = await createChannel({
        name: name.trim(),
        scope: companyUid ? "company" : "personal",
        companyUid: companyUid || undefined,
        visibility: isPrivate ? "invite" : "company",
      });
      const add = api.addChannelMember;
      if (add) {
        for (const id of selected) {
          if (id.startsWith("grp_")) continue;
          await add(created.channelId, id);
        }
      }
      const body = purpose.trim();
      if (body) await api.sendChannelMessage({ channelId: created.channelId, body });
      const channel: Channel = {
        channelId: created.channelId,
        name: name.trim(),
        scope: companyUid ? "company" : "personal",
        companyUid: companyUid || null,
        membership: "joined",
        unread: 0,
        lastMessageAt: null,
      };
      aftercreate(channel);
      onclose(created.channelId, { title: name.trim(), companyUid: companyUid || null });
    } catch (err) {
      console.warn("[new-channel] create failed", err);
      error = "Could not create the channel. Try again.";
      creating = false;
    }
  }
</script>

<svelte:window onkeydown={(event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    onclose();
  }
}} />

<div class="scrim" role="presentation" onclick={() => onclose()}></div>
<div class="sheet" role="dialog" aria-label="New channel" data-testid="new-channel-sheet">
  <header class="sh">
    New channel
    <span class="sub"
      >{#if companyUid}<CompanyLabel name={company?.label ?? "Personal"} {companyUid} />{:else}Personal{/if}</span
    >
    <span class="grow"></span>
    <button type="button" class="icon" aria-label="Close" onclick={() => onclose()}>
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" /></svg>
    </button>
  </header>
  <div class="sb">
    <div class="fr">
      <div class="lb">Name</div>
      <div>
        <label class="search">
          <span class="pre">#</span>
          <input data-testid="new-channel-name" bind:value={name} placeholder="channel-name" />
        </label>
        <p class="hint">Lowercase, dashes only · <span class="mono" data-testid="new-channel-path">{path}</span></p>
      </div>
    </div>
    <div class="fr">
      <div class="lb">Company</div>
      <div class="tabs" data-testid="new-channel-companies">
        {#each companies as company (company.companyUid)}
          <button
            type="button"
            class="tab"
            role="tab"
            aria-selected={companyUid === company.companyUid}
            onclick={(event) => {
              companyUid = company.companyUid;
              event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
            }}
          ><CompanyLabel name={company.label} companyUid={company.companyUid} /></button>
        {/each}
      </div>
    </div>
    <div class="fr">
      <div class="lb">Purpose</div>
      <textarea class="ta" rows="3" bind:value={purpose} data-testid="new-channel-purpose"></textarea>
    </div>
    <div class="fr">
      <div class="lb">Members</div>
      <PeoplePicker
        {entries}
        {selected}
        companyUid={companyUid || null}
        bind:query
        onToggle={(entry) => (selected = togglePickerId(selected, entry.id))}
      />
    </div>
    <div class="fr">
      <div class="lb">Private</div>
      <div>
        <label class="inl">
          <button
            type="button"
            class="tog"
            aria-label="Invite only"
            class:on={isPrivate}
            role="switch"
            aria-checked={isPrivate}
            data-testid="new-channel-private"
            onclick={() => (isPrivate = !isPrivate)}
          ></button>
          Invite only
        </label>
        <p class="hint">Hidden from the channel browser. Bots need an explicit grant to read it.</p>
      </div>
    </div>
  </div>
  <footer class="sf">
    <span class="hint">
      {#if error}{error}{:else}{humans} people · posts the purpose as the first message{/if}
    </span>
    <button type="button" class="btn" onclick={() => onclose()}>Cancel</button>
    <button
      type="button"
      class="btn primary"
      data-testid="new-channel-create"
      disabled={creating || !slug || !api.createChannel}
      onclick={() => void create()}
    >{creating ? "Creating…" : "Create channel"}</button>
  </footer>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 70; }
  .sheet {
    position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: min(480px, calc(100vw - 32px)); max-height: calc(100% - 40px);
    display: flex; flex-direction: column; overflow: hidden; z-index: 71;
    background: var(--overlay-bg);
    border: 1px solid var(--overlay-border);
    border-radius: 8px; color: var(--t1, var(--v4-text-1));
  }
  .sh {
    height: 52px; display: flex; align-items: center; gap: 8px;
    padding: 0 10px 0 20px; border-bottom: 1px solid var(--overlay-border);
    font-size: 13px; font-weight: 500;
  }
  .sub { font-size: 13px; font-weight: 400; color: var(--t3, var(--v4-text-3)); }
  .grow { flex: 1; }
  .icon {
    width: 24px; height: 24px; padding: 0; display: grid; place-items: center;
    border: 0; border-radius: 6px; background: transparent; color: var(--t3, var(--v4-text-3));
  }
  .icon:hover { background: var(--hover); color: var(--t1, var(--v4-text-1)); }
  .icon svg { fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; }
  .sb { overflow-x: hidden; overflow-y: auto; }
  .fr {
    display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 12px;
    padding: 10px 20px; border-bottom: 1px solid var(--panel-border, var(--v4-rowline));
  }
  .lb { font-size: 13px; color: var(--t3, var(--v4-text-3)); padding-top: 6px; }
  .search {
    display: flex; align-items: center; height: 28px; gap: 4px; padding: 0 8px;
    border: 1px solid var(--overlay-field-border); border-radius: 6px;
  }
  .search input { flex: 1; border: 0; background: transparent; color: inherit; font: inherit; font-size: 13px; min-width: 0; }
  .pre, .hint, .mono { color: var(--t3, var(--v4-text-3)); font-size: 13px; }
  .mono { font-family: var(--font-mono, ui-monospace, monospace); }
  .hint { margin: 5px 0 0; line-height: 1.4; }
  /* QA-020: the company strip scrolls inside its own column; the form never shifts. */
  .tabs {
    display: flex; gap: 2px; width: max-content; max-width: 100%; min-width: 0;
    overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; padding: 2px; border-radius: 6px; border: 1px solid var(--overlay-field-border); background: var(--overlay-field-bg); }
  .tabs::-webkit-scrollbar { display: none; }
  .tab { border: 0; background: transparent; color: var(--t2, inherit); font: inherit; font-size: 13px; padding: 4px 8px; border-radius: 4px; flex: 0 0 auto; white-space: nowrap; }
  .tab[aria-selected="true"] { background: var(--v4-active-row, var(--hover)); color: var(--t1, inherit); }
  .ta {
    width: 100%; min-height: 60px; border: 1px solid var(--panel-border); border-radius: 6px;
    background: transparent; color: inherit; font: inherit; font-size: 13px; padding: 6px 10px;
  }
  .inl { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .tog {
    width: 30px; height: 18px; border-radius: 9px; border: 1px solid var(--panel-border);
    background: var(--hover); position: relative; padding: 0;
  }
  .tog::after {
    content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
    background: var(--t3, #888);
  }
  .tog.on { background: var(--t1, var(--v4-text-1)); border-color: transparent; }
  .tog.on::after { left: 14px; background: var(--overlay-bg); }
  .sf { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--panel-border); }
  .sf .hint { flex: 1; margin: 0; }
  .btn { border: 1px solid var(--panel-border); background: transparent; color: inherit; border-radius: 6px; padding: 6px 10px; font: inherit; }
  .btn.primary { background: var(--t1, #111); color: var(--overlay-bg); }
  .btn:disabled { opacity: 0.45; }
</style>

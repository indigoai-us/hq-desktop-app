<script lang="ts">
  /**
   * 340 px cloud bot pane: who the bot is and whether it is online, then one
   * tab per part of the bot that lives on its box. The tabs come from
   * CLOUD_BOT_TABS; each reads its slice of the control view and writes
   * through the control API, which answers with the box's read-back.
   */
  import "./cloud-pane.css";
  import type { AgentControlApi, AgentControlChannelKind, AgentControlView, PlatformAdapter } from "@hq/platform";
  import Avatar from "../../../common/avatar/Avatar.svelte";
  import RailIcon from "../../../common/button/RailIcon.svelte";
  import ReadLoader from "../../../common/ReadLoader.svelte";
  import { PROFILE_PANE_WIDTH } from "../profile-pane-model.js";
  import { CLOUD_BOT_TABS, rememberTab, rememberedTab, type CloudTabDef } from "./cloud-bot-tabs.js";
  import { controlError, controlViewFromPayload, relativeTime } from "./agent-control-model.js";

  interface Props {
    uid: string;
    /** Name and presence from the roster, painted until the box answers. */
    name: string;
    live?: boolean;
    avatarUrl?: string | null;
    control: AgentControlApi | null;
    tabs?: readonly CloudTabDef[];
    onclose?: () => void;
    /** Opens the DM with this bot; no button without it. */
    onmessage?: (() => void) | null;
    onconnect?: ((kind: AgentControlChannelKind) => void) | null;
    onopenurl?: ((url: string) => void) | null;
    adapter?: PlatformAdapter | null;
    companyUid?: string | null;
  }

  let {
    uid,
    name,
    live = false,
    avatarUrl = null,
    control,
    tabs = CLOUD_BOT_TABS,
    onclose,
    onmessage = null,
    onconnect = null,
    onopenurl = null,
    adapter = null,
    companyUid = null,
  }: Props = $props();

  type Load =
    | { status: "loading" }
    | { status: "ready"; view: AgentControlView }
    | { status: "error"; message: string };

  let load = $state<Load>({ status: "loading" });
  let refusedOffline = $state(false);
  let reloadKey = $state(0);
  // svelte-ignore state_referenced_locally
  let active = $state(rememberedTab(uid, tabs));
  let tabEls: HTMLButtonElement[] = $state([]);

  $effect(() => {
    const id = uid;
    const api = control;
    void reloadKey;
    active = rememberedTab(id, tabs);
    refusedOffline = false;
    if (!api) {
      load = { status: "error", message: "Bot controls are not available in this version of the app." };
      return;
    }
    load = { status: "loading" };
    let cancelled = false;
    void api.getControl(id).then(
      (res) => {
        if (cancelled) return;
        if (res.ok) {
          load = { status: "ready", view: controlViewFromPayload(res.value, { uid: id, displayName: name, online: live }) };
        } else {
          console.warn("[hq-desktop] bot control read failed", res.code, res.message);
          load = { status: "error", message: controlError(res).message };
        }
      },
      (err: unknown) => {
        if (cancelled) return;
        console.warn("[hq-desktop] bot control read failed", err);
        load = { status: "error", message: "Could not reach HQ. Check your connection and try again." };
      },
    );
    return () => {
      cancelled = true;
    };
  });

  const view = $derived(load.status === "ready" ? load.view : null);
  const displayName = $derived(view?.agent.displayName || name);
  const title = $derived(view?.agent.title ?? "");
  const online = $derived(view ? view.agent.online && !refusedOffline : live);
  const lastSeen = $derived(view && !online ? relativeTime(view.agent.lastSeenAt) : null);
  const offline = $derived(view !== null && !online);
  const activeTab = $derived(tabs.find((t) => t.id === active) ?? tabs[0]);

  function select(id: string, focus = false): void {
    active = id;
    rememberTab(uid, id);
    if (focus) tabEls[tabs.findIndex((t) => t.id === id)]?.focus();
  }

  function onTabKey(e: KeyboardEvent, index: number): void {
    const last = tabs.length - 1;
    const next =
      e.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : e.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    select(tabs[next]!.id, true);
  }

  function patchView(patch: Partial<AgentControlView>): void {
    if (load.status !== "ready") return;
    load = { status: "ready", view: { ...load.view, ...patch } };
  }
</script>

<aside
  class="pane"
  style:width="{PROFILE_PANE_WIDTH}px"
  aria-label="{displayName} profile"
  data-testid="cloud-bot-pane"
  data-state={load.status}
>
  <header class="top">
    <Avatar kind="bot" name={displayName} id={uid} photo={view?.agent.avatarUrl ?? avatarUrl} size={40} presence={online ? "online" : "offline"} testid="cloud-bot-avatar" />
    <div class="who">
      <div class="nm" data-testid="cloud-bot-name">{displayName}</div>
      {#if title}<div class="ttl" data-testid="cloud-bot-title">{title}</div>{/if}
      <div class="line">
        <span class="chip" data-testid="bot-profile-runtime-chip">Cloud</span>
        <span class="presence" data-online={online ? "true" : "false"} data-testid="cloud-bot-presence">
          {online ? "Online" : lastSeen ? `Offline · last seen ${lastSeen}` : "Offline"}
        </span>
      </div>
    </div>
    <button type="button" class="icon" data-testid="bot-profile-close" aria-label="Close profile" onclick={() => onclose?.()}><RailIcon name="x" /></button>
  </header>

  {#if onmessage}
    <div class="msg"><button type="button" class="cp-btn primary wide" data-testid="bot-profile-message" onclick={() => onmessage?.()}><RailIcon name="send" />Message</button></div>
  {:else}
    <div></div>
  {/if}

  <div class="tabs" role="tablist" aria-label="Bot settings">
    {#each tabs as tab, i (tab.id)}
      <button
        type="button"
        role="tab"
        class="tab"
        id="cloud-bot-tab-{tab.id}"
        aria-selected={tab.id === activeTab?.id}
        aria-controls="cloud-bot-panel"
        tabindex={tab.id === activeTab?.id ? 0 : -1}
        data-testid="cloud-bot-tab-{tab.id}"
        bind:this={tabEls[i]}
        onclick={() => select(tab.id)}
        onkeydown={(e) => onTabKey(e, i)}
      >{tab.label}</button>
    {/each}
  </div>

  <div class="body" id="cloud-bot-panel" role="tabpanel" aria-labelledby="cloud-bot-tab-{activeTab?.id}" data-testid="cloud-bot-panel" data-tab={activeTab?.id}>
    {#if load.status === "loading"}
      <ReadLoader testid="cloud-bot-loading" />
    {:else if load.status === "error"}
      <div class="cp-empty" data-testid="cloud-bot-error">
        <p class="cp-error" role="alert">{load.message}</p>
        <button type="button" class="cp-btn" data-testid="cloud-bot-retry" onclick={() => (reloadKey += 1)}><RailIcon name="refresh" />Try again</button>
      </div>
    {:else if activeTab}
      {#if offline}
        <p class="cp-banner" data-tone="warn" role="status" data-testid="cloud-bot-offline">This bot is offline. Changes will fail until it's back.</p>
      {:else if load.view.source === "snapshot"}
        <p class="cp-banner" role="status" data-testid="cloud-bot-snapshot">Showing the last saved copy. The bot's box did not answer.</p>
      {/if}
      {#key `${uid}:${activeTab.id}`}
        <activeTab.component
          {uid}
          control={control!}
          view={load.view}
          {offline}
          onview={patchView}
          onoffline={() => (refusedOffline = true)}
          {onconnect}
          {onopenurl}
          {adapter}
          {companyUid}
        />
      {/key}
    {/if}
  </div>
</aside>

<style>
  .pane {
    box-sizing: border-box;
    max-width: 100%;
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-rows: auto auto auto minmax(0, 1fr);
    grid-template-columns: minmax(0, 1fr);
    background: var(--v4-secondary-sidebar, var(--side-bg));
    color: var(--v4-text-2);
    font: 400 13px/1.45 var(--font-ui, var(--font-sans));
  }
  .top {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 16px 16px 12px 20px;
  }
  .who { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
  .nm {
    font-size: 20px;
    line-height: 1.25;
    font-weight: 500;
    color: var(--v4-text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ttl { color: var(--v4-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .line { display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; margin-top: 4px; color: var(--v4-text-3); }
  .chip { flex: none; padding: 0 8px; border-radius: var(--v4-radius-pill, 999px); background: var(--v4-control-bg); color: var(--v4-text-2); }
  .presence { display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .presence::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--v4-idle, var(--v4-text-3)); }
  .presence[data-online="true"]::before { background: var(--v4-ok); }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-2);
    cursor: pointer;
  }
  .icon:hover { background: var(--hover, var(--v4-hover)); color: var(--v4-text-1); }
  .msg { padding: 0 20px 12px; }
  .msg :global(.wide) { width: 100%; }
  .tabs {
    display: flex;
    gap: 2px;
    padding: 0 16px 8px 18px;
    border-bottom: 1px solid var(--v4-rowline, var(--line));
  }
  .tab {
    display: inline-flex;
    align-items: center;
    height: 24px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-weight: 500;
    cursor: pointer;
  }
  .tab:hover { background: var(--hover, var(--v4-hover)); color: var(--v4-text-1); }
  .tab[aria-selected="true"] { background: var(--sel, var(--v4-control-bg)); color: var(--v4-text-1); }
  .tab:focus-visible { outline: 2px solid var(--v4-focus-ring); outline-offset: 1px; }
  .body {
    min-height: 0;
    overflow: auto;
    padding: 16px 20px 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
</style>

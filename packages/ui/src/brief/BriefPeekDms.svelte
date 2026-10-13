<script lang="ts">
  /**
   * A person's recent DMs to you, inside the peek: newest first, five shown
   * and the rest a scroll away, each clamped to three lines until clicked.
   * Open thread is the primary action; drafting a reply (with the actual
   * messages quoted) is secondary.
   */
  import { onMount } from "svelte";
  import BriefLaunch from "./BriefLaunch.svelte";
  import { useBrief } from "./brief-context.svelte.js";
  import { shortAgo, teammateReplyPrompt } from "./brief-dms.js";

  let { uid, name, isAgent }: { uid: string; name: string; isAgent: boolean } = $props();
  const brief = useBrief();
  const load = $derived(brief.dms[uid] ?? { state: "loading" as const });
  let open = $state<Record<string, boolean>>({});
  let showAll = $state(false);
  const dms = $derived(load.state === "ready" ? load.dms : []);
  const shown = $derived(showAll ? dms : dms.slice(0, 5));
  const prompt = $derived(teammateReplyPrompt(name, dms, isAgent));

  onMount(() => void brief.loadDms(uid));
</script>

<div class="sec" data-testid="brief-peek-dms">
  <div class="eyebrow">{isAgent ? "Agent · " : ""}Recent messages to you</div>
  {#if load.state === "loading"}
    <p class="muted" data-testid="brief-peek-dms-loading">Loading messages…</p>
  {:else if load.state === "error"}
    <p class="muted" data-testid="brief-peek-dms-error">{load.message}</p>
    <button type="button" class="link" onclick={() => void brief.loadDms(uid, true)}>Try again</button>
  {:else if !dms.length}
    <p class="muted" data-testid="brief-peek-dms-empty">No recent messages from {name}.</p>
  {:else}
    <ul class="dms">
      {#each shown as d (d.id)}
        <li data-testid="brief-peek-dm">
          <button type="button" class="msg" class:open={open[d.id]} aria-expanded={!!open[d.id]} onclick={() => (open = { ...open, [d.id]: !open[d.id] })}>
            <span class="meta">
              {#if d.unread}<span class="dot" aria-label="Unread"></span>{/if}
              <span>{shortAgo(d.at)}</span>
              {#if d.thread}<span class="thr">· {d.thread}</span>{/if}
            </span>
            <span class="body">{d.text}</span>
          </button>
        </li>
      {/each}
    </ul>
    {#if dms.length > 5 && !showAll}
      <button type="button" class="link" onclick={() => (showAll = true)}>Show {dms.length - 5} more</button>
    {/if}
  {/if}
  <div class="acts">
    {#if brief.canOpenThread}
      <button type="button" class="primary" onclick={() => brief.openThread(uid)} data-testid="brief-peek-open-thread">Open thread</button>
    {/if}
  </div>
</div>
{#if load.state === "ready"}
  <div class="sec">
    <div class="eyebrow">Draft a reply</div>
    <div class="prompt" data-testid="brief-peek-prompt">{prompt}</div>
    <div class="acts"><BriefLaunch id={`dm:${uid}`} {prompt} compact /></div>
  </div>
{/if}

<style>
  .muted {
    color: var(--b-t2);
  }
  .dms {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .msg {
    all: unset;
    cursor: pointer;
    display: block;
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    border-radius: 6px;
    box-shadow: var(--b-well);
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--b-mono);
    font-size: 11px;
    color: var(--b-t3);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--b-sun);
  }
  .body {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin-top: 3px;
    font-size: 13px;
    line-height: 1.4;
    color: var(--b-t1);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .msg.open .body {
    display: block;
    -webkit-line-clamp: unset;
    line-clamp: unset;
  }
  .link {
    all: unset;
    cursor: pointer;
    margin-top: 6px;
    font-size: 13px;
    color: var(--b-sun);
  }
  .primary {
    all: unset;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    padding: 6px 14px;
    border-radius: 8px;
    color: #1b1b1e;
    background: rgb(var(--b-ink) / 0.92);
  }
</style>

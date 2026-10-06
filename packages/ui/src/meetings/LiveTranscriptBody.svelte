<!--
  Live Transcript tab body (Recall real-time). Loaded through
  LiveTranscriptDoor, so the poller and this view stay out of the initial JS.

  Lines are speaker turns (name, offset into the call, text) appended as they
  arrive. The in-progress line is greyed. The view follows new lines unless
  the reader has scrolled up. Status is a dot and plain text.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import {
    LiveTranscriptState,
    startLiveTranscriptPoll,
    type LiveTranscriptFetch,
  } from "./live-transcript.svelte";
  import { isAtBottom, liveTurns, notetakerInCall, partialLine } from "./live-transcript-model";
  import { liveTranscriptFetcher } from "./meetings-store.svelte";
  import MeetingAgentLaunch from "./MeetingAgentLaunch.svelte";

  interface Props {
    recallBotId: string;
    companyId?: string | null;
    /** True while the meeting is live; polling stops when it turns false. */
    live: boolean;
    botStatus?: string | null;
    meetingTitle?: string | null;
    startTime?: string | null;
    /** Transport override (tests). Defaults to the platform adapter. */
    fetch?: LiveTranscriptFetch | null;
  }

  let { recallBotId, companyId = null, live, botStatus = null, meetingTitle = null, startTime = null, fetch = undefined }: Props = $props();

  const transport = $derived(fetch === undefined ? liveTranscriptFetcher() : fetch);
  const transcript = $derived.by(() => {
    void recallBotId;
    return new LiveTranscriptState();
  });
  let retryAttempt = $state(0);

  $effect(() => {
    const s = transcript;
    const bot = recallBotId;
    const company = companyId;
    const run = transport;
    void retryAttempt;
    if (!run || !company) {
      s.status = "unavailable";
      return;
    }
    if (!live) return;
    return untrack(() =>
      startLiveTranscriptPoll({
        recallBotId: bot,
        companyId: company,
        state: s,
        fetch: run,
        isLive: () => live,
      }),
    );
  });

  const turns = $derived(liveTurns(transcript.segments));
  const partial = $derived(partialLine(transcript.partial, transcript.segments));
  const inCall = $derived(notetakerInCall(botStatus));
  const statusText = $derived(
    !live
      ? "Notetaker ended - the saved transcript will be in Transcript shortly"
      : inCall
        ? "Live"
        : "Waiting for the first words",
  );
  const emptyText = $derived(
    transcript.status === "unavailable"
      ? "Live transcript isn't available here. The full transcript appears once the notetaker saves it."
      : transcript.status === "off"
        ? "Live transcript is off for this meeting. The full transcript appears here once the notetaker saves it."
        : transcript.status === "retry"
          ? "We could not reach the live transcript."
        : transcript.status === "connecting"
          ? "Connecting to the notetaker…"
          : "Waiting for the first words",
  );

  let root = $state<HTMLElement | null>(null);
  let follow = $state(true);
  let scroller = $state<HTMLElement | null>(null);

  function scrollParent(el: HTMLElement | null): HTMLElement | null {
    let node = el?.parentElement ?? null;
    while (node) {
      const oy = getComputedStyle(node).overflowY;
      if (oy === "auto" || oy === "scroll") return node;
      node = node.parentElement;
    }
    return null;
  }

  $effect(() => {
    const nextScroller = scrollParent(root);
    scroller = nextScroller;
    if (!nextScroller) return;
    const onScroll = () => {
      follow = isAtBottom(nextScroller);
    };
    nextScroller.addEventListener("scroll", onScroll, { passive: true });
    return () => nextScroller.removeEventListener("scroll", onScroll);
  });

  $effect(() => {
    void turns;
    void partial;
    const parent = untrack(() => scrollParent(root));
    if (parent && follow) parent.scrollTop = parent.scrollHeight;
  });

  function jumpToLatest(): void {
    if (!scroller) return;
    follow = true;
    scroller.scrollTop = scroller.scrollHeight;
  }

  function retry(): void {
    transcript.failures = 0;
    transcript.status = "connecting";
    retryAttempt += 1;
  }
</script>

<div class="lt" bind:this={root} data-testid="live-transcript" data-status={transcript.status}>
  <div class="header"><p class="status" data-testid="live-transcript-status"><i class="dot" class:on={live && inCall}></i>{statusText}</p>{#if companyId}<MeetingAgentLaunch title={meetingTitle} companyUid={companyId} {recallBotId} {startTime} />{/if}</div>
  {#if turns.length || partial}
    <div class="turns" aria-live="polite">
      {#each turns as t (t.id)}
        <div class="turn" data-testid="live-turn">
          <div class="hd"><b>{t.speaker}</b><span>{t.at}</span></div>
          <p>{t.text}</p>
        </div>
      {/each}
      {#if partial}
        <div class="turn partial" data-testid="live-partial">
          <div class="hd"><b>{partial.speaker}</b><span>{partial.at}</span></div>
          <p>{partial.text}</p>
        </div>
      {/if}
    </div>
  {:else}
    <p class="empty" data-testid="live-transcript-empty">{emptyText}</p>
  {/if}
  {#if transcript.status === "retry"}
    <button type="button" class="retry" onclick={retry}>Retry</button>
  {/if}
  {#if !follow && (turns.length || partial)}
    <button type="button" class="jump" onclick={jumpToLatest}>Jump to latest</button>
  {/if}
</div>

<style>
  .lt {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: var(--t2);
    font-size: 13px;
  }
  .header { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--t3);
  }

  .dot.on {
    background: var(--ok);
  }

  .turns {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .hd {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 13px;
  }

  .hd b {
    font-weight: 500;
  }

  .hd span {
    color: var(--t3);
    font-size: 13px;
  }

  .turn p {
    margin: 2px 0 0;
    font-size: 13px;
    line-height: 1.5;
  }

  .turn.partial,
  .turn.partial .hd span {
    color: var(--t3);
  }

  .empty {
    margin: 0;
    color: var(--t2);
    font-size: 13px;
  }

  .jump,
  .retry {
    align-self: flex-start;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .jump {
    position: sticky;
    bottom: 0;
    padding: 4px 0;
    background: var(--surface);
  }
</style>

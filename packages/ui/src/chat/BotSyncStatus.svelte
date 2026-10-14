<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  /**
   * The file sync status in the header of a cloud bot's direct message: a
   * small still glyph and one short line, to the right of "Direct message",
   * while the bot's copy of the company's files is being brought up to date.
   *
   * It replaced a full-width strip with a progress bar under the header
   * (owner, 2026-10-04: "remove the 'syncing' progress bar and just add it as
   * a sync icon and message to the right of the 'Direct message' in the
   * header next to the bot's name"). It takes no room of its own: the header
   * is the same height with it or without it, so the thread never moves when
   * it comes or goes.
   *
   * It is drawn from the same plain facts as the strip was (bot-sync-model.ts),
   * and is there exactly when the strip was: while a sync runs, for a few
   * seconds after one this app watched finish ("Files are up to date."), and
   * after one that failed. With no facts it draws nothing.
   *
   * The words are in the header's muted ink, the size of the "Direct message"
   * label beside them, on one line. In a narrow window the line is cut with
   * an ellipsis and gives way before anything else in the header does: the
   * host lays it out as the header's one flexible item, so the bot's name,
   * "Direct message" and "Edit profile" keep their places. The whole status
   * is in the `title` attribute.
   *
   * Nothing here moves. The glyph is still in every state, and there is no
   * transition, no keyframe and no ticking clock: one timer is set for the
   * moment "up to date" goes away.
   */
  import { botSyncHeaderLine, botSyncHideDeadline, botSyncView, type BotSyncFacts } from "./bot-sync-model.js";

  interface Props {
    facts: BotSyncFacts | null;
  }

  let { facts }: Props = $props();

  let now = $state(Date.now());
  const view = $derived(botSyncView(facts, { now }));
  const line = $derived(botSyncHeaderLine(view));

  // Time changes the status in one case only: "up to date" goes away after a
  // few seconds. So there is no ticking clock: one timer is set to that
  // moment. New facts are always read at the present moment, however long
  // ago the last timer fired.
  $effect(() => {
    const current = Date.now();
    now = current;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (at: number): void => {
      const deadline = botSyncHideDeadline(facts, at);
      if (deadline === null) return;
      timer = setTimeout(() => {
        timer = null;
        now = Date.now();
        // A timer that fired a moment early is set again for what is left.
        arm(now);
      }, Math.max(0, deadline - at));
    };
    arm(current);
    return () => {
      if (timer) clearTimeout(timer);
    };
  });
</script>

{#if line}
  <span
    class="bot-sync-status"
    data-testid="bot-sync-status"
    data-state={view.state}
    role="group"
    aria-label="File sync"
    title={line.full}
  >
    <span class="bot-sync-status-icon" data-testid="bot-sync-status-icon" aria-hidden="true">
      {#if view.state === "done"}
        <RailIcon name="check" size={12} />
      {:else if view.state === "failed"}
        <RailIcon name="warning-circle" size={12} />
      {:else}
        <!-- The sync glyph: two arrows round a circle. Still in every state. -->
        <RailIcon name="arrows-clockwise" size={12} />
      {/if}
    </span>
    <!-- Only the words are announced. -->
    <span class="bot-sync-status-text" data-testid="bot-sync-status-text" role="status" aria-live="polite">{line.text}</span>
  </span>
{/if}

<style>
  /*
   * One line in the conversation header, after the title and its "Direct
   * message" label. The header's title block is a row; this is its one item
   * that may shrink to nothing (a flex basis of zero and a minimum width of
   * zero), so it takes the room that is left and is the first thing cut when
   * there is not enough. It never wraps and never makes the header taller.
   *
   * The ink and the size are the "Direct message" label's own (--t3, 12px,
   * weight 400, line height 1.45), in every state: this is a quiet note, not
   * an alert.
   */
  .bot-sync-status {
    display: flex;
    flex: 1 1 0;
    align-items: baseline;
    gap: 5px;
    min-width: 0;
    overflow: hidden;
    color: var(--t3);
    font-size: 12px;
    font-weight: 400;
    line-height: 1.45;
    white-space: nowrap;
  }
  /* The glyph sits in the middle of the line and is never squeezed. The
     words carry the baseline, so they line up with the label beside them. */
  .bot-sync-status-icon {
    display: inline-flex;
    flex: 0 0 auto;
    align-self: center;
  }
  .bot-sync-status-text {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
</style>

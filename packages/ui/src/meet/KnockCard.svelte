<script lang="ts">
  /**
   * One knock, as a quiet actionable item (US-019).
   *
   * Deliberately NOT a ringing call sheet: no sound, no modal, no auto-focus
   * steal, no media. It is a `role="status"` region with `aria-live="polite"`,
   * so a screen reader mentions it at the next pause instead of interrupting,
   * and every action is a plain focusable button.
   *
   * Nothing here means anything by colour alone: the state is written out, the
   * countdown is written out, and a refusal is rendered as text in an alert.
   *
   * Accepting opens a door; it never starts capture, and — on a RECEIVED
   * knock — it does not open a window either. The knock is bound to OUR room:
   * accepting lets the knocker in, it does not move us anywhere. When we are
   * not currently in that room the host offers `ongoto`, which walks us back
   * into our own room on our own membership, with no capability.
   */
  import {
    expireKnock,
    knockSecondsLeft,
    type Knock,
    type KnockState,
  } from "./knocks.js";

  interface Props {
    knock: Knock;
    /** "received" renders accept/reply/defer/dismiss; "sent" renders cancel. */
    direction?: "received" | "sent";
    displayName?: (personUid: string) => string;
    /** Injected clock so the countdown is deterministic under test. */
    now?: () => number;
    /** Countdown heartbeat. 0 disables it (tests drive `now`). */
    tickMs?: number;
    /** The initial mic/transcript choice this device will take into the room. */
    joinIntent?: { microphone: boolean; transcript: boolean };
    busy?: boolean;
    onaccept?: (knock: Knock) => void | Promise<void>;
    /** Send `text` back as a DM and close the door politely. */
    onreply?: (knock: Knock, text: string) => void | Promise<void>;
    ondefer?: (knock: Knock) => void | Promise<void>;
    ondismiss?: (knock: Knock) => void | Promise<void>;
    oncancel?: (knock: Knock) => void | Promise<void>;
    /**
     * "Go to your room" on an accepted RECEIVED knock. Supplied by the host
     * only while we are not already in that room; absent means we are in it and
     * there is nothing to press.
     */
    ongoto?: (knock: Knock) => void | Promise<void>;
    /** Suggested reply text when the composer is opened. */
    replySuggestion?: string;
  }

  let {
    knock,
    direction = "received",
    displayName = (personUid: string) => personUid,
    now = () => Date.now(),
    tickMs = 1000,
    joinIntent = { microphone: false, transcript: false },
    busy = false,
    onaccept,
    onreply,
    ondefer,
    ondismiss,
    oncancel,
    ongoto,
    replySuggestion = "",
  }: Props = $props();

  let tick = $state(0);
  $effect(() => {
    if (tickMs <= 0) return;
    const handle = setInterval(() => {
      tick += 1;
    }, tickMs);
    return () => clearInterval(handle);
  });

  let replying = $state(false);
  let replyText = $state("");

  const at = $derived.by(() => {
    void tick;
    return now();
  });
  const secondsLeft = $derived(knockSecondsLeft(knock, at));
  /**
   * The state as it is NOW. A knock rendered past its `expiresAt` says so
   * itself rather than waiting for the next authoritative read to arrive — the
   * door is already gone either way.
   */
  const live = $derived(expireKnock(knock, at));
  const pending = $derived(live.state === "pending" && secondsLeft > 0);
  const peer = $derived(direction === "received" ? knock.from : knock.target);

  const STATE_LABEL: Record<KnockState, string> = {
    pending: "Waiting for an answer",
    accepted: "Door opened",
    declined: "Not now",
    deferred: "Asked to come back later",
    cancelled: "Knock withdrawn",
    expired: "No answer — the knock expired",
  };

  const headline = $derived(
    direction === "received"
      ? `${displayName(knock.from)} knocked`
      : `You knocked for ${displayName(knock.target)}`,
  );

  const stateText = $derived(
    pending ? STATE_LABEL.pending : STATE_LABEL[live.state],
  );

  const intentText = $derived(
    joinIntent.microphone
      ? joinIntent.transcript
        ? "You will join with your microphone on and the transcript on. Camera stays off."
        : "You will join with your microphone on and the transcript off. Camera stays off."
      : joinIntent.transcript
        ? "You will join muted with the transcript on. Camera stays off."
        : "You will join muted, with no transcript. Camera stays off.",
  );

  function openReply(): void {
    replying = true;
    if (!replyText) replyText = replySuggestion;
  }

  async function sendReply(): Promise<void> {
    const text = replyText.trim();
    if (!text) return;
    replying = false;
    replyText = "";
    await onreply?.(knock, text);
  }
</script>

<article
  class="knock"
  role="status"
  aria-live="polite"
  data-testid={`knock-card-${knock.knockId}`}
  data-state={pending ? "pending" : live.state}
  data-direction={direction}
>
  <header class="knock-head">
    <strong data-testid={`knock-from-${knock.knockId}`}>{headline}</strong>
    <span class="knock-state" data-testid={`knock-state-${knock.knockId}`}>
      {stateText}
    </span>
  </header>

  {#if knock.note}
    <p class="knock-note" data-testid={`knock-note-${knock.knockId}`}>
      “{knock.note}”
    </p>
  {/if}

  <p class="knock-meta">
    {#if pending}
      <span data-testid={`knock-countdown-${knock.knockId}`}>
        {secondsLeft}s left to answer
      </span>
    {:else}
      <span data-testid={`knock-countdown-${knock.knockId}`}>
        No time left to answer
      </span>
    {/if}
    <span class="knock-peer">· with {displayName(peer)}</span>
  </p>

  {#if pending && direction === "received"}
    <p class="knock-intent" data-testid={`knock-join-intent-${knock.knockId}`}>
      {intentText}
    </p>
    <div class="knock-actions">
      <button
        type="button"
        class="knock-button knock-button-primary"
        data-testid={`knock-accept-${knock.knockId}`}
        disabled={busy}
        onclick={() => void onaccept?.(knock)}
      >
        Open the door
      </button>
      <button
        type="button"
        class="knock-button"
        data-testid={`knock-reply-${knock.knockId}`}
        disabled={busy}
        onclick={openReply}
      >
        Reply with a message
      </button>
      <button
        type="button"
        class="knock-button"
        data-testid={`knock-defer-${knock.knockId}`}
        disabled={busy}
        onclick={() => void ondefer?.(knock)}
      >
        Not right now
      </button>
      <button
        type="button"
        class="knock-button"
        data-testid={`knock-dismiss-${knock.knockId}`}
        disabled={busy}
        onclick={() => void ondismiss?.(knock)}
      >
        Dismiss
      </button>
    </div>

    {#if replying}
      <div class="knock-reply">
        <label for={`knock-reply-text-${knock.knockId}`}>
          Your reply to {displayName(knock.from)}
        </label>
        <textarea
          id={`knock-reply-text-${knock.knockId}`}
          data-testid={`knock-reply-text-${knock.knockId}`}
          rows="2"
          bind:value={replyText}
        ></textarea>
        <div class="knock-actions">
          <button
            type="button"
            class="knock-button knock-button-primary"
            data-testid={`knock-reply-send-${knock.knockId}`}
            disabled={busy || replyText.trim().length === 0}
            onclick={() => void sendReply()}
          >
            Send reply
          </button>
          <button
            type="button"
            class="knock-button"
            data-testid={`knock-reply-cancel-${knock.knockId}`}
            onclick={() => {
              replying = false;
            }}
          >
            Keep the knock open
          </button>
        </div>
      </div>
    {/if}
  {:else if !pending && direction === "received" && live.state === "accepted" && ongoto}
    <!--
      We accepted, so THEY are on their way into our room. Nothing opened on
      its own: this is an explicit click, and it carries no capability, because
      the room is ours to walk into.
    -->
    <div class="knock-actions">
      <button
        type="button"
        class="knock-button knock-button-primary"
        data-testid={`knock-goto-${knock.knockId}`}
        disabled={busy}
        onclick={() => void ongoto?.(knock)}
      >
        Go to your room
      </button>
    </div>
  {:else if pending && direction === "sent"}
    <div class="knock-actions">
      <button
        type="button"
        class="knock-button"
        data-testid={`knock-cancel-${knock.knockId}`}
        disabled={busy}
        onclick={() => void oncancel?.(knock)}
      >
        Withdraw the knock
      </button>
    </div>
  {/if}
</article>

<style>
  .knock {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2, 8px);
    padding: var(--v4-space-4, 16px);
    border: 1px solid var(--v4-border, rgba(0, 0, 0, 0.12));
    border-radius: var(--v4-radius-panel, 10px);
    font-family: var(--font-sans);
    color: var(--v4-text-1);
  }

  /* Emphasis is structural (border weight), so it survives colour blindness,
     high-contrast modes and a monochrome screenshot. */
  .knock[data-state="pending"] {
    border-width: 2px;
  }

  .knock-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--v4-space-2, 8px);
  }

  .knock-state,
  .knock-peer {
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 13px);
  }

  .knock-note {
    margin: 0;
    font-size: var(--type-body, 15px);
    max-width: 60ch;
    overflow-wrap: anywhere;
  }

  .knock-meta,
  .knock-intent {
    margin: 0;
    font-size: var(--type-secondary, 14px);
  }

  .knock-intent {
    color: var(--v4-text-3);
  }

  .knock-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--v4-space-2, 8px);
  }

  .knock-reply {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2, 8px);
  }

  .knock-reply label {
    font-size: var(--type-secondary, 14px);
  }

  .knock-reply textarea {
    font: inherit;
    padding: 6px 8px;
    border: 1px solid var(--v4-border, rgba(0, 0, 0, 0.12));
    border-radius: var(--v4-radius-button, 6px);
    background: transparent;
    color: inherit;
    resize: vertical;
  }

  .knock-button {
    padding: 6px 12px;
    border: 1px solid var(--v4-border, rgba(0, 0, 0, 0.12));
    border-radius: var(--v4-radius-button, 6px);
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .knock-button-primary {
    font-weight: 600;
  }

  .knock-button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .knock-button:focus-visible,
  .knock-reply textarea:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }
</style>

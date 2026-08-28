<script lang="ts">
  /**
   * Mission Control — the Manager ⇄ Liaison conversation for one team, so the
   * operator has the full context behind a pending question, plus a composer to
   * post a message straight into the team-manager inbox (no liaison needed).
   */
  import {
    agencyStore,
    sendAgencyMessage,
    selectAgencyTeam,
  } from "./agency-store.svelte";
  import { senderTone, relativeTime, type AgencyMessage } from "./agency";

  const teams = $derived(agencyStore.teams);
  const selected = $derived(agencyStore.selected);
  const messages = $derived(agencyStore.messages);

  interface FailedSend {
    text: string;
    message: string;
    company: string;
    team: string;
  }

  let draft = $state("");
  let busy = $state(false);
  let sendingSource = $state<"compose" | "retry" | null>(null);
  let failedSend = $state<FailedSend | null>(null);
  let scroller = $state<HTMLDivElement | undefined>(undefined);
  const visibleFailedSend = $derived(
    failedSend &&
      selected?.company === failedSend.company &&
      selected?.team === failedSend.team
      ? failedSend
      : null,
  );

  // Stick to the bottom as the conversation grows.
  $effect(() => {
    void messages.length;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });

  const KIND_BADGE: Record<string, string> = {
    ask: "ASK",
    fyi: "FYI",
    answer: "ANSWER",
    learn: "LEARN",
    close: "CLOSED",
  };

  function teamKey(company: string, team: string) {
    return `${company}/${team}`;
  }

  function sendFailureMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === "string" && error.trim()) return error;
    return "The message could not be delivered.";
  }

  async function send(retry?: FailedSend) {
    const target = selected;
    const isRetry = retry !== undefined;
    const text = (retry?.text ?? draft).trim();
    if (
      !target ||
      !text ||
      busy ||
      (retry &&
        (retry.company !== target.company || retry.team !== target.team))
    ) {
      return;
    }
    busy = true;
    sendingSource = isRetry ? "retry" : "compose";
    if (!isRetry) failedSend = null;
    try {
      await sendAgencyMessage(text);
      // A send can finish after the operator has started writing their next
      // message. Only clear the exact draft that was submitted.
      if (draft.trim() === text) draft = "";
      failedSend = null;
    } catch (err) {
      console.error("send failed:", err);
      failedSend = {
        text,
        message: sendFailureMessage(err),
        company: target.company,
        team: target.team,
      };
    } finally {
      busy = false;
      sendingSource = null;
    }
  }

  function onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void send();
    }
  }
</script>

<div class="acp">
  <header class="acp-head">
    <h2>Conversation</h2>
    {#if teams.length > 1}
      <div class="tabs" role="tablist">
        {#each teams as t (teamKey(t.company, t.team))}
          <button
            class="tab"
            class:active={selected &&
              selected.company === t.company &&
              selected.team === t.team}
            onclick={() => selectAgencyTeam(t.company, t.team)}>{t.team}</button
          >
        {/each}
      </div>
    {:else if selected}
      <span class="scope">{selected.company}/{selected.team}</span>
    {/if}
  </header>

  {#if !selected}
    <p class="empty">No team selected.</p>
  {:else}
    <div class="thread" bind:this={scroller}>
      {#if messages.length === 0}
        <p class="empty">No messages yet.</p>
      {/if}
      {#each messages as m, i (m.ts + "/" + m.inbox + "/" + i)}
        <div class="msg">
          <span class={`dot ${senderTone(m.from)}`} aria-hidden="true"></span>
          <div class="mbody">
            <div class="mhead">
              <span class={`mfrom ${senderTone(m.from)}`}>{m.from}</span>
              {#if KIND_BADGE[m.kind]}<span class={`kind ${m.kind}`}
                  >{KIND_BADGE[m.kind]}</span
                >{/if}
              {#if m.ts}<span class="mage">{relativeTime(m.ts)}</span>{/if}
            </div>
            <p class="mtext">{m.text}</p>
          </div>
        </div>
      {/each}
    </div>

    <div class="composer">
      <textarea
        rows="2"
        placeholder="Message the team directly… (⌘↵ to send)"
        bind:value={draft}
        onkeydown={onKey}
      ></textarea>
      <button
        class="send"
        type="button"
        onclick={() => void send()}
        disabled={busy || !draft.trim()}
        aria-busy={busy && sendingSource === "compose"}
      >
        {busy && sendingSource === "compose" ? "Sending…" : "Send"}
      </button>
    </div>
    {#if visibleFailedSend}
      <div class="send-error" role="alert" title={visibleFailedSend.message}>
        <span>Couldn’t send that message. Your draft is still here.</span>
        <button
          type="button"
          onclick={() => void send(visibleFailedSend!)}
          disabled={busy}
          aria-busy={busy && sendingSource === "retry"}
        >
          {busy && sendingSource === "retry" ? "Retrying…" : "Retry"}
        </button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .acp {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
  }
  .acp-head {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .acp-head h2 {
    margin: 0;
    font-size: var(--text-lg, 15px);
    color: var(--v4-text-1);
  }
  .scope {
    color: var(--v4-text-3);
    font-size: var(--text-base);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }
  .tab {
    padding: 2px 12px;
    border: 0;
    border-bottom: 1px solid transparent;
    border-radius: 0;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--text-base);
    cursor: pointer;
  }
  .tab:hover {
    border-bottom-color: var(--v4-rowline);
    color: var(--v4-text-1);
  }
  .tab.active {
    border-bottom-color: var(--v4-text-2);
    background: transparent;
    color: var(--v4-text-1);
  }
  .tab:focus-visible {
    outline: 2px solid var(--v4-control-border);
    outline-offset: 2px;
  }
  .empty {
    color: var(--v4-text-3);
    font-size: var(--text-base);
    margin: 8px 0;
  }
  .thread {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: 320px;
    overflow-y: auto;
    border: 0;
    border-top: 1px solid var(--v4-rowline);
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    padding: 12px 0 0;
  }
  .msg {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }
  .mbody {
    min-width: 0;
    flex: 1 1 auto;
  }
  .mhead {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .mfrom {
    font-weight: 600;
    font-size: var(--text-base);
    color: var(--v4-text-2);
  }
  .mfrom.ok {
    color: var(--v4-ok);
  }
  .mfrom.warn {
    color: var(--v4-text-2);
  }
  .mfrom.unread {
    color: var(--v4-unread);
  }
  .kind {
    font-size: 11px;
    letter-spacing: 0.04em;
    color: var(--v4-text-3);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    padding: 0 5px;
  }
  .kind.ask {
    color: var(--v4-text-2);
    border-color: var(--v4-hairline);
  }
  .kind.answer {
    color: var(--v4-ok);
    border-color: var(--v4-ok);
  }
  .mage {
    color: var(--v4-text-3);
    font-size: var(--text-base);
    margin-left: auto;
  }
  .mtext {
    margin: 2px 0 0;
    color: var(--v4-text-1);
    font-size: var(--text-base);
    line-height: 1.35;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .dot {
    flex: 0 0 6px;
    width: 6px;
    height: 6px;
    border-radius: 999px;
    margin-top: 5px;
    background: var(--v4-idle);
  }
  .dot.ok {
    background: var(--v4-ok);
  }
  .dot.warn {
    background: var(--v4-idle);
  }
  .dot.unread {
    background: var(--v4-unread);
  }
  .dot.idle {
    background: var(--v4-idle);
  }
  .composer {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  textarea {
    flex: 1 1 auto;
    resize: vertical;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-field);
    background: var(--v4-raised);
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--text-base);
    padding: 8px 10px;
    box-sizing: border-box;
  }
  textarea:focus {
    outline: none;
    border-color: var(--v4-control-border);
  }
  .send {
    border: 1px solid transparent;
    border-radius: var(--v4-radius-button);
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
    font: inherit;
    font-weight: 600;
    font-size: var(--text-base);
    padding: 8px 16px;
    cursor: pointer;
  }
  .send:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .send-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-top: 8px;
    border-top: 1px solid var(--v4-rowline);
    /* Soft status — never alarm red (Indigo / HQ anti-pattern). */
    color: var(--v4-text-2, var(--t2, rgba(255, 255, 255, 0.56)));
    font-size: var(--text-base);
  }
  .send-error button {
    flex: 0 0 auto;
    padding: 0;
    border: 0;
    border-bottom: 1px solid currentColor;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .send-error button:disabled {
    cursor: progress;
    opacity: 0.58;
  }
</style>

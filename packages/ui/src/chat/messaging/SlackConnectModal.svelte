<script module lang="ts">
  import type { PlatformAdapter } from "@hq/platform";

  /**
   * Attach requests on their way, by bot. Module-wide on purpose: it outlives
   * one instance of this modal, so a modal taken down (the conversation
   * changed) and opened again while the server is still answering waits for
   * that answer instead of asking for a second Slack app. An entry is removed
   * the moment its request settles; a settled request is never reused.
   */
  const attachesInFlight = new Map<string, Promise<unknown>>();

  /** The one attach request for this bot: the one on its way, or a new one. Never throws. */
  function attachOnce(adapter: PlatformAdapter, agentUid: string): Promise<unknown> {
    const pending = attachesInFlight.get(agentUid);
    if (pending) return pending;
    // A request that throws, now or later, is an answer of null: read as
    // "Slack did not answer", never as a crash.
    let request: Promise<unknown>;
    try {
      request = Promise.resolve(adapter.agents.attachSlack(agentUid)).then(
        (result) => result,
        () => null,
      );
    } catch {
      request = Promise.resolve(null);
    }
    attachesInFlight.set(agentUid, request);
    void request.then(() => {
      if (attachesInFlight.get(agentUid) === request) attachesInFlight.delete(agentUid);
    });
    return request;
  }
</script>

<script lang="ts">
  /**
   * Connect a cloud bot to Slack, inside the Slack card's modal.
   *
   * One guided flow: approve the bot in Slack, make one token on Slack's
   * site when the server asks for it, wait for the bot to connect. What step
   * a person is on is worked out in slack-connect-model.ts from the bot's
   * status, which the shell keeps asking for while this is open. This file
   * is the markup and the two requests.
   *
   * ATTACH CREATES A REAL SLACK APP. The press on the card's Connect Slack
   * button is the intent, so the modal sends it as it opens, once, and only
   * while the status says the bot has no Slack. Try again sends it again
   * after a failure. A request on its way is shared across instances of this
   * modal for the same bot (`attachesInFlight`): a modal taken down and put
   * back while the server is still answering does not ask a second time.
   *
   * THE TOKEN IS A SECRET. It lives in `token` below and in the field, and
   * nowhere else: not in storage, a link, a log or an error. It is cleared
   * when the server accepts it, when the modal closes and when the modal is
   * taken down (the conversation changed). A request that throws is dropped
   * unread, because a transport error can repeat what was sent.
   */
  import { onDestroy, tick, untrack } from "svelte";
  import { companyAgentsUrl, companyIntegrationsUrl } from "../../common/hq-console.js";
  import CardModal from "./CardModal.svelte";
  import CardModalField from "./CardModalField.svelte";
  import CardModalStatus from "./CardModalStatus.svelte";
  import CardModalStep from "./CardModalStep.svelte";
  import { CARD_MODAL_AUTOFOCUS } from "./card-modal.js";
  import type { CardModalContentProps } from "./card-modal-registry.js";
  import {
    SLACK_APPROVE_DETAIL,
    SLACK_APPROVE_NO_LINK_DETAIL,
    SLACK_ATTACH_RETRY_SENTENCE,
    SLACK_COPIED_MS,
    SLACK_STARTING,
    SLACK_TOKEN_CHECKING,
    SLACK_TOKEN_SCOPE,
    checkSlackAppToken,
    isWholeSlackAppToken,
    readSlackAttachAnswer,
    readSlackTokenAnswer,
    slackAccessPendingSentence,
    slackConnectView,
    slackConnectedSentence,
    slackTokenSteps,
    slackTokenWhySentence,
    type SlackBlockedReason,
    type SlackConsolePage,
  } from "./slack-connect-model.js";

  let {
    frame,
    agentUid,
    botName,
    companySlug,
    status,
    statusDenied,
    checkedAt,
    adapter,
    openUrl,
    refresh,
    started,
  }: CardModalContentProps = $props();

  // What this modal has done. None of it is stored: opening the modal again
  // starts from the bot's status.
  let attached = $state.raw<unknown | null>(null);
  let attachInFlight = $state(false);
  let attachError = $state<string | null>(null);
  let blocked = $state<SlackBlockedReason | null>(null);
  /** The pasted app-level token. A secret: see the note at the top. */
  let token = $state("");
  let tokenInFlight = $state(false);
  let tokenError = $state<string | null>(null);
  let tokenAcceptedAt = $state<number | null>(null);
  let waitingSince = $state<number | null>(null);
  /** When something last happened here (ms). */
  let touchedAt = $state(Date.now());
  let gone = false;
  /**
   * The one value this modal sent by itself, the moment it was pasted whole.
   * A value is sent that way once: the same value again goes through Connect.
   * Part of the secret: cleared with `token` on accept, close and take-down.
   */
  let autoSent: string | null = null;
  /** The Copy button next to the scope says "Copied" for a moment. */
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  let scopeEl = $state<HTMLElement | null>(null);

  // The shell's check every few seconds is the clock. No timer here.
  const now = $derived(Math.max(checkedAt, touchedAt));
  const view = $derived(
    slackConnectView({
      status,
      statusDenied,
      attached,
      botName,
      attachInFlight,
      attachError,
      blocked,
      tokenInFlight,
      tokenError,
      tokenAcceptedAt,
      waitingSince,
      now,
    }),
  );
  const tokenWhy = $derived(slackTokenWhySentence(botName));
  const tokenSteps = $derived(slackTokenSteps(botName));
  const tokenEmpty = $derived(token.trim() === "");
  /** Steps where there is nothing to press but Close: focus goes there. */
  const closeTakesFocus = $derived(
    view.stage === "finishing" ||
      (view.stage === "approve" && !view.installUrl && !attachInFlight && !view.attachError) ||
      view.accessPending,
  );

  const autofocus = { [CARD_MODAL_AUTOFOCUS]: "" };

  function touch(): void {
    touchedAt = Date.now();
  }

  // The last step's wait is counted from when this modal first saw it.
  $effect(() => {
    const finishing = view.stage === "finishing";
    untrack(() => {
      if (finishing && waitingSince === null) waitingSince = Date.now();
      else if (!finishing && waitingSince !== null) waitingSince = null;
    });
  });

  let root = $state<HTMLElement | null>(null);
  function dialogEl(): HTMLElement | null {
    return root?.closest<HTMLElement>('[role="dialog"]') ?? null;
  }
  function tokenInput(): HTMLInputElement | null {
    return dialogEl()?.querySelector<HTMLInputElement>('[data-testid="slack-connect-token"] input') ?? null;
  }
  async function focusTokenField(): Promise<void> {
    await tick();
    if (!gone) tokenInput()?.focus();
  }

  /**
   * Keep the keyboard inside the dialog while the button that was pressed is
   * disabled: a disabled button drops focus to the page.
   */
  function holdFocus(): void {
    dialogEl()?.focus();
  }
  /** Put focus on the current step's own control, unless it is already on a live control in here. */
  async function focusStageControl(): Promise<void> {
    await tick();
    if (gone) return;
    const dialog = dialogEl();
    if (!dialog) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== dialog &&
      dialog.contains(active) &&
      !(active as HTMLButtonElement).disabled
    ) {
      return;
    }
    dialog.querySelector<HTMLElement>(`[${CARD_MODAL_AUTOFOCUS}]:not([disabled])`)?.focus();
  }

  // A step can finish by itself while the person is in Slack, and the button
  // they last pressed goes with it. Focus then moves to the new step's own
  // control, so the keyboard is never left on nothing.
  let stageSeen: string | null = null;
  $effect(() => {
    const stage = view.stage;
    if (stageSeen === null) {
      stageSeen = stage;
      return;
    }
    if (stage === stageSeen) return;
    stageSeen = stage;
    void focusStageControl();
  });

  /**
   * Ask the server to set the bot up in Slack. Sent once as the modal opens
   * (the press on the card was the intent), and again from Try again.
   */
  async function start(): Promise<void> {
    if (attachInFlight || !view.needsAttach) return;
    attachInFlight = true;
    attachError = null;
    touch();
    holdFocus();
    try {
      if (status == null) {
        // Not known yet whether this bot already has Slack. Find out first:
        // a second setup must never be asked for on top of one that exists.
        await refresh();
        await tick();
        if (gone) return;
        if (status == null) {
          if (!statusDenied) attachError = SLACK_ATTACH_RETRY_SENTENCE;
          return;
        }
        if (!view.needsAttach) return;
      }
      const result = await attachOnce(adapter, agentUid);
      if (gone) return;
      const answer = readSlackAttachAnswer(result);
      if (answer.kind === "attached") {
        attached = answer.attached;
        started();
        await refresh();
      } else if (answer.kind === "continue") {
        started();
        await refresh();
        await tick();
        // The server says Slack is there and the status does not show it yet.
        if (!gone && view.needsAttach) attachError = SLACK_ATTACH_RETRY_SENTENCE;
      } else if (answer.kind === "retry") {
        attachError = answer.sentence;
      } else {
        blocked = answer.reason;
      }
    } finally {
      attachInFlight = false;
      touch();
      // Open Slack, Try again, or whatever step came next.
      void focusStageControl();
    }
  }

  // The modal opens straight into the first step and sends the attach by
  // itself, once per instance. After that only Try again sends it again.
  let autoStarted = false;
  $effect(() => {
    const needs = view.needsAttach;
    untrack(() => {
      if (!needs || autoStarted) return;
      autoStarted = true;
      void start();
    });
  });

  function openSlack(): void {
    const url = view.installUrl;
    if (!url) return;
    started();
    openUrl(url);
  }

  function openAppPage(): void {
    const url = view.appPageUrl;
    if (!url) return;
    started();
    openUrl(url);
  }

  /** Connected: the bot's direct message in Slack. */
  function openBot(): void {
    const url = view.botUrl;
    if (url) openUrl(url);
  }

  /** Put the scope on the clipboard. Without a clipboard, select it so Copy on the keyboard takes it. */
  async function copyScope(): Promise<void> {
    let written = false;
    try {
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (clipboard && typeof clipboard.writeText === "function") {
        await clipboard.writeText(SLACK_TOKEN_SCOPE);
        written = true;
      }
    } catch {
      written = false;
    }
    if (gone) return;
    if (!written) {
      selectScope();
      return;
    }
    copied = true;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedTimer = null;
      copied = false;
    }, SLACK_COPIED_MS);
  }

  function selectScope(): void {
    const el = scopeEl;
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (!el || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /**
   * Something was typed or pasted into the field. A whole token, pasted in
   * one go, is sent at once: there is nothing left for the person to do.
   * Anything else waits for Connect.
   */
  function onTokenInput(value: string): void {
    token = value;
    if (tokenError) tokenError = null;
    const whole = value.trim();
    if (!isWholeSlackAppToken(whole) || whole === autoSent) return;
    autoSent = whole;
    void submitToken();
  }

  /** Connect: check what was pasted, then hand it to the server once. */
  async function submitToken(): Promise<void> {
    if (tokenInFlight || view.stage !== "token" || view.accessPending) return;
    const checked = checkSlackAppToken(token);
    if (!checked.ok) {
      tokenError = checked.sentence;
      void focusTokenField();
      return;
    }
    tokenInFlight = true;
    tokenError = null;
    touch();
    // The Connect button is disabled while this is on its way: focus stays in the field.
    tokenInput()?.focus();
    started();
    let result: unknown = null;
    try {
      result = await adapter.agents.submitSlackAppToken(agentUid, checked.token);
    } catch {
      // Dropped unread: a transport error can repeat what was sent.
      result = null;
    }
    if (gone) return;
    const answer = readSlackTokenAnswer(result);
    if (answer.kind === "accepted") {
      token = "";
      autoSent = null;
      tokenAcceptedAt = Date.now();
    } else if (answer.kind === "continue") {
      token = "";
    } else if (answer.kind === "rejected") {
      token = "";
      tokenError = answer.sentence;
    } else if (answer.kind === "retry") {
      // The value stays in the field for the retry, and nowhere else.
      tokenError = answer.sentence;
    } else {
      token = "";
      blocked = answer.reason;
    }
    tokenInFlight = false;
    touch();
    if (answer.kind === "accepted" || answer.kind === "continue") await refresh();
    else if (answer.kind === "rejected" || answer.kind === "retry") void focusTokenField();
  }

  function consolePage(page: SlackConsolePage): string {
    return page === "integrations" ? companyIntegrationsUrl(companySlug) : companyAgentsUrl(companySlug);
  }

  function close(): void {
    token = "";
    autoSent = null;
    tokenError = null;
    frame.onclose();
  }

  /** The field is emptied by hand when it is taken down, not left to the DOM. */
  function wipeOnRemove(node: HTMLElement) {
    return {
      destroy() {
        const input = node.querySelector<HTMLInputElement>("input");
        if (input) input.value = "";
      },
    };
  }

  onDestroy(() => {
    gone = true;
    token = "";
    autoSent = null;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = null;
  });
</script>

<CardModal {...frame} title={view.title} onclose={close} busy={view.busy} steps={view.indicator}>
  {#snippet body()}
    <div class="slack-connect" data-testid="slack-connect" data-stage={view.stage} bind:this={root}>
      {#if view.stage === "blocked" && view.blocked}
        <div class="slack-connect-blocked" data-testid="slack-connect-blocked" data-reason={view.blocked.reason}>
          <CardModalStatus kind="problem" text={view.blocked.sentence} />
        </div>
      {:else}
        <ol class="card-modal-step-list" data-testid="slack-connect-steps">
          {#each view.steps as step (step.key)}
            {#if step.key === "approve" && step.state === "current"}
              {#snippet attachStatus()}
                {#if attachInFlight}
                  <div data-testid="slack-connect-starting">
                    <CardModalStatus kind="working" text={SLACK_STARTING} />
                  </div>
                {:else if view.attachError}
                  <div data-testid="slack-connect-attach-error">
                    <CardModalStatus kind="problem" text={view.attachError} />
                  </div>
                {/if}
              {/snippet}
              <CardModalStep
                number={step.number}
                state={step.state}
                text={step.text}
                detail={view.installUrl
                  ? SLACK_APPROVE_DETAIL
                  : attachInFlight || view.attachError
                    ? null
                    : SLACK_APPROVE_NO_LINK_DETAIL}
                more={attachInFlight || view.attachError ? attachStatus : undefined}
              >
                {#snippet action()}
                  {#if view.installUrl}
                    <button
                      type="button"
                      class="card-modal-btn is-primary is-small"
                      data-testid="slack-connect-open-slack"
                      onclick={openSlack}
                      {...autofocus}
                    >
                      Open Slack
                    </button>
                  {:else if view.attachError && !attachInFlight}
                    <button
                      type="button"
                      class="card-modal-btn is-primary is-small"
                      data-testid="slack-connect-start"
                      onclick={() => void start()}
                      {...autofocus}
                    >
                      Try again
                    </button>
                  {/if}
                {/snippet}
              </CardModalStep>
            {:else if step.key === "token" && step.state === "current"}
              <CardModalStep number={step.number} state={step.state} text={step.text}>
                {#snippet more()}
                  {#if view.accessPending}
                    <CardModalStatus kind="working" text={slackAccessPendingSentence(botName)} />
                  {:else}
                    <p class="slack-connect-why" data-testid="slack-connect-why">{tokenWhy}</p>
                    <ol class="slack-connect-howto" data-testid="slack-connect-howto">
                      {#each tokenSteps as item, index (item.key)}
                        <li class="slack-connect-howto-row" data-step={item.key}>
                          <span class="slack-connect-howto-num" aria-hidden="true">{index + 1}</span>
                          <span class="slack-connect-howto-text">
                            <span class="slack-connect-howto-line">{item.text}</span>
                            {#if item.key === "scope"}
                              <span class="slack-connect-scope" data-testid="slack-connect-scope">
                                <code class="slack-connect-scope-name" bind:this={scopeEl}>{SLACK_TOKEN_SCOPE}</code>
                                <button
                                  type="button"
                                  class="slack-connect-copy"
                                  data-testid="slack-connect-copy-scope"
                                  data-copied={copied ? "true" : "false"}
                                  aria-label={copied ? "Copied connections:write" : "Copy connections:write"}
                                  onclick={() => void copyScope()}
                                >
                                  {copied ? "Copied" : "Copy"}
                                </button>
                              </span>
                            {/if}
                          </span>
                          {#if item.key === "open" && view.appPageUrl}
                            <span class="slack-connect-howto-action">
                              <button
                                type="button"
                                class="card-modal-btn is-small"
                                data-testid="slack-connect-open-app-page"
                                onclick={openAppPage}
                              >
                                Open app page
                              </button>
                            </span>
                          {/if}
                          {#if item.key === "paste"}
                            <div class="slack-connect-howto-field" data-testid="slack-connect-token" use:wipeOnRemove>
                              <CardModalField
                                label="Token"
                                labelHidden
                                type="password"
                                placeholder="xapp-"
                                bind:value={token}
                                error={view.tokenError}
                                autofocus
                                oninput={onTokenInput}
                                onsubmit={() => void submitToken()}
                              />
                            </div>
                          {/if}
                        </li>
                      {/each}
                    </ol>
                    {#if tokenInFlight}
                      <CardModalStatus kind="working" text={SLACK_TOKEN_CHECKING} />
                    {/if}
                  {/if}
                {/snippet}
              </CardModalStep>
            {:else if step.key === "finishing" && step.state === "current"}
              <CardModalStep number={step.number} state={step.state} text={step.text}>
                {#snippet more()}
                  <div data-testid="slack-connect-waiting" data-slow={view.slow ? "true" : "false"} data-wait={view.wait?.kind ?? undefined}>
                    <CardModalStatus kind="working" text={view.finishingSentence ?? ""} />
                  </div>
                {/snippet}
              </CardModalStep>
            {:else}
              <CardModalStep number={step.number} state={step.state} text={step.text} />
            {/if}
          {/each}
        </ol>
        {#if view.stage === "connected"}
          <div data-testid="slack-connect-done">
            <CardModalStatus kind="done" text={slackConnectedSentence(botName)} />
          </div>
        {/if}
      {/if}
    </div>
  {/snippet}
  {#snippet footer()}
    {#if view.stage === "token" && !view.accessPending}
      <button
        type="button"
        class="card-modal-btn is-primary"
        data-testid="slack-connect-submit"
        disabled={tokenInFlight || tokenEmpty}
        onclick={() => void submitToken()}
      >
        Connect
      </button>
    {:else if view.stage === "connected"}
      {#if view.botUrl}
        <button type="button" class="card-modal-btn is-quiet" data-testid="slack-connect-finish" onclick={close}>Done</button>
        <button
          type="button"
          class="card-modal-btn is-primary"
          data-testid="slack-connect-open-bot"
          onclick={openBot}
          {...autofocus}
        >
          Open {botName.trim() || "your bot"} in Slack
        </button>
      {:else}
        <button type="button" class="card-modal-btn is-primary" data-testid="slack-connect-finish" onclick={close} {...autofocus}>
          Done
        </button>
      {/if}
    {:else if view.stage === "blocked" && view.blocked}
      {@const action = view.blocked.action}
      <button
        type="button"
        class="card-modal-btn is-quiet"
        data-testid="slack-connect-close"
        onclick={close}
        {...(action ? {} : autofocus)}
      >
        Close
      </button>
      {#if action}
        <button
          type="button"
          class="card-modal-btn is-primary"
          data-testid="slack-connect-blocked-action"
          onclick={() => openUrl(consolePage(action.page))}
          {...autofocus}
        >
          {action.label}
        </button>
      {/if}
    {:else}
      <button
        type="button"
        class="card-modal-btn is-quiet"
        data-testid="slack-connect-close"
        onclick={close}
        {...(closeTakesFocus ? autofocus : {})}
      >
        Close
      </button>
    {/if}
  {/snippet}
</CardModal>

<style>
  .slack-connect {
    display: grid;
    gap: 14px;
    min-width: 0;
  }

  /* A blocked state is not a failure: the mark warns, the sentence reads as copy. */
  .slack-connect-blocked :global(.card-modal-status-text) {
    color: var(--cm-ink);
  }

  /* Why there is a token step. Quiet. */
  .slack-connect-why {
    margin: 0;
    color: var(--cm-faint);
    font-size: 12px;
    line-height: 1.5;
  }

  /* The three things to do on Slack's page: a number, one line, and the
     thing that line needs on the right (a button) or under it (the field). */
  .slack-connect-howto {
    display: grid;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--cm-muted);
    font-size: 13px;
    line-height: 1.45;
  }

  .slack-connect-howto-row {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto;
    column-gap: 8px;
    row-gap: 8px;
    align-items: center;
    min-width: 0;
  }

  .slack-connect-howto-num {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 50%;
    color: var(--cm-faint);
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
  }

  .slack-connect-howto-text {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .slack-connect-howto-action {
    display: inline-flex;
    align-items: center;
  }

  .slack-connect-howto-field {
    grid-column: 2 / -1;
    min-width: 0;
  }

  /* The scope, as a chip the person copies with one press. */
  .slack-connect-scope {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: 6px;
    vertical-align: baseline;
    white-space: nowrap;
  }

  .slack-connect-scope-name {
    padding: 2px 7px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.08);
    color: var(--cm-ink);
    font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.3;
    user-select: all;
  }

  .slack-connect-copy {
    padding: 3px 8px;
    border: 1px solid rgba(255, 255, 255, 0.24);
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.08);
    color: var(--cm-ink);
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    line-height: 1.3;
    cursor: pointer;
    transition: border-color 0.12s, background 0.12s, color 0.12s;
  }

  .slack-connect-copy:hover {
    border-color: rgba(255, 255, 255, 0.6);
    background: rgba(255, 255, 255, 0.14);
  }

  .slack-connect-copy[data-copied="true"] {
    border-color: color-mix(in srgb, var(--cm-ok) 60%, transparent);
    color: var(--cm-ok);
  }

  .slack-connect-copy:focus-visible {
    outline: 2px solid var(--cm-accent);
    outline-offset: 2px;
  }

  @media (max-width: 520px) {
    .slack-connect-howto-row {
      grid-template-columns: 18px minmax(0, 1fr);
    }

    .slack-connect-howto-action {
      grid-column: 2;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .slack-connect-copy {
      transition: none;
    }
  }
</style>

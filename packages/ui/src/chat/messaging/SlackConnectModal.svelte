<script lang="ts">
  /**
   * Connect a cloud bot to Slack, inside the Slack card's modal.
   *
   * One guided flow: Start, approve the bot in Slack, make one token on
   * Slack's site when the server asks for it, wait for the bot to connect.
   * What step a person is on is worked out in slack-connect-model.ts from the
   * bot's status, which the shell keeps asking for while this is open. This
   * file is the markup and the two requests.
   *
   * ATTACH CREATES A REAL SLACK APP. It is sent from exactly one place, the
   * Start button, and only while the status says the bot has no Slack. It is
   * never sent when the modal opens.
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
    SLACK_STARTING,
    SLACK_TOKEN_CHECKING,
    checkSlackAppToken,
    readSlackAttachAnswer,
    readSlackTokenAnswer,
    slackAccessPendingSentence,
    slackConnectView,
    slackConnectedSentence,
    slackFinishingSentence,
    slackIntroLines,
    slackTokenInstructions,
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
  const introLines = $derived(slackIntroLines(botName));
  const instructions = $derived(slackTokenInstructions(botName));
  const tokenEmpty = $derived(token.trim() === "");
  /** Steps where there is nothing to press but Close: focus goes there. */
  const closeTakesFocus = $derived(
    view.stage === "finishing" || (view.stage === "approve" && !view.installUrl) || view.accessPending,
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
    void tick().then(() => {
      if (gone) return;
      const dialog = dialogEl();
      if (!dialog) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== dialog && dialog.contains(active)) return;
      dialog.querySelector<HTMLElement>(`[${CARD_MODAL_AUTOFOCUS}]:not([disabled])`)?.focus();
    });
  });

  /** Start: ask the server to set the bot up in Slack. The only place attach is sent. */
  async function start(): Promise<void> {
    if (attachInFlight || view.stage !== "intro") return;
    attachInFlight = true;
    attachError = null;
    touch();
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
        if (view.stage !== "intro") return;
      }
      let result: unknown = null;
      try {
        result = await adapter.agents.attachSlack(agentUid);
      } catch {
        result = null;
      }
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
        if (!gone && view.stage === "intro") attachError = SLACK_ATTACH_RETRY_SENTENCE;
      } else if (answer.kind === "retry") {
        attachError = answer.sentence;
      } else {
        blocked = answer.reason;
      }
    } finally {
      attachInFlight = false;
      touch();
    }
  }

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
  });
</script>

<CardModal {...frame} title={view.title} onclose={close} busy={view.busy} steps={view.indicator}>
  {#snippet body()}
    <div class="slack-connect" data-testid="slack-connect" data-stage={view.stage} bind:this={root}>
      {#if view.stage === "intro"}
        <div class="slack-connect-intro" data-testid="slack-connect-intro">
          {#each introLines as line (line)}
            <p class="card-modal-copy">{line}</p>
          {/each}
        </div>
        {#if attachInFlight}
          <CardModalStatus kind="working" text={SLACK_STARTING} />
        {:else if view.attachError}
          <CardModalStatus kind="problem" text={view.attachError} />
        {/if}
      {:else if view.stage === "blocked" && view.blocked}
        <div data-testid="slack-connect-blocked" data-reason={view.blocked.reason}>
          <CardModalStatus kind="problem" text={view.blocked.sentence} />
        </div>
      {:else}
        <ol class="card-modal-step-list" data-testid="slack-connect-steps">
          {#each view.steps as step (step.key)}
            {#if step.key === "approve" && step.state === "current"}
              <CardModalStep
                number={step.number}
                state={step.state}
                text={step.text}
                detail={view.installUrl ? SLACK_APPROVE_DETAIL : SLACK_APPROVE_NO_LINK_DETAIL}
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
                  {/if}
                {/snippet}
              </CardModalStep>
            {:else if step.key === "token" && step.state === "current"}
              <CardModalStep number={step.number} state={step.state} text={step.text}>
                {#snippet more()}
                  {#if view.accessPending}
                    <CardModalStatus kind="working" text={slackAccessPendingSentence(botName)} />
                  {:else}
                    <ol class="slack-connect-howto" data-testid="slack-connect-howto">
                      {#each instructions as line, index (index)}
                        <li>
                          <span class="slack-connect-howto-num" aria-hidden="true">{index + 1}.</span>
                          <span class="slack-connect-howto-text">
                            <span class="slack-connect-howto-line">{line}</span>
                            {#if index === 0 && view.appPageUrl}
                              <button
                                type="button"
                                class="card-modal-btn is-small slack-connect-howto-btn"
                                data-testid="slack-connect-open-app-page"
                                onclick={openAppPage}
                              >
                                Open app page
                              </button>
                            {/if}
                          </span>
                        </li>
                      {/each}
                    </ol>
                    <div data-testid="slack-connect-token" use:wipeOnRemove>
                      <CardModalField
                        label="Token"
                        type="password"
                        placeholder="xapp-"
                        bind:value={token}
                        error={view.tokenError}
                        autofocus
                        oninput={() => {
                          if (tokenError) tokenError = null;
                        }}
                        onsubmit={() => void submitToken()}
                      />
                    </div>
                    {#if tokenInFlight}
                      <CardModalStatus kind="working" text={SLACK_TOKEN_CHECKING} />
                    {/if}
                  {/if}
                {/snippet}
              </CardModalStep>
            {:else if step.key === "finishing" && step.state === "current"}
              <CardModalStep number={step.number} state={step.state} text={step.text}>
                {#snippet more()}
                  <div data-testid="slack-connect-waiting" data-slow={view.slow ? "true" : "false"}>
                    <CardModalStatus kind="working" text={slackFinishingSentence(botName, view.slow)} />
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
    {#if view.stage === "intro"}
      <button
        type="button"
        class="card-modal-btn is-primary"
        data-testid="slack-connect-start"
        disabled={attachInFlight}
        onclick={() => void start()}
        {...autofocus}
      >
        {view.attachError ? "Try again" : "Start"}
      </button>
    {:else if view.stage === "token" && !view.accessPending}
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
      <button type="button" class="card-modal-btn is-primary" data-testid="slack-connect-finish" onclick={close} {...autofocus}>
        Done
      </button>
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

  .slack-connect-intro {
    display: grid;
    gap: 2px;
  }

  /* The four things to do on Slack's page. Quieter than the step it sits in. */
  .slack-connect-howto {
    display: grid;
    gap: 7px;
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--cm-muted);
    font-size: 13px;
    line-height: 1.45;
  }

  .slack-connect-howto li {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  .slack-connect-howto-num {
    flex: 0 0 auto;
    min-width: 14px;
    color: var(--cm-faint);
    font-variant-numeric: tabular-nums;
  }

  .slack-connect-howto-text {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .slack-connect-howto-btn {
    margin-left: 6px;
    vertical-align: baseline;
  }
</style>

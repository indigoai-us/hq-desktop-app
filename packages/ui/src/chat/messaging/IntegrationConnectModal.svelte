<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
  /**
   * Connect a key-based app from its card, inside the card modal.
   *
   * One component for every such app, parameterized by the card's domain:
   * the app's logo and name on the frame with its website domain under the
   * name, one line, a "Get a key" button when the app's blueprint says where
   * to make one, the key field labelled the way the blueprint names the
   * credential, and Connect. The blueprint is pulled when the modal opens;
   * the install is sent from exactly one place, the Connect button.
   *
   * WHERE THINGS GO IS SAID. A name alone does not say which site it stands
   * for, so the domain is under the title, the host a button opens is next
   * to that button, and the host the key will be used with is under the
   * field, before Connect is pressed. Every host shown is read with the URL
   * parser from the address the app itself is about to use.
   *
   * THE KEY IS A SECRET. It lives in `key` below and in the field, and
   * nowhere else: not in storage, a link, a log or an error. It is cleared
   * when the server accepts it, when the server rejects it, when the modal
   * closes and when the modal is taken down (the conversation changed). A
   * request that throws is dropped unread, because a transport error can
   * repeat what was sent.
   */
  import { onDestroy, onMount, tick } from "svelte";
  import { companyIntegrationsUrl } from "../../common/hq-console.js";
  import CardModal from "./CardModal.svelte";
  import CardModalField from "./CardModalField.svelte";
  import CardModalStatus from "./CardModalStatus.svelte";
  import { CARD_MODAL_AUTOFOCUS } from "./card-modal.js";
  import type { CardModalContentProps } from "./card-modal-registry.js";
  import {
    CONNECT_ELSEWHERE_LINK,
    connectFailureSentence,
    keyRejectedSentence,
    readKeyBlueprint,
    type KeyBlueprint,
  } from "./integration-cards-model.js";

  let { frame, integration, botName, companyUid, companySlug, adapter, openUrl, started }: CardModalContentProps = $props();

  const name = $derived(integration?.name ?? frame.title);
  const bot = $derived(botName.trim() || "your bot");

  let blueprint = $state<KeyBlueprint | null>(null);
  let blueprintFailed = $state(false);
  /** The pasted key. A secret: see the note at the top. */
  let key = $state("");
  let keyError = $state<string | null>(null);
  let inFlight = $state(false);
  /** The server accepted the key: the app is connected. */
  let done = $state(false);
  /** A failure that this modal cannot get past: the person goes to HQ Integrations instead. */
  let elsewhere = $state<string | null>(null);
  let gone = false;

  const label = $derived(blueprint?.label ?? "Key");

  /** The host of an https address, as the URL parser reads it. Null for anything else. */
  function hostOf(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && parsed.hostname ? parsed.hostname : null;
    } catch {
      return null;
    }
  }
  /** Where "Get a key" opens. */
  const getKeyHost = $derived(hostOf(blueprint?.generateUrl));
  /**
   * The host the key is used with: the app's own server when the blueprint
   * names one (the same address the install is sent with), else the app's
   * website domain.
   */
  const keyHost = $derived(hostOf(blueprint?.mcpUrl) ?? integration?.domain ?? null);
  /** Where "Open HQ Integrations" opens. */
  const elsewhereHost = $derived(hostOf(companyIntegrationsUrl(companySlug)));
  const keyEmpty = $derived(key.trim() === "");
  const autofocus = { [CARD_MODAL_AUTOFOCUS]: "" };

  let root = $state<HTMLElement | null>(null);
  function dialogEl(): HTMLElement | null {
    return root?.closest<HTMLElement>('[role="dialog"]') ?? null;
  }
  function keyInput(): HTMLInputElement | null {
    return dialogEl()?.querySelector<HTMLInputElement>('[data-testid="integration-connect-key"] input') ?? null;
  }
  async function focusKeyField(): Promise<void> {
    await tick();
    if (!gone) keyInput()?.focus();
  }

  /** What the app needs: read once when the modal opens. */
  onMount(() => {
    void (async () => {
      const app = integration;
      if (!app || !companyUid) {
        blueprintFailed = true;
        return;
      }
      let result: Awaited<ReturnType<typeof adapter.integrations.blueprint>> | null = null;
      try {
        result = await adapter.integrations.blueprint({
          companyUid,
          ...(app.catalogEntryId ? { catalogEntryId: app.catalogEntryId } : { domain: app.domain }),
        });
      } catch {
        result = null;
      }
      if (gone) return;
      if (result?.ok) blueprint = readKeyBlueprint(result.value);
      else blueprintFailed = true;
    })();
  });

  function getKey(): void {
    const url = blueprint?.generateUrl;
    if (!url) return;
    openUrl(url);
  }

  /** Connect: hand the key to the server once. */
  async function submit(): Promise<void> {
    const app = integration;
    if (inFlight || done || !app || !companyUid || keyEmpty) return;
    const pasted = key.trim();
    // A key app named only by domain installs by its MCP URL, which the
    // blueprint gives. Without one there is nothing to send the key to.
    if (!app.catalogEntryId && !blueprint?.mcpUrl) {
      elsewhere = connectFailureSentence({ code: "OAUTH_DISCOVERY_FAILED" }, name).sentence;
      return;
    }
    inFlight = true;
    keyError = null;
    // The Connect button is disabled while this is on its way: focus stays in the field.
    keyInput()?.focus();
    started();
    let result: Awaited<ReturnType<typeof adapter.integrations.install>> | null = null;
    try {
      result = await adapter.integrations.install(
        app.catalogEntryId
          ? { companyUid, catalogEntryId: app.catalogEntryId, bearerToken: pasted }
          : {
              companyUid,
              mcpUrl: blueprint!.mcpUrl!,
              authMode: "bearer",
              bearerToken: pasted,
              ...(blueprint?.provider ? { provider: blueprint.provider } : {}),
              displayName: blueprint?.displayName ?? name,
              domain: app.domain,
            },
      );
    } catch {
      // Dropped unread: a transport error can repeat what was sent.
      result = null;
    }
    if (gone) return;
    inFlight = false;
    if (!result) {
      // The value stays in the field for the retry, and nowhere else.
      keyError = connectFailureSentence(null, name).sentence;
      void focusKeyField();
      return;
    }
    if (!result.ok) {
      key = "";
      const failure = connectFailureSentence(result, name);
      if (failure.withLink || !failure.retry) elsewhere = failure.sentence;
      else keyError = keyRejectedSentence(result, name);
      void focusKeyField();
      return;
    }
    const answer = result.value as { connection?: { id?: string; provider?: string }; installation?: { displayName?: string; status?: string } };
    const connectionId = typeof answer.connection?.id === "string" ? answer.connection.id : "";
    if (!connectionId || answer.installation?.status === "needs_credentials") {
      key = "";
      keyError = keyRejectedSentence({ status: 401 }, name);
      void focusKeyField();
      return;
    }
    key = "";
    done = true;
    app.connected({
      id: connectionId,
      provider: typeof answer.connection?.provider === "string" ? answer.connection.provider : "",
      name: typeof answer.installation?.displayName === "string" && answer.installation.displayName ? answer.installation.displayName : name,
    });
  }

  function close(): void {
    key = "";
    keyError = null;
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
    key = "";
  });
</script>

<CardModal {...frame} title={name} subtitle={integration?.domain ?? null} onclose={close} busy={inFlight}>
  {#snippet body()}
    <div
      class="integration-connect"
      data-testid="integration-connect"
      data-domain={integration?.domain}
      data-stage={done ? "done" : elsewhere ? "elsewhere" : "key"}
      bind:this={root}
    >
      {#if done}
        <div data-testid="integration-connect-done">
          <CardModalStatus kind="done" text={`${name} is connected. ${bot} can use it now.`} />
        </div>
      {:else if elsewhere}
        <div data-testid="integration-connect-elsewhere">
          <CardModalStatus kind="problem" text={elsewhere} />
        </div>
        {#if elsewhereHost}
          <p class="card-modal-hint" data-testid="integration-connect-elsewhere-host">{CONNECT_ELSEWHERE_LINK} opens {elsewhereHost} in your browser.</p>
        {/if}
      {:else}
        <p class="card-modal-copy">{name} needs a key to connect.</p>
        {#if blueprint?.generateUrl}
          <div class="card-modal-action-row">
            <button type="button" class="card-modal-btn is-small" data-testid="integration-connect-get-key" onclick={getKey}><RailIcon name="key" />
              Get a key
            </button>
            {#if getKeyHost}
              <span class="card-modal-hint" data-testid="integration-connect-get-key-host">Opens {getKeyHost} in your browser.</span>
            {/if}
          </div>
        {/if}
        <div data-testid="integration-connect-key" use:wipeOnRemove>
          <CardModalField
            {label}
            type="password"
            bind:value={key}
            error={keyError}
            disabled={inFlight}
            autofocus
            oninput={() => {
              if (keyError) keyError = null;
            }}
            onsubmit={() => void submit()}
          />
        </div>
        {#if keyHost}
          <p class="card-modal-hint" data-testid="integration-connect-destination">Connect sends the key to HQ, which stores it and uses it with {keyHost}.</p>
        {/if}
        {#if inFlight}
          <CardModalStatus kind="working" text={`Connecting ${name}.`} />
        {:else if blueprintFailed && !blueprint}
          <CardModalStatus kind="problem" text={`Could not read what ${name} needs. You can still paste a key.`} />
        {/if}
      {/if}
    </div>
  {/snippet}
  {#snippet footer()}
    {#if done}
      <button type="button" class="card-modal-btn is-primary" data-testid="integration-connect-finish" onclick={close} {...autofocus}><RailIcon name="check" />
        Done
      </button>
    {:else if elsewhere}
      <button type="button" class="card-modal-btn is-quiet" data-testid="integration-connect-close" onclick={close}><RailIcon name="x" />Close</button>
      <button
        type="button"
        class="card-modal-btn is-primary"
        data-testid="integration-connect-elsewhere-action"
        onclick={() => openUrl(companyIntegrationsUrl(companySlug))}
        {...autofocus}
      ><RailIcon name="external" />
        Open {CONNECT_ELSEWHERE_LINK}
      </button>
    {:else}
      <button type="button" class="card-modal-btn is-quiet" data-testid="integration-connect-close" disabled={inFlight} onclick={close}><RailIcon name="x" />
        Close
      </button>
      <button
        type="button"
        class="card-modal-btn is-primary"
        data-testid="integration-connect-submit"
        disabled={inFlight || keyEmpty}
        onclick={() => void submit()}
      ><RailIcon name="plug" />
        Connect
      </button>
    {/if}
  {/snippet}
</CardModal>

<style>
  .integration-connect {
    display: grid;
    gap: 12px;
    min-width: 0;
  }
</style>

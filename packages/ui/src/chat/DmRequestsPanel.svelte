<script lang="ts">
  /**
   * Pending DM connection requests, rendered in the main conversation area.
   *
   * Each request is a bordered CARD (deliberately not a chat bubble) so an
   * incoming request reads as something to act on: requester name + email,
   * an optional "also in {company}" trust hint, the held first message, and
   * Accept (primary) / Decline / Block (destructive). The card owns the
   * respond call plus its busy/error state; the host is told on success so it
   * can refresh the rail and, on accept, open the new conversation.
   *
   * Platform-pure: the API seam is `ChatSidebarApi`, the realtime seam is the
   * chat wake bus. No Tauri or fetch imports.
   */
  import { onMount } from "svelte";
  import PageHeader from "../shell/PageHeader.svelte";
  import type { ChatSidebarApi, ChatWakeBus } from "./chat-api";
  import {
    addRequest,
    removeRequest,
    requestDisplayName,
    requestInitials,
    type DmRequest,
    type RequestAction,
  } from "./dm-requests";
  import { sanitizeVisibleIdentifiers } from "./visible-labels";

  interface Props {
    api: Pick<ChatSidebarApi, "listDmRequests" | "respondDmRequest">;
    wakes?: ChatWakeBus | null;
    /** Scroll/focus this request first when the panel opens. */
    focusPairKey?: string | null;
    onback?: () => void;
    /**
     * A request was answered successfully. The panel has already pruned it
     * and emitted `dm:request-update`; the host refreshes its rail and, on
     * `accept`, opens the conversation with `request.fromPersonUid`.
     */
    onresolved?: (request: DmRequest, action: RequestAction) => void;
  }

  let {
    api,
    wakes = null,
    focusPairKey = null,
    onback,
    onresolved,
  }: Props = $props();

  let requests = $state<DmRequest[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  /** pairKey → action in flight. */
  let busy = $state<Record<string, RequestAction>>({});
  /** pairKey → inline failure copy. */
  let errors = $state<Record<string, string>>({});

  const canRespond = $derived(typeof api.respondDmRequest === "function");

  export async function refresh(): Promise<void> {
    loadError = null;
    try {
      const resp = await api.listDmRequests();
      requests = Array.isArray(resp?.requests) ? resp.requests : [];
    } catch (err) {
      loadError = "Couldn’t load connection requests.";
      console.error("dm-requests: list_dm_requests failed", err);
    } finally {
      loading = false;
    }
  }

  function labelFor(req: DmRequest): string {
    return sanitizeVisibleIdentifiers(requestDisplayName(req));
  }

  async function respond(req: DmRequest, action: RequestAction): Promise<void> {
    if (!api.respondDmRequest || busy[req.pairKey]) return;
    busy = { ...busy, [req.pairKey]: action };
    const { [req.pairKey]: _dropped, ...rest } = errors;
    errors = rest;
    try {
      await api.respondDmRequest({ pairKey: req.pairKey, action });
      requests = removeRequest(requests, req.pairKey);
      // The native poll also emits this once the server-side set changes;
      // emitting it here makes the rail badge honest immediately and is
      // idempotent (removeRequest by pairKey).
      wakes?.emit?.("dm:request-update", { pairKey: req.pairKey });
      onresolved?.(req, action);
    } catch (err) {
      const detail =
        typeof err === "string"
          ? err
          : err instanceof Error && err.message
            ? err.message
            : "";
      errors = {
        ...errors,
        [req.pairKey]: detail
          ? `Could not ${action} this request: ${detail}`
          : `Could not ${action} this request.`,
      };
      console.error(`dm-requests: respond_dm_request ${action} failed`, err);
    } finally {
      const { [req.pairKey]: _done, ...remaining } = busy;
      busy = remaining;
    }
  }

  onMount(() => {
    void refresh();
    const unlisteners: Array<() => void> = [];
    if (wakes) {
      unlisteners.push(
        wakes.on("dm:request-new", (payload) => {
          requests = addRequest(requests, payload);
        }),
      );
      unlisteners.push(
        wakes.on("dm:request-update", (payload) => {
          requests = removeRequest(requests, payload.pairKey);
        }),
      );
    }
    return () => {
      for (const unlisten of unlisteners) unlisten();
    };
  });

  $effect(() => {
    const key = focusPairKey?.trim();
    if (!key || loading) return;
    const el = document.querySelector<HTMLElement>(
      `[data-testid="dm-request-card"][data-pair-key="${CSS.escape(key)}"]`,
    );
    el?.scrollIntoView?.({ block: "nearest" });
  });
</script>

<section
  class="dm-requests"
  aria-label="Connection requests"
  data-testid="dm-requests-panel"
>
  <PageHeader
    title="Connection requests"
    subtitle="People outside your workspaces who want to message you. Accept to start the conversation; declined and blocked requests are dropped."
    backTestId="dm-requests-back"
    onback={() => onback?.()}
    variant="embedded"
  />

  {#if loading}
    <p class="dm-requests-status" data-testid="dm-requests-loading" role="status">
      Loading requests…
    </p>
  {:else if loadError}
    <div class="dm-requests-status" data-testid="dm-requests-error" role="alert">
      <span>{loadError}</span>
      <button type="button" onclick={() => void refresh()}>Retry</button>
    </div>
  {:else if requests.length === 0}
    <p class="dm-requests-status" data-testid="dm-requests-empty" role="status">
      No pending connection requests.
    </p>
  {:else}
    <ul class="dm-requests-list" aria-label="Pending connection requests">
      {#each requests as req (req.pairKey)}
        {@const name = labelFor(req)}
        {@const inflight = busy[req.pairKey] ?? null}
        <li>
          <article
            class="request-card"
            data-testid="dm-request-card"
            data-pair-key={req.pairKey}
            aria-label={`Connection request from ${name}`}
          >
            <header class="request-head">
              <span class="request-avatar" aria-hidden="true">
                {requestInitials(req)}
              </span>
              <span class="request-id">
                <span class="request-name" data-testid="dm-request-name">{name}</span>
                {#if req.fromEmail?.trim()}
                  <span class="request-email">{req.fromEmail.trim()}</span>
                {/if}
              </span>
            </header>

            {#if req.sharedCompany?.trim()}
              <p class="request-hint" title="Why you're seeing this request">
                Also in <strong>{req.sharedCompany.trim()}</strong>
              </p>
            {/if}

            {#if req.message?.trim()}
              <blockquote class="request-message" data-testid="dm-request-message">
                {req.message.trim()}
              </blockquote>
            {:else}
              <p class="request-no-message">No message included.</p>
            {/if}

            {#if errors[req.pairKey]}
              <p class="request-error" role="alert" data-testid="dm-request-error">
                {errors[req.pairKey]}
              </p>
            {/if}

            {#if canRespond}
              <div class="request-actions">
                <button
                  class="action action-accept"
                  type="button"
                  data-testid="dm-request-accept"
                  disabled={inflight !== null}
                  onclick={() => void respond(req, "accept")}
                >
                  {inflight === "accept" ? "Accepting…" : "Accept"}
                </button>
                <button
                  class="action action-decline"
                  type="button"
                  data-testid="dm-request-decline"
                  disabled={inflight !== null}
                  onclick={() => void respond(req, "decline")}
                >
                  {inflight === "decline" ? "Declining…" : "Decline"}
                </button>
                <button
                  class="action action-block"
                  type="button"
                  data-testid="dm-request-block"
                  disabled={inflight !== null}
                  onclick={() => void respond(req, "block")}
                >
                  {inflight === "block" ? "Blocking…" : "Block"}
                </button>
              </div>
            {:else}
              <p class="request-no-message" data-testid="dm-request-readonly">
                Open HQ on your desktop to answer this request.
              </p>
            {/if}
          </article>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .dm-requests {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: auto;
    color: var(--t1);
    background: var(--v4-bg, var(--desktop-bg, #0c0c0c));
  }
  .dm-requests-status,
  .dm-requests-list {
    max-width: 760px;
    width: 100%;
    box-sizing: border-box;
    margin: 16px auto 24px;
    padding: 0 20px;
  }
  .dm-requests-status {
    display: flex;
    gap: 12px;
    align-items: center;
    color: var(--t2);
  }
  .dm-requests-status button {
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 5px 9px;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .dm-requests-list {
    display: grid;
    gap: 8px;
    list-style: none;
  }
  .dm-requests-list li {
    margin: 0;
    padding: 0;
  }

  /* Connection requests are action rows: identity and copy carry the
     hierarchy; only the actual controls are bounded. */
  .request-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--raised);
  }
  .request-head {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .request-avatar {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 7px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--t1);
    background: var(--v4-control-bg, rgba(127, 127, 127, 0.18));
  }
  .request-id {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .request-name {
    font-weight: 600;
    color: var(--t1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .request-email {
    font-size: 12px;
    color: var(--t2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .request-hint {
    margin: 0;
    font-size: 12px;
    color: var(--t2);
  }
  .request-message {
    margin: 0;
    padding: 8px 12px;
    border-left: 2px solid var(--line2);
    color: var(--t1);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .request-no-message {
    margin: 0;
    font-size: 12px;
    font-style: italic;
    color: var(--t2);
  }
  .request-error {
    margin: 0;
    font-size: 12px;
    color: var(--v4-error, #e5484d);
  }
  .request-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .action {
    appearance: none;
    -webkit-appearance: none;
    height: 28px;
    padding: 0 12px;
    border: 1px solid var(--line2);
    border-radius: var(--v4-radius-button, 6px);
    background: transparent;
    color: var(--t1);
    font: 500 12px/1 inherit;
    cursor: pointer;
  }
  .action:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .action-accept {
    border-color: transparent;
    background: var(--v4-primary-bg, var(--t1));
    color: var(--v4-primary-fg, var(--v4-bg, #0c0c0c));
  }
  .action-block {
    color: var(--v4-error, #e5484d);
  }
</style>

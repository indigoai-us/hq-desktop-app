<script lang="ts">
  /**
   * Forward a message to one destination (US-009). Candidates are passed in
   * from data the shell already holds (sidebar rows and contacts), so the
   * picker opens with no network call. The server decides cross-company and
   * file access; the picker only answers its 409 prompts.
   */
  import { onMount, tick } from "svelte";
  import type { ConversationRow } from "../sidebar-model.js";
  import type { MentionTarget } from "../mentions.js";
  import {
    buildForwardCandidates,
    filterForwardCandidates,
    forwardErrorMessage,
    forwardPreview,
    showCompanyControl,
    type ForwardCandidate,
    type ForwardCompany,
    type ForwardRequest,
    type ForwardResult,
    type ForwardSource,
  } from "./forward-model.js";

  interface Props {
    source: ForwardSource;
    rows: readonly ConversationRow[];
    contacts: readonly MentionTarget[];
    adminCompanies: readonly ForwardCompany[];
    onsend: (req: ForwardRequest) => Promise<ForwardResult>;
    onclose: () => void;
    ondone: (destinationName: string, result: Extract<ForwardResult, { ok: true }>) => void;
  }

  let { source, rows, contacts, adminCompanies, onsend, onclose, ondone }: Props = $props();

  // "" = the source conversation's own scope.
  let companyChoice = $state(source.companyUid ?? "");
  let query = $state("");
  let selectedId = $state<string | null>(null);
  let note = $state("");
  let sending = $state(false);
  let errorText = $state<string | null>(null);
  let pending = $state<null | { kind: "ack" | "files"; message: string; request: ForwardRequest }>(null);
  let searchEl = $state<HTMLInputElement | null>(null);

  const companyControl = $derived(showCompanyControl(adminCompanies, source.companyUid));
  const candidates = $derived(
    buildForwardCandidates(rows, contacts, companyChoice || null, source.companyUid),
  );
  const visible = $derived(filterForwardCandidates(candidates, query));
  const selected = $derived<ForwardCandidate | null>(
    candidates.find((c) => c.id === selectedId) ?? null,
  );
  const preview = $derived(forwardPreview(source));

  const KIND_LABEL: Record<ForwardCandidate["kind"], string> = {
    person: "Person",
    bot: "Bot",
    channel: "Channel",
    group: "Group",
  };

  onMount(() => {
    void tick().then(() => searchEl?.focus());
  });

  function pick(id: string): void {
    selectedId = id;
    errorText = null;
    pending = null;
  }

  function changeCompany(uid: string): void {
    companyChoice = uid;
    selectedId = null;
    pending = null;
    errorText = null;
  }

  async function submit(extra: Partial<ForwardRequest> = {}): Promise<void> {
    const dest = selected;
    if (!dest || sending) return;
    const request: ForwardRequest = {
      destination: dest,
      forwardOf: { conversationId: source.conversationId, eventId: source.eventId },
      note,
      ...(pending?.request.fileAccess ? { fileAccess: pending.request.fileAccess } : {}),
      ...(pending?.request.acknowledgeCrossCompany ? { acknowledgeCrossCompany: true } : {}),
      ...extra,
    };
    sending = true;
    errorText = null;
    let result: ForwardResult;
    try {
      result = await onsend(request);
    } catch (err) {
      console.error("[forward] send failed", err);
      result = { ok: false, code: "NETWORK", status: null, files: [], notShareable: [] };
    }
    sending = false;
    if (result.ok) {
      pending = null;
      onclose();
      ondone(dest.name, result);
      return;
    }
    const message = forwardErrorMessage(result, {
      destinationName: dest.name,
      sourceCompanyName: adminCompanies.find((c) => c.uid === source.companyUid)?.name,
    });
    if (result.code === "CROSS_COMPANY_ACK_REQUIRED") {
      const from = result.sourceCompany?.name ?? "this company";
      const to = result.destinationCompany?.name ?? "another company";
      pending = {
        kind: "ack",
        message: `This sends the message from ${from} to ${to}. Files are not carried across companies.`,
        request,
      };
      return;
    }
    if (result.code === "FORWARD_FILE_ACCESS_REQUIRED") {
      pending = { kind: "files", message, request };
      return;
    }
    pending = null;
    errorText = message;
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onclose();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "BUTTON" || target?.tagName === "SELECT") return;
      if (pending) return;
      e.preventDefault();
      if (selected) void submit();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "TEXTAREA") return;
      if (visible.length === 0) return;
      e.preventDefault();
      const at = visible.findIndex((c) => c.id === selectedId);
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next = at < 0 ? (step > 0 ? 0 : visible.length - 1) : (at + step + visible.length) % visible.length;
      pick(visible[next].id);
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="forward-backdrop"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="forward-card"
    role="dialog"
    aria-modal="true"
    aria-labelledby="forward-title"
    data-testid="forward-picker"
    tabindex="-1"
    onkeydown={onKey}
  >
    <h2 class="forward-title" id="forward-title">Forward message</h2>

    <div class="forward-preview" data-testid="forward-preview">
      <div class="forward-preview-sender" data-testid="forward-preview-sender">{preview.senderName}</div>
      {#if preview.lines.length > 0}
        <div class="forward-preview-body" data-testid="forward-preview-body">
          {#each preview.lines as line, i (i)}<div>{line || " "}</div>{/each}
        </div>
      {/if}
      {#if preview.artifactLabel}
        <div class="forward-preview-artifact" data-testid="forward-preview-artifact">{preview.artifactLabel}</div>
      {/if}
    </div>

    {#if companyControl}
      <label class="forward-field">
        <span class="forward-label">Company</span>
        <select
          data-testid="forward-company"
          value={companyChoice}
          onchange={(e) => changeCompany((e.currentTarget as HTMLSelectElement).value)}
        >
          {#if !source.companyUid}
            <option value="">This conversation</option>
          {/if}
          {#each adminCompanies as company (company.uid)}
            <option value={company.uid}>{company.name}</option>
          {/each}
        </select>
      </label>
    {/if}

    <input
      bind:this={searchEl}
      class="forward-search"
      type="search"
      placeholder="Search people, bots, and channels"
      aria-label="Search destinations"
      data-testid="forward-search"
      bind:value={query}
    />

    <div class="forward-list" role="listbox" aria-label="Destinations" data-testid="forward-list">
      {#each visible as candidate (candidate.id)}
        <button
          type="button"
          role="option"
          class="forward-option"
          class:selected={candidate.id === selectedId}
          aria-selected={candidate.id === selectedId}
          data-testid="forward-option"
          data-id={candidate.id}
          onclick={() => pick(candidate.id)}
        >
          <span class="forward-option-name">{candidate.kind === "channel" ? `#${candidate.name}` : candidate.name}</span>
          <span class="forward-option-kind">{KIND_LABEL[candidate.kind]}</span>
        </button>
      {:else}
        <div class="forward-empty" data-testid="forward-empty">
          {query.trim() ? "No matches. Try another name." : "No one to forward to here yet."}
        </div>
      {/each}
    </div>

    <label class="forward-field">
      <span class="forward-label">Note (optional)</span>
      <textarea
        data-testid="forward-note"
        rows="2"
        placeholder="Add a note"
        bind:value={note}
      ></textarea>
    </label>

    {#if pending}
      <div class="forward-prompt" role="status" data-testid={pending.kind === "ack" ? "forward-ack" : "forward-files"}>
        <p>{pending.message}</p>
        <div class="forward-actions">
          <button type="button" class="forward-btn ghost" onclick={() => (pending = null)}>Cancel</button>
          {#if pending.kind === "ack"}
            <button
              type="button"
              class="forward-btn"
              data-testid="forward-ack-confirm"
              disabled={sending}
              onclick={() => void submit({ acknowledgeCrossCompany: true })}
            >Send anyway</button>
          {:else}
            <button
              type="button"
              class="forward-btn ghost"
              data-testid="forward-files-omit"
              disabled={sending}
              onclick={() => void submit({ fileAccess: "omit" })}
            >Send without files</button>
            <button
              type="button"
              class="forward-btn"
              data-testid="forward-files-grant"
              disabled={sending}
              onclick={() => void submit({ fileAccess: "grant" })}
            >Share files</button>
          {/if}
        </div>
      </div>
    {/if}

    {#if errorText}
      <p class="forward-error" role="alert" data-testid="forward-error">{errorText}</p>
    {/if}

    <div class="forward-actions">
      <button type="button" class="forward-btn ghost" data-testid="forward-cancel" onclick={onclose}>Cancel</button>
      <button
        type="button"
        class="forward-btn"
        data-testid="forward-send"
        disabled={!selected || sending}
        aria-busy={sending}
        onclick={() => void submit()}
      >{sending ? "Sending…" : "Forward"}</button>
    </div>
  </div>
</div>

<style>
  .forward-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40000;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.62);
  }

  .forward-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(420px, 100%);
    max-height: min(640px, 100%);
    padding: 18px 18px 14px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.14));
    border-radius: 10px;
    background: var(--v4-surface-solid, var(--elevated, #1e1e24));
    color: var(--t1);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
    font: 400 13px/1.45 var(--font-ui);
    outline: none;
  }

  .forward-title {
    margin: 0;
    font: 600 14px/1.3 var(--font-ui);
  }

  .forward-preview {
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--t2);
  }

  .forward-preview-sender {
    color: var(--t1);
    font-weight: 600;
  }

  .forward-preview-body {
    overflow: hidden;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .forward-preview-artifact {
    margin-top: 4px;
    color: var(--t3, var(--t2));
  }

  .forward-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .forward-label {
    color: var(--t2);
  }

  .forward-search,
  .forward-field select,
  .forward-field textarea {
    padding: 6px 8px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.14));
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
  }

  .forward-field textarea {
    resize: vertical;
  }

  .forward-list {
    display: flex;
    flex-direction: column;
    min-height: 80px;
    max-height: 220px;
    overflow-y: auto;
  }

  .forward-option {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .forward-option:hover,
  .forward-option.selected {
    background: color-mix(in srgb, var(--t1) 10%, transparent);
  }

  .forward-option-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .forward-option-kind,
  .forward-empty {
    color: var(--t2);
  }

  .forward-empty {
    padding: 6px 8px;
  }

  .forward-prompt p,
  .forward-error {
    margin: 0;
    color: var(--t2);
  }

  .forward-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .forward-btn {
    appearance: none;
    -webkit-appearance: none;
    padding: 6px 12px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.14));
    border-radius: var(--v4-radius-button, 6px);
    background: color-mix(in srgb, var(--t1) 10%, transparent);
    color: var(--t1);
    font: 500 12px/1.3 var(--font-ui);
    cursor: pointer;
  }

  .forward-btn.ghost {
    background: transparent;
    color: var(--t2);
  }

  .forward-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>

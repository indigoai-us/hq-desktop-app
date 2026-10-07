<script lang="ts">
  /**
   * Forward a message to one or more destinations (US-009). Candidates are
   * passed in from data the shell already holds (sidebar rows and contacts),
   * so the picker opens with no network call. The server decides cross-company
   * and file access; the picker only answers its 409 prompts.
   *
   * Layout follows HQ messaging: a quoted card with the sender's avatar, time
   * and origin; one search field that carries the scope chip and the chosen
   * recipient chips; grouped results (Recent, Channels, People, Bots) with
   * avatars and presence; a note; a plain footer.
   */
  import { onMount, tick } from "svelte";
  import type { ConversationRow } from "../sidebar-model.js";
  import type { MentionTarget } from "../mentions.js";
  import IdentityMark from "./IdentityMark.svelte";
  import { presenceStatus } from "../presence-store.svelte.js";
  import { authorAvatarUrl } from "./agent-avatars.js";
  import {
    buildForwardCandidates,
    crossCompanyText,
    filesPromptTitle,
    flattenForwardSections,
    forwardErrorView,
    forwardFileNames,
    forwardNotices,
    forwardOriginLabel,
    forwardPreview,
    forwardScopeLabel,
    forwardTimeLabel,
    groupForwardCandidates,
    FORWARD_ERROR_ACTION_LABEL,
    showCompanyControl,
    type ForwardCandidate,
    type ForwardCompany,
    type ForwardErrorView,
    type ForwardRequest,
    type ForwardResult,
    type ForwardSource,
  } from "./forward-model.js";

  interface Props {
    source: ForwardSource;
    rows: readonly ConversationRow[];
    contacts: readonly MentionTarget[];
    adminCompanies: readonly ForwardCompany[];
    /** uid → avatar URL from loaded rosters; monograms when absent. */
    avatarByUid?: Record<string, string> | null;
    onsend: (req: ForwardRequest) => Promise<ForwardResult>;
    onclose: () => void;
    /** Called once per forward with the destination names joined by ", ". */
    ondone: (destinationName: string, result: Extract<ForwardResult, { ok: true }>) => void;
  }

  let {
    source,
    rows,
    contacts,
    adminCompanies,
    avatarByUid = null,
    onsend,
    onclose,
    ondone,
  }: Props = $props();

  // "" = the source conversation's own scope.
  let companyChoice = $state(source.companyUid ?? "");
  let scopeOpen = $state(false);
  let query = $state("");
  let selectedIds = $state<string[]>([]);
  let highlightId = $state<string | null>(null);
  let note = $state("");
  let sending = $state(false);
  let errorView = $state<ForwardErrorView | null>(null);
  let lastRequest = $state<ForwardRequest | null>(null);
  let pending = $state<
    null | {
      kind: "ack" | "files";
      message: string;
      request: ForwardRequest;
      files: string[];
      notIncluded: string[];
    }
  >(null);
  let searchEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);

  const companyControl = $derived(showCompanyControl(adminCompanies, source.companyUid));
  const candidates = $derived(
    buildForwardCandidates(rows, contacts, companyChoice || null, source.companyUid),
  );
  const sections = $derived(groupForwardCandidates(candidates, query));
  const visible = $derived(flattenForwardSections(sections));
  const selected = $derived<ForwardCandidate[]>(
    selectedIds.map((id) => candidates.find((c) => c.id === id)).filter((c): c is ForwardCandidate => !!c),
  );
  const preview = $derived(forwardPreview(source));
  const timeLabel = $derived(forwardTimeLabel(source.createdAt));
  const originLabel = $derived(forwardOriginLabel(source.origin));
  const scopeLabel = $derived(forwardScopeLabel(companyChoice, adminCompanies));
  const companyName = (uid: string | null | undefined): string | null =>
    (uid && adminCompanies.find((c) => c.uid === uid)?.name) || null;
  const notices = $derived.by(() => {
    const seen = new Set<string>();
    const out: ReturnType<typeof forwardNotices> = [];
    for (const dest of selected) {
      for (const n of forwardNotices({
        source,
        destination: dest,
        sourceCompanyName: companyName(source.companyUid),
        destinationCompanyName: companyName(dest.companyUid),
      })) {
        if (seen.has(n.kind)) continue;
        seen.add(n.kind);
        out.push(n);
      }
    }
    return out;
  });
  const crossCompany = $derived(notices.some((n) => n.kind === "cross-company"));
  const sendLabel = $derived(
    sending
      ? "Sending…"
      : crossCompany
        ? "Confirm and forward"
        : selected.length > 1
          ? `Forward to ${selected.length}`
          : "Forward",
  );

  const KIND_LABEL: Record<ForwardCandidate["kind"], string> = {
    person: "Person",
    bot: "Bot",
    channel: "Channel",
    group: "Group",
  };

  onMount(() => {
    void tick().then(() => searchEl?.focus());
  });

  $effect(() => {
    // Keep the highlight on a visible row as the query or scope changes.
    if (highlightId && !visible.some((c) => c.id === highlightId)) highlightId = visible[0]?.id ?? null;
    if (!highlightId && visible.length > 0) highlightId = visible[0].id;
  });

  function isSelected(id: string): boolean {
    return selectedIds.includes(id);
  }

  function toggle(id: string): void {
    selectedIds = isSelected(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id];
    highlightId = id;
    errorView = null;
    pending = null;
    if (query) query = "";
    void tick().then(() => searchEl?.focus());
  }

  function remove(id: string): void {
    selectedIds = selectedIds.filter((x) => x !== id);
    errorView = null;
    pending = null;
  }

  function changeCompany(uid: string): void {
    companyChoice = uid;
    scopeOpen = false;
    selectedIds = [];
    pending = null;
    errorView = null;
    void tick().then(() => searchEl?.focus());
  }

  /** Drop the destination that failed so the user can choose a different one. */
  function pickAnother(): void {
    const failed = lastRequest?.destination.id;
    if (failed) selectedIds = selectedIds.filter((x) => x !== failed);
    errorView = null;
    pending = null;
    void tick().then(() => searchEl?.focus());
  }

  function identityKind(c: ForwardCandidate): "person" | "agent" | "channel" | "group" {
    if (c.kind === "bot") return "agent";
    if (c.kind === "channel") return "channel";
    if (c.kind === "group") return "group";
    return "person";
  }

  function online(c: ForwardCandidate): boolean {
    if (!c.principalUid) return false;
    return presenceStatus(c.companyUid ?? source.companyUid ?? "", c.principalUid) === "online";
  }

  /** Repeat the failed request, keeping any file or company choice already made. */
  function retry(extra: Partial<ForwardRequest> = {}): void {
    const prev = lastRequest;
    void submit({
      ...(prev?.fileAccess ? { fileAccess: prev.fileAccess } : {}),
      ...(prev?.acknowledgeCrossCompany ? { acknowledgeCrossCompany: true } : {}),
      ...extra,
    });
  }

  function runErrorAction(action: ForwardErrorView["action"]): void {
    if (action === "pick") pickAnother();
    else if (action === "close") onclose();
    else if (action === "omit") retry({ fileAccess: "omit" });
    else retry();
  }

  /**
   * Send to every selected destination in order. A prompt or error stops the
   * run at that destination; the ones already delivered leave the selection,
   * so confirming or retrying only resends what is still outstanding.
   */
  async function submit(extra: Partial<ForwardRequest> = {}): Promise<void> {
    if (selected.length === 0 || sending) return;
    sending = true;
    errorView = null;
    const delivered: string[] = [];
    let last: Extract<ForwardResult, { ok: true }> | null = null;
    for (const dest of [...selected]) {
      const request: ForwardRequest = {
        destination: dest,
        forwardOf: { conversationId: source.conversationId, eventId: source.eventId },
        note,
        ...(pending?.request.fileAccess ? { fileAccess: pending.request.fileAccess } : {}),
        ...(pending?.request.acknowledgeCrossCompany ? { acknowledgeCrossCompany: true } : {}),
        ...extra,
      };
      lastRequest = request;
      let result: ForwardResult;
      try {
        result = await onsend(request);
      } catch (err) {
        console.error("[forward] send failed", err);
        result = { ok: false, code: "NETWORK", status: null, files: [], notShareable: [] };
      }
      if (result.ok) {
        delivered.push(dest.name);
        last = result;
        selectedIds = selectedIds.filter((id) => id !== dest.id);
        continue;
      }
      sending = false;
      const view = forwardErrorView(result, {
        destinationName: dest.name,
        sourceCompanyName: companyName(source.companyUid) ?? undefined,
      });
      if (result.code === "CROSS_COMPANY_ACK_REQUIRED") {
        pending = {
          kind: "ack",
          message: crossCompanyText(
            result.sourceCompany?.name ?? companyName(source.companyUid),
            result.destinationCompany?.name ?? companyName(dest.companyUid),
          ),
          request,
          files: [],
          notIncluded: [],
        };
        return;
      }
      if (result.code === "FORWARD_FILE_ACCESS_REQUIRED") {
        pending = {
          kind: "files",
          message:
            result.files.length > 0 ? filesPromptTitle(result.files.length, dest.name) : view.text,
          request,
          files: forwardFileNames(result.files),
          notIncluded: forwardFileNames(result.notShareable),
        };
        return;
      }
      pending = null;
      errorView = view;
      return;
    }
    sending = false;
    pending = null;
    onclose();
    if (last) ondone(delivered.join(", "), last);
  }

  function send(): void {
    void submit(crossCompany ? { acknowledgeCrossCompany: true } : {});
  }

  function onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (scopeOpen) {
        scopeOpen = false;
        return;
      }
      onclose();
      return;
    }
    if (e.key === "Enter" && !e.isComposing) {
      if (tag === "BUTTON") return;
      if (pending) return;
      const inSearch = target === searchEl;
      if (inSearch && !(e.metaKey || e.ctrlKey)) {
        // Enter in the search field adds the highlighted row; ⌘Enter sends.
        e.preventDefault();
        if (highlightId && !isSelected(highlightId)) toggle(highlightId);
        else if (selected.length > 0) send();
        return;
      }
      if (tag === "TEXTAREA" && e.shiftKey) return;
      e.preventDefault();
      if (selected.length > 0) send();
      return;
    }
    if (e.key === "Backspace" && target === searchEl && !query && selectedIds.length > 0) {
      e.preventDefault();
      remove(selectedIds[selectedIds.length - 1]);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (tag === "TEXTAREA") return;
      if (visible.length === 0) return;
      e.preventDefault();
      const at = visible.findIndex((c) => c.id === highlightId);
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next =
        at < 0 ? (step > 0 ? 0 : visible.length - 1) : (at + step + visible.length) % visible.length;
      highlightId = visible[next].id;
      void tick().then(() =>
        listEl
          ?.querySelector<HTMLElement>(`[data-id="${CSS.escape(visible[next].id)}"]`)
          ?.scrollIntoView({ block: "nearest" }),
      );
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
    <div class="forward-head">
      <h2 class="forward-title" id="forward-title">Forward message</h2>
      <button type="button" class="forward-close" aria-label="Close" data-testid="forward-close" onclick={onclose}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <div class="forward-quote" data-testid="forward-preview">
      <IdentityMark
        kind={source.senderUid?.startsWith("agt_") ? "agent" : "person"}
        label={preview.senderName}
        avatarUrl={authorAvatarUrl(source.senderUid, avatarByUid)}
        agentUid={source.senderUid ?? null}
        size="small"
      />
      <div class="forward-quote-copy">
        <div class="forward-quote-meta">
          <span class="forward-quote-sender" data-testid="forward-preview-sender">{preview.senderName}</span>
          {#if timeLabel}<span class="forward-quote-time" data-testid="forward-preview-time">{timeLabel}</span>{/if}
          {#if originLabel}<span class="forward-quote-origin" data-testid="forward-preview-origin">{originLabel}</span>{/if}
        </div>
        {#if preview.lines.length > 0}
          <div class="forward-quote-body" data-testid="forward-preview-body">
            {#each preview.lines as line, i (i)}<div>{line || " "}</div>{/each}
          </div>
        {/if}
        {#if preview.artifactLabel}
          <div class="forward-quote-artifact" data-testid="forward-preview-artifact">{preview.artifactLabel}</div>
        {/if}
        {#if source.attachmentCount > 0}
          <div class="forward-quote-files" data-testid="forward-preview-files">
            {source.attachmentCount === 1 ? "1 file" : `${source.attachmentCount} files`}
          </div>
        {/if}
      </div>
    </div>

    <div class="forward-to">
      <span class="forward-to-label" id="forward-to-label">To</span>
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
      <div class="forward-field-frame" onclick={() => searchEl?.focus()}>
        {#if companyControl}
          <div class="forward-scope">
            <button
              type="button"
              class="forward-chip scope"
              data-testid="forward-company"
              aria-haspopup="listbox"
              aria-expanded={scopeOpen}
              onclick={(e) => {
                e.stopPropagation();
                scopeOpen = !scopeOpen;
              }}
            >
              <span class="forward-chip-name">{scopeLabel}</span>
              <svg viewBox="0 0 10 10" width="9" height="9" fill="none" aria-hidden="true">
                <path d="M2 3.5l3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
              </svg>
            </button>
            {#if scopeOpen}
              <div class="forward-scope-menu" role="listbox" aria-label="Scope" data-testid="forward-company-menu">
                {#if !source.companyUid}
                  <button
                    type="button"
                    role="option"
                    class="forward-scope-option"
                    aria-selected={companyChoice === ""}
                    data-value=""
                    onclick={(e) => {
                      e.stopPropagation();
                      changeCompany("");
                    }}>This conversation</button>
                {/if}
                {#each adminCompanies as company (company.uid)}
                  <button
                    type="button"
                    role="option"
                    class="forward-scope-option"
                    aria-selected={companyChoice === company.uid}
                    data-value={company.uid}
                    onclick={(e) => {
                      e.stopPropagation();
                      changeCompany(company.uid);
                    }}>{company.name}</button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
        {#each selected as dest (dest.id)}
          <span class="forward-chip" data-testid="forward-recipient" data-id={dest.id}>
            <span class="forward-chip-name">{dest.kind === "channel" ? `#${dest.name}` : dest.name}</span>
            <button
              type="button"
              class="forward-chip-x"
              aria-label={`Remove ${dest.name}`}
              data-testid="forward-recipient-remove"
              onclick={(e) => {
                e.stopPropagation();
                remove(dest.id);
              }}>×</button>
          </span>
        {/each}
        <input
          bind:this={searchEl}
          class="forward-search"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder={selected.length > 0 ? "Add another" : "Search people, bots, and channels"}
          aria-labelledby="forward-to-label"
          aria-controls="forward-list"
          aria-activedescendant={highlightId ? `forward-opt-${highlightId}` : undefined}
          data-testid="forward-search"
          bind:value={query}
        />
      </div>
    </div>

    <div
      bind:this={listEl}
      class="forward-list"
      id="forward-list"
      role="listbox"
      aria-multiselectable="true"
      aria-label="Destinations"
      data-testid="forward-list"
    >
      {#each sections as section (section.key)}
        <div class="forward-section" data-testid="forward-section" data-section={section.key}>
          <div class="forward-section-label">{section.label}</div>
          {#each section.items as candidate (candidate.id)}
            {@const picked = isSelected(candidate.id)}
            <button
              type="button"
              role="option"
              id={`forward-opt-${candidate.id}`}
              class="forward-option"
              class:highlight={candidate.id === highlightId}
              class:picked
              aria-selected={picked}
              data-testid="forward-option"
              data-id={candidate.id}
              data-section={section.key}
              onclick={() => toggle(candidate.id)}
              onmousemove={() => (highlightId = candidate.id)}
            >
              <IdentityMark
                kind={identityKind(candidate)}
                label={candidate.name}
                avatarUrl={authorAvatarUrl(candidate.principalUid, avatarByUid)}
                agentUid={candidate.kind === "bot" ? (candidate.principalUid ?? null) : null}
                online={online(candidate)}
                size="small"
              />
              <span class="forward-option-copy">
                <span class="forward-option-name">{candidate.kind === "channel" ? `#${candidate.name}` : candidate.name}</span>
                {#if candidate.subtitle}
                  <span class="forward-option-sub">{candidate.subtitle}</span>
                {/if}
              </span>
              <span class="forward-option-kind">{KIND_LABEL[candidate.kind]}</span>
              <span class="forward-option-check" aria-hidden="true">
                {#if picked}
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
                    <path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                {/if}
              </span>
            </button>
          {/each}
        </div>
      {:else}
        <div class="forward-empty" data-testid="forward-empty">
          {query.trim() ? "No matches. Try another name." : "No one to forward to here yet."}
        </div>
      {/each}
    </div>

    <textarea
      class="forward-note"
      data-testid="forward-note"
      rows="2"
      placeholder="Add a note (optional)"
      aria-label="Note"
      bind:value={note}
    ></textarea>

    {#each notices as notice (notice.kind)}
      <div
        class="forward-prompt"
        role="status"
        data-testid={notice.kind === "channel-files" ? "forward-notice-channel" : "forward-notice-cross-company"}
      >
        <p>{notice.text}</p>
      </div>
    {/each}

    {#if pending}
      <div class="forward-prompt" role="status" data-testid={pending.kind === "ack" ? "forward-ack" : "forward-files"}>
        <p data-testid={pending.kind === "files" ? "forward-files-title" : undefined}>{pending.message}</p>
        {#if pending.files.length > 0}
          <ul class="forward-file-list" data-testid="forward-files-list">
            {#each pending.files as name, i (i)}<li>{name}</li>{/each}
          </ul>
        {/if}
        {#if pending.notIncluded.length > 0}
          <div class="forward-file-group" data-testid="forward-files-not-included">
            <span class="forward-label">Not included</span>
            <ul class="forward-file-list">
              {#each pending.notIncluded as name, i (i)}<li>{name}</li>{/each}
            </ul>
          </div>
        {/if}
        <div class="forward-actions">
          <button type="button" class="forward-btn ghost" onclick={() => (pending = null)}>Cancel</button>
          {#if pending.kind === "ack"}
            <button
              type="button"
              class="forward-btn primary"
              data-testid="forward-ack-confirm"
              disabled={sending}
              onclick={() => void submit({ acknowledgeCrossCompany: true })}
            >Confirm and forward</button>
          {:else}
            <button
              type="button"
              class="forward-btn ghost"
              data-testid="forward-files-omit"
              disabled={sending}
              onclick={() => void submit({ fileAccess: "omit" })}
            >Send without files</button>
            {#if pending.files.length > 0}
              <button
                type="button"
                class="forward-btn primary"
                data-testid="forward-files-grant"
                disabled={sending}
                onclick={() => void submit({ fileAccess: "grant" })}
              >Share and send</button>
            {/if}
          {/if}
        </div>
      </div>
    {/if}

    {#if errorView}
      <div class="forward-prompt" role="alert" data-testid="forward-error">
        <p class="forward-error" data-testid="forward-error-text">{errorView.text}</p>
        <div class="forward-actions">
          {#if errorView.alsoOmit}
            <button
              type="button"
              class="forward-btn ghost"
              data-testid="forward-error-omit"
              disabled={sending}
              onclick={() => retry({ fileAccess: "omit" })}
            >{FORWARD_ERROR_ACTION_LABEL.omit}</button>
          {/if}
          <button
            type="button"
            class="forward-btn primary"
            data-testid="forward-error-action"
            data-action={errorView.action}
            disabled={sending}
            onclick={() => runErrorAction(errorView!.action)}
          >{FORWARD_ERROR_ACTION_LABEL[errorView.action]}</button>
        </div>
      </div>
    {/if}

    <div class="forward-footer">
      <span class="forward-hint" aria-hidden="true">↑↓ move · Enter add · ⌘Enter send</span>
      <div class="forward-actions">
        <button type="button" class="forward-btn ghost" data-testid="forward-cancel" onclick={onclose}>Cancel</button>
        <button
          type="button"
          class="forward-btn primary"
          data-testid="forward-send"
          disabled={selected.length === 0 || sending}
          aria-busy={sending}
          onclick={send}
        >{sendLabel}</button>
      </div>
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
    background: rgba(0, 0, 0, 0.55);
  }

  .forward-card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: min(460px, 100%);
    max-height: min(680px, 100%);
    padding: 14px 16px 12px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.1));
    border-radius: 14px;
    background: var(--v4-surface-solid, var(--elevated, #1e1e24));
    color: var(--t1);
    box-shadow: var(--pop-shadow, 0 24px 64px rgba(0, 0, 0, 0.55));
    font: 400 13px/1.4 var(--font-ui);
    outline: none;
  }

  .forward-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .forward-title {
    margin: 0;
    font: 600 13px/1.3 var(--font-ui);
  }

  .forward-close {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t3);
    cursor: pointer;
  }

  .forward-close:hover {
    background: var(--hover, rgba(255, 255, 255, 0.06));
    color: var(--t1);
  }

  /* Quoted message: the sender's avatar, name, time and origin, then the
     first lines. A soft fill, no border and no accent bar. */
  .forward-quote {
    display: flex;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--t1) 5%, transparent);
  }

  .forward-quote-copy {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .forward-quote-meta {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }

  .forward-quote-sender {
    color: var(--t1);
    font-weight: 600;
  }

  .forward-quote-time,
  .forward-quote-origin,
  .forward-quote-artifact,
  .forward-quote-files {
    color: var(--t3, var(--t2));
    font-size: 11px;
  }

  .forward-quote-body {
    overflow: hidden;
    color: var(--t2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .forward-to {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .forward-to-label {
    flex: 0 0 auto;
    padding-top: 8px;
    color: var(--t3);
    font-size: 11px;
  }

  .forward-field-frame {
    flex: 1 1 auto;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    min-width: 0;
    min-height: 32px;
    padding: 3px 6px;
    border: 1px solid var(--v4-control-border, var(--line2, rgba(255, 255, 255, 0.12)));
    border-radius: 9px;
    background: var(--v4-control-bg, transparent);
    cursor: text;
  }

  .forward-field-frame:focus-within {
    border-color: color-mix(in srgb, var(--t1) 28%, transparent);
  }

  .forward-search {
    flex: 1 1 120px;
    min-width: 80px;
    padding: 4px 2px;
    border: 0;
    background: transparent;
    color: var(--t1);
    font: inherit;
    outline: none;
  }

  .forward-search::placeholder {
    color: var(--t3);
  }

  .forward-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    height: 22px;
    padding: 0 4px 0 8px;
    border: 0;
    border-radius: 999px;
    background: color-mix(in srgb, var(--t1) 10%, transparent);
    color: var(--t1);
    font: 500 12px/1 var(--font-ui);
  }

  .forward-chip.scope {
    padding-right: 7px;
    background: color-mix(in srgb, var(--t1) 7%, transparent);
    color: var(--t2);
    cursor: pointer;
  }

  .forward-chip.scope:hover,
  .forward-chip.scope[aria-expanded="true"] {
    color: var(--t1);
  }

  .forward-chip-name {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .forward-chip-x {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--t3);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
  }

  .forward-chip-x:hover {
    background: color-mix(in srgb, var(--t1) 12%, transparent);
    color: var(--t1);
  }

  .forward-scope {
    position: relative;
  }

  .forward-scope-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    min-width: 180px;
    padding: 4px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.1));
    border-radius: 10px;
    background: var(--v4-surface-solid, var(--elevated, #1e1e24));
    box-shadow: var(--pop-shadow, 0 12px 32px rgba(0, 0, 0, 0.45));
  }

  .forward-scope-option {
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }

  .forward-scope-option:hover,
  .forward-scope-option[aria-selected="true"] {
    background: var(--hover, rgba(255, 255, 255, 0.06));
  }

  .forward-list {
    display: flex;
    flex-direction: column;
    min-height: 96px;
    max-height: 260px;
    margin: 0 -6px;
    padding: 0 6px;
    overflow-y: auto;
  }

  .forward-section {
    display: flex;
    flex-direction: column;
  }

  .forward-section-label {
    padding: 8px 8px 3px;
    color: var(--t3);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .forward-section:first-child .forward-section-label {
    padding-top: 2px;
  }

  .forward-option {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 36px;
    padding: 5px 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .forward-option.highlight {
    background: var(--hover, color-mix(in srgb, var(--t1) 7%, transparent));
  }

  .forward-option-copy {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }

  .forward-option-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .forward-option-sub {
    overflow: hidden;
    color: var(--t3);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .forward-option-kind {
    flex: 0 0 auto;
    color: var(--t3);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .forward-option-check {
    display: grid;
    place-items: center;
    flex: 0 0 14px;
    width: 14px;
    height: 14px;
    color: var(--t1);
  }

  .forward-option.picked .forward-option-name {
    font-weight: 500;
  }

  .forward-empty {
    padding: 10px 8px;
    color: var(--t3);
  }

  .forward-note {
    padding: 7px 10px;
    border: 1px solid var(--v4-control-border, var(--line2, rgba(255, 255, 255, 0.12)));
    border-radius: 9px;
    background: var(--v4-control-bg, transparent);
    color: var(--t1);
    font: inherit;
    resize: none;
    outline: none;
  }

  .forward-note::placeholder {
    color: var(--t3);
  }

  .forward-note:focus {
    border-color: color-mix(in srgb, var(--t1) 28%, transparent);
  }

  .forward-label {
    color: var(--t2);
  }

  .forward-prompt p,
  .forward-error {
    margin: 0;
    color: var(--t2);
  }

  .forward-prompt {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .forward-file-list {
    margin: 0;
    padding-left: 18px;
    color: var(--t1);
    overflow-wrap: anywhere;
  }

  .forward-file-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .forward-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .forward-hint {
    color: var(--t3);
    font-size: 11px;
    white-space: nowrap;
  }

  .forward-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  .forward-btn {
    appearance: none;
    -webkit-appearance: none;
    height: 30px;
    padding: 0 12px;
    border: 0;
    border-radius: 9px;
    background: var(--v4-control-bg, color-mix(in srgb, var(--t1) 8%, transparent));
    color: var(--t1);
    font: 500 13px/1 var(--font-ui);
    cursor: pointer;
    transition: background 0.12s;
  }

  .forward-btn.primary {
    background: var(--t1);
    color: var(--v4-ground, var(--elevated, #151515));
  }

  .forward-btn.primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--t1) 88%, transparent);
  }

  .forward-btn.ghost {
    background: transparent;
    color: var(--t2);
  }

  .forward-btn.ghost:hover:not(:disabled) {
    background: var(--hover, color-mix(in srgb, var(--t1) 7%, transparent));
    color: var(--t1);
  }

  .forward-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>

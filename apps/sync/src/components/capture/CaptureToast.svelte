<script lang="ts" module>
  /** Events emitted by src-tauri/src/commands/capture.rs. */
  export const EVENT_SHOW = 'capture-toast:show';
  /** App-wide event; only applied when payload.id matches the shown record. */
  export const EVENT_UPDATED = 'capture:updated';
  /**
   * Native undo, emitted by the transient ⌘Z/Ctrl+Z global binding Rust arms
   * while this toast is up. The toast window is non-activating, so it is
   * never the key window and the DOM `onkeydown` below can never see ⌘Z —
   * this event is the real delivery path for the advertised shortcut.
   */
  export const EVENT_UNDO = 'capture-toast:undo';

  /** Auto-dismiss timeout (ms) after `capture-toast:show`, per the design mock. */
  export const AUTO_DISMISS_MS = 6000;
  /** How long the "Undone" confirmation stays up before the toast closes. */
  export const UNDONE_DISMISS_MS = 1200;
</script>

<script lang="ts">
  /**
   * Idea-board capture toast (hq-idea-board US-005).
   *
   * Renders inside the `capture-toast` Tauri window (see
   * src-tauri/src/commands/capture.rs). Shows what was just captured, the
   * company it was filed to, and a row of optional one-key actions: undo, add
   * a note, reassign the company, or open the board. Nothing here is a
   * confirmation step — every key is optional, and the toast auto-dismisses
   * after ~6s of no interaction (design.md FIG. 02).
   *
   * The window is non-activating by default: this component never asks Rust
   * to make it focusable except on an explicit note-edit (`N`) or a click
   * into the toast body, and always flips focusable back to false once that
   * interaction ends — so the toast never silently steals focus from
   * whatever the user was doing.
   *
   * Mountable with zero Tauri APIs (happy-dom tests). Listeners and invokes
   * only run when `__TAURI_INTERNALS__` is present. Tauri listeners tear down
   * through `safeUnlisten` (HQ-DESKTOP-39 shared teardown boundary).
   */
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { safeUnlisten } from '../../lib/listener-registry';
  import type { IdeaCapture } from '../../stores/ideaCaptures';
  import { cardTitle, kindLabel, sourceHost } from '../../desktop-alt/ideas/ideaSearch';

  type ToastPhase = 'shown' | 'undone';

  let record = $state<IdeaCapture | null>(null);
  let phase = $state<ToastPhase>('shown');
  let filedCompany = $state<string | null>(null);

  let thumbSrc = $state<string | null>(null);
  let thumbFailed = $state(false);
  /** Why the thumbnail failed — surfaced so a broken preview is never silent. */
  let thumbError = $state<string | null>(null);

  /**
   * True once the user has actually reached into the toast (clicked it, or
   * started a note), which is what makes the window focusable and therefore
   * what makes its DOM key handling reachable at all. The key hints are gated
   * on this so the toast never advertises a shortcut it cannot receive.
   */
  let engaged = $state(false);

  let noteEditing = $state(false);
  let noteValue = $state('');
  let noteInputEl = $state<HTMLInputElement | null>(null);

  let pickerOpen = $state(false);
  let companies = $state<string[]>([]);

  /**
   * Last failed write, surfaced in the toast. Every write here is a real
   * mutation of the user's vault: swallowing a rejected invoke would leave
   * the toast claiming "Undone" or "Filed to <other>" for a change that
   * never happened (the defect US-010's review found in the detail pane).
   */
  let writeError = $state<string | null>(null);

  /** True while hovered or mid-interaction — either suspends the auto-dismiss timer. */
  let hovering = false;
  let suspended = false;
  let dismissTimer: ReturnType<typeof setTimeout> | undefined;
  let undoneTimer: ReturnType<typeof setTimeout> | undefined;

  const title = $derived(record ? cardTitle(record) : '');
  const pillText = $derived.by(() => {
    if (!record) return '';
    if (record.status === 'pending') return 'Reading…';
    const label = kindLabel(record.kind);
    return record.confidence != null ? `${label} · ${record.confidence.toFixed(2)}` : label;
  });
  const provenanceText = $derived.by(() => {
    if (!record) return '';
    const host = sourceHost(record.provenance?.url) ?? record.provenance?.app ?? '';
    const time = formatTime(record.provenance?.captured_at);
    return [host, time].filter(Boolean).join(' · ');
  });

  function formatTime(iso: string | null | undefined): string {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function hasTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  function errorText(e: unknown): string {
    if (e instanceof Error) return e.message;
    return typeof e === 'string' && e.trim() !== '' ? e : 'unknown error';
  }

  function clearDismissTimer() {
    if (dismissTimer !== undefined) {
      clearTimeout(dismissTimer);
      dismissTimer = undefined;
    }
  }

  /** Arms the auto-dismiss timer unless the toast is hovered or mid-interaction. */
  function armDismissTimer() {
    clearDismissTimer();
    if (hovering || suspended) return;
    dismissTimer = setTimeout(() => {
      void dismiss();
    }, AUTO_DISMISS_MS);
  }

  function onPointerEnter() {
    hovering = true;
    clearDismissTimer();
  }

  function onPointerLeave() {
    hovering = false;
    armDismissTimer();
  }

  /** Any explicit interaction (key action, note editing, picker) pauses the timer. */
  function beginInteraction() {
    suspended = true;
    clearDismissTimer();
  }

  function endInteraction() {
    suspended = false;
    // Per spec, the timer only resumes via pointerleave — not automatically
    // the moment an interaction ends, since the pointer may still be over
    // the toast (or never was, for a keyboard-only interaction).
  }

  async function dismiss(): Promise<void> {
    // A note typed but never committed must not be silently dropped just
    // because the toast is going away (US-010 review: Escape/close discarded
    // blur-only drafts). Flush first, and abort the dismiss if it failed so
    // the error is visible.
    if (noteEditing) {
      await commitNote();
      if (writeError !== null) return;
    }
    clearDismissTimer();
    if (undoneTimer !== undefined) {
      clearTimeout(undoneTimer);
      undoneTimer = undefined;
    }
    if (hasTauri()) {
      void invoke('dismiss_capture_toast').catch(() => {});
    }
    reset();
  }

  function reset() {
    record = null;
    phase = 'shown';
    filedCompany = null;
    thumbSrc = null;
    thumbFailed = false;
    thumbError = null;
    engaged = false;
    noteEditing = false;
    noteValue = '';
    pickerOpen = false;
    companies = [];
    writeError = null;
    hovering = false;
    suspended = false;
  }

  /**
   * LIVE-CAPTURE FIX (BUG 3): the thumbnail used to go through
   * `get_authorized_file_preview`, which is gated on the DESKTOP FILES session
   * scope (`enforce_desktop_read_scope`). The toast is its own window and
   * never binds an active company, so every `companies/<slug>/ideas/<id>/
   * image.png` preview failed with "company scope not bound" — and the
   * `catch {}` below swallowed it, so the owner saw a toast with no thumbnail
   * and no explanation anywhere.
   *
   * `ideas_capture_preview` is the ideas-tree-aware command (it authorizes the
   * ideas roots directly and logs `idea.capture.thumb_failed reason=…`). The
   * frontend now also records WHY it failed so the state is never silent.
   */
  async function loadThumbnail(path: string): Promise<void> {
    if (!hasTauri()) return;
    try {
      const preview = (await invoke('ideas_capture_preview', { path })) as {
        mimeType?: string;
        dataBase64?: string;
      } | null;
      const mime = preview?.mimeType ?? '';
      const data = preview?.dataBase64 ?? '';
      if (mime && data) {
        thumbSrc = `data:${mime};base64,${data}`;
        thumbFailed = false;
        thumbError = null;
      } else {
        thumbFailed = true;
        thumbError = 'preview returned no image data';
        console.error('capture thumbnail failed:', path, thumbError);
      }
    } catch (e) {
      thumbFailed = true;
      thumbError = errorText(e);
      console.error('capture thumbnail failed:', path, thumbError);
    }
  }

  function onShow(payload: IdeaCapture) {
    reset();
    record = payload;
    filedCompany = payload.company_slug;
    armDismissTimer();
    if (payload.image_path) void loadThumbnail(payload.image_path);
  }

  function onUpdated(payload: IdeaCapture) {
    if (!record || payload.id !== record.id) return;
    record = payload;
  }

  async function setFocusable(focusable: boolean): Promise<void> {
    if (!hasTauri()) return;
    try {
      await invoke('set_capture_toast_focusable', { focusable });
    } catch {
      // Best-effort: the toast still works, just not editable this time.
    }
  }

  async function undo(): Promise<void> {
    if (!record) return;
    beginInteraction();
    const id = record.id;
    writeError = null;
    if (hasTauri()) {
      try {
        await invoke('ideas_delete_capture', { id });
      } catch (e) {
        // The record (and its PNG/sidecar) is still on disk — saying "Undone"
        // here would be a lie the user can only discover much later.
        writeError = `Couldn't undo: ${errorText(e)}`;
        return;
      }
    }
    phase = 'undone';
    undoneTimer = setTimeout(() => {
      void dismiss();
    }, UNDONE_DISMISS_MS);
  }

  async function startNoteEdit(): Promise<void> {
    if (!record || noteEditing) return;
    engaged = true;
    beginInteraction();
    await setFocusable(true);
    noteValue = record.note ?? '';
    noteEditing = true;
    queueMicrotask(() => noteInputEl?.focus());
  }

  async function commitNote(): Promise<void> {
    if (!record) return;
    const id = record.id;
    const note = noteValue;
    writeError = null;
    if (hasTauri()) {
      try {
        await invoke('ideas_set_note', { id, note });
      } catch (e) {
        // Keep the draft on screen: the text is still only in this input.
        writeError = `Couldn't save that note: ${errorText(e)}`;
        return;
      }
    }
    noteEditing = false;
    await setFocusable(false);
    endInteraction();
  }

  /**
   * Escape leaves note editing. It commits rather than discards: the toast is
   * a 6-second surface with no second chance, and US-010's review found
   * exactly this silent-discard bug in the detail pane.
   */
  async function leaveNoteEdit(): Promise<void> {
    await commitNote();
  }

  async function openPicker(): Promise<void> {
    if (!record || pickerOpen) return;
    beginInteraction();
    pickerOpen = true;
    if (hasTauri()) {
      try {
        const result = (await invoke('ideas_list_companies')) as unknown;
        const all = Array.isArray(result) ? result.filter((s): s is string => typeof s === 'string') : [];
        companies = all.filter((slug) => slug !== filedCompany);
      } catch {
        companies = [];
      }
    } else {
      companies = [];
    }
  }

  function closePicker() {
    pickerOpen = false;
    companies = [];
    endInteraction();
  }

  async function chooseCompany(toCompany: string): Promise<void> {
    if (!record) return;
    const id = record.id;
    closePicker();
    writeError = null;
    if (hasTauri()) {
      try {
        await invoke('ideas_move_capture', { id, toCompany });
      } catch (e) {
        // "Filed to" must keep naming where the record actually lives.
        writeError = `Couldn't reassign: ${errorText(e)}`;
        return;
      }
    }
    filedCompany = toCompany;
  }

  async function openBoard(): Promise<void> {
    if (!record) return;
    const id = record.id;
    writeError = null;
    if (hasTauri()) {
      try {
        await invoke('ideas_open_board', { id });
      } catch (e) {
        // Dismissing here would hide the toast without opening anything.
        writeError = `Couldn't open the board: ${errorText(e)}`;
        return;
      }
    }
    await dismiss();
  }

  function onToastClick() {
    engaged = true;
    beginInteraction();
    void setFocusable(true);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!record || phase === 'undone') return;

    if (noteEditing) {
      if (e.key === 'Enter') {
        e.preventDefault();
        void commitNote();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        void leaveNoteEdit();
      }
      // Any other key is normal typing into the note input.
      return;
    }

    if (pickerOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePicker();
      }
      return;
    }

    const meta = e.metaKey || e.ctrlKey;

    if (meta && e.altKey) {
      e.preventDefault();
      void openPicker();
      return;
    }

    if (meta && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      void undo();
      return;
    }

    if (!meta && !e.altKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      void startNoteEdit();
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      void openBoard();
    }
  }

  onMount(() => {
    if (!hasTauri()) return;
    let unlistenShow: UnlistenFn | undefined;
    let unlistenUpdated: UnlistenFn | undefined;
    let unlistenUndo: UnlistenFn | undefined;
    void listen<IdeaCapture>(EVENT_SHOW, (ev) => onShow(ev.payload)).then((fn) => {
      unlistenShow = safeUnlisten(fn);
    });
    void listen<IdeaCapture>(EVENT_UPDATED, (ev) => onUpdated(ev.payload)).then((fn) => {
      unlistenUpdated = safeUnlisten(fn);
    });
    void listen(EVENT_UNDO, () => {
      // Same guard the DOM handler applies: no record, or already undone,
      // means there is nothing to undo.
      if (!record || phase === 'undone') return;
      void undo();
    }).then((fn) => {
      unlistenUndo = safeUnlisten(fn);
    });
    void invoke('capture_toast_ready').catch(() => {});
    return () => {
      clearDismissTimer();
      if (undoneTimer !== undefined) clearTimeout(undoneTimer);
      safeUnlisten(unlistenShow)();
      safeUnlisten(unlistenUpdated)();
      safeUnlisten(unlistenUndo)();
    };
  });
</script>

<!--
  The toast owns its whole window, so a click anywhere in it is a click "into
  the toast" — listening at the window level keeps the status region a plain
  live region (no dead svelte-ignore, no a11y warning) and also catches clicks
  on the padding around the card.
-->
<svelte:window onkeydown={onKeyDown} onclick={onToastClick} />

{#if record}
  <div
    class="toast"
    data-testid="capture-toast"
    role="status"
    onpointerenter={onPointerEnter}
    onpointerleave={onPointerLeave}
  >
    {#if phase === 'undone'}
      <div class="undone" data-testid="capture-toast-undone">Undone</div>
    {:else}
      <div class="toast-top">
        <div
          class="toast-thumb"
          data-testid="capture-toast-thumb"
          data-thumb-error={thumbError ?? undefined}
        >
          {#if thumbSrc}
            <img src={thumbSrc} alt="" />
          {:else if thumbFailed}
            <span
              class="thumb-fallback"
              data-testid="capture-toast-thumb-fallback"
              title={thumbError ? `Preview unavailable: ${thumbError}` : undefined}
              aria-hidden="true"
            ></span>
          {/if}
        </div>
        <div class="toast-meta">
          <span class="type-pill" data-testid="capture-toast-pill">{pillText}</span>
          <div class="toast-title" data-testid="capture-toast-title">{title}</div>
          <div class="toast-src" data-testid="capture-toast-src">{provenanceText}</div>
        </div>
      </div>

      {#if noteEditing}
        <div class="toast-note">
          <input
            type="text"
            data-testid="capture-toast-note-input"
            bind:value={noteValue}
            bind:this={noteInputEl}
            placeholder="Add a note…"
          />
        </div>
      {:else if pickerOpen}
        <div class="toast-picker" data-testid="capture-toast-picker">
          {#each companies as company (company)}
            <button
              type="button"
              class="picker-item"
              data-testid="capture-toast-picker-item"
              data-company={company}
              onclick={(e) => {
                e.stopPropagation();
                void chooseCompany(company);
              }}
            >
              {company}
            </button>
          {/each}
        </div>
      {:else}
        <div class="toast-co">
          <span data-testid="capture-toast-filed">Filed to <span class="co">{filedCompany}</span></span>
          <span>⌘⌥ to change</span>
        </div>
      {/if}

      {#if writeError}
        <div class="toast-error" data-testid="capture-toast-error" role="alert">{writeError}</div>
      {/if}

      <!--
        HONEST AFFORDANCES. ⌘Z is always shown because Rust arms a real
        transient global binding for it while this toast is up. The bare-key
        actions (N / ⌘⌥ / ⏎) travel over the DOM handler, which only works
        once the window is focusable — so they are only advertised once the
        user has engaged the toast. Advertising them before that is the lie
        that sent the owner's ⌘Z into their editor.
      -->
      <div class="toast-keys" data-testid="capture-toast-keys" data-engaged={engaged}>
        <div class="tkey"><kbd>⌘Z</kbd>Undo</div>
        {#if engaged}
          <div class="tkey"><kbd>N</kbd>Add note</div>
          <div class="tkey"><kbd>⌘⌥</kbd>Reassign</div>
          <div class="tkey"><kbd>⏎</kbd>Open</div>
        {:else}
          <div class="tkey" data-testid="capture-toast-engage-hint">Click for note, reassign, open</div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  :global(html[data-window='capture-toast']),
  :global(html[data-window='capture-toast'] body) {
    margin: 0;
    background: transparent !important;
    overflow: hidden;
  }

  .toast {
    width: 358px;
    background: #141419;
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #fff;
  }

  .toast-top {
    display: flex;
    gap: 12px;
    padding: 14px 15px 12px;
  }

  .toast-thumb {
    width: 56px;
    height: 56px;
    flex: none;
    background: linear-gradient(140deg, #23202e, #191a22);
    border: 1px solid rgba(255, 255, 255, 0.09);
    overflow: hidden;
  }

  .toast-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .thumb-fallback {
    display: block;
    width: 100%;
    height: 100%;
  }

  .toast-meta {
    flex: 1;
    min-width: 0;
  }

  .type-pill {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.55);
  }

  .toast-title {
    font-size: 13px;
    color: #fff;
    margin-top: 8px;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .toast-src {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
    color: rgba(255, 255, 255, 0.4);
    margin-top: 6px;
    letter-spacing: 0.04em;
  }

  .toast-co {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 15px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(129, 140, 248, 0.05);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 9.5px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.55);
  }

  .toast-co .co {
    color: #818cf8;
  }

  .toast-note {
    padding: 8px 15px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }

  .toast-note input {
    width: 100%;
    box-sizing: border-box;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 4px;
    color: #fff;
    font-size: 12px;
    padding: 6px 8px;
  }

  .toast-picker {
    padding: 6px 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 140px;
    overflow-y: auto;
  }

  .picker-item {
    text-align: left;
    background: transparent;
    border: none;
    color: #fff;
    font-size: 12px;
    padding: 6px 8px;
    border-radius: 4px;
    cursor: pointer;
  }

  .picker-item:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .toast-error {
    padding: 8px 15px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 11px;
    color: #f6a5a5;
  }

  .toast-keys {
    display: flex;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }

  .tkey {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 5px;
    justify-content: center;
    padding: 8px 4px;
    font-size: 9.5px;
    color: rgba(255, 255, 255, 0.55);
  }

  .tkey kbd {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 9px;
    color: rgba(255, 255, 255, 0.8);
  }

  .undone {
    padding: 18px 15px;
    text-align: center;
    font-size: 12.5px;
    letter-spacing: 0.04em;
    color: rgba(255, 255, 255, 0.75);
  }
</style>

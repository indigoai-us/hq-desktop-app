<script lang="ts">
  /**
   * One memory entry or knowledge file from the bot's box: rendered Markdown
   * to read, a plain editor to change it, Delete with a confirm. A new entry
   * opens straight in the editor.
   */
  import type { AdapterFailure, AgentControlApi } from "@hq/platform";
  import RailIcon from "../../../common/button/RailIcon.svelte";
  import ConfirmDialog from "../../../common/ConfirmDialog.svelte";
  import ReadLoader from "../../../common/ReadLoader.svelte";
  import { renderMarkdownDocument } from "../../../common/markdown.js";
  import { markdownLinks } from "../../../common/markdown-links.js";
  import ControlDialog from "./ControlDialog.svelte";
  import {
    controlError,
    knowledgeDocFromPayload,
    memoryDocFromPayload,
    validKnowledgePath,
    type BrainDocTarget,
  } from "./agent-control-model.js";

  interface Props {
    uid: string;
    control: AgentControlApi;
    target: BrainDocTarget;
    botName: string;
    offline: boolean;
    /** The box changed: re-read the brain lists. */
    onchanged: () => Promise<void>;
    onoffline: () => void;
    onclose: () => void;
  }

  let { uid, control, target, botName, offline, onchanged, onoffline, onclose }: Props = $props();

  const isNew = $derived(target.kind === "new-memory" || target.kind === "new-knowledge");
  const isMemory = $derived(target.kind === "memory" || target.kind === "new-memory");

  // svelte-ignore state_referenced_locally
  let mode = $state<"loading" | "view" | "edit">(target.kind === "new-memory" || target.kind === "new-knowledge" ? "edit" : "loading");
  let original = $state("");
  let content = $state("");
  let newTitle = $state("");
  let newPath = $state("");
  let busy = $state<"save" | "delete" | null>(null);
  let error = $state<string | null>(null);
  let confirmDelete = $state(false);

  const heading = $derived(
    target.kind === "memory" ? target.title
    : target.kind === "knowledge" ? target.path
    : target.kind === "new-memory" ? "New memory"
    : "New knowledge file",
  );
  const dirty = $derived(mode === "edit" && (content !== original || newTitle.trim() !== "" || newPath.trim() !== ""));
  const html = $derived(mode === "view" ? renderMarkdownDocument(content) : "");
  const canSave = $derived(
    mode === "edit" &&
      !offline &&
      busy === null &&
      (target.kind === "new-knowledge"
        ? validKnowledgePath(newPath) && content.trim() !== ""
        : target.kind === "new-memory"
          ? content.trim() !== ""
          : content !== original),
  );

  function fail(res: AdapterFailure): void {
    const e = controlError(res);
    if (e.offline) onoffline();
    error = e.message;
  }

  async function read(): Promise<boolean> {
    if (target.kind === "memory") {
      const res = await control.getMemory(uid, target.id);
      if (!res.ok) {
        fail(res);
        return false;
      }
      original = content = memoryDocFromPayload(res.value, target.id).content;
      return true;
    }
    if (target.kind === "knowledge") {
      const res = await control.getKnowledge(uid, target.path);
      if (!res.ok) {
        fail(res);
        return false;
      }
      original = content = knowledgeDocFromPayload(res.value, target.path).content;
      return true;
    }
    return true;
  }

  $effect(() => {
    if (target.kind !== "memory" && target.kind !== "knowledge") return;
    let cancelled = false;
    void read().then(() => {
      if (!cancelled) mode = "view";
    });
    return () => {
      cancelled = true;
    };
  });

  async function save(): Promise<void> {
    if (!canSave) return;
    busy = "save";
    error = null;
    let res;
    if (target.kind === "memory") res = await control.updateMemory(uid, target.id, content);
    else if (target.kind === "knowledge") res = await control.putKnowledge(uid, target.path, content);
    else if (target.kind === "new-memory") res = await control.createMemory(uid, { content, ...(newTitle.trim() ? { title: newTitle.trim() } : {}) });
    else res = await control.putKnowledge(uid, newPath.trim(), content);
    if (!res.ok) {
      busy = null;
      fail(res);
      return;
    }
    await onchanged();
    if (isNew) {
      busy = null;
      onclose();
      return;
    }
    const readBack = await read();
    busy = null;
    if (!readBack) {
      error = "Saved, but the bot did not read it back. Check again in a moment.";
      return;
    }
    mode = "view";
  }

  async function remove(): Promise<void> {
    confirmDelete = false;
    if (busy) return;
    busy = "delete";
    error = null;
    const res =
      target.kind === "memory" ? await control.deleteMemory(uid, target.id)
      : target.kind === "knowledge" ? await control.deleteKnowledge(uid, target.path)
      : null;
    if (res && !res.ok) {
      busy = null;
      fail(res);
      return;
    }
    await onchanged();
    busy = null;
    onclose();
  }
</script>

<ControlDialog
  title={heading}
  subtitle="{isMemory ? 'Memory' : 'Knowledge'} · {botName}"
  wide
  {dirty}
  busy={busy !== null}
  testid="cloud-brain-dialog"
  {onclose}
>
  {#if mode === "loading"}
    <ReadLoader testid="cloud-brain-doc-loading" />
  {:else if mode === "view"}
    {#if content.trim()}
      <div class="cp-doc" data-testid="cloud-brain-doc" use:markdownLinks={{ currentPath: target.kind === "knowledge" ? target.path : "" }}>{@html html}</div>
    {:else if !error}
      <p class="cp-muted" data-testid="cloud-brain-doc-empty">This file is empty.</p>
    {/if}
  {:else}
    {#if target.kind === "new-memory"}
      <label class="cp-field">
        <span>Title</span>
        <input class="cp-input" data-autofocus data-testid="cloud-brain-title-input" bind:value={newTitle} placeholder="Optional" />
      </label>
    {:else if target.kind === "new-knowledge"}
      <label class="cp-field">
        <span>File path</span>
        <input class="cp-input cp-mono" data-autofocus data-testid="cloud-brain-path-input" bind:value={newPath} placeholder="notes/pricing.md" />
        {#if newPath.trim() && !validKnowledgePath(newPath)}<span class="cp-error">Use a relative path inside the knowledge folder.</span>{/if}
      </label>
    {/if}
    <textarea class="cp-textarea roomy" data-testid="cloud-brain-editor" bind:value={content} spellcheck="false" aria-label="Content"></textarea>
  {/if}
  {#if error}<p class="cp-error" role="alert" data-testid="cloud-brain-error">{error}</p>{/if}
  {#snippet footer()}
    {#if !isNew}
      <button type="button" class="cp-btn danger" data-testid="cloud-brain-delete" disabled={busy !== null || offline || mode === "loading"} onclick={() => (confirmDelete = true)}>
        {#if busy === "delete"}<span class="cp-spin" aria-hidden="true"></span>{:else}<RailIcon name="trash" />{/if}Delete
      </button>
    {/if}
    <span class="cp-grow"></span>
    {#if mode === "view"}
      <button type="button" class="cp-btn primary" data-testid="cloud-brain-edit" disabled={offline} onclick={() => (mode = "edit")}><RailIcon name="pencil" />Edit</button>
    {:else if mode === "edit"}
      {#if !isNew}
        <button type="button" class="cp-btn quiet" data-testid="cloud-brain-cancel-edit" disabled={busy !== null} onclick={() => { content = original; mode = "view"; error = null; }}><RailIcon name="x" />Cancel</button>
      {/if}
      <button type="button" class="cp-btn primary" data-testid="cloud-brain-save" disabled={!canSave} onclick={() => void save()}>
        {#if busy === "save"}<span class="cp-spin" aria-hidden="true"></span>{:else}<RailIcon name="save" />{/if}{isNew ? "Add" : "Save"}
      </button>
    {/if}
  {/snippet}
</ControlDialog>

<ConfirmDialog
  open={confirmDelete}
  title={isMemory ? "Delete this memory?" : "Delete this file?"}
  message="It is removed from the bot's box. This cannot be undone here."
  confirmLabel="Delete"
  danger
  onconfirm={() => void remove()}
  oncancel={() => (confirmDelete = false)}
/>

<script lang="ts">
  /**
   * Shared-folder / access-request timeline card (console-rail US-015, scene
   * home-share-request). Zero-network: Copy prompt writes the clipboard, Open
   * in Claude Code goes through the host `onopenurl` seam, and Approve / Deny
   * bubble through the lifecycle `oncardaction` seam the host already posts.
   * Grant levels are read and write only.
   */
  import type { LifecycleCardActionEvent } from "./channelMessageModels";
  import {
    accessDecisionActionId,
    levelLabel,
    shareOpenInClaudeUrl,
    sharePrompt,
    type AccessRequestState,
    type ShareGrantLevel,
    type ShareRequestCardModel,
  } from "./share-request-card";

  interface Props {
    model: ShareRequestCardModel;
    channelId?: string | null;
    /** HQ folder for the Claude Code deep link; omitted when unknown. */
    hqFolderPath?: string | null;
    onopenurl?: (url: string) => void;
    oncardaction?: (event: LifecycleCardActionEvent) => void;
  }

  let { model, channelId = "", hqFolderPath = null, onopenurl, oncardaction }: Props =
    $props();

  let copied = $state(false);
  let copyError = $state<string | null>(null);
  let chosenLevel = $state<ShareGrantLevel | null>(null);
  let decided = $state<AccessRequestState | null>(null);

  const level = $derived<ShareGrantLevel>(chosenLevel ?? model.level);
  const requestState = $derived<AccessRequestState>(
    model.kind === "access_request" ? (decided ?? model.state) : "pending",
  );

  async function copyPrompt(): Promise<void> {
    try {
      await navigator.clipboard.writeText(sharePrompt(model));
      copied = true;
      copyError = null;
      setTimeout(() => (copied = false), 1500);
    } catch (err) {
      console.error("ShareRequestCard: clipboard write failed", err);
      copyError = "Couldn't copy";
      setTimeout(() => (copyError = null), 2500);
    }
  }

  function openInClaude(): void {
    onopenurl?.(shareOpenInClaudeUrl(model, hqFolderPath));
  }

  function decide(decision: "approve" | "deny"): void {
    if (model.kind !== "access_request" || requestState !== "pending") return;
    // Paint the outcome in this frame; the host settles it with the server.
    decided = decision === "approve" ? "approved" : "denied";
    oncardaction?.({
      channelId: channelId ?? "",
      cardId: model.id,
      actionId: accessDecisionActionId(decision, level),
      values: { level, path: model.path },
    });
  }
</script>

<div
  class="share-card"
  role="group"
  aria-label={model.kind === "shared_folder" ? "Shared folder" : "Access request"}
  data-testid="share-request-card"
  data-kind={model.kind}
>
  <div class="share-k">
    {model.kind === "shared_folder" ? "Shared folder" : "Access request"}
    <span class="share-lvl" data-testid="share-request-level">{levelLabel(level)}</span>
  </div>
  <div class="share-p">{model.path}</div>
  {#if model.kind === "shared_folder" && model.files.length > 0}
    <div class="share-fl">
      {#each model.files as file (file.name)}
        <span>{file.name}{#if file.sizeLabel}<i>{file.sizeLabel}</i>{/if}</span>
      {/each}
    </div>
  {/if}
  {#if model.kind === "access_request" && model.note}
    <div class="share-d">{model.note}</div>
  {/if}
  <div class="share-act">
    {#if model.kind === "access_request" && model.canAct && requestState === "pending"}
      <div class="share-seg" role="radiogroup" aria-label="Access level">
        {#each ["read", "write"] as const as option (option)}
          <button
            type="button"
            role="radio"
            class="share-seg-btn"
            aria-checked={level === option}
            data-testid={`share-request-level-${option}`}
            onclick={() => (chosenLevel = option)}>{levelLabel(option)}</button
          >
        {/each}
      </div>
      <button
        type="button"
        class="share-btn primary"
        data-testid="share-request-approve"
        onclick={() => decide("approve")}>Approve {level}</button
      >
      <button
        type="button"
        class="share-btn"
        data-testid="share-request-deny"
        onclick={() => decide("deny")}>Deny</button
      >
    {:else}
      <button
        type="button"
        class="share-btn"
        data-testid="share-request-copy"
        onclick={() => void copyPrompt()}
        >{copyError ?? (copied ? "Copied" : "Copy prompt")}</button
      >
      <button
        type="button"
        class="share-btn"
        data-testid="share-request-open-claude"
        onclick={openInClaude}>Open in Claude Code</button
      >
    {/if}
    <span class="share-m" data-testid="share-request-meta">
      {#if model.kind === "shared_folder"}
        {model.sharedBy ? `Shared by ${model.sharedBy} · ` : ""}{level === "write"
          ? "read and write"
          : "read-only"}
      {:else if requestState === "approved"}
        {levelLabel(level)} access granted
      {:else if requestState === "denied"}
        Request denied
      {:else}
        {model.requestedBy ? `${model.requestedBy} · ` : ""}pending
      {/if}
    </span>
  </div>
</div>

<style>
  .share-card {
    margin: 6px 0 0;
    max-width: 560px;
    padding: 10px 12px;
    border: 1px solid var(--v4-hairline, var(--line));
    border-radius: 8px;
    background: var(--v4-raised, var(--raised));
    color: var(--v4-text-1, var(--t1));
  }

  .share-k {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 500;
    color: var(--v4-text-2, var(--t2));
  }

  .share-lvl {
    margin-left: auto;
    font-weight: 400;
    color: var(--v4-text-3, var(--t3));
  }

  .share-p {
    margin: 6px 0 2px;
    font-family: var(--font-mono);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .share-d {
    font-size: 13px;
    line-height: 1.45;
    color: var(--v4-text-2, var(--t2));
  }

  .share-fl {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 6px;
  }

  .share-fl span {
    display: flex;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--v4-text-2, var(--t2));
  }

  .share-fl i {
    font-style: normal;
    color: var(--v4-text-3, var(--t3));
  }

  .share-act {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 10px;
  }

  .share-m {
    margin-left: auto;
    font-size: 13px;
    color: var(--v4-text-3, var(--t3));
  }

  .share-btn,
  .share-seg-btn {
    height: var(--hq-btn-h);
    padding: 0 var(--hq-btn-pad-inline);
    border: 1px solid var(--v4-control-border);
    border-radius: 6px;
    background: var(--v4-control-faint);
    color: var(--v4-text-1, var(--t1));
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .share-btn:hover,
  .share-seg-btn:hover {
    background: var(--v4-control-bg);
  }

  .share-btn.primary {
    border-color: transparent;
    background: var(--v4-text-1, var(--t1));
    color: var(--panel-bg, var(--v4-popover));
  }

  .share-seg {
    display: inline-flex;
    gap: 2px;
  }

  .share-seg-btn {
    background: transparent;
  }

  .share-seg-btn[aria-checked="true"] {
    background: var(--v4-active-row);
  }

  .share-btn:focus-visible,
  .share-seg-btn:focus-visible {
    outline: 2px solid var(--v4-text-3, var(--t3));
    outline-offset: 1px;
  }
</style>

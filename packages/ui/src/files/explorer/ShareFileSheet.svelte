<script lang="ts">
  /**
   * Share sheet for one explorer file (QA-005). Shows the path a grant would
   * name and, while the app cannot grant access itself, a disabled Share
   * button with the reason.
   */
  import { dismissable } from "../../common/dismissable.js";
  import type { ShareTarget } from "./vault-model.js";

  interface Props {
    target: ShareTarget;
    onclose: () => void;
  }

  let { target, onclose }: Props = $props();
</script>

<div class="sf-scrim" role="presentation" onclick={onclose}></div>
<div class="sf-sheet" role="dialog" aria-modal="true" aria-label="Share" data-testid="file-share-sheet" use:dismissable={{ onclose }}>
  <header class="sf-head">
    <h2>Share</h2>
    <button type="button" class="sf-x" aria-label="Close" onclick={onclose}>✕</button>
  </header>
  <p class="sf-path" data-testid="file-share-path">{target.path}</p>
  {#if target.company}<p class="sf-meta">{target.company} vault</p>{/if}
  {#if !target.available}
    <p class="sf-reason" data-testid="file-share-unavailable">{target.reason}</p>
  {/if}
  <footer class="sf-foot">
    <button type="button" class="sf-btn" onclick={onclose}>Close</button>
    <button type="button" class="sf-btn primary" disabled={!target.available} aria-disabled={!target.available} data-testid="file-share-submit">Share</button>
  </footer>
</div>

<style>
  .sf-scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: rgba(0, 0, 0, 0.32);
  }
  .sf-sheet {
    position: fixed;
    top: 72px;
    left: 50%;
    z-index: 41;
    width: min(420px, calc(100vw - 32px));
    padding: 14px 16px;
    transform: translateX(-50%);
    border: 1px solid var(--v4-hairline);
    border-radius: 12px;
    background: var(--overlay-bg);
    box-shadow: var(--v4-shadow-popover);
    color: var(--v4-text-1);
    font-size: 13px;
  }
  .sf-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .sf-head h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }
  .sf-x {
    border: 0;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    cursor: pointer;
  }
  .sf-path {
    margin: 10px 0 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    word-break: break-all;
  }
  .sf-meta {
    margin: 2px 0 0;
    color: var(--v4-text-2);
  }
  .sf-reason {
    margin: 10px 0 0;
    color: var(--v4-text-2);
    line-height: 1.45;
  }
  .sf-foot {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 14px;
  }
  .sf-btn {
    padding: 4px 10px;
    border: 1px solid var(--v4-hairline);
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    cursor: pointer;
  }
  .sf-btn.primary {
    background: var(--v4-control-faint);
  }
  .sf-btn:disabled {
    color: var(--v4-text-2);
    cursor: default;
    opacity: 0.6;
  }
</style>

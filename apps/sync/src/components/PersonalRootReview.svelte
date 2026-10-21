<script lang="ts">
  import {
    APPROVAL_LABELS,
    APPROVAL_STEP,
    formatBytes,
    personalRootCanRetry,
    personalRootOffersAdoption,
    personalRootReasonText,
    type PersonalRootView,
  } from '../lib/personal-root';

  interface Props {
    view: PersonalRootView;
    busy?: boolean;
    error?: string | null;
    /** Ask the wrapper for the adoption plan. */
    onreview: () => void;
    /** Approve exactly the next phase of the plan on screen. */
    onapprove: () => void;
    /** Only offered for busy and authority_unavailable. */
    onretry?: () => void;
  }

  let { view, busy = false, error = null, onreview, onapprove, onretry }: Props = $props();

  const offersAdoption = $derived(personalRootOffersAdoption(view));
  const reasonText = $derived(personalRootReasonText(view.reason));
  const title = $derived(
    view.phase === 'resume_authorized'
      ? 'Personal sync is ready'
      : view.reason === 'owner_mismatch'
        ? 'This folder belongs to another account'
        : offersAdoption
          ? 'Review this folder before HQ syncs it'
          : 'HQ stopped setting up this folder',
  );
</script>

<section
  class="personal-root-review"
  data-testid="personal-root-review"
  data-phase={view.phase}
  aria-labelledby="personal-root-review-title"
>
  <h3 id="personal-root-review-title" class="title">{title}</h3>
  {#if view.rootPath}
    <p class="path" aria-label="Folder">{view.rootPath}</p>
  {/if}

  {#if view.phase === 'adoption_review' && !view.reason && !view.plan}
    <p class="body">
      {personalRootReasonText('adoption_required')}
    </p>
  {/if}
  {#if reasonText}
    <p class="body" data-testid="personal-root-reason" role="status">{reasonText}</p>
  {/if}

  {#if view.plan && offersAdoption}
    {@const plan = view.plan}
    <dl class="plan" data-testid="personal-root-plan">
      <dt>Files in the folder</dt>
      <dd>{plan.fileCount} ({formatBytes(plan.byteCount)})</dd>
      <dt>Files HQ would upload</dt>
      <dd>{plan.uploadCount} ({formatBytes(plan.uploadBytes)})</dd>
      <dt>Kept only on this computer</dt>
      <dd>{plan.preservedOnlyTotal}</dd>
      <dt>Uploads to</dt>
      <dd>{plan.destinationBucket} ({plan.destinationRegion}), account {plan.destinationUid}</dd>
      {#if plan.historicalUids.length > 0}
        <dt>Earlier accounts seen in this folder</dt>
        <dd>{plan.historicalUids.join(', ')}</dd>
      {/if}
    </dl>
    {#if plan.preservedOnly.length > 0}
      <ul class="kept" aria-label="Kept only on this computer">
        {#each plan.preservedOnly as entry (entry.key)}
          <li><span class="key">{entry.key}</span> <span class="why">{entry.reason}</span></li>
        {/each}
      </ul>
      {#if plan.preservedOnlyTotal > plan.preservedOnly.length}
        <p class="more">and {plan.preservedOnlyTotal - plan.preservedOnly.length} more</p>
      {/if}
    {/if}
    <p class="note">
      HQ never deletes or overwrites files during this review. Each step needs your approval.
    </p>
  {/if}

  {#if error}
    <p class="body error" role="alert">{error}</p>
  {/if}

  <div class="actions">
    {#if offersAdoption && view.phase === 'adoption_review' && !view.plan}
      <button
        type="button"
        class="primary"
        data-testid="personal-root-review-plan"
        disabled={busy}
        onclick={onreview}
      >Review this folder</button>
    {:else if offersAdoption && view.nextPhase && view.plan}
      <button
        type="button"
        class="primary"
        data-testid="personal-root-approve"
        data-next-phase={view.nextPhase}
        disabled={busy}
        onclick={onapprove}
      >Step {APPROVAL_STEP[view.nextPhase]} of 4: {APPROVAL_LABELS[view.nextPhase]}</button>
    {/if}
    {#if personalRootCanRetry(view) && onretry}
      <button
        type="button"
        data-testid="personal-root-retry"
        disabled={busy}
        onclick={onretry}
      >Try again</button>
    {/if}
  </div>
</section>

<style>
  .personal-root-review {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;
    line-height: 1.45;
  }

  .title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }

  .path,
  .key {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .path {
    margin: 0;
    opacity: 0.8;
  }

  .body,
  .note,
  .more {
    margin: 0;
  }

  .error {
    color: var(--danger, #c0392b);
  }

  .plan {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 12px;
    margin: 0;
  }

  .plan dt {
    opacity: 0.75;
  }

  .plan dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .kept {
    max-height: 20vh;
    margin: 0;
    padding: 6px 10px;
    overflow-y: auto;
    list-style: none;
    border-radius: 8px;
    background: color-mix(in srgb, currentColor 6%, transparent);
  }

  .why {
    opacity: 0.7;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .actions button {
    padding: 6px 14px;
    border-radius: 8px;
    border: 1px solid currentColor;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .actions .primary {
    border-color: transparent;
    background: var(--accent, #2563eb);
    color: var(--accent-contrast, #fff);
  }

  .actions button:disabled {
    cursor: default;
    opacity: 0.6;
  }
</style>

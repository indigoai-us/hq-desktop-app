<script lang="ts">
  import { open as openExternal } from '@tauri-apps/plugin-shell';
  import type { ActiveMeeting } from '../../lib/activeMeetings';
  import type { RecordingMembership } from '../../lib/recordingCompany';
  import { humanCompanyLabel } from '../../lib/visible-labels';
  import '../v4/tokens.css';

  interface Props {
    meeting: ActiveMeeting | null;
    memberships?: RecordingMembership[];
    onstart: (windowId: string) => void;
    onstop: (windowId: string) => void;
    oncompany?: (windowId: string, companyUid: string | null) => void;
  }

  let { meeting, memberships = [], onstart, onstop, oncompany }: Props = $props();

  const isRecording = $derived(meeting?.state === 'recording' || meeting?.state === 'stopping');
  const isBusy = $derived(meeting?.state === 'starting' || meeting?.state === 'stopping');
  const title = $derived(meeting?.summary || platformLabel(meeting?.platform) || 'Detected meeting');
  const stateLabel = $derived(meeting ? labelForState(meeting.state) : 'Standing by');
  // Only real join URLs are linkable; recall detections carry a synthetic
  // `recall-window:` URI that can't open in a browser.
  const joinUrl = $derived(
    meeting?.meetingUrl && !meeting.meetingUrl.startsWith('recall-window:')
      ? meeting.meetingUrl
      : null,
  );
  const detectedLabel = $derived(meeting ? relativeFromNow(meeting.detectedAt) : '');
  // The per-meeting recording-company picker only makes sense for live
  // detections the user can attribute. Scheduled-bot rows carry baked
  // attribution from the calendar event, so they get no picker.
  const showCompanyPicker = $derived(!!meeting && !meeting.windowId.startsWith('scheduled-bot:'));

  function platformLabel(platform?: string): string {
    if (!platform) return '';
    if (platform === 'meet') return 'Google Meet';
    return platform.charAt(0).toUpperCase() + platform.slice(1);
  }

  function labelForState(state: ActiveMeeting['state']): string {
    switch (state) {
      case 'starting':
        return 'Starting';
      case 'recording':
        return 'Recording';
      case 'stopping':
        return 'Stopping';
      case 'error':
        return 'Needs attention';
      case 'detected':
      default:
        return 'Detected';
    }
  }

  function relativeFromNow(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    return `${hrs}h ago`;
  }

  function join(): void {
    if (joinUrl) void openExternal(joinUrl);
  }
</script>

{#snippet iconVideo(size: number)}
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m22 8-6 4 6 4Z" />
    <rect x="2" y="6" width="14" height="12" rx="2" />
  </svg>
{/snippet}

{#if meeting}
  <!-- True live monitor — rounded discrete payload when a detection is active. -->
  <section class="card live" aria-labelledby="live-now-title" data-testid="meetings-live-now">
    <div class="card-header">
      <h3 id="live-now-title" class="live-title">&#9679; Live now</h3>
      {#if detectedLabel}<span>started {detectedLabel}</span>{/if}
    </div>
    <div class="card-body">
      <div class="live-main">
        <span class="live-icon" class:recording={meeting.state === 'recording'}>
          {@render iconVideo(18)}
        </span>
        <div class="live-copy">
          <div class="live-name">{title}</div>
          <div class="live-sub">{platformLabel(meeting.platform) || 'Meeting app'} · {stateLabel}</div>
        </div>
      </div>

      {#if meeting.error}
        <p class="live-error" role="status">{meeting.error}</p>
      {/if}

      {#if showCompanyPicker && oncompany}
        <div class="live-company">
          <label class="lc-label" for="live-company-select">Record as</label>
          <select
            id="live-company-select"
            class="lc-select"
            value={meeting.companyUid ?? ''}
            onchange={(e) => oncompany(meeting.windowId, (e.currentTarget as HTMLSelectElement).value || null)}
            disabled={isBusy}
          >
            <option value="">Personal</option>
            {#each memberships as m (m.companyUid)}
              <option value={m.companyUid}>{humanCompanyLabel(m)}</option>
            {/each}
          </select>
        </div>
      {/if}

      <div class="live-actions detail-primary-actions">
        {#if isRecording}
          <button type="button" class="btn" onclick={() => onstop(meeting.windowId)} disabled={isBusy}>
            {meeting.state === 'stopping' ? 'Stopping' : 'Stop recording'}
          </button>
        {:else}
          <button type="button" class="btn primary" onclick={() => onstart(meeting.windowId)} disabled={isBusy}>
            {meeting.state === 'starting' ? 'Starting' : 'Start recording'}
          </button>
        {/if}
        {#if joinUrl}
          <button type="button" class="btn" onclick={join}>
            <span class="btn-icon">{@render iconVideo(13)}</span>
            Join
          </button>
        {/if}
      </div>
    </div>
  </section>
{:else}
  <!-- Calm standing-by — hairline strip, no decorative empty card. -->
  <section class="standby" aria-labelledby="live-now-title" data-testid="meetings-live-now">
    <h3 id="live-now-title">Live now</h3>
    <p class="empty-copy">No active meeting window has been detected.</p>
  </section>
{/if}

<style>
  /* Live monitor — rounded container reserved for a true live detection. */
  .card {
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-field);
    background: var(--v4-raised);
  }
  .card.live {
    border-color: var(--v4-control-border);
  }
  .card-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--v4-rowline);
    background: transparent;
  }
  .card-header h3 {
    margin: 0;
    color: var(--v4-text-2);
    font-size: var(--type-body, 12px);
    font-weight: 600;
    line-height: 16px;
  }
  .card-header h3.live-title {
    color: var(--v4-ok);
  }
  .card-header > span {
    flex: 0 0 auto;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    line-height: 14px;
  }
  .card-body {
    padding: 12px;
  }
  .live-main {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .live-icon {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    color: var(--v4-text-2);
  }
  .live-icon.recording {
    border-color: var(--v4-control-border);
    color: var(--v4-ok);
  }
  .live-copy {
    min-width: 0;
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
  }
  .live-name {
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: var(--type-body, 12px);
    font-weight: 600;
    line-height: 16px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .live-sub {
    overflow: hidden;
    color: var(--v4-text-2);
    font-size: var(--type-secondary, 11px);
    line-height: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .live-error {
    margin: 10px 0 0;
    color: var(--v4-error);
    font-size: var(--type-secondary, 11px);
    line-height: 16px;
  }
  .live-company {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
  }
  .lc-label {
    flex: 0 0 auto;
    color: var(--v4-text-2);
    font-size: var(--type-secondary, 11px);
    font-weight: 600;
    line-height: 16px;
  }
  .lc-select {
    min-width: 0;
    flex: 1 1 auto;
    padding: 5px 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-field);
    background: var(--v4-raised);
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--type-body, 12px);
    line-height: 16px;
    cursor: pointer;
  }
  .lc-select:hover:not(:disabled) {
    border-color: var(--v4-control-border);
  }
  .lc-select:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }
  .lc-select:disabled {
    opacity: 0.56;
    cursor: default;
  }
  .live-actions,
  .detail-primary-actions {
    display: flex;
    flex: 0 0 auto;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }

  /* Calm standing-by — naked hairline strip. */
  .standby {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: baseline;
    gap: 12px;
    padding: 8px 0;
    border-top: 1px solid var(--v4-rowline);
    border-bottom: 1px solid var(--v4-rowline);
    border-radius: 0;
    background: transparent;
  }
  .standby h3 {
    margin: 0;
    color: var(--v4-text-3);
    font-size: var(--type-body, 12px);
    font-weight: 600;
    line-height: 16px;
  }
  .empty-copy {
    margin: 0;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
    line-height: 16px;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    padding: 6px 12px;
    border: 1px solid var(--v4-control-border);
    border-radius: var(--v4-radius-button);
    background: var(--v4-secondary-bg);
    color: var(--v4-secondary-fg);
    font: inherit;
    font-size: var(--type-body, 12px);
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
    transition: background 140ms cubic-bezier(.2,.7,.2,1), border-color 140ms cubic-bezier(.2,.7,.2,1), opacity 140ms cubic-bezier(.2,.7,.2,1);
  }
  .btn:hover:not(:disabled) {
    border-color: var(--v4-control-border);
    background: var(--v4-active-row);
  }
  .btn:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }
  .btn:disabled {
    opacity: 0.56;
    cursor: default;
  }
  .btn.primary {
    border-color: transparent;
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
  }
  .btn.primary:hover:not(:disabled) {
    border-color: transparent;
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
  }
  .btn-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
  }

  @media (prefers-reduced-motion: reduce) {
    .btn {
      transition: none;
    }
  }
</style>

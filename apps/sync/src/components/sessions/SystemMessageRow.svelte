<script lang="ts">
  // US-025: quiet system event row (joins, renames) with a centered gutter
  // glyph so it aligns with the message grid without reading as a message.
  import { formatTime } from './session-types';
  import type { WsMessage } from './session-types';

  interface Props {
    message: WsMessage;
  }

  let { message }: Props = $props();
</script>

<div class="ws-system-row" data-testid="ws-system-row">
  <span class="glyph" aria-hidden="true">
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M6 1.5v9M1.5 6h9"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linecap="round"
      />
    </svg>
  </span>
  <span class="body">{message.body}</span>
  <span class="time">{formatTime(message.createdAt)}</span>
</div>

<style>
  .ws-system-row {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    min-height: var(--v4-row-h);
    padding: 2px var(--v4-space-4);
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
  }

  .glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 28px;
    color: var(--v4-idle);
  }

  .body {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .time {
    flex: none;
    font-size: 11px;
    color: var(--v4-idle);
  }
</style>

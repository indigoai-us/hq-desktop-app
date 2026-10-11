<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  /** 36 px offline strip (console-rail US-016, scene home-offline). */
  interface Props {
    lastSynced?: string | null;
    conflictCount?: number;
    onresolve?: () => void;
    ondismiss?: () => void;
  }
  let { lastSynced = null, conflictCount = 0, onresolve, ondismiss }: Props = $props();
  const conflicts = $derived(
    conflictCount > 0 ? `${conflictCount} conflict${conflictCount === 1 ? "" : "s"}` : "no conflicts",
  );
</script>

<div class="offl" data-testid="home-offline-banner" role="status">
  <i class="dot" aria-hidden="true"></i>
  <span class="t"><b>Offline</b> · last synced {lastSynced || "just now"} · {conflicts}</span>
  <span class="s">Messages you send stay on this Mac and go out in order when the connection returns.</span>
  <span class="grow"></span>
  <button type="button" data-testid="offline-resolve" onclick={() => onresolve?.()}><RailIcon name="check" />Resolve</button>
  <button type="button" class="x" data-testid="offline-dismiss" aria-label="Dismiss offline banner" onclick={() => ondismiss?.()}><RailIcon name="x" size={14} /></button>
</div>

<style>
  .offl {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 12px 0 20px;
    height: 36px;
    border-bottom: 1px solid var(--v4-rowline);
    background: var(--v4-control-faint);
    font-size: 12px;
    color: var(--v4-text-2);
    flex: none;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--v4-idle);
    flex: none;
  }
  .t b { font-weight: 600; color: var(--v4-text-1); }
  .s { color: var(--v4-text-3); }
  .grow { flex: 1; }
  button {
    font: inherit;
    font-size: 12px;
    padding: 3px 9px;
    border-radius: 6px;
    border: 1px solid var(--v4-control-border);
    background: transparent;
    color: var(--v4-text-1);
    cursor: pointer;
  }
  .x {
    display: inline-grid;
    place-items: center;
  }
</style>

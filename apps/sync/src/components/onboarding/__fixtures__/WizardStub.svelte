<script lang="ts">
  // The real wizard drags in Tauri, telemetry and the network. These tests only
  // ask what Onboarding hands it and what Onboarding does around it.
  let {
    mode = 'onboarding',
    initialStep = 0,
    onfinish,
  }: { mode?: string; initialStep?: number; onfinish?: () => void | Promise<void> } = $props();
</script>

<div data-testid="wizard-stub" data-mode={mode} data-initial-step={initialStep}>
  wizard
  <button type="button" data-testid="wizard-stub-finish" onclick={() => void onfinish?.()}>finish</button>
</div>

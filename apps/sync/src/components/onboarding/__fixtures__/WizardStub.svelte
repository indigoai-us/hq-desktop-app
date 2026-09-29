<script lang="ts">
  // The real wizard drags in Tauri, telemetry and the network. This test only
  // asks whether the wizard is what replaced the failed film.
  let { mode = 'onboarding', initialStep = 0 }: { mode?: string; initialStep?: number } = $props();
</script>

<div data-testid="wizard-stub" data-mode={mode} data-initial-step={initialStep}>wizard</div>

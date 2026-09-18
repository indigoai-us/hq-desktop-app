<script lang="ts">
  // The real wizard drags in Tauri, telemetry and the network. This test only
  // asks whether the wizard is what replaced the failed film.
  let { mode = 'onboarding' }: { mode?: string } = $props();
</script>

<div data-testid="wizard-stub" data-mode={mode}>wizard</div>

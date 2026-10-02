<script lang="ts">
  // The real wizard drags in Tauri, telemetry and the network. These tests only
  // ask what Onboarding hands it and what Onboarding does around it.
  let {
    mode = 'onboarding',
    initialStep = 0,
    recoveringMissingRoot = false,
    onfinish,
    wallpaper = null,
  }: {
    mode?: string;
    initialStep?: number;
    recoveringMissingRoot?: boolean;
    onfinish?: () => void | Promise<void>;
    wallpaper?: string | null;
  } = $props();
</script>

<div
  data-testid="wizard-stub"
  data-mode={mode}
  data-initial-step={initialStep}
  data-recovering-missing-root={recoveringMissingRoot ? 'true' : 'false'}
  data-wallpaper={wallpaper ?? ''}
>
  wizard
  <button type="button" data-testid="wizard-stub-finish" onclick={() => void onfinish?.()}>finish</button>
</div>

<script lang="ts">
  import type { PlatformAdapter } from "@hq/platform";
  import ShellSettings, { type ShellSettingsProfile } from "./ShellSettings.svelte";

  interface Props {
    profile: ShellSettingsProfile;
    adapter: PlatformAdapter;
  }

  let { profile, adapter }: Props = $props();
  let generation = $state(1);

  export function switchSession(): void {
    generation += 1;
  }
</script>

<ShellSettings {profile} {adapter} sessionGeneration={generation} />

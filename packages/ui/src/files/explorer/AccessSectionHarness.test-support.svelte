<script lang="ts">
  /** Test harness: lets a test move the Access section's focus. */
  import AccessSection from "./AccessSection.svelte";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let { initial, ctl }: { initial: Record<string, any>; ctl: { setPath?: (p: string) => void } } = $props();
  // svelte-ignore state_referenced_locally
  let path = $state<string>(initial.path);
  ctl.setPath = (p: string) => (path = p);
</script>

<AccessSection vault={initial.vault} isDir={initial.isDir} companyUid={initial.companyUid} readTree={initial.readTree} debounceMs={initial.debounceMs} {path} />

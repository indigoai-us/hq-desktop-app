<script lang="ts">
  let {
    slug,
    cloudBacked = false,
    connectionIssue = false,
    syncEnabled = true,
  }: {
    slug: string;
    cloudBacked?: boolean;
    connectionIssue?: boolean;
    syncEnabled?: boolean;
  } = $props();

  const resourcesEnabled = $derived(
    cloudBacked && !connectionIssue && syncEnabled,
  );
</script>

<section
  data-testid="board-state"
  data-slug={slug}
  data-cloud-backed={String(cloudBacked)}
  data-board-enabled={String(resourcesEnabled)}
  data-summary-enabled={String(resourcesEnabled)}
>
  {cloudBacked ? "cloud connected" : "local only"}
</section>

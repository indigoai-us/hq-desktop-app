<script lang="ts">
  import WorkShell from "../lib/WorkShell.svelte";

  let accountId = $state<string | null>(null);
  let generation = $state(0);

  export function establishTenant(
    nextAccountId: string | null,
    nextGeneration: number,
  ): void {
    accountId = nextAccountId;
    generation = nextGeneration;
  }
</script>

<WorkShell
  data={{ user: null }}
  runtimeKind="desktop"
  hostIdentity={{ sub: "prs_embedded" }}
  hostTenantAccountId={accountId}
  hostTenantGeneration={generation}
/>

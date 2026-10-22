<script lang="ts">
  /**
   * Fixture preview for the dev harness. Screen names match COMPANY_OUTPOST_SCREENS.
   */
  import CompanyOutpostPage from "./CompanyOutpostPage.svelte";
  import { companyOutpostPreview, FIXTURE_NOW } from "./company-outpost.fixture.js";

  let { screen = "admin-list" }: { screen?: string } = $props();
  const preview = $derived(companyOutpostPreview(screen));
</script>

<div class="stage" data-testid="company-outpost-preview" data-preview={screen}>
  {#key screen}
    <CompanyOutpostPage
      companyUid="cmp_indigo"
      role={preview.role}
      client={preview.client}
      now={FIXTURE_NOW}
      pollMs={null}
      initialScreen={preview.initialScreen}
      initialOutpostId={preview.initialOutpostId ?? ""}
      initialJobId={preview.initialJobId ?? ""}
      initialNotice={preview.initialNotice ?? ""}
    />
  {/key}
</div>

<style>
  .stage {
    min-height: 100vh;
    background: var(--page-bg, #fff);
  }
</style>

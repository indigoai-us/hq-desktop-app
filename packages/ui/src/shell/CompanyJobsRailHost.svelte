<script lang="ts">
  /**
   * Rail mount for company Outpost jobs (route outpost-jobs).
   * The loader is the first frame. The page loads through the lazy door.
   */
  import { onMount } from "svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import { loadCompanyJobs } from "./company-jobs-lazy.js";
  import type { CompanyJobsApi, CompanyJobsContact } from "../outpost/company-jobs-client.js";
  import type { CompanyJobRole } from "../outpost/company-jobs-model.js";

  interface Props {
    companyUid?: string | null;
    outpostId?: string | null;
    role?: CompanyJobRole;
    api?: CompanyJobsApi | null;
    contact?: CompanyJobsContact | null;
  }

  let { companyUid = null, outpostId = null, role = "unknown", api = null, contact = null }: Props = $props();

  let Body = $state<typeof import("../outpost/CompanyJobsPage.svelte").default | null>(null);

  onMount(() => {
    void loadCompanyJobs().then((mod) => {
      Body = mod.default;
    });
  });
</script>

<div class="host" data-testid="company-jobs-rail-host">
  {#if Body}
    {#key companyUid}
    <Body {companyUid} {outpostId} {role} {api} {contact} />
  {/key}
  {:else}
    <div class="loading" aria-busy="true">
      <ReadLoader testid="company-jobs-host-loader" />
    </div>
  {/if}
</div>

<style>
  .host { height: 100%; min-height: 0; }
  .loading { padding: 16px; }
</style>

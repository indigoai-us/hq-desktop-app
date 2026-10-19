<script lang="ts">
  /**
   * Test harness: keeps one CompanyJobsPage mounted while the company changes,
   * the way the rail reuses the page, so a test can check per-company state.
   */
  import CompanyJobsPage from "./CompanyJobsPage.svelte";
  import type { CompanyJobsApi, CompanyJobsClient, CompanyJobsContact } from "./company-jobs-client.js";
  import type { CompanyJobRole } from "./company-jobs-model.js";

  interface Props {
    companies: string[];
    role: CompanyJobRole;
    client: CompanyJobsClient;
    api: CompanyJobsApi;
    contact?: CompanyJobsContact | null;
    now: number;
  }

  let { companies, role, client, api, contact = null, now }: Props = $props();
  let index = $state(0);
</script>

<button type="button" data-testid="harness-next-company" onclick={() => (index = (index + 1) % companies.length)}>next</button>
<CompanyJobsPage companyUid={companies[index]} {role} {client} {api} {contact} {now} />

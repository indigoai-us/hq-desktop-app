<script lang="ts">
  /**
   * Test-only host: the suggested apps with a company the test can change
   * while mounted, the way the shell swaps in a company created from the
   * report.
   */
  import BriefSuggestedApps from "./BriefSuggestedApps.svelte";
  import type { FoundAppsResult } from "../chat/first-run/found-apps.js";
  import type { YourAppsHost } from "../chat/first-run/your-apps-host.js";
  import type { WelcomeConnectMemory } from "./welcome-ai-apps.js";

  type Company = { uid: string; name: string } | null;
  interface Props {
    scan: FoundAppsResult;
    host: YourAppsHost;
    company?: Company;
    onnewcompany?: () => Promise<string | null>;
    memory?: WelcomeConnectMemory;
    control: { setCompany?: (next: Company) => void };
  }
  let { scan, host, company: initial = null, onnewcompany, memory, control }: Props = $props();

  // svelte-ignore state_referenced_locally
  let company = $state<Company>(initial);
  // svelte-ignore state_referenced_locally
  control.setCompany = (next) => (company = next);
</script>

<BriefSuggestedApps {scan} suggest={{ host, company, onnewcompany, memory }} />

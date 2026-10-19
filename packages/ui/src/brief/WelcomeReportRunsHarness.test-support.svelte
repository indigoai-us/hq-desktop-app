<script lang="ts">
  /**
   * Test-only host: the welcome report around the real brief runs page, the
   * way the shell nests them, so a test sees what a person with companies
   * gets after the rise.
   */
  import WelcomeReport from "./WelcomeReport.svelte";
  import BriefRunsPage from "./BriefRunsPage.svelte";
  import type { BriefSweepSource } from "./brief-data.js";

  interface Props {
    source: BriefSweepSource;
    companies: { uid: string; slug?: string | null; label: string }[];
    report: Record<string, unknown>;
    /** Extra brief page props (onconnectcompany, onlaunch). */
    page?: Record<string, unknown>;
  }
  let { source, companies, report, page = {} }: Props = $props();
</script>

<WelcomeReport ready {...report}>
  <BriefRunsPage adapter={{}} {source} {companies} {...page} />
</WelcomeReport>

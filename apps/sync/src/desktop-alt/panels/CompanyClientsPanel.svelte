<script lang="ts">
  /** Company Clients workspace, fixed to companies/<slug>/clients. */
  import CompanyScopedFilesPanel from './CompanyScopedFilesPanel.svelte';

  interface Props {
    slug: string;
  }

  let { slug }: Props = $props();
</script>

<CompanyScopedFilesPanel {slug} directory="clients" />

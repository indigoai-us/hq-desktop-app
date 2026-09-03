<script lang="ts">
  /**
   * Desktop-alt Atlas host (US-016).
   *
   * Gates on `desktop_alt_enabled` (same GA gate as other desktop-alt
   * surfaces / meetings_feature_enabled → desktop_features_enabled) and
   * renders the shared @hq/ui AtlasPage against the active company.
   */
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { AtlasPage as SharedAtlasPage } from '@hq/ui';
  import type { LiveReadResponse } from '@hq/core';

  interface Props {
    companyUid: string;
    companyLabel?: string | null;
    /** Test / harness override — skips the Tauri gate when set. */
    featureEnabled?: boolean | null;
    live?: LiveReadResponse | null;
    getJson?: ((path: string) => Promise<unknown>) | null;
    onback?: () => void;
  }

  let {
    companyUid,
    companyLabel = null,
    featureEnabled = null,
    live = null,
    getJson = null,
    onback,
  }: Props = $props();

  let gate = $state<boolean | null>(featureEnabled);

  onMount(() => {
    if (featureEnabled != null) {
      gate = featureEnabled;
      return;
    }
    let cancelled = false;
    // Same GA gate as Meetings / desktop-alt surfaces.
    void invoke<boolean>('desktop_alt_enabled')
      .then((enabled) => {
        if (!cancelled) gate = enabled;
      })
      .catch(() => {
        if (!cancelled) gate = false;
      });
    return () => {
      cancelled = true;
    };
  });
</script>

<SharedAtlasPage
  {companyUid}
  {companyLabel}
  {live}
  {getJson}
  featureEnabled={gate}
  {onback}
  headerVariant="window"
/>

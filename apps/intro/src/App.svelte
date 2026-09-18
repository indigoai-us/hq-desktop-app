<script lang="ts">
  /**
   * The standalone welcome-intro preview. One transparent full-screen window
   * with native frosted material behind it, the same CinematicIntro the
   * shipped app plays on first run, and nothing else. Finishing or skipping
   * the film closes the app.
   */
  import { invoke } from '@tauri-apps/api/core';
  import CinematicIntro from '../../sync/src/components/onboarding/CinematicIntro.svelte';

  async function finish() {
    try {
      await invoke('intro_finished');
    } catch (err) {
      // Browser preview (no Tauri): nothing to quit.
      console.warn('intro preview: not running under Tauri, reloading instead', err);
      window.location.reload();
    }
  }
</script>

<CinematicIntro onfinish={finish} />

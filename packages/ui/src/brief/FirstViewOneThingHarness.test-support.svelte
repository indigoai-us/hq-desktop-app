<script lang="ts">
  /**
   * Test-only host for FirstViewOneThing. DailyBrief provides the BriefState
   * context (engine, launch seam) through a module-private key, so the card
   * cannot be mounted alone; this probe provides the same state and renders
   * the card, nothing else.
   */
  import FirstViewOneThing from "./FirstViewOneThing.svelte";
  import { BriefState, provideBrief, type BriefLaunch } from "./brief-context.svelte.js";
  import type { WelcomeAction } from "./brief-welcome-contract.js";

  interface Props {
    action: WelcomeAction;
    onaction?: ((action: WelcomeAction) => void) | null;
    actionLabel?: string | null;
    onlaunch?: BriefLaunch;
    busy?: boolean;
  }
  let { action, onaction = null, actionLabel = null, onlaunch = async () => null, busy = false }: Props = $props();

  provideBrief(new BriefState((engine, prompt) => onlaunch(engine, prompt), () => []));
</script>

<div class="daily-brief">
  <FirstViewOneThing {action} {onaction} {actionLabel} {busy} />
</div>

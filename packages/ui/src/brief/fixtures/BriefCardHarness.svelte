<script lang="ts">
  /**
   * Test harness for one brief card. Cards read the shared BriefState from
   * context, which only DailyBrief provides; this provides the same context
   * and renders the card with its props so a test can mount it alone.
   */
  import { untrack, type Component } from "svelte";
  import { provideBrief, type BriefState } from "../brief-context.svelte.js";

  interface Props {
    state: BriefState;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    card: Component<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    props: Record<string, any>;
  }

  let { state, card, props }: Props = $props();
  // Context is set once at init, as DailyBrief does; the initial state is the one meant.
  provideBrief(untrack(() => state));
  const Card = $derived(card);
</script>

<Card {...props} />

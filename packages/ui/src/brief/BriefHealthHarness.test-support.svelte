<script lang="ts">
  /**
   * Test harness: mounts one of the health cards (BriefIncident, BriefRisk,
   * BriefPriorities) inside a brief context with the peek card, the way
   * DailyBrief does, so a test can pass the new props and hover rows.
   */
  import BriefIncident from "./BriefIncident.svelte";
  import BriefPeek from "./BriefPeek.svelte";
  import BriefPriorities from "./BriefPriorities.svelte";
  import BriefRisk from "./BriefRisk.svelte";
  import { BriefState, provideBrief, type BriefCompanyLogo, type BriefLaunch } from "./brief-context.svelte.js";
  import type { BriefDecision, BriefMainHealth, BriefPriority, BriefRisk as Risk } from "./brief-types.js";

  interface Props {
    card: "incident" | "risk" | "priorities";
    risks?: Risk[];
    prompts?: Record<string, string>;
    rows?: number;
    cols?: number;
    now?: string;
    mainHealth?: BriefMainHealth[] | null;
    priorities?: BriefPriority[];
    decisions?: BriefDecision[];
    companies?: BriefCompanyLogo[];
    onlaunch?: BriefLaunch;
  }

  let {
    card,
    risks = [],
    prompts = {},
    rows = 1,
    cols = 1,
    now = "2026-10-11T14:54:00.000Z",
    mainHealth = null,
    priorities = [],
    decisions = [],
    companies = [],
    onlaunch = async () => null,
  }: Props = $props();
  const state = new BriefState((engine, prompt) => onlaunch(engine, prompt), () => companies);
  provideBrief(state);
</script>

<div class="daily-brief">
  {#if card === "incident" && risks[0]}
    <BriefIncident risk={risks[0]} prompt={prompts[risks[0].id]} {rows} {now} incidents={risks} {prompts} />
  {:else if card === "risk"}
    <BriefRisk {risks} {prompts} {rows} {cols} {mainHealth} {now} />
  {:else if card === "priorities"}
    <BriefPriorities {priorities} {decisions} {risks} {prompts} {now} />
  {/if}
  <BriefPeek />
</div>

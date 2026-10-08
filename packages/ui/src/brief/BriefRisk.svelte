<script lang="ts">
  /** A standing risk worth watching. */
  import BriefOrigin from "./BriefOrigin.svelte";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import type { BriefRisk } from "./brief-types.js";

  let { risk, prompt }: { risk: BriefRisk; prompt: string | undefined } = $props();
  const brief = useBrief();
</script>

<div
  class="w"
  data-testid="brief-risk"
  role="group"
  aria-label={risk.title}
  use:peek={{ state: brief, content: () => ({ title: risk.title, status: "Watch", sections: [{ label: "Detail", text: risk.summary }], prompt: prompt ? { id: risk.id, text: prompt } : undefined }) }}
>
  <div class="eyebrow" style="color:var(--b-warn)">
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 2.8 19.5h18.4z" /><path d="M12 10v4M12 17v.01" /></svg> Watch
  </div>
  <h3 style="font-size:14px">{risk.title}</h3>
  <div class="sub" style="margin-top:6px;font-size:11.5px">{risk.summary}</div>
  <div style="margin-top:auto"><BriefOrigin origin={risk.origin} /></div>
</div>

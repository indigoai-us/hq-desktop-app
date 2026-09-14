<script lang="ts">
  /**
   * Test-only stand-in for a host-provided `rowExtras` hover card.
   *
   * It implements exactly what the seam promises a host: the sidebar mounts
   * the component with the hovered `row`, nothing else. The probe echoes the
   * row so `DesktopApp.row-extras.test.ts` can prove which row was handed
   * over without pulling a host page into `packages/ui`.
   */
  import type { ConversationRow } from "../chat/sidebar-model.js";

  interface Props {
    row: ConversationRow;
  }

  let { row }: Props = $props();
</script>

<div data-testid="row-extras-probe" data-row-id={row.id}>
  Sessions for {row.title}
</div>

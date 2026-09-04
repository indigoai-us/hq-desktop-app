<script lang="ts">
  import type { ComponentProps } from "svelte";
  import DesktopApp from "./DesktopApp.svelte";
  import type { ConversationRow } from "../chat/sidebar-model.js";

  type Props = ComponentProps<typeof DesktopApp>;

  let { initialRow: suppliedInitialRow, ...desktopProps }: Props = $props();
  let initialRow = $state(suppliedInitialRow);

  export function updateInitialRow(next: ConversationRow | null): void {
    initialRow = next;
  }
</script>

<DesktopApp {...desktopProps} {initialRow} />

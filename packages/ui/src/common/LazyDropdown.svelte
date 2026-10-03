<script lang="ts">
  /**
   * OWNER-R5/R6: the shared Dropdown, loaded on demand. Until it loads, a
   * button with the same look shows the current value, so nothing shifts.
   */
  import LazyDoor from "../shell/LazyDoor.svelte";
  import { dropdownDoor } from "../shell/lazy-doors.js";
  import type { DropdownOption } from "./Dropdown.svelte";

  interface Props {
    value: string;
    options: readonly DropdownOption[];
    label: string;
    prefix?: string;
    disabled?: boolean;
    testid?: string;
    block?: boolean;
    onchange?: (value: string) => void;
  }

  let { value = $bindable(), options, label, prefix = "", disabled = false, testid, block = false, onchange }: Props = $props();

  const current = $derived(options.find((o) => o.value === value)?.label ?? "");
</script>

<LazyDoor
  door={dropdownDoor}
  props={{
    value,
    options,
    label,
    prefix,
    disabled,
    testid,
    block,
    onchange: (next: string) => {
      value = next;
      onchange?.(next);
    },
  }}
>
  {#snippet skeleton()}
    <span class="dd-wait" class:block aria-hidden="true">
      {#if prefix}<span class="dd-wait-prefix">{prefix} · </span>{/if}{current}
    </span>
  {/snippet}
</LazyDoor>

<style>
  .dd-wait {
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    padding: 0 30px 0 10px;
    border: 1px solid var(--v4-hairline);
    border-radius: 6px;
    font-size: 13px;
    color: var(--v4-text-1);
    white-space: nowrap;
  }
  .dd-wait.block { display: flex; width: 100%; }
  .dd-wait-prefix { color: var(--v4-text-3); }
</style>

<script lang="ts">
  import { classNames } from "./class-names.js";

  interface Props {
    variant?: "primary" | "secondary";
    disabled?: boolean;
    onclick?: (event: MouseEvent) => void;
    children?: import("svelte").Snippet;
  }

  let {
    variant = "primary",
    disabled = false,
    onclick,
    children,
  }: Props = $props();
</script>

<button class={classNames("hq-btn", `hq-btn--${variant}`)} {disabled} {onclick}>
  {@render children?.()}
</button>

<style>
  .hq-btn {
    border-radius: 6px;
    padding: 0.5rem 1rem;
    cursor: pointer;
  }
  .hq-btn--primary {
    background: #4f46e5;
    color: #fff;
  }
  .hq-btn--secondary {
    background: transparent;
  }
</style>

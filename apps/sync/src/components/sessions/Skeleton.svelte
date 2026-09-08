<script lang="ts">
  // US-025 shared atom: shimmer placeholder block. Reduced-motion safe — the
  // sheen sweep is disabled under prefers-reduced-motion and the base block
  // keeps its contrast so loading states stay legible.
  interface Props {
    width?: string;
    height?: string;
    radius?: string;
  }

  let { width = '100%', height = '12px', radius = '6px' }: Props = $props();
</script>

<div
  class="ws-skeleton"
  style:width
  style:height
  style:border-radius={radius}
  aria-hidden="true"
></div>

<style>
  .ws-skeleton {
    position: relative;
    overflow: hidden;
    flex: none;
    background: var(--ws-skeleton-base, var(--v4-inset));
  }

  .ws-skeleton::after {
    content: '';
    position: absolute;
    inset: 0;
    transform: translateX(-100%);
    background: linear-gradient(
      90deg,
      transparent 0%,
      var(--ws-skeleton-sheen, rgba(255, 255, 255, 0.25)) 50%,
      transparent 100%
    );
    animation: ws-shimmer 1.6s ease-in-out infinite;
  }

  @keyframes ws-shimmer {
    100% {
      transform: translateX(100%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ws-skeleton::after {
      animation: none;
      transform: none;
      opacity: 0;
    }
  }
</style>

<script lang="ts">
  /**
   * HQ glow: the app icon's pink and violet ring, warming up around a round
   * photo after it saves and settling away. Place it inside a positioned box
   * the size of the photo; it plays once when mounted (wrap it in {#key} to
   * replay). Opacity and transform only; reduced motion fades without turning.
   */
  interface Props {
    testid?: string;
  }

  let { testid }: Props = $props();
</script>

<span class="glow" aria-hidden="true" data-testid={testid}>
  <span class="halo"></span>
  <span class="ring"></span>
</span>

<style>
  .glow {
    --hq-glow-a: #f08ac0;
    --hq-glow-b: #9a6bff;
    position: absolute;
    inset: -3px;
    border-radius: 50%;
    pointer-events: none;
    opacity: 0;
    animation: hq-glow 2.4s ease-in-out forwards;
  }

  .ring,
  .halo {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: conic-gradient(
      from 200deg,
      var(--hq-glow-a),
      var(--hq-glow-b),
      #ffc58f,
      var(--hq-glow-a)
    );
  }

  .ring {
    -webkit-mask: radial-gradient(circle, transparent calc(50% - 1.5px), #000 calc(50% - 1px));
    mask: radial-gradient(circle, transparent calc(50% - 1.5px), #000 calc(50% - 1px));
  }

  .halo {
    inset: -2px;
    filter: blur(8px);
    opacity: 0.4;
  }

  @keyframes hq-glow {
    0% {
      opacity: 0;
      transform: scale(0.95) rotate(-30deg);
    }
    30% {
      opacity: 1;
      transform: scale(1) rotate(15deg);
    }
    60% {
      opacity: 1;
      transform: scale(1.01) rotate(55deg);
    }
    100% {
      opacity: 0;
      transform: scale(1.04) rotate(95deg);
    }
  }

  @keyframes hq-glow-still {
    0%,
    100% {
      opacity: 0;
    }
    30%,
    60% {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .glow {
      animation: hq-glow-still 1.4s ease-out forwards;
    }
  }
</style>

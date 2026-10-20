<script lang="ts">
  /**
   * A company level's mark (usage-only-pricing US-019): the level number on a
   * coin in that level's colours (usage-level-theme.ts). Shown on each
   * Settings > Usage line, in the Core menu meter, and at the start of the
   * level-up card. Level 0 (no level yet) is an outlined coin with no fill,
   * so an account that has not reached $10 reads as "not started", not as a
   * missing value.
   */
  import { levelTheme } from "./usage-level-theme.js";
  import { levelLabel } from "./usage-levels.js";

  interface Props {
    level: number;
    /** Diameter in px. */
    size?: number;
    /** Speak the level; off where the text next to it already says it. */
    labelled?: boolean;
    [key: string]: unknown;
  }

  let { level, size = 18, labelled = false, ...rest }: Props = $props();
  const theme = $derived(levelTheme(level));
</script>

<span
  class="ulm"
  class:none={!theme}
  class:special={theme?.finish !== "flat" && Boolean(theme)}
  style:--ulm="{size}px"
  style:--ulm-bg={theme?.mark ?? "transparent"}
  style:--ulm-ink={theme?.markInk ?? "var(--t3)"}
  data-level={level}
  data-testid="usage-level-mark"
  role={labelled ? "img" : undefined}
  aria-label={labelled ? levelLabel(level) : undefined}
  aria-hidden={labelled ? undefined : "true"}
  {...rest}
></span>

<style>
  .ulm {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: var(--ulm);
    height: var(--ulm);
    border-radius: 50%;
    background: var(--ulm-bg);
    color: var(--ulm-ink);
    font-size: calc(var(--ulm) * 0.56);
    font-weight: 650;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }

  /* The number is drawn, not text, so a line's name reads the same with or
     without its mark (the mark is decoration; the chip's words say the level). */
  .ulm::before {
    content: attr(data-level);
  }

  /* No level yet: an outline, so it reads as not started. */
  .ulm.none {
    box-shadow: inset 0 0 0 1.25px var(--line2, rgba(127, 127, 127, 0.4));
  }

  /* Levels 5 to 7 carry a gradient; a thin inner light marks them as the special ones. */
  .ulm.special {
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
  }
</style>

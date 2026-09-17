<script lang="ts">
  /**
   * Cloud / Local marker for a bot. The one user-facing split between bots:
   * "Cloud" (company-hosted, always on) vs "Local · Claude Code" (this Mac,
   * the user's own login). Pure presentation — derive `kind` with
   * `botKindFor(uid, localBots)`.
   *
   * Default is a small icon with a hover tooltip (rows, headers, pickers stay
   * quiet). `variant="label"` renders the text pill for places with room:
   * profile sheets and the Settings → Bots groups.
   */
  import { botKindLabel, type BotKind } from "./bot-kind.js";

  interface Props {
    kind: BotKind;
    runtime?: string | null;
    size?: "sm" | "md";
    variant?: "icon" | "label";
  }

  let { kind, runtime = null, size = "sm", variant = "icon" }: Props = $props();
  const label = $derived(botKindLabel(kind, runtime));
  const hint = $derived(
    kind === "cloud"
      ? `${label} — runs in your company's cloud, always on`
      : `${label} — runs on this Mac under your own login`,
  );
</script>

<span
  class="bot-kind-chip"
  class:md={size === "md"}
  class:icon={variant === "icon"}
  data-testid="bot-kind-chip"
  data-kind={kind}
  role="img"
  aria-label={label}
  title={hint}
>
  {#if variant === "icon"}
    {#if kind === "cloud"}
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path
          d="M5 12.5h6.5a2.75 2.75 0 0 0 .4-5.47A4 4 0 0 0 4.3 8.2 2.2 2.2 0 0 0 5 12.5Z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linejoin="round"
        />
      </svg>
    {:else}
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <rect x="3" y="3.5" width="10" height="6.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3" />
        <path d="M1.8 12.5h12.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      </svg>
    {/if}
  {:else}
    {label}
  {/if}
</span>

<style>
  .bot-kind-chip {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    padding: 1px 6px;
    border: 1px solid var(--line2, var(--line, rgba(255, 255, 255, 0.1)));
    border-radius: 999px;
    background: var(--hover, transparent);
    color: var(--t3);
    font-family: var(--font-mono, inherit);
    font-size: 10px;
    font-weight: 500;
    line-height: 1.4;
    letter-spacing: 0.03em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: middle;
  }

  .bot-kind-chip.icon {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--t3);
    opacity: 0.7;
    width: 14px;
    height: 14px;
    justify-content: center;
  }
  .bot-kind-chip.icon:hover { opacity: 1; }

  .bot-kind-chip[data-kind="cloud"]:not(.icon) {
    color: var(--ice-ink, var(--t2, inherit));
  }

  .bot-kind-chip.md:not(.icon) {
    padding: 2px 8px;
    font-size: 11px;
  }
</style>

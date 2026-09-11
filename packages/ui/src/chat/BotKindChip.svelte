<script lang="ts">
  /**
   * Cloud / Local kind chip for a bot. The one user-facing split between bots:
   * "Cloud" (company-hosted, always on) vs "Local · Claude Code" (this Mac,
   * the user's own login). Pure presentation — derive `kind` with
   * `botKindFor(uid, localBots)`.
   */
  import { botKindLabel, type BotKind } from "./bot-kind.js";

  interface Props {
    kind: BotKind;
    runtime?: string | null;
    size?: "sm" | "md";
  }

  let { kind, runtime = null, size = "sm" }: Props = $props();
  const label = $derived(botKindLabel(kind, runtime));
</script>

<span
  class="bot-kind-chip"
  class:md={size === "md"}
  data-testid="bot-kind-chip"
  data-kind={kind}
  title={kind === "cloud"
    ? "Runs in your company's cloud — always on"
    : "Runs on this Mac under your own login"}
>
  {label}
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

  .bot-kind-chip[data-kind="cloud"] {
    color: var(--ice-ink, var(--t2, inherit));
  }

  .bot-kind-chip.md {
    padding: 2px 8px;
    font-size: 11px;
  }
</style>

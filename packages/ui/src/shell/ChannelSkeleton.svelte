<script lang="ts">
  /**
   * ChannelSkeleton — shimmer placeholder for the conversation pane while the
   * mesh overlay / channel list is still loading (no row selected yet).
   * Replaces the jarring "No data / Nothing to show yet" flash on startup.
   * Pure presentation; honors prefers-reduced-motion.
   */
  const ROWS = [
    { name: 84, lines: [220, 320] },
    { name: 64, lines: [280] },
    { name: 96, lines: [180, 340, 240] },
    { name: 72, lines: [260] },
    { name: 88, lines: [300, 200] },
  ];
</script>

<div
  class="skeleton chat-shell"
  data-testid="channel-skeleton"
  aria-hidden="true"
>
  <div class="sk-header">
    <span class="sk sk-title"></span>
    <span class="sk sk-pill"></span>
  </div>
  <div class="sk-body">
    {#each ROWS as row, i (i)}
      <div class="sk-row">
        <span class="sk sk-avatar"></span>
        <span class="sk-col">
          <span class="sk sk-name" style={`width:${row.name}px`}></span>
          {#each row.lines as w, j (j)}
            <span class="sk sk-line" style={`width:${w}px`}></span>
          {/each}
        </span>
      </div>
    {/each}
  </div>
  <div class="sk-composer">
    <span class="sk sk-input"></span>
  </div>
</div>

<style>
  .skeleton {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }

  .sk {
    display: inline-block;
    border-radius: 6px;
    background: linear-gradient(
      100deg,
      color-mix(in srgb, var(--t1, #fff) 6%, transparent) 40%,
      color-mix(in srgb, var(--t1, #fff) 11%, transparent) 50%,
      color-mix(in srgb, var(--t1, #fff) 6%, transparent) 60%
    );
    background-size: 200% 100%;
    animation: sk-shimmer 1.4s ease-in-out infinite;
  }

  @keyframes sk-shimmer {
    from {
      background-position: 120% 0;
    }
    to {
      background-position: -80% 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sk {
      animation: none;
      background: color-mix(in srgb, var(--t1, #fff) 7%, transparent);
    }
  }

  .sk-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex: 0 0 auto;
    height: 52px;
    padding: 0 20px;
    border-bottom: 1px solid var(--line, rgba(255, 255, 255, 0.08));
  }

  .sk-title {
    width: 160px;
    height: 14px;
  }

  .sk-pill {
    width: 64px;
    height: 22px;
    border-radius: 999px;
  }

  .sk-body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    gap: 22px;
    padding: 24px;
    overflow: hidden;
  }

  .sk-row {
    display: flex;
    gap: 12px;
  }

  .sk-avatar {
    flex: 0 0 auto;
    width: 32px;
    height: 32px;
    border-radius: 50%;
  }

  .sk-col {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding-top: 2px;
  }

  .sk-name {
    height: 11px;
  }

  .sk-line {
    height: 10px;
  }

  .sk-composer {
    flex: 0 0 auto;
    padding: 0 24px 20px;
  }

  .sk-input {
    display: block;
    width: 100%;
    height: 84px;
    border-radius: 10px;
  }
</style>

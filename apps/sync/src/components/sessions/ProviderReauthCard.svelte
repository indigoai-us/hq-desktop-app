<script lang="ts">
  /**
   * Sign-in needed — same tile language as a chat artifact card, not an error.
   */
  interface Props {
    tool?: string | null;
    pending?: boolean;
    message?: string;
    onsignin?: () => void;
  }

  let { tool = 'claude', pending = false, message = '', onsignin }: Props = $props();

  const name = $derived(
    tool === 'codex' ? 'Codex' : tool === 'grok' ? 'Grok' : 'Claude',
  );
</script>

<div class="reauth-card" data-testid="session-reauth-card" data-tool={tool ?? 'claude'}>
  <span class="tile" aria-hidden="true">
    <span class="tile-mesh"></span>
    <svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
      <path
        d="M8 1.75a3.25 3.25 0 00-3.25 3.25v1.5h-.5A1.75 1.75 0 002.5 8.25v4.5c0 .97.78 1.75 1.75 1.75h7.5c.97 0 1.75-.78 1.75-1.75v-4.5A1.75 1.75 0 0011.75 6.5h-.5v-1.5A3.25 3.25 0 008 1.75zm-1.75 3.25a1.75 1.75 0 113.5 0v1.5h-3.5z"
        fill="currentColor"
      />
    </svg>
  </span>
  <span class="copy">
    <span class="title">Sign in to {name}</span>
    <span class="summary">{message.trim() || `This session needs a fresh sign-in on this Mac. Other ${name} apps can stay signed in.`}</span>
    <span class="meta">{name.toUpperCase()} · SIGN IN</span>
  </span>
  <button
    type="button"
    class="signin"
    data-testid="session-reauth"
    disabled={pending}
    onclick={(event) => {
      event.stopPropagation();
      onsignin?.();
    }}
  >
    {pending ? 'Signing in…' : 'Sign in'}
  </button>
</div>

<style>
  .reauth-card {
    --mesh-a: #7dd3fc;
    --mesh-b: #34d399;
    --mesh-c: #a78bfa;
    --mesh-base: #1f2f3a;
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    max-width: 520px;
    box-sizing: border-box;
    margin-top: 4px;
    padding: 8px 10px 8px 8px;
    border: 1px solid var(--line, rgba(255, 255, 255, 0.07));
    border-radius: 12px;
    background: var(--elevated, #1e1e24);
    font-size: 13px;
    text-align: left;
  }

  .tile {
    position: relative;
    display: inline-grid;
    flex: 0 0 auto;
    place-items: center;
    width: 44px;
    height: 44px;
    overflow: hidden;
    border-radius: 9px;
    background: var(--mesh-base);
    color: #fff;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
  }

  .tile-mesh {
    position: absolute;
    inset: -30%;
    background:
      radial-gradient(closest-side at 28% 26%, var(--mesh-a) 0%, transparent 100%),
      radial-gradient(closest-side at 78% 34%, var(--mesh-b) 0%, transparent 100%),
      radial-gradient(closest-side at 50% 88%, var(--mesh-c) 0%, transparent 100%);
    opacity: 0.9;
  }

  .tile svg {
    position: relative;
    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.35));
  }

  .copy {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }

  .title {
    overflow: hidden;
    color: var(--t1, rgba(255, 255, 255, 0.95));
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .summary {
    overflow: hidden;
    color: var(--t2, rgba(255, 255, 255, 0.56));
    font-size: 12.5px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    color: var(--t3, rgba(255, 255, 255, 0.4));
    font-size: 11px;
    letter-spacing: 0.04em;
  }

  .signin {
    flex: 0 0 auto;
    margin-left: 4px;
    height: 32px;
    padding: 0 12px;
    border: 1px solid var(--line, rgba(255, 255, 255, 0.12));
    border-radius: 8px;
    background: var(--v4-control-bg, rgba(255, 255, 255, 0.08));
    color: var(--t1, inherit);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .signin:hover:not(:disabled) {
    background: var(--v4-active-row, rgba(255, 255, 255, 0.12));
  }

  .signin:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>

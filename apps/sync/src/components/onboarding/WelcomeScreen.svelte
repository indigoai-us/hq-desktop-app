<script lang="ts">
  interface Props {
    telemetryEnabled?: boolean;
    ontelemetrychange?: (enabled: boolean) => void;
  }

  let {
    telemetryEnabled = true,
    ontelemetrychange,
  }: Props = $props();

  function handleTelemetryChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    ontelemetrychange?.(input.checked);
  }
</script>

<div class="welcome-screen">
  <div class="welcome-copy">
    <h1>Set up HQ</h1>
    <p>
      Open-source AI dev team for Claude Code. 45 AI workers, 60+ skills, and
      an orchestrator that ships code autonomously.
    </p>
  </div>

  <label class="telemetry-option">
    <span class="checkbox-wrap">
      <input
        type="checkbox"
        checked={telemetryEnabled}
        onchange={handleTelemetryChange}
      />
      <span class="checkmark" aria-hidden="true">
        <svg viewBox="0 0 12 12" focusable="false">
          <path d="M2.5 6.5 5 9l4.5-5.5" />
        </svg>
      </span>
    </span>
    <span>Help improve HQ by sharing anonymous usage telemetry</span>
  </label>
</div>

<style>
  .welcome-screen {
    display: flex;
    flex-direction: column;
    gap: var(--space-6, 24px);
    width: 100%;
    max-width: 460px;
  }

  .welcome-copy {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 12px);
  }

  h1 {
    margin: 0;
    color: var(--popover-text-heading, #ffffff);
    font-size: 28px;
    font-weight: 600;
    line-height: 1.15;
  }

  p {
    margin: 0;
    color: var(--popover-text, rgba(255, 255, 255, 0.86));
    font-size: var(--text-base, 13px);
    font-weight: 400;
    line-height: 1.6;
  }

  .telemetry-option {
    display: flex;
    align-items: center;
    gap: var(--space-3, 12px);
    color: var(--popover-text, rgba(255, 255, 255, 0.86));
    font-size: var(--text-sm, 13px);
    line-height: 1.35;
    cursor: pointer;
  }

  .checkbox-wrap {
    position: relative;
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 18px;
    flex: 0 0 18px;
  }

  input {
    appearance: none;
    width: 18px;
    height: 18px;
    margin: 0;
    border: 1px solid var(--popover-border, rgba(255, 255, 255, 0.18));
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.05);
    cursor: pointer;
    transition:
      background-color 0.12s ease,
      border-color 0.12s ease;
  }

  .telemetry-option:hover input {
    border-color: var(--popover-highlight, rgba(255, 255, 255, 0.34));
  }

  input:checked {
    border-color: var(--popover-primary, #ffffff);
    background: var(--popover-primary, #ffffff);
  }

  input:focus-visible {
    outline: 2px solid var(--popover-highlight, rgba(255, 255, 255, 0.34));
    outline-offset: 2px;
  }

  .checkmark {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
    color: var(--popover-primary-text, #111113);
    opacity: 0;
    transition: opacity 0.12s ease;
  }

  input:checked + .checkmark {
    opacity: 1;
  }

  svg {
    width: 12px;
    height: 12px;
  }

  path {
    fill: none;
    stroke: currentColor;
    stroke-width: 2.25;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>

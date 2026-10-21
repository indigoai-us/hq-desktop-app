<script lang="ts">
  /**
   * One quiet line under the name in Settings › Profile.
   *
   *   • Steps left: a small progress ring and the next step ("2 of 3 · Add an
   *     About line"); clicking it goes to that step.
   *   • Last step saved: the ring fills with the HQ glow and the line reads
   *     "Profile complete" for a moment (once per account).
   *   • After that: a nudge toward the public profile while it's missing a
   *     handle, photo or bio, else a plain "Public profile ›" link.
   */
  import { publicProfileHint, type ChecklistStep, type PublicProfileState } from "./profile-checklist.js";

  interface Props {
    steps: ChecklistStep[];
    publicProfile: PublicProfileState;
    /** Account-scoped storage; remembers that the completion was celebrated. */
    storage?: Pick<Storage, "getItem" | "setItem"> | null;
    onstep?: (id: ChecklistStep["id"]) => void;
    onopenpublic?: () => void;
  }

  let { steps, publicProfile, storage = null, onstep, onopenpublic }: Props = $props();

  const SEEN_KEY = "hq.settings.profile-complete-celebrated";
  const RING = 2 * Math.PI * 5.5;

  const doneCount = $derived(steps.filter((s) => s.done).length);
  const complete = $derived(steps.length > 0 && doneCount === steps.length);
  const next = $derived(steps.find((s) => !s.done) ?? null);
  const hint = $derived(publicProfileHint(publicProfile));

  function readSeen(): boolean {
    try {
      return storage?.getItem(SEEN_KEY) === "1";
    } catch {
      return false;
    }
  }

  // svelte-ignore state_referenced_locally
  let wasComplete = complete;
  let celebrating = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (complete && !wasComplete && !readSeen()) {
      celebrating = true;
      try {
        storage?.setItem(SEEN_KEY, "1");
      } catch {
        // best-effort
      }
      clearTimeout(timer);
      timer = setTimeout(() => (celebrating = false), 3200);
    }
    wasComplete = complete;
    return () => clearTimeout(timer);
  });
</script>

<span class="progress" data-testid="profile-checklist">
  {#if !complete && next}
    <button
      type="button"
      class="line"
      data-testid="profile-checklist-next"
      onclick={() => onstep?.(next.id)}
    >
      <svg class="ring" viewBox="0 0 14 14" aria-hidden="true">
        <circle class="track" cx="7" cy="7" r="5.5" />
        <circle
          class="fill"
          cx="7"
          cy="7"
          r="5.5"
          style={`stroke-dasharray:${RING};stroke-dashoffset:${RING * (1 - doneCount / steps.length)}`}
        />
      </svg>
      <span data-testid="profile-checklist-count">{doneCount} of {steps.length}</span>
      <span class="dot" aria-hidden="true">·</span>
      <span class="todo">{next.todo}</span>
    </button>
    {#if onopenpublic}
      <span class="sep" aria-hidden="true">·</span>
      <button type="button" class="line" data-testid="settings-open-public-profile" onclick={onopenpublic}
        >Public profile ›</button
      >
    {/if}
  {:else if celebrating}
    <span class="line done" data-testid="profile-checklist-complete" role="status">
      <span class="ring-wrap" aria-hidden="true">
        <span class="halo"></span>
        <svg class="ring" viewBox="0 0 14 14">
          <circle class="fill full" cx="7" cy="7" r="5.5" />
          <path class="check" d="M4.6 7.2l1.6 1.6 3.3-3.4" />
        </svg>
      </span>
      Profile complete
    </span>
  {:else if hint && onopenpublic}
    <button type="button" class="line nudge" data-testid="profile-public-hint" onclick={onopenpublic}>
      <span class="hq" aria-hidden="true">HQ</span>{hint} ›
    </button>
  {:else if onopenpublic}
    <button type="button" class="line" data-testid="settings-open-public-profile" onclick={onopenpublic}
      >Public profile ›</button
    >
  {/if}
</span>

<style>
  .progress {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 2px 8px;
    margin-top: 2px;
    --hq-a: #f08ac0;
    --hq-b: #9a6bff;
  }

  .line {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--t2, var(--v4-text-2));
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    animation: pp-in 0.25s ease-out;
  }

  button.line:hover {
    color: var(--t1, var(--v4-text-1));
  }

  button.line:focus-visible {
    outline: 1.5px solid var(--v4-focus-ring, #6366f1);
    outline-offset: 2px;
    border-radius: 3px;
  }

  .line.done {
    color: var(--t1, var(--v4-text-1));
    cursor: default;
  }

  .dot,
  .sep {
    color: var(--v4-text-3, rgb(250 250 250 / 0.36));
    font-size: 12px;
  }

  .todo {
    color: var(--t1, var(--v4-text-1));
  }

  .ring {
    width: 14px;
    height: 14px;
    flex: none;
    transform: rotate(-90deg);
  }

  .track {
    fill: none;
    stroke: var(--line2, var(--v4-control-border));
    stroke-width: 2;
  }

  .fill {
    fill: none;
    stroke: var(--hq-b);
    stroke-width: 2;
    stroke-linecap: round;
    transition: stroke-dashoffset 0.6s cubic-bezier(0.22, 0.8, 0.3, 1);
  }

  .fill.full {
    stroke: var(--hq-a);
  }

  .check {
    fill: none;
    stroke: var(--t1, var(--v4-text-1));
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    transform: rotate(90deg);
    transform-origin: 7px 7px;
  }

  .ring-wrap {
    position: relative;
    display: inline-grid;
    place-items: center;
    width: 14px;
    height: 14px;
  }

  .halo {
    position: absolute;
    inset: -4px;
    border-radius: 50%;
    background: radial-gradient(circle, var(--hq-a), var(--hq-b) 60%, transparent 72%);
    filter: blur(4px);
    opacity: 0;
    animation: pp-glow 2.4s ease-in-out forwards;
  }

  .hq {
    display: inline-grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--hq-a), var(--hq-b));
    color: #fff;
    font-size: 6.5px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .nudge {
    color: var(--t1, var(--v4-text-1));
  }

  @keyframes pp-in {
    from {
      opacity: 0;
    }
  }

  @keyframes pp-glow {
    0%,
    100% {
      opacity: 0;
    }
    30%,
    65% {
      opacity: 0.7;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .line,
    .halo {
      animation: none;
    }
    .fill {
      transition: none;
    }
  }
</style>

<script lang="ts">
  /**
   * Office hours (US-018) — who is reachable, who is willing to talk, and who
   * is already in a room, as THREE independent facts.
   *
   * The three badges never collapse into one "status": someone can be online
   * and do-not-disturb, offline with the door open (they will see the knock
   * later), or occupied while still reachable. Each badge carries its own text
   * label and its own countdown, so nothing depends on colour alone.
   *
   * The component owns no network: it renders an injected `OfficeStore` and
   * calls back out for the room actions the host performs.
   */
  import {
    OFFICE_DURATIONS,
    type OfficeConnectivity,
    type OfficeOccupancy,
    type OfficePerson,
    type OfficeStore,
    type OfficeWillingness,
    isRoomJoinable,
  } from "./office-store.svelte.js";

  interface Props {
    store: OfficeStore;
    /** This device's person uid — the row that renders the own controls. */
    selfPersonUid: string;
    /** Optional display names, keyed by person uid. */
    displayName?: (personUid: string) => string;
    /** Injected clock so countdowns are deterministic under test. */
    now?: () => number;
    /** Ticks the countdowns. Set to 0 to disable (tests drive `now`). */
    tickMs?: number;
    /** "Start a room" — the host creates the room and opens the call window. */
    onstartroom?: () => void | Promise<void>;
    /** "Open room" on a member row whose room is joinable. */
    onopenroom?: (person: OfficePerson) => void | Promise<void>;
    /** Retry after an error state. */
    onretry?: () => void | Promise<void>;
  }

  let {
    store,
    selfPersonUid,
    displayName = (personUid: string) => personUid,
    now = () => Date.now(),
    tickMs = 1000,
    onstartroom,
    onopenroom,
    onretry,
  }: Props = $props();

  /** Re-render heartbeat: countdowns and lease expiry are time-dependent. */
  let tick = $state(0);
  $effect(() => {
    if (tickMs <= 0) return;
    const handle = setInterval(() => {
      tick += 1;
    }, tickMs);
    return () => clearInterval(handle);
  });

  const view = $derived(store.state);
  const at = $derived.by(() => {
    void tick;
    return now();
  });
  const people = $derived.by(() => {
    void tick;
    return store
      .visiblePeople()
      .filter((person) => person.personUid !== selfPersonUid);
  });
  const self = $derived.by(() => {
    void tick;
    return store.visibleSelf();
  });

  const CONNECTIVITY_LABEL: Record<OfficeConnectivity, string> = {
    online: "Reachable",
    away: "Away",
    offline: "Not reachable",
  };
  const WILLINGNESS_LABEL: Record<OfficeWillingness, string> = {
    open: "Door open",
    knock: "Knock first",
    dnd: "Do not disturb",
  };
  const OCCUPANCY_LABEL: Record<OfficeOccupancy, string> = {
    occupied: "In a room",
    unoccupied: "Not in a room",
  };

  const WILLINGNESS_CHOICES: ReadonlyArray<{
    id: OfficeWillingness;
    label: string;
    hint: string;
  }> = [
    { id: "open", label: "Open", hint: "Anyone in the company can walk in." },
    { id: "knock", label: "Knock only", hint: "People ask before joining." },
    { id: "dnd", label: "Do not disturb", hint: "No knocks reach you." },
  ];

  let ttlMs = $state(OFFICE_DURATIONS[OFFICE_DURATIONS.length - 1].ttlMs);

  /** Human countdown for a lease, or null when the fact carries no expiry. */
  function remaining(expiresAt: number | null): string | null {
    if (expiresAt === null) return null;
    const left = expiresAt - at;
    if (left <= 0) return null;
    const seconds = Math.ceil(left / 1000);
    if (seconds < 60) return `${seconds}s left`;
    return `${Math.ceil(seconds / 60)}m left`;
  }

  function joinable(person: OfficePerson): boolean {
    return isRoomJoinable(person, at);
  }

  const busy = $derived(view.saving);
</script>

<section class="office" aria-labelledby="office-title">
  <header class="office-header">
    <h1 id="office-title">Office</h1>
    <p class="office-lede">
      Reachability, willingness and whether someone is already in a room are
      separate. Being online does not mean being available.
    </p>
  </header>

  <p class="sr-live" role="status" aria-live="polite">
    {#if view.status === "loading"}Loading the office…{:else if view.status === "ready"}Office
      loaded: {people.length} other {people.length === 1 ? "person" : "people"}.{:else if view.error}{view.error.message}{/if}
  </p>

  {#if view.status === "unsupported"}
    <div class="office-notice" data-testid="office-unsupported">
      <strong>Native calls are not available here</strong>
      <span>{view.error?.message ?? "Open HQ on the desktop app to use office hours."}</span>
    </div>
  {:else if view.status === "disabled"}
    <div class="office-notice" data-testid="office-disabled">
      <strong>Native calls are not enabled for this company</strong>
      <span>Ask a company owner to turn on native calls in the HQ console.</span>
    </div>
  {:else if view.status === "error"}
    <div class="office-notice office-notice-error" data-testid="office-error">
      <strong>The office could not be loaded</strong>
      <span>{view.error?.message}</span>
      <button type="button" class="office-button" onclick={() => void onretry?.()}>
        Try again
      </button>
    </div>
  {:else}
    <div class="office-self" data-testid="office-self">
      <h2>Your office hours</h2>
      <div
        class="office-segmented"
        role="group"
        aria-label="Your willingness to be interrupted"
      >
        {#each WILLINGNESS_CHOICES as choice (choice.id)}
          <button
            type="button"
            class="office-segment"
            data-testid={`office-willingness-${choice.id}`}
            aria-pressed={self?.willingness === choice.id}
            disabled={busy || view.status === "loading"}
            title={choice.hint}
            onclick={() => void store.setWillingness(choice.id, ttlMs)}
          >
            {choice.label}
          </button>
        {/each}
      </div>

      <label class="office-duration">
        <span>For</span>
        <select
          bind:value={ttlMs}
          data-testid="office-duration"
          disabled={busy}
        >
          {#each OFFICE_DURATIONS as duration (duration.ttlMs)}
            <option value={duration.ttlMs}>{duration.label}</option>
          {/each}
        </select>
      </label>

      <p class="office-self-state" data-testid="office-self-state">
        <span>{WILLINGNESS_LABEL[self?.willingness ?? "knock"]}</span>
        {#if remaining(self?.willingnessExpiresAt ?? null)}
          <span class="office-expiry">
            · {remaining(self?.willingnessExpiresAt ?? null)}
          </span>
        {:else}
          <span class="office-expiry">· no timer set</span>
        {/if}
      </p>

      <div class="office-self-actions">
        <button
          type="button"
          class="office-button"
          data-testid="office-open-door"
          disabled={busy || view.status === "loading"}
          onclick={() => void store.setWillingness("open", ttlMs)}
        >
          Open my door
        </button>
        <button
          type="button"
          class="office-button office-button-primary"
          data-testid="office-start-room"
          disabled={busy || view.status === "loading"}
          onclick={() => void onstartroom?.()}
        >
          Start a room
        </button>
        <button
          type="button"
          class="office-button"
          data-testid="office-go-offline"
          disabled={busy}
          onclick={() =>
            void store.setConnectivity(
              self?.connectivity === "online" ? "offline" : "online",
            )}
        >
          {self?.connectivity === "online"
            ? "Mark me not reachable"
            : "Mark me reachable"}
        </button>
      </div>
    </div>

    {#if view.status === "loading" && people.length === 0}
      <p class="office-empty" data-testid="office-loading">Loading the office…</p>
    {:else if people.length === 0}
      <p class="office-empty" data-testid="office-empty">
        Nobody else has office hours in this company yet. Open your door so
        teammates know they can walk in.
      </p>
    {:else}
      <ul class="office-list" data-testid="office-list">
        {#each people as person (person.personUid)}
          <li class="office-row" data-testid={`office-row-${person.personUid}`}>
            <span class="office-name">{displayName(person.personUid)}</span>

            <span class="office-badges">
              <span
                class="office-badge"
                data-kind="connectivity"
                data-value={person.connectivity}
                data-testid={`office-connectivity-${person.personUid}`}
              >
                {CONNECTIVITY_LABEL[person.connectivity]}
                {#if remaining(person.connectivityExpiresAt)}
                  <span class="office-expiry">
                    · {remaining(person.connectivityExpiresAt)}
                  </span>
                {/if}
              </span>
              <span
                class="office-badge"
                data-kind="willingness"
                data-value={person.willingness}
                data-testid={`office-willingness-badge-${person.personUid}`}
              >
                {WILLINGNESS_LABEL[person.willingness]}
                {#if remaining(person.willingnessExpiresAt)}
                  <span class="office-expiry">
                    · {remaining(person.willingnessExpiresAt)}
                  </span>
                {/if}
              </span>
              <span
                class="office-badge"
                data-kind="occupancy"
                data-value={person.occupancy}
                data-testid={`office-occupancy-${person.personUid}`}
              >
                {OCCUPANCY_LABEL[person.occupancy]}
                {#if remaining(person.occupancyExpiresAt)}
                  <span class="office-expiry">
                    · {remaining(person.occupancyExpiresAt)}
                  </span>
                {/if}
              </span>
            </span>

            <span class="office-actions">
              <!--
                Knocking is not built yet. A permanently disabled button is a
                dead end for keyboard and screen-reader users — it is focus-
                skipped, announces nothing about why, and still looks like the
                primary action. A plain note says the same thing honestly.
              -->
              <span
                class="office-soon"
                data-testid={`office-knock-soon-${person.personUid}`}
              >
                Knocks coming next
              </span>
              {#if joinable(person)}
                <button
                  type="button"
                  class="office-button"
                  data-testid={`office-open-room-${person.personUid}`}
                  onclick={() => void onopenroom?.(person)}
                >
                  Open room
                </button>
              {/if}
            </span>
          </li>
        {/each}
      </ul>

      {#if view.nextCursor}
        <button
          type="button"
          class="office-button"
          data-testid="office-load-more"
          onclick={() => void store.loadMore()}
        >
          Show more people
        </button>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .office {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-4, 16px);
    padding: var(--v4-space-4, 16px);
    font-family: var(--font-sans);
    color: var(--v4-text-1);
  }

  .office-header h1 {
    margin: 0;
    font-size: var(--type-detail, 24px);
    font-weight: 600;
  }

  .office-lede {
    margin: var(--v4-row-stack-gap, 3px) 0 0;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 14px);
    max-width: 60ch;
  }

  .sr-live {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  .office-notice,
  .office-self {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--v4-space-2, 8px);
    padding: var(--v4-space-4, 16px);
    border: 1px solid var(--v4-border, rgba(0, 0, 0, 0.12));
    border-radius: var(--v4-radius-panel, 10px);
  }

  .office-notice strong {
    font-size: var(--type-section, 17px);
  }

  .office-notice span {
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 14px);
  }

  /* Structural emphasis, not colour: the error notice reads as different at a
     glance for everyone, and its heading + retry say what it is. */
  .office-notice-error {
    border-width: 2px;
  }

  .office-self h2 {
    margin: 0;
    font-size: var(--type-section, 17px);
    font-weight: 600;
  }

  .office-segmented {
    display: flex;
    gap: 0;
  }

  .office-segment {
    padding: 6px 12px;
    border: 1px solid var(--v4-border, rgba(0, 0, 0, 0.12));
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .office-segment:first-child {
    border-radius: var(--v4-radius-button, 6px) 0 0 var(--v4-radius-button, 6px);
  }

  .office-segment:last-child {
    border-radius: 0 var(--v4-radius-button, 6px) var(--v4-radius-button, 6px) 0;
  }

  /* Selection is text-weight + an inset marker, never colour alone. */
  .office-segment[aria-pressed="true"] {
    font-weight: 600;
    box-shadow: inset 0 -3px 0 currentColor;
  }

  .office-soon {
    color: var(--v4-text-3, #6b7280);
    font-size: var(--type-caption, 12px);
    white-space: nowrap;
  }

  .office-segment:disabled,
  .office-button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .office-duration {
    display: inline-flex;
    align-items: center;
    gap: var(--v4-space-2, 8px);
    font-size: var(--type-secondary, 14px);
  }

  .office-self-state {
    margin: 0;
    font-size: var(--type-secondary, 14px);
  }

  .office-self-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--v4-space-2, 8px);
  }

  .office-button {
    padding: 6px 12px;
    border: 1px solid var(--v4-border, rgba(0, 0, 0, 0.12));
    border-radius: var(--v4-radius-button, 6px);
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .office-button-primary {
    font-weight: 600;
  }

  .office-segment:focus-visible,
  .office-button:focus-visible,
  select:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }

  .office-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2, 8px);
  }

  .office-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--v4-space-2, 8px);
    padding: var(--v4-space-2, 8px);
    border: 1px solid var(--v4-border, rgba(0, 0, 0, 0.12));
    border-radius: var(--v4-radius-panel, 10px);
  }

  .office-name {
    font-size: var(--type-body, 15px);
    font-weight: 500;
    min-width: 12ch;
  }

  .office-badges {
    display: flex;
    flex-wrap: wrap;
    gap: var(--v4-space-2, 8px);
    flex: 1 1 auto;
  }

  .office-badge {
    padding: 2px 8px;
    border: 1px solid var(--v4-border, rgba(0, 0, 0, 0.12));
    border-radius: 999px;
    font-size: var(--type-metadata, 13px);
    white-space: nowrap;
  }

  .office-expiry {
    color: var(--v4-text-3);
  }

  .office-actions {
    display: flex;
    gap: var(--v4-space-2, 8px);
  }

  .office-empty {
    margin: 0;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 14px);
  }
</style>

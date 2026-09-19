<script lang="ts">
  /**
   * `?view=switch-stability` — the browser fixture behind
   * `e2e/browser/conversation-switch-stability.spec.ts`.
   *
   * Why a fixture and not the live shell: the conversation rail in the preview
   * harness paints exactly one conversation (`welcome`), so there is nothing to
   * switch between there. This stage mounts the REAL `ChannelConversation` in a
   * real browser, at a fixed pane size, with three conversations and the two
   * timings that make a switch look unstable:
   *
   *   1. a conversation opened for the first time answers after a delay, the
   *      way a fetch does — so the switch has a genuine loading window;
   *   2. every conversation grows AFTER its rows land, the way reactions,
   *      avatars and late markdown do.
   *
   * A conversation opened a second time answers from the harness cache with no
   * delay, which is the shell's cached-switch path.
   *
   * Nothing here mocks the component. The anchoring, the bottom pin and the
   * rapid-switch guard under test are the shipped ones.
   */
  import { ChannelConversation } from '@hq/ui';

  const params = new URLSearchParams(window.location.search);
  // `Number(null)` is 0, not NaN, so an absent param has to be rejected before
  // the parse — otherwise every default here silently becomes zero.
  const number = (key: string, fallback: number): number => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };

  /** How long a first open takes to answer. */
  const FETCH_MS = number('fetchMs', 120);
  /** How long after the rows land the late content shows up. */
  const GROWTH_MS = number('growthMs', 250);
  const MESSAGE_COUNT = number('messages', 40);

  type Wire = {
    eventId: string;
    direction: 'in' | 'out';
    fromPersonUid: string;
    fromDisplayName: string;
    body: string;
    createdAt: string;
  };

  const CONVERSATIONS = ['alpha', 'bravo', 'charlie'] as const;
  type ConversationId = (typeof CONVERSATIONS)[number];

  function thread(id: ConversationId): Wire[] {
    return Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
      eventId: `${id}-${index + 1}`,
      direction: 'in' as const,
      fromPersonUid: `prs_${(index % 2) + 1}`,
      fromDisplayName: index % 2 === 0 ? 'Ada Lovelace' : 'Grace Hopper',
      // Mixed lengths so rows are not a uniform height, as in a real thread.
      body: index % 3 === 0
        ? `${id} message ${index + 1} — long enough that it wraps onto a second line in this pane, so the rows in this thread are not all the same height.`
        : `${id} message ${index + 1}`,
      createdAt: new Date(Date.UTC(2026, 8, 1, 9, index)).toISOString(),
    }));
  }

  let active = $state<ConversationId>('alpha');
  /** Conversations whose rows the harness already holds — the "cache". */
  const cache = new Map<ConversationId, Wire[]>();
  let shown = $state<Wire[]>([]);
  let loading = $state(false);
  /** Set on the row that grows late, so the growth is visible and measurable. */
  let grownFor = $state<ConversationId | null>(null);

  let fetchTimer: ReturnType<typeof setTimeout> | null = null;
  let growthTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The rapid-switch guard, modelled the way the shell's is: every deferred
   * write checks that the conversation it was started for is still the open
   * one. Click alpha, bravo, charlie quickly and only charlie's rows land.
   */
  function open(id: ConversationId): void {
    active = id;
    if (fetchTimer) clearTimeout(fetchTimer);
    if (growthTimer) clearTimeout(growthTimer);
    grownFor = null;

    const cached = cache.get(id);
    if (cached) {
      loading = false;
      shown = cached;
      scheduleGrowth(id);
      return;
    }
    loading = true;
    shown = [];
    fetchTimer = setTimeout(() => {
      if (active !== id) return;
      const rows = thread(id);
      cache.set(id, rows);
      shown = rows;
      loading = false;
      scheduleGrowth(id);
    }, FETCH_MS);
  }

  function scheduleGrowth(id: ConversationId): void {
    growthTimer = setTimeout(() => {
      if (active !== id) return;
      grownFor = id;
    }, GROWTH_MS);
  }

  /**
   * Late content on the NEWEST row — the one against the composer, which is
   * exactly the row an unpinned thread pushes out of sight when it grows.
   */
  const reactions = $derived(
    grownFor === active && shown.length > 0
      ? { [shown[shown.length - 1]!.eventId]: [{ emoji: '🎉', count: 2, reactedByMe: false }] }
      : {},
  );

  // Opened from the component body, not an effect: `open` schedules timers and
  // writes state, and an effect that does both re-arms and cancels its own
  // pending timer before it can fire.
  open('alpha');

  $effect(() => () => {
    if (fetchTimer) clearTimeout(fetchTimer);
    if (growthTimer) clearTimeout(growthTimer);
  });
</script>

<div class="switch-stage" data-testid="switch-stage">
  <nav class="switch-rail" aria-label="Conversations">
    {#each CONVERSATIONS as id (id)}
      <button
        type="button"
        class="switch-row"
        class:active={active === id}
        aria-current={active === id ? 'page' : undefined}
        data-testid={`switch-to-${id}`}
        onclick={() => open(id)}
      >
        {id}
      </button>
    {/each}
  </nav>
  <div class="switch-pane">
    <!-- Fixed-height header, matching the shell's 52px channel header: it
         must not be a source of movement while the pane below changes. -->
    <header class="switch-header" data-testid="switch-header">
      <h2>{active}</h2>
    </header>
    <!-- Keyed exactly as the shell keys it: a switch is a remount. -->
    {#key active}
      <div class="conversation-layer" data-testid="conversation-layer">
        <ChannelConversation
          messages={shown}
          {loading}
          {reactions}
          emptyLabel="No messages yet"
          onsend={async () => {}}
          ontogglereaction={async () => {}}
        />
      </div>
    {/key}
  </div>
</div>

<style>
  /* The stage reproduces the shell's box for the pane under test: a fixed
     viewport, a 52px header, and a conversation that owns the rest. */
  .switch-stage {
    display: flex;
    width: 100%;
    height: 100vh;
    overflow: hidden;
    background: var(--v4-ground, #161618);
    color: var(--t1, #f4f4f5);
  }

  .switch-rail {
    display: flex;
    flex: 0 0 180px;
    flex-direction: column;
    gap: 2px;
    padding: 12px 8px;
    border-right: 1px solid var(--line, rgba(255, 255, 255, 0.08));
  }

  .switch-row {
    appearance: none;
    padding: 6px 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  /* Background highlight only — no left accent bar. */
  .switch-row.active {
    background: var(--sel, rgba(255, 255, 255, 0.08));
  }

  .switch-pane {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .switch-header {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    height: 52px;
    padding: 0 20px;
    border-bottom: 1px solid var(--line, rgba(255, 255, 255, 0.08));
  }

  .switch-header h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .conversation-layer {
    display: flex;
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
    animation: conversation-enter 140ms ease-out both;
  }

  .conversation-layer > :global(.conversation) {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }

  @keyframes conversation-enter {
    from {
      opacity: 0.55;
    }
    to {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .conversation-layer {
      animation: none;
    }
  }
</style>

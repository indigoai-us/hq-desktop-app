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
  import OfficeMap from "./OfficeMap.svelte";
  import { memberLabel, initials, humanOfficePeople, type OfficeMember } from "./office-map.js";
  import KnockCard from "./KnockCard.svelte";
  import { isNoteTooLong, KNOCK_LIMITS, type Knock } from "./knocks.js";
  import type { KnockStore } from "./knocks.svelte.js";
  import {
    OFFICE_DURATIONS,
    type OfficeConnectivity,
    type OfficeOccupancy,
    type OfficePerson,
    type OfficeStore,
    type OfficeWillingness,
    isRoomJoinable,
    isWalkIn,
  } from "./office-store.svelte.js";

  interface Props {
    store: OfficeStore;
    directory?: readonly OfficeMember[];
    chimeEnabled?: boolean;
    ontogglechime?: () => void;
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
    /**
     * "Open my door" — the host sets willingness to `open` AND makes sure there
     * is a live room to walk into, then opens the call window. Absent → the
     * button only writes the preference, which is a door with no room behind it.
     */
    onopendoor?: (ttlMs: number) => void | Promise<void>;
    /** "Open room" on a member row whose room is joinable. */
    onopenroom?: (person: OfficePerson) => void | Promise<void>;
    /** Retry after an error state. */
    onretry?: () => void | Promise<void>;

    /**
     * Knock state (US-019). Absent → the office renders with no knock surface
     * at all, rather than with dead controls.
     *
     * The view reads the store and calls back out: it never knocks by itself,
     * because knocking needs a ROOM binding and the host owns room creation.
     */
    knocks?: KnockStore | null;
    /** Knock a person, with an optional short note. */
    onknock?: (person: OfficePerson, note: string) => void | Promise<void>;
    /**
     * Accept: let the knocker into OUR room. This opens no window — the knock
     * was bound to our room, not theirs.
     */
    onacceptknock?: (knock: Knock) => void | Promise<void>;
    /** "Go to your room" on an accepted knock, when we are not in it. */
    ongotoknock?: (knock: Knock) => void | Promise<void>;
    /** Reply with text instead of opening the door. */
    onreplyknock?: (knock: Knock, text: string) => void | Promise<void>;
    ondeferknock?: (knock: Knock) => void | Promise<void>;
    ondismissknock?: (knock: Knock) => void | Promise<void>;
    oncancelknock?: (knock: Knock) => void | Promise<void>;
    /** What this device will take into the room, shown before any capture. */
    joinIntent?: { microphone: boolean; transcript: boolean };
    /** Suggested reply text when there is no DM composer to open. */
    replySuggestion?: (knock: Knock) => string;
  }

  let {
    store,
    directory = [],
    chimeEnabled = true,
    ontogglechime,
    selfPersonUid,
    displayName = (personUid: string) => personUid,
    now = () => Date.now(),
    tickMs = 1000,
    onstartroom,
    onopendoor,
    onopenroom,
    onretry,
    knocks = null,
    onknock,
    onacceptknock,
    ongotoknock,
    onreplyknock,
    ondeferknock,
    ondismissknock,
    oncancelknock,
    joinIntent = { microphone: false, transcript: false },
    replySuggestion = () => "",
  }: Props = $props();

  /** Re-render heartbeat: countdowns and lease expiry are time-dependent. */
  let mapMode = $state(true);
  let query = $state("");
  let selectedUid = $state<string | null>(null);
  const named = (uid: string) => memberLabel(uid, displayName);
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
    return humanOfficePeople(store.visiblePeople(), directory, selfPersonUid)
      .filter((person) => person.personUid !== selfPersonUid);
  });
  const self = $derived.by(() => {
    void tick;
    return store.visibleSelf() ?? humanOfficePeople([], [], selfPersonUid)[0] ?? null;
  });

  const filteredPeople = $derived(people.filter(p => named(p.personUid).toLowerCase().includes(query.toLowerCase())));
  const mapPeople = $derived(self ? [self, ...filteredPeople] : filteredPeople);
  const activeUid = $derived(filteredPeople.some(p=>p.personUid===selectedUid) ? selectedUid : filteredPeople[0]?.personUid ?? null);

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

  /**
   * Row policy (US-019). A knock asks to enter THEIR room, so what a row can
   * offer is decided entirely by what is behind their door:
   *
   *   - `open` willingness, a live room, not private  → Join, straight in.
   *   - a live room, but `knock` willingness or a private room → Knock.
   *   - no live room at all → nothing to knock on, said in words.
   *   - `dnd` → nothing at all, said in words.
   *
   * There is deliberately no "knock anyway" for someone with no room: the
   * binding a knock needs is their room, and inventing one produces an empty
   * room the server seals a minute later.
   */
  function walkIn(person: OfficePerson): boolean {
    return isWalkIn(person, at);
  }

  /** Why this row offers no knock, in words, or null when it does offer one. */
  function knockBlockedReason(person: OfficePerson): string | null {
    if (person.willingness === "dnd") return "Do not disturb — no knocks";
    if (!joinable(person)) return "No open door yet";
    return null;
  }

  const busy = $derived(view.saving);

  /**
   * Knock surface. The composer is opened per row so the office is not a wall
   * of text boxes, and the note is optional — a bare knock is the common case.
   */
  let composingFor = $state<string | null>(null);
  let note = $state("");
  const knockBusy = $derived(knocks?.state.busy === true);
  const noteTooLong = $derived(isNoteTooLong(note));
  const received = $derived.by(() => {
    void tick;
    return knocks?.visibleReceived() ?? [];
  });
  const sent = $derived.by(() => {
    void tick;
    return knocks?.visibleSent().filter((knock) => knock.state === "pending") ?? [];
  });
  const lastSend = $derived(knocks?.state.lastSend ?? null);

  /**
   * What actually happened to the last knock, in words. `created:false,
   * duplicate:true` means the server answered with the knock already pending;
   * `suppressed` means it deliberately did not disturb anyone.
   */
  const sendFeedback = $derived.by(() => {
    if (!lastSend) return null;
    if (!lastSend.ok) return lastSend.error?.message ?? "That knock was refused.";
    if (lastSend.suppressed === "dnd") {
      return "They are on do not disturb, so nothing was shown to them. Your knock was recorded.";
    }
    if (lastSend.suppressed === "pending" || lastSend.duplicate) {
      return "You already have a knock waiting with them. Nothing new was sent.";
    }
    return lastSend.waked
      ? "Knock sent."
      : "Knock sent. They may not see it until they open HQ.";
  });

  async function sendKnock(person: OfficePerson): Promise<void> {
    if (noteTooLong) return;
    const text = note;
    composingFor = null;
    note = "";
    await onknock?.(person, text);
  }
</script>

<section class="office" aria-labelledby="office-title">
  <header class="office-header">
    <div><span class="office-eyebrow">MEET / THE OFFICE</span><h1 id="office-title">A place to find each other.</h1>
    <p class="office-lede">
      See who’s around. Drop in, or knock first.
    </p></div>
    <div class="office-view-tools">{#if ontogglechime}<button class="office-button sound-toggle" aria-pressed={chimeEnabled} onclick={ontogglechime} aria-label="Knock sound">{chimeEnabled?"♪":"♩"}</button>{/if}<label><span class="sr-live">Find a person</span><input aria-label="Find a person" bind:value={query} placeholder="Find someone…" /></label><button class="office-button" aria-pressed={mapMode} onclick={()=>mapMode=true}>Map</button><button class="office-button" aria-pressed={!mapMode} onclick={()=>mapMode=false}>People</button></div>
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
      <h2><span class="self-avatar">{initials(named(selfPersonUid))}</span> Your office hours</h2>
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
            onclick={() =>
              void (choice.id === "open" && onopendoor
                ? onopendoor(ttlMs)
                : store.setWillingness(choice.id, ttlMs))}
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
          onclick={() =>
            void (onopendoor
              ? onopendoor(ttlMs)
              : store.setWillingness("open", ttlMs))}
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

    {#if knocks}
      <section class="office-knocks" class:quiet={received.length === 0 && sent.length === 0 && !sendFeedback && !knocks.state.error && !knocks.state.actionError} aria-labelledby="office-knocks-title">
        <h2 id="office-knocks-title">Knocks</h2>
        {#if sendFeedback}
          <p
            class="office-knock-feedback"
            role="status"
            aria-live="polite"
            data-testid="office-knock-feedback"
          >
            {sendFeedback}
          </p>
        {/if}
        {#if knocks.state.actionError ?? knocks.state.error}
          <!--
            An action refusal outranks a list-load error, and lives in its own
            field so the next poll's success cannot quietly erase it.
          -->
          <p role="alert" data-testid="office-knock-error">
            {(knocks.state.actionError ?? knocks.state.error)?.message}
          </p>
        {/if}
        {#if received.length === 0 && sent.length === 0}
          <p class="office-empty" data-testid="office-knocks-empty">
            No one is at your door.
          </p>
        {:else}
          <ul class="office-knock-list" data-testid="office-knock-list">
            {#each received as knock (knock.knockId)}
              <li>
                <KnockCard
                  {knock}
                  direction="received"
                  {displayName}
                  {now}
                  {tickMs}
                  {joinIntent}
                  busy={knockBusy}
                  replySuggestion={replySuggestion(knock)}
                  onaccept={onacceptknock}
                  ongoto={ongotoknock}
                  onreply={onreplyknock}
                  ondefer={ondeferknock}
                  ondismiss={ondismissknock}
                />
              </li>
            {/each}
            {#each sent as knock (knock.knockId)}
              <li>
                <KnockCard
                  {knock}
                  direction="sent"
                  {displayName}
                  {now}
                  {tickMs}
                  {joinIntent}
                  busy={knockBusy}
                  oncancel={oncancelknock}
                />
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}

    {#if view.status === "loading" && people.length === 0}
      <p class="office-empty" data-testid="office-loading">Loading the office…</p>
    {:else if mapPeople.length === 0}
      <p class="office-empty" data-testid="office-empty">
        Nobody else has office hours in this company yet. Open your door so
        teammates know they can walk in.
      </p>
    {:else}
      {#if people.length === 0}<p class="office-empty" data-testid="office-empty">Open your door so teammates know they can walk in.</p>{/if}
      <div class="office-discovery" class:people-mode={!mapMode}>
        {#if mapMode}<OfficeMap selfUid={selfPersonUid} people={mapPeople} displayName={(uid)=>uid===selfPersonUid?"You":named(uid)} selected={selectedUid===selfPersonUid ? selfPersonUid : activeUid} onselect={(uid)=>{selectedUid=uid;if(uid===selfPersonUid)document.querySelector('[data-testid="office-self"]')?.scrollIntoView({block:'nearest'});}} />{/if}
      <ul class="office-list" data-testid="office-list" aria-label={mapMode?"Selected office details":"People in this company"}>
        {#if mapMode && selectedUid===selfPersonUid}
          <li class="office-row"><span class="office-room-eyebrow">YOUR HOME BASE</span><span class="office-person-avatar" aria-hidden="true">{initials(named(selfPersonUid))}</span><span class="office-name">Your office</span><span class="office-badges"><span>{WILLINGNESS_LABEL[self?.willingness ?? "knock"]}</span><span>{CONNECTIVITY_LABEL[self?.connectivity ?? "offline"]}</span></span><p class="office-empty">Your door stays with you while you work.</p><button class="office-button" onclick={()=>document.querySelector('[data-testid="office-self"]')?.scrollIntoView({block:'nearest'})}>Manage your door</button></li>
        {/if}
        {#each people as person (person.personUid)}
          <li class="office-row" hidden={!filteredPeople.includes(person) || (mapMode && (selectedUid===selfPersonUid || person.personUid!==activeUid))} data-testid={`office-row-${person.personUid}`}>
            <span class="office-room-eyebrow">{mapMode?"ROOM OVERVIEW":"TEAM MEMBER"}</span>
            <div class="office-room-art" aria-hidden="true"><span class="office-person-avatar">{initials(named(person.personUid))}</span></div>
            <span class="office-name">{person.room ? "Conversation" : named(person.personUid)+"’s office"}</span>

            <span class="office-badges">
              <span
                class="office-badge"
                data-kind="connectivity"
                data-value={person.connectivity}
                data-testid={`office-connectivity-${person.personUid}`}
              >
                {person.presenceUnknown ? "Availability not shared" : CONNECTIVITY_LABEL[person.connectivity]}
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
                {person.presenceUnknown ? "Door status not shared" : WILLINGNESS_LABEL[person.willingness]}
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
                {person.presenceUnknown ? "No room shared" : OCCUPANCY_LABEL[person.occupancy]}
                {#if remaining(person.occupancyExpiresAt)}
                  <span class="office-expiry">
                    · {remaining(person.occupancyExpiresAt)}
                  </span>
                {/if}
              </span>
            </span>

            <p class="room-description">{person.presenceUnknown ? "Their office is here. Live availability hasn’t been shared yet." : person.room ? "A conversation is happening here. Check the door before joining." : "A home base for working independently. A call starts when people join a room."}</p>
            <div class="room-occupants"><span class="office-room-eyebrow">{person.room ? "IN THIS ROOM" : "OFFICE OWNER"}</span>
              {#each (person.room ? person.room.participants.filter(uid=>!uid.startsWith('agt_') && !uid.startsWith('agent:')) : [person.personUid]) as uid}
                <div class="occupant"><span class="self-avatar">{initials(named(uid))}</span><span>{named(uid)}</span></div>
              {/each}
            </div>
            <span class="office-actions">
              {#if knocks && walkIn(person)}
                <!--
                  Their door is open and their room is company-visible: walking
                  in needs nobody's permission, so asking for it would be
                  ceremony. No knock is offered alongside it.
                -->
                <button
                  type="button"
                  class="office-button office-button-primary"
                  data-testid={`office-open-room-${person.personUid}`}
                  onclick={() => void onopenroom?.(person)}
                >
                  Join
                </button>
              {:else if knocks && knockBlockedReason(person) === null}
                <button
                  type="button"
                  class="office-button"
                  data-testid={`office-knock-${person.personUid}`}
                  disabled={knockBusy}
                  onclick={() =>
                    (composingFor =
                      composingFor === person.personUid
                        ? null
                        : person.personUid)}
                  aria-expanded={composingFor === person.personUid}
                >
                  Knock
                </button>
                <span
                  class="office-soon"
                  data-testid={`office-knock-note-why-${person.personUid}`}
                >
                  They ask to be knocked on first.
                </span>
              {:else if knocks}
                <!--
                  A reason, not a dead button: a permanently disabled control is
                  focus-skipped and explains nothing. Do-not-disturb would be
                  suppressed server-side anyway, and someone with no live room
                  has no binding for a knock to name.
                -->
                <span
                  class="office-soon"
                  data-testid={person.willingness === "dnd"
                    ? `office-knock-dnd-${person.personUid}`
                    : `office-knock-none-${person.personUid}`}
                >
                  {knockBlockedReason(person)}
                </span>
              {:else}
                <!--
                  No knock surface was handed in (a host that has not wired
                  US-019). A permanently disabled button would be a dead end for
                  keyboard and screen-reader users — focus-skipped, announcing
                  nothing about why, and still looking like the primary action.
                  A plain note says the same thing honestly.
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
              {/if}
            </span>

            {#if knocks && composingFor === person.personUid}
              <div
                class="office-knock-composer"
                data-testid={`office-knock-composer-${person.personUid}`}
              >
                <label for={`office-knock-note-${person.personUid}`}>
                  Add a note (optional)
                </label>
                <input
                  id={`office-knock-note-${person.personUid}`}
                  data-testid={`office-knock-note-${person.personUid}`}
                  type="text"
                  bind:value={note}
                  placeholder="Two minutes on the pricing page?"
                />
                <span class="office-expiry">
                  Up to {KNOCK_LIMITS.noteMaxBytes} bytes. They get a quiet
                  notification, not a ring.
                </span>
                {#if noteTooLong}
                  <span role="alert" data-testid="office-knock-note-too-long">
                    That note is too long. Shorten it and knock again.
                  </span>
                {/if}
                <p class="room-description">{person.presenceUnknown ? "Their office is here. Live availability hasn’t been shared yet." : person.room ? "A conversation is happening here. Check the door before joining." : "A home base for working independently. A call starts when people join a room."}</p>
            <div class="room-occupants"><span class="office-room-eyebrow">{person.room ? "IN THIS ROOM" : "OFFICE OWNER"}</span>
              {#each (person.room ? person.room.participants.filter(uid=>!uid.startsWith('agt_') && !uid.startsWith('agent:')) : [person.personUid]) as uid}
                <div class="occupant"><span class="self-avatar">{initials(named(uid))}</span><span>{named(uid)}</span></div>
              {/each}
            </div>
            <span class="office-actions">
                  <button
                    type="button"
                    class="office-button office-button-primary"
                    data-testid={`office-knock-send-${person.personUid}`}
                    disabled={knockBusy || noteTooLong}
                    onclick={() => void sendKnock(person)}
                  >
                    Send knock
                  </button>
                  <button
                    type="button"
                    class="office-button"
                    data-testid={`office-knock-cancel-${person.personUid}`}
                    onclick={() => {
                      composingFor = null;
                      note = "";
                    }}
                  >
                    Never mind
                  </button>
                </span>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      <p class="office-presence-note">Being online does not mean being available. Each door shows its own entry policy.</p>
      {#if filteredPeople.length===0}<p class="office-empty">No people match your search.</p>{/if}
      </div>

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

  .office-knocks {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2, 8px);
  }

  .office-knocks h2 {
    margin: 0;
    font-size: var(--type-section, 17px);
    font-weight: 600;
  }

  .office-knock-feedback {
    margin: 0;
    font-size: var(--type-secondary, 14px);
  }

  .office-knock-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2, 8px);
  }

  .office-knock-composer {
    display: flex;
    flex-direction: column;
    gap: var(--v4-row-stack-gap, 3px);
    flex: 1 0 100%;
    font-size: var(--type-secondary, 14px);
  }

  .office-knock-composer input {
    font: inherit;
    padding: 6px 8px;
    border: 1px solid var(--v4-border, rgba(0, 0, 0, 0.12));
    border-radius: var(--v4-radius-button, 6px);
    background: transparent;
    color: inherit;
  }

  .office-knock-composer input:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }

  .office-empty {
    margin: 0;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 14px);
  }

  .office{padding:24px;gap:20px;min-height:680px;background:var(--v4-ground,#151817);font-family:var(--font-sans,system-ui)}
  .office-header{display:flex;align-items:center;justify-content:space-between;gap:18px;order:0}.office-header h1{font-weight:500;letter-spacing:-.6px;margin:7px 0;font-size:var(--type-detail,24px)}.office-eyebrow,.office-room-eyebrow{font:11px ui-monospace,monospace;letter-spacing:1.3px;color:var(--v4-text-3,#8f9d93)}.office-view-tools{display:flex;gap:5px;align-items:center}.office-view-tools input{width:155px;padding:9px 12px;border:1px solid var(--v4-hairline,#ffffff16);border-radius:7px;background:var(--v4-inset,#ffffff04);color:inherit;font:inherit;font-size:12px}.office-lede{color:var(--v4-text-2,#a4b0a8);font-size:13px}
  .office-duration select{padding:8px;border-radius:7px;border:1px solid var(--v4-hairline,#ffffff20);background:var(--v4-inset,#ffffff05);color:inherit;font:inherit;font-size:12px}
  .office-presence-note{grid-column:1/-1;font-size:11px;color:var(--v4-text-3,#9aa99e);margin:10px 0 0}.office-discovery{display:grid;grid-template-columns:minmax(350px,1fr) 260px;gap:0;order:1;min-height:520px}.office-discovery.people-mode{display:block}.office-list{padding:24px;border:1px solid var(--v4-hairline,#ffffff14);border-radius:12px;background:var(--v4-ground,#191e1b);gap:15px}.office-row{border:0;padding:0;flex-direction:column;align-items:flex-start;gap:18px}.office-row[hidden]{display:none}.office-name{font-size:21px;font-weight:500;overflow-wrap:anywhere}.office-badges{flex-direction:column;gap:8px}.office-badge{border:0;padding:0;font-size:12px;color:var(--v4-text-2,#b5c2b9)}.office-person-avatar,.self-avatar{display:inline-grid;place-items:center;background:var(--v4-inset,#6f88732a);border:1px solid var(--v4-hairline,#ffffff20);border-radius:50%;width:54px;height:54px;font-size:17px}.office-person-avatar{margin:14px 0;box-shadow:0 12px 35px #0002}.office-actions{flex-wrap:wrap}.office-button-primary{background:var(--v4-text-1,#e0e9e2);color:var(--v4-ground,#18221b);border-color:transparent}.office-button,.office-segment{font-size:12px;padding:9px 12px;border-color:var(--v4-hairline,#ffffff20);border-radius:7px}.office-actions .office-soon{white-space:normal;line-height:1.7}.office-self{order:3;flex-direction:row;align-items:center;flex-wrap:wrap;gap:12px;background:var(--v4-raised,#191e1b);border-color:var(--v4-hairline,#ffffff16)}.office-self h2{font-size:13px;display:flex;align-items:center;gap:10px;margin-right:auto}.self-avatar{width:32px;height:32px;font-size:11px}.office-self-state{font-size:12px}.office-self-actions{flex-basis:100%;justify-content:flex-end}.office-knocks{order:2;border:1px solid var(--v4-hairline,#ffffff14);padding:16px;border-radius:10px}.office-knocks h2{font-size:14px}.office-empty{font-size:12px}.office-notice{order:1}.people-mode .office-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}.people-mode .office-row{border:1px solid var(--v4-hairline,#ffffff14);border-radius:10px;padding:16px}.people-mode .office-person-avatar{margin:0}.people-mode .office-name{font-size:16px}
  .office{--v4-ground:#111413;--v4-raised:#1c2521;--v4-inset:#101513;--v4-text-1:#f0f3f1;--v4-text-2:#a5b3aa;--v4-text-3:#809087;--v4-hairline:#ffffff14;color:var(--v4-text-1);padding:22px 28px;gap:16px;min-height:0}.office-discovery{min-height:470px;grid-template-columns:minmax(350px,1fr) 250px}.office-list{border-radius:0 12px 12px 0;background:#151a17;padding:26px}.office-knocks.quiet{display:flex;align-items:center;gap:16px;padding:0;border:0}.office-knocks.quiet h2{font-size:12px;margin:0}.office-knocks.quiet p{margin:0;color:#829087}.office-self{padding:14px 18px;background:#191e1b}.office-self-actions{flex-basis:auto}.office-header h1{font-size:26px}.office-self-state{margin:0}.office-presence-note{margin:0}
  .office{height:100%;box-sizing:border-box;overflow:hidden;padding:0;gap:0;min-height:550px}.office-header{padding:20px 26px;border-bottom:1px solid #ffffff12;flex-shrink:0}.office-header h1{font-size:24px}.office-discovery{flex:1;min-height:0;overflow:hidden;grid-template-columns:minmax(350px,1fr) 290px}.office-list{border:0;border-left:1px solid #ffffff12;border-radius:0;overflow:auto;display:block}.office-row{gap:14px}.office-room-art{height:112px;width:100%;display:grid;place-items:center;position:relative;background:radial-gradient(ellipse,#55756322,transparent 70%);flex-shrink:0}.office-room-art:before{content:"";position:absolute;width:110px;height:74px;transform:rotate(-28deg) skew(25deg);background:linear-gradient(135deg,#344c3e55,#1c2922);border:1px solid #93ae9c55;box-shadow:-10px -10px 0 -9px #9cb9a060,8px 10px 0 #18241e}.office-room-art .office-person-avatar{z-index:1;width:44px;height:44px;margin:0;background:#48584d}.office-name{font-size:22px}.office-badges{gap:5px}.room-description{font-size:12px;line-height:1.7;color:#a5b3aa;margin:0}.room-occupants{border-block:1px solid #ffffff12;width:100%;padding:16px 0;display:grid;gap:12px}.occupant{display:flex;align-items:center;gap:10px;font-size:12px}.office-actions{width:100%;margin-top:auto}.office-actions button{width:100%}.office-self{border:0;border-top:1px solid #ffffff14;border-radius:0;flex-shrink:0;padding:12px 22px;gap:10px}.office-self-actions{gap:6px}.office-self h2{margin:0 auto 0 0}.office-knocks.quiet{display:none;height:28px;flex-shrink:0;padding:0 24px;background:#111714}.office-knocks:not(.quiet){max-height:180px;overflow:auto;margin:0;border-radius:0}.office-presence-note{display:none}.office-expiry{font-variant-numeric:tabular-nums}.people-mode .office-room-art{display:none}.people-mode .room-description,.people-mode .room-occupants{display:none}
  @media(max-width:950px){.office-discovery{grid-template-columns:1fr}.office-header{flex-wrap:wrap}.office-row{flex-direction:row;align-items:center}.office-badges{flex-direction:row}.office-room-eyebrow{flex-basis:100%}.office-self-actions{justify-content:flex-start}}
</style>

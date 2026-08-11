<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import type { GoogleAccount, MeetingEvent } from '../lib/meetings-model';
  import { getHomeTodayAgenda } from '../v4/home-model';

  /**
   * Home "Today" schedule rail — owns its calendar data.
   *
   * First paint uses the cached `meetingEvents` prop (from DesktopApp's
   * loadMeetingsCache) so the rail is instant when cache already has today.
   * On mount it refreshes via `meetings_list_accounts` + `meetings_list_upcoming`.
   *
   * Hidden entirely (renders nothing — no empty-state copy) when:
   *   • accounts fetch fails or returns empty
   *   • events fetch fails (4xx / absent API)
   *   • {@link getHomeTodayAgenda} returns no items
   */
  interface Props {
    /** Cached calendar events — filtered to today for the agenda. */
    meetingEvents?: MeetingEvent[];
    /** company UID → display name, for each row's company label. */
    companyNamesByUid?: Map<string, string>;
  }

  let {
    meetingEvents = [],
    companyNamesByUid = new Map(),
  }: Props = $props();

  /** Live events once a successful refresh lands; null means "use cache prop". */
  let liveEvents = $state<MeetingEvent[] | null>(null);
  /** False after accounts fail or return empty — hide the rail. */
  let accountsOk = $state(true);
  /** False after events invoke fails — hide the rail (never show stale cache as live). */
  let eventsFetchOk = $state(true);

  const events = $derived(liveEvents ?? meetingEvents);
  const agenda = $derived(getHomeTodayAgenda({ events, companyNamesByUid }));
  const visible = $derived(accountsOk && eventsFetchOk && agenda.length > 0);

  $effect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const accounts = await invoke<GoogleAccount[]>('meetings_list_accounts');
        if (cancelled) return;
        if (!accounts || accounts.length === 0) {
          accountsOk = false;
          return;
        }
        accountsOk = true;
        try {
          const upcoming = await invoke<MeetingEvent[]>('meetings_list_upcoming');
          if (cancelled) return;
          liveEvents = upcoming ?? [];
          eventsFetchOk = true;
        } catch {
          if (!cancelled) eventsFetchOk = false;
        }
      } catch {
        if (!cancelled) accountsOk = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  });
</script>

{#if visible}
  <div class="home-col home-col-rail today-schedule-rail" data-testid="today-schedule-rail">
    <section class="home-section" aria-label="Today">
      <h2 class="home-label">Today · {agenda.length}</h2>
      <div class="home-agenda">
        {#each agenda as item (item.id)}
          <div class="home-agenda-row">
            <span class="home-agenda-time">{item.time}</span>
            <span class="home-agenda-copy">
              <span class="home-agenda-title">{item.title}</span>
              <span class="home-agenda-company">{item.company}</span>
            </span>
          </div>
        {/each}
      </div>
    </section>
  </div>
{/if}

<style>
  .home-col {
    display: grid;
    gap: var(--v4-space-5);
    align-content: start;
    min-width: 0;
  }

  .home-section {
    display: grid;
    gap: var(--v4-space-2);
  }

  .home-label {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 0;
    color: var(--v4-text-3);
    font-size: var(--text-base);
    font-weight: 400;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .home-agenda {
    display: grid;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    overflow: visible;
  }

  .home-agenda-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--v4-rowline);
  }

  .home-agenda-row:last-child {
    border-bottom: none;
  }

  .home-agenda-time {
    flex: 0 0 60px;
    color: var(--v4-text-2);
    font-size: var(--text-base);
  }

  .home-agenda-copy {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .home-agenda-title {
    color: var(--v4-text-1);
    font-size: var(--text-base);
    line-height: 1.3;
  }

  .home-agenda-company {
    color: var(--v4-text-3);
    font-size: var(--text-base);
  }
</style>

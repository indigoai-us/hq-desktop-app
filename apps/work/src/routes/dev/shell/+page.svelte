<script lang="ts">
  /**
   * DEV-ONLY design harness for the shipped desktop shell.
   *
   * Mounts the real `DesktopApp` — the same component `apps/sync` boots through
   * HqWorkWorkShell and the web app renders at `/` — against the fixture APIs
   * exported from `@hq/ui`. No Tauri build, no sign-in, no network: design work
   * on the shell can happen in a browser tab with instant reload, against the
   * component that actually ships.
   *
   * Follows the `dev/chat-demo` precedent: guarded by `dev`, so a production
   * build renders nothing.
   *
   * Not covered here (still needs the real app): native window chrome, OS
   * notifications, the menu bar, and anything behind a native capability.
   */
  import { dev } from "$app/environment";
  import { ok, type PlatformAdapter } from "@hq/platform";
  import {
    DesktopApp,
    FIXTURE_COMPANIES,
    FIXTURE_INITIAL_ROW,
    FIXTURE_SEARCH_ROWS,
    FIXTURE_SETTINGS_PROFILE,
    createChatWakeBus,
    createFixtureChatSidebarApi,
    createFixtureNotificationsApi,
    fixtureBoardFor,
    fixtureChannelStatusFor,
    fixtureFilesFor,
    fixtureMessagesFor,
    fixtureReactionsFor,
    seedFixturePins,
  } from "@hq/ui";

  /**
   * The shell only reaches the adapter for host concerns (contacts, history
   * fetches, native capabilities). Each one answers empty here — everything
   * visible comes from the injected fixtures below, so the surface is
   * deterministic and reloads identically every time.
   *
   * Slices the shell calls but that carry no design surface fall through to
   * `emptySlice`, which answers every method with an empty ok(). That keeps the
   * console clean without pretending to model 18 host APIs.
   */
  const adapter = {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      listChannelMembers: async () => ok({ members: [] }),
    },
    // The Meetings page polls on mount; answering it keeps the console clean.
    meetings: {
      listUpcoming: async () => ok([]),
      listMemberships: async () => ok([]),
    },
  } as unknown as PlatformAdapter;

  const self = {
    uid: "prs_designer",
    displayName: "Lizzie Liu",
    email: "lizzie@getindigo.ai",
  };

  // Pins live in localStorage; seed them before first paint so the sidebar
  // opens with its pinned section populated.
  if (dev) seedFixturePins();

  const sidebarApi = createFixtureChatSidebarApi();
  const notificationsApi = createFixtureNotificationsApi();
  const wakes = createChatWakeBus();

  /**
   * `seedDirectory` is read once at mount, so the rows have to be in hand
   * before DesktopApp is created — otherwise the sidebar paints its empty
   * state and never backfills. Await the fixture feed first.
   */
  const directory = sidebarApi
    .fetchChannelDirectory(null)
    .then((feed) => feed.rows);
</script>

<svelte:head>
  <title>HQ — shell design harness</title>
</svelte:head>

{#if dev}
  <div class="harness-root">
    {#await directory}
      <p class="off">Loading fixtures…</p>
    {:then seedDirectory}
      <DesktopApp
        {adapter}
        {sidebarApi}
        {notificationsApi}
        {wakes}
        {self}
        {seedDirectory}
        version="dev"
        companies={FIXTURE_COMPANIES}
        initialRow={FIXTURE_INITIAL_ROW}
        searchRows={FIXTURE_SEARCH_ROWS}
        settingsProfile={FIXTURE_SETTINGS_PROFILE}
        messagesByRow={fixtureMessagesFor}
        reactionsByRow={fixtureReactionsFor}
        boardByRow={fixtureBoardFor}
        filesByRow={fixtureFilesFor}
        channelStatusByRow={fixtureChannelStatusFor}
        coreFixtures={true}
        onopenurl={(url) => window.open(url, "_blank", "noopener")}
      />
    {:catch error}
      <p class="off">Fixture load failed: {error}</p>
    {/await}
  </div>
{:else}
  <p class="off">This harness is development-only.</p>
{/if}

<style>
  /* Mirrors WorkShell's .shell-root so the shell lays out exactly as it does in
     the product, and fills the tab the way it fills the app window. */
  .harness-root {
    position: relative;
    width: 100%;
    height: 100vh;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .off {
    padding: 2rem;
    font: inherit;
  }
</style>

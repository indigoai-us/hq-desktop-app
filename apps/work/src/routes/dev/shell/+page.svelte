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
   * Not covered here (still needs the real app): OS notifications, the menu
   * bar, and anything behind a native capability. The window chrome below is a
   * stand-in drawn to the shipping metrics, not the real AppKit one.
   */
  import { dev } from "$app/environment";
  import { TAURI_CAPABILITIES, ok, type PlatformAdapter } from "@hq/platform";
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
    settingsArea,
  } from "@hq/ui";
  import SessionsHarnessPage from "./SessionsHarnessPage.svelte";

  /**
   * The shell only reaches the adapter for host concerns (contacts, history
   * fetches, native capabilities). Each one answers empty here — everything
   * visible comes from the injected fixtures below, so the surface is
   * deterministic and reloads identically every time.
   *
   * Capabilities are the desktop set, not the web set. This is the difference
   * between previewing the shipped shell and previewing a subset of it: half
   * the window chrome is capability-gated, so a web-capability harness
   * silently drops the Launch pill, the HQ folder and Console buttons, the
   * Core popover, and the local-only rails — none of which announce that they
   * are missing. Design review then happens against a window the product
   * never renders.
   *
   * `isAvailable` has to agree with the table: several controls ask through it
   * rather than reading `capabilities` directly.
   */
  /**
   * Turning the desktop capabilities on turns on the code paths behind them —
   * sync status, packages, sessions, local files — so the slices they reach
   * for have to exist. Rather than model eighteen host APIs, unknown slices
   * fall through to `emptySlice`, which answers any method with an empty
   * `ok()`: `list*` yields `[]`, everything else `{}`.
   *
   * Explicit slices are for the ones whose shape the UI actually reads. They
   * are layered *over* the fallback rather than replacing it, so naming one
   * method on a slice does not silently remove the other seventeen.
   */
  const emptySlice = new Proxy(
    {},
    {
      get:
        (_target, method) =>
        async () =>
          typeof method === "string" && method.startsWith("list")
            ? ok([])
            : ok({}),
    },
  );

  /** An explicit slice that still answers everything else with an empty ok(). */
  const slice = (methods: Record<string, unknown>) =>
    new Proxy(methods, {
      get: (target, method) =>
        method in target
          ? target[method as keyof typeof target]
          : emptySlice[method as keyof typeof emptySlice],
    });

  const adapter = new Proxy(
    {
      kind: "tauri",
      isAvailable: (capability: keyof typeof TAURI_CAPABILITIES) =>
        TAURI_CAPABILITIES[capability] ?? false,
      capabilities: TAURI_CAPABILITIES,
      messaging: slice({
        listContacts: async () => ok({ contacts: [] }),
        fetchChannel: async () => ok({ messages: [], nextCursor: null }),
        fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
        listChannelMembers: async () => ok({ members: [] }),
      }),
      meetings: slice({
        listUpcoming: async () => ok([]),
      }),
    } as Record<string | symbol, unknown>,
    {
      get: (target, prop) => (prop in target ? target[prop] : emptySlice),
    },
  ) as unknown as PlatformAdapter;

  const self = {
    uid: "prs_designer",
    displayName: "Lizzie Liu",
    email: "lizzie@getindigo.ai",
  };

  // Pins live in localStorage; seed them before first paint so the sidebar
  // opens with its pinned section populated.
  if (dev) seedFixturePins();

  /**
   * Desktop stage. The shipping window is transparent with an AppKit vibrancy
   * material behind it (src-tauri/src/glass.rs), so every surface token is an
   * alpha over whatever is on the desktop. A browser tab has nothing behind
   * it, which reads those same tokens as flat grey and makes translucency
   * impossible to judge.
   *
   * So: put a wallpaper behind the window, and blur it with the app's own
   * `--v4-glass-filter` values — the closest a browser gets to the native
   * material. Pass `?stage=off` for full-bleed, or `?wallpaper=<url>` to judge
   * the tint against your own desktop picture.
   */
  const params = new URLSearchParams(
    typeof location === "undefined" ? "" : location.search,
  );
  const staged = params.get("stage") !== "off";
  const wallpaper = params.get("wallpaper");

  /**
   * Appearance. Not a harness invention: this is the same `applyColorTheme`
   * seam the shipped Settings → Appearance radios drive, writing
   * `data-force-theme` on <html> and remembering the choice in localStorage.
   * So what the toggle shows is what a user switching themes in the app sees.
   */
  type Theme = "light" | "dark" | "system";
  const THEMES: Theme[] = ["light", "dark", "system"];
  // Client-only route (`+page.ts` sets `ssr = false`), so localStorage is
  // readable at module scope and the stage opens on the last theme picked.
  let theme = $state<Theme>(settingsArea.readStoredTheme() as Theme);
  // The desktop applies the stored theme during boot; nothing does that here,
  // so replay it before first paint or the toggle would disagree with <html>.
  if (dev) settingsArea.applyColorTheme(theme);

  function setTheme(next: Theme) {
    theme = settingsArea.applyColorTheme(next) as Theme;
  }

  const sidebarApi = createFixtureChatSidebarApi();
  const notificationsApi = createFixtureNotificationsApi();
  const wakes = createChatWakeBus();

  /**
   * `seedDirectory` is read once at mount, so the rows have to be in hand
   * before DesktopApp is created — otherwise the sidebar paints its empty
   * state and never backfills. Await the fixture feed first.
   */
  /**
   * The shipped fixtures carry no #welcome row, so the setup pane — the
   * onboarding surface a new user meets first — had no way to render here.
   * The shell keys it off the channel id, so one synthetic row is enough.
   */
  const SETUP_ROW = {
    channelId: "setup",
    type: "project",
    scope: "personal",
    companyUid: null,
    name: "welcome",
    subtitle: "getting started",
    lastActivityAt: new Date().toISOString(),
    unreadCount: 0,
    memberCount: 1,
  };

  const directory = sidebarApi
    .fetchChannelDirectory(null)
    .then((feed) => {
      const rows = feed.rows ?? [];
      return rows.some((r) => r.channelId === "setup")
        ? rows
        : [SETUP_ROW as (typeof rows)[number], ...rows];
    });
</script>

<svelte:head>
  <title>HQ — shell design harness</title>
</svelte:head>

{#if dev}
  <div
    class="stage"
    class:staged
    style={wallpaper ? `--wallpaper: url("${wallpaper}")` : undefined}
  >
    <div class="harness-root">
      <!-- Stand-in for the macOS traffic lights the real window gets from
           AppKit. Drawn to the shipping metrics from titlebar-layout.ts
           (close at x=20, 20px pitch, centred on the 48px titlebar) so the
           gutter the titlebar reserves is filled by something the eye can
           judge spacing against. Decorative — the real ones are the OS's. -->
      <div class="window-controls" aria-hidden="true">
        <span class="light close"></span>
        <span class="light minimize"></span>
        <span class="light zoom"></span>
      </div>

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
        extraPages={{
          sessions: {
            label: "Sessions",
            detail: "Run a Codex or Claude session inside the app",
            createAction: { label: "New session", param: () => "new" },
            component: SessionsHarnessPage,
          },
        }}
          onopenurl={(url) => window.open(url, "_blank", "noopener")}
        />
      {:catch error}
        <p class="off">Fixture load failed: {error}</p>
      {/await}
    </div>

    <!-- Harness chrome, deliberately outside the window so it never sits on
         top of the surface being judged. -->
    <div class="harness-bar">
      {#each THEMES as option (option)}
        <button
          type="button"
          class:on={theme === option}
          onclick={() => setTheme(option)}
        >
          {option}
        </button>
      {/each}
    </div>
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

  /* ── Desktop stage ───────────────────────────────────────────────────
     Stands in for the desktop behind a transparent window. A busy backdrop
     is the point: a flat one can't show whether a surface is tinting or
     just grey. */
  .stage.staged {
    --wallpaper: linear-gradient(
      135deg,
      #1b2a4a 0%,
      #3d2f63 28%,
      #7b3f6d 52%,
      #c96a54 74%,
      #f0b37a 100%
    );

    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 44px 44px 92px;
    background-image: var(--wallpaper);
    background-size: cover;
    background-position: center;
  }

  /* The window material, copied from the V2 concept harness
     (apps/sync/dev-harness/Harness.svelte, `.mac-window.v2-window`) on the
     design/desktop-os-redesign branch — the same values the preview at
     hq-desktop-preview-v2.indigo-hq.com renders.

     This matters more than it looks: the window carries most of the opacity
     (0.82 light / 0.86 dark) and the shell's own surfaces are thin alphas on
     top. Get the window wrong and every surface above it reads wrong. In the
     shipped app this backing is the native macOS glass, which CSS cannot set
     — which is exactly why it has to be emulated faithfully here. */
  .stage.staged .harness-root {
    width: min(1180px, 100%);
    height: min(800px, 100%);
    border-radius: 18px;
    background: rgba(250, 250, 252, 0.82);
    backdrop-filter: blur(60px) saturate(1.6);
    -webkit-backdrop-filter: blur(60px) saturate(1.6);
    box-shadow:
      0 0 0 1px rgba(0, 0, 0, 0.23),
      0 16px 48px rgba(0, 0, 0, 0.35);
  }

  :global(html[data-force-theme="dark"]) .stage.staged .harness-root {
    background: rgba(14, 14, 18, 0.86);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.12),
      0 16px 48px rgba(0, 0, 0, 0.55);
  }

  /* ── Window controls ─────────────────────────────────────────────────
     Geometry pinned to titlebar-layout.ts: TITLEBAR_TRAFFIC_LIGHT_X_PX = 20,
     TITLEBAR_HEIGHT_PX = 48. 12px buttons on a 20px pitch end at x=72, just
     inside the 78px gutter `.has-window-controls` reserves. */
  .window-controls {
    position: absolute;
    top: 0;
    left: 20px;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 48px;
    pointer-events: none;
  }

  .light {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 0.5px rgb(0 0 0 / 12%);
  }

  .close {
    background: #ff5f57;
  }
  .minimize {
    background: #febc2e;
  }
  .zoom {
    background: #28c840;
  }

  /* ── Harness chrome ──────────────────────────────────────────────── */
  .harness-bar {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 30;
    display: flex;
    gap: 2px;
    padding: 3px;
    border-radius: 999px;
    background: rgb(20 20 22 / 55%);
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / 14%);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
  }

  .harness-bar button {
    padding: 5px 12px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: rgb(255 255 255 / 62%);
    font: inherit;
    font-size: 12px;
    text-transform: capitalize;
    cursor: pointer;
  }

  .harness-bar button:hover {
    color: rgb(255 255 255 / 92%);
  }

  .harness-bar button.on {
    background: rgb(255 255 255 / 16%);
    color: #fff;
  }

  .off {
    padding: 2rem;
    font: inherit;
  }
</style>

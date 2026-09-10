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
  import { WEB_CAPABILITIES, ok, type PlatformAdapter } from "@hq/platform";
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

  /**
   * The shell only reaches the adapter for host concerns (contacts, history
   * fetches, native capabilities). Each one answers empty here — everything
   * visible comes from the injected fixtures below, so the surface is
   * deterministic and reloads identically every time.
   *
   * Capabilities are the web set with `hasWindowControls` flipped on: that one
   * flag is what makes the titlebar reserve its 78px macOS traffic-light
   * gutter, so the chrome lays out the way it does on the desktop instead of
   * flush-left the way it does on the web. The rest stay web-false — this is a
   * browser tab with no local machine behind it.
   */
  const adapter = {
    kind: "web",
    isAvailable: () => false,
    capabilities: { ...WEB_CAPABILITIES, hasWindowControls: true },
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
      listAccounts: async () => ok([]),
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

  /**
   * Window transparency, 0–100. Every surface token is an alpha derived from
   * this, so it is the single strongest lever on how much desktop shows
   * through — and at the shipping default of 65 the light ground lands around
   * 34% opaque, which is why light mode reads as wallpaper-with-a-haze rather
   * than tinted white.
   *
   * The three properties below are the same ones the desktop's appearance
   * preferences write at boot (apps/sync/src/lib/appearancePreferences.ts);
   * duplicated rather than imported because that module is a `@hq/sync`
   * internal, not a package export. Keep the arithmetic in lockstep.
   */
  const DEFAULT_TRANSPARENCY = 65;
  let transparency = $state(DEFAULT_TRANSPARENCY);

  function applyTransparency(value: number) {
    transparency = Math.min(100, Math.max(0, Math.round(value)));
    const root = document.documentElement;
    const lightAlpha = Math.max(0.15, 1 - transparency / 100);
    const darkAlpha = Math.min(1, lightAlpha + 0.13);
    root.style.setProperty(
      "--hq-window-transparency-factor",
      (transparency / 100).toFixed(2),
    );
    root.style.setProperty("--hq-window-alpha-light", lightAlpha.toFixed(2));
    root.style.setProperty("--hq-window-alpha-dark", darkAlpha.toFixed(2));
    root.dataset.windowTransparency = String(transparency);
  }

  if (dev) applyTransparency(DEFAULT_TRANSPARENCY);

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

      <span class="divider" aria-hidden="true"></span>

      <label class="slider">
        <span>Transparency</span>
        <input
          type="range"
          min="0"
          max="100"
          value={transparency}
          oninput={(e) => applyTransparency(e.currentTarget.valueAsNumber)}
        />
        <output>{transparency}</output>
      </label>
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
    padding: clamp(16px, 3vw, 48px);
    background-image: var(--wallpaper);
    background-size: cover;
    background-position: center;
  }

  /* The window: rounded, shadowed, and blurring what is behind it with the
     app's own glass values — the browser's nearest equivalent to the AppKit
     material the real window sits on. */
  .stage.staged .harness-root {
    height: 100%;
    max-width: 1440px;
    max-height: 900px;
    border-radius: 12px;
    box-shadow:
      0 1px 0 rgb(255 255 255 / 12%) inset,
      0 30px 80px rgb(0 0 0 / 45%);
    backdrop-filter: blur(28px) saturate(122%) contrast(102%);
    -webkit-backdrop-filter: blur(28px) saturate(122%) contrast(102%);
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

  .divider {
    align-self: stretch;
    width: 1px;
    margin: 4px 6px;
    background: rgb(255 255 255 / 16%);
  }

  .slider {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px 0 4px;
    color: rgb(255 255 255 / 62%);
    font-size: 12px;
  }

  .slider input {
    width: 108px;
    accent-color: #fff;
  }

  .slider output {
    min-width: 2ch;
    color: #fff;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .off {
    padding: 2rem;
    font: inherit;
  }
</style>

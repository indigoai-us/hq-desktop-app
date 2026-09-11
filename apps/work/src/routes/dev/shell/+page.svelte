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
    createFixtureConversationApi,
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

  /**
   * The shell paints `messagesByRow` first, then re-hydrates from the host and
   * commits whatever comes back. An adapter that answered `fetchChannel` with
   * an empty page therefore wiped the seeded thread a beat after it appeared —
   * the conversation would flash in and fall back to "No activity yet". Answer
   * from the same fixtures the shell was seeded with instead.
   */
  const fixtureConversation = createFixtureConversationApi();

  const adapter = new Proxy(
    {
      kind: "tauri",
      isAvailable: (capability: keyof typeof TAURI_CAPABILITIES) =>
        TAURI_CAPABILITIES[capability] ?? false,
      capabilities: TAURI_CAPABILITIES,
      messaging: slice({
        listContacts: async () => ok({ contacts: [] }),
        // #welcome's lifecycle cards are seeded, not part of the shipped
        // fixtures — so the re-hydrate has to answer with them too. Answering
        // from the generic fixture wiped the cards a beat after they painted.
        fetchChannel: async (args: { channelId: string }) => {
          if (args.channelId === "setup") {
            return ok({ messages: SETUP_MESSAGES, nextCursor: null });
          }
          const page = await fixtureConversation.fetchChannel(args);
          if (args.channelId === "agent-orchestrator") {
            return ok({
              ...page,
              messages: [...(page.messages ?? []), ...ATTACHMENT_MESSAGES],
            });
          }
          return ok(page);
        },
        fetchDmThread: async (args: { withPersonUid: string }) =>
          ok(await fixtureConversation.fetchDmThread(args)),
        // Without this the reply panel asks the fallback slice, gets an empty
        // ok(), and every thread opens on "No replies yet".
        fetchReplyThread: async (args: {
          scope: "channel" | "dm";
          rootEventId: string;
        }) => ok(await fixtureConversation.fetchReplyThread(args)),
        listChannelMembers: async () => ok({ members: [] }),
        /**
         * Company channel surfaces. The header's Add-agent control and the
         * Team / Atlas / Settings tabs all read their rows — and their
         * permission — from this one call, so without it the company channel
         * rendered as a chat tab with nothing behind the others.
         */
        getCompanyTab: async (companyUid: string, tab: string) =>
          ok(companyTab(companyUid, tab)),
        runCompanyTabAction: async (args: { cardId?: string; actionId?: string }) =>
          ok({
            cardId: args.cardId ?? "",
            actionId: args.actionId ?? "",
            state: "open",
            replayed: false,
          }),
      }),
      meetings: slice({
        listUpcoming: async () => ok([]),
      }),
      /**
       * Core popover data. Answering these from the adapter — rather than
       * leaving `coreUseFixtures` on — puts the popover on the SAME code path
       * the desktop app runs, including the update actions, which the fixture
       * path deliberately hides (a fixture must never offer a real install).
       * Without them the one state worth reviewing, "update available", could
       * not be rendered here at all.
       */
      packages: slice({
        listPackagesCached: async () => ok({ packs: { installed: HARNESS_PACKS } }),
        listPackages: async () => ok({ packs: { installed: HARNESS_PACKS } }),
      }),
      updates: slice({
        getVersions: async () => ok({ core: HARNESS_CORE_VERSION, cli: "5.4.2" }),
        // Truthy value => "available" (update-orchestration `appStatusFrom`).
        checkForUpdates: async () =>
          ok(updateAvailable ? { version: "0.10.241" } : null),
        checkCoreState: async () =>
          ok({
            channel: "release",
            localVersion: HARNESS_CORE_VERSION,
            targetVersion: HARNESS_CORE_VERSION,
            versionBehind: false,
            driftReport: { count: 0 },
          }),
        checkCliUpdate: async () => ok(null),
        getDownloadedUpdate: async () => ok(null),
      }),
    } as Record<string | symbol, unknown>,
    {
      get: (target, prop) => (prop in target ? target[prop] : emptySlice),
    },
  ) as unknown as PlatformAdapter;

  /** Viewer who owns the company, so every actionable control renders. */
  const HARNESS_VIEWER = { canAct: true, role: "owner" };

  const tabRow = (
    companyUid: string,
    id: string,
    fields: Record<string, unknown>[],
    actions: Record<string, unknown>[] = [],
  ) => ({
    v: 1,
    type: "lifecycle_card",
    cardId: id,
    kind: "tab_row",
    companyUid,
    state: "open",
    viewer: HARNESS_VIEWER,
    fields,
    actions,
  });

  function companyTab(companyUid: string, tab: string) {
    const base = { tab, companyUid, viewer: HARNESS_VIEWER };
    if (tab === "team") {
      return {
        ...base,
        sections: [
          {
            id: "people",
            title: "People",
            rows: [
              // `name` is the field id the Team tab renders as the person;
              // anything else renders as a plain value beside it.
              tabRow(companyUid, "team:corey", [
                { id: "name", label: "Name", control: "readonly", value: "Corey Berger" },
                { id: "role", label: "Role", control: "readonly", value: "Owner" },
              ]),
              tabRow(
                companyUid,
                "team:bryan",
                [
                  { id: "name", label: "Name", control: "readonly", value: "Bryan Ng" },
                  { id: "role", label: "Role", control: "readonly", value: "Admin" },
                ],
                [{ id: "remove", label: "Remove", style: "secondary" }],
              ),
              tabRow(
                companyUid,
                "team:sofia",
                [
                  { id: "name", label: "Name", control: "readonly", value: "Sofia Marchetti" },
                  { id: "role", label: "Role", control: "readonly", value: "Member" },
                ],
                [{ id: "remove", label: "Remove", style: "secondary" }],
              ),
            ],
          },
          {
            id: "agents",
            title: "Agents",
            rows: [
              tabRow(
                companyUid,
                "team:polar",
                [
                  { id: "name", label: "Name", control: "readonly", value: "Polar" },
                  { id: "size", label: "Size", control: "readonly", value: "Basic" },
                  { id: "price", label: "Price", control: "readonly", value: "$100/mo" },
                ],
                [{ id: "remove", label: "Remove", style: "secondary" }],
              ),
              tabRow(
                companyUid,
                "team:spend",
                [{ id: "total", label: "Agent spend", control: "readonly", value: "$300/mo" }],
                [{ id: "add_agent", label: "Add agent", style: "primary" }],
              ),
            ],
          },
        ],
      };
    }
    if (tab === "settings") {
      return {
        ...base,
        sections: [
          {
            id: "plan",
            title: "Plan",
            rows: [
              tabRow(companyUid, "settings:plan", [
                { id: "plan", label: "Plan", control: "readonly", value: "Workforce" },
                { id: "seats", label: "Seats", control: "readonly", value: "12 of 25" },
              ]),
            ],
          },
        ],
      };
    }
    return { ...base, sections: [] };
  }

  /**
   * `?update=available` paints the desktop-app row in its update state
   * (UPDATE AVAILABLE + Install). Default is up to date, so a routine design
   * pass is not looking at an update banner it did not ask for. Set it on the
   * URL — it is deliberately NOT a harness-bar chip, because the bar is for
   * things you flip constantly (theme) and this is not one of them.
   */
  const updateAvailable =
    new URLSearchParams(
      typeof location === "undefined" ? "" : location.search,
    ).get("update") === "available";

  const HARNESS_CORE_VERSION = "15.0.87";
  const HARNESS_PACKS = [
    { name: "design-styles", version: "1.2.0" },
    { name: "design-quality", version: "0.9.2" },
    { name: "gstack", version: "2.1.0" },
  ];

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

  /**
   * #welcome carries the onboarding lifecycle cards — the server-driven
   * "Name your company" form and the "Your companies" summary the desktop app
   * renders from `/v1/notify/channels/.../cards`. Without them the harness's
   * setup channel was an empty room, and the one surface a brand-new user
   * meets first could not be design-reviewed here at all.
   *
   * Same `lifecycle_card` v1 envelope the app parses (channelMessageModels),
   * so what renders is the shipped card component, not a mock of it.
   */
  const cardMessage = (
    eventId: string,
    minutesAgo: number,
    card: Record<string, unknown>,
  ) => ({
    eventId,
    direction: "in" as const,
    fromDisplayName: "HQ",
    fromPersonUid: "agt_hq",
    body: "",
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    messageKind: "system" as const,
    systemEvent: { v: 1, type: "lifecycle_card", viewer: { canAct: true }, ...card },
  });

  const SETUP_MESSAGES = [
    cardMessage("evt_setup_create", 12, {
      cardId: "card_create_company",
      kind: "create_company",
      companyUid: null,
      state: "open",
      title: "Name your company",
      summary: "This creates the company channel, vault, and team roster.",
      fields: [
        {
          id: "name",
          label: "Company name",
          control: "text",
          required: true,
          value: "",
          hint: "Shown in the sidebar and on invites.",
        },
        {
          id: "slug",
          label: "Slug",
          control: "text",
          required: true,
          value: "",
        },
        {
          id: "website",
          label: "Website (optional) — we'll use its icon for your company",
          control: "text",
          value: "",
        },
      ],
      actions: [{ id: "submit", label: "Create company", style: "primary" }],
    }),
    cardMessage("evt_setup_summary", 4, {
      cardId: "companies_summary",
      kind: "companies_summary",
      companyUid: null,
      state: "open",
      title: "Your companies",
      summary: "Each company is a channel. Create another to add one.",
      fields: [
        {
          id: "indigo",
          label: "Indigo",
          control: "readonly",
          value: "cloud:chn_01M2OJYC8RX0AS1CTD0RRWWC",
        },
        {
          id: "hpo",
          label: "hpo",
          control: "readonly",
          value: "cloud:chn_01M26J8A256TVW4TPQW0JJ0R4D",
        },
      ],
      actions: [
        { id: "indigo", label: "Indigo", style: "secondary" },
        { id: "hpo", label: "hpo", style: "secondary" },
        { id: "create_company", label: "Create another company", style: "primary" },
      ],
    }),
  ];

  /**
   * The same card seen by someone who cannot act on it: the server sends
   * readonly rows and a "who to ask" line instead of controls. It is a
   * distinct visual state and easy to regress, so the harness carries one.
   */
  SETUP_MESSAGES.push(
    cardMessage("evt_setup_plan", 2, {
      cardId: "card_upgrade_plan",
      kind: "upgrade_plan",
      companyUid: "cmp_indigo",
      state: "open",
      title: "Choose a plan",
      summary: "Agents, integrations, and cloud sessions unlock on Workforce.",
      fields: [
        { id: "starter", label: "Starter", control: "readonly", value: "Free" },
        {
          id: "workforce",
          label: "Workforce",
          control: "readonly",
          value: "$500/mo flat · agents unlocked",
        },
        {
          id: "enterprise",
          label: "Enterprise",
          control: "readonly",
          value: "Talk to us",
        },
      ],
      actions: [],
      // No actorName on the wire, so the card asks for "the owner".
      viewer: { canAct: false },
    }),
  );

  /**
   * A sent message carrying files. The timeline's attachment cards are only
   * reachable with real attachments on the wire, so the harness carries one
   * image and one document — the two shapes the card renders differently.
   */
  const ATTACHMENT_MESSAGES = [
    {
      eventId: "evt_attach_doc",
      direction: "in" as const,
      fromDisplayName: "Sofia",
      fromPersonUid: "person-sofia",
      body: "Here's the spec and the mock for the new titlebar.",
      createdAt: new Date(Date.now() - 26 * 60_000).toISOString(),
      attachments: [
        {
          id: "att_spec",
          vaultPath: "chat/chan/agent-orchestrator/titlebar-spec.pdf",
          companyUid: "cmp_indigo",
          name: "titlebar-spec.pdf",
          contentType: "application/pdf",
          sizeBytes: 248_320,
          kind: "file",
        },
        {
          id: "att_mock",
          vaultPath: "chat/chan/agent-orchestrator/titlebar-mock.png",
          companyUid: "cmp_indigo",
          name: "titlebar-mock.png",
          contentType: "image/png",
          sizeBytes: 1_204_992,
          kind: "image",
          // Inline preview: the harness has no vault to resolve a thumb from,
          // so without this the image card sits in its "unavailable" state.
          previewUrl:
            "data:image/svg+xml;utf8," +
            encodeURIComponent(
              `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300">
                 <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
                   <stop offset="0" stop-color="#c9d6e4"/><stop offset="1" stop-color="#8fa7bf"/>
                 </linearGradient></defs>
                 <rect width="480" height="300" fill="url(#g)"/>
                 <rect x="0" y="0" width="480" height="48" fill="#ffffff" opacity="0.75"/>
                 <circle cx="26" cy="24" r="6" fill="#ff5f57"/><circle cx="46" cy="24" r="6" fill="#febc2e"/>
                 <circle cx="66" cy="24" r="6" fill="#28c840"/>
               </svg>`,
            ),
        },
      ],
    },
  ];

  const messagesFor = (row: Parameters<typeof fixtureMessagesFor>[0]) => {
    const id = (row as { channelId?: string })?.channelId;
    if (id === "setup") {
      return SETUP_MESSAGES as unknown as ReturnType<typeof fixtureMessagesFor>;
    }
    const base = fixtureMessagesFor(row);
    if (id === "agent-orchestrator") {
      return [
        ...base,
        ...(ATTACHMENT_MESSAGES as unknown as ReturnType<typeof fixtureMessagesFor>),
      ];
    }
    return base;
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
        <!-- `tenantAccountId`: composer drafts (and the rest of the shell's
             per-tenant state) live under an account-scoped key, and that
             storage is a deliberate no-op without an account — so a draft
             never persisted here and the rail's draft pencil could not be
             seen at all. -->
        <DesktopApp
          {adapter}
          {sidebarApi}
          {notificationsApi}
          {wakes}
          {self}
          {seedDirectory}
          version="0.10.233"
          tenantAccountId="acct_harness"
          companies={FIXTURE_COMPANIES}
          initialRow={FIXTURE_INITIAL_ROW}
          searchRows={FIXTURE_SEARCH_ROWS}
          settingsProfile={FIXTURE_SETTINGS_PROFILE}
          messagesByRow={messagesFor}
          reactionsByRow={fixtureReactionsFor}
          boardByRow={fixtureBoardFor}
          filesByRow={fixtureFilesFor}
          channelStatusByRow={fixtureChannelStatusFor}
          coreFixtures={params.get("core") === "fixtures"}
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
  /* The shipping window sets `box-sizing: border-box` on everything
     (desktop-alt.css); the work app does not. Without this the harness gives
     every padded, `width: 100%` element more box than production does — cards
     and rows bled past their panes here and nowhere else. Scoped to the stage
     so the rest of the work app keeps its own defaults. */
  .harness-root :global(*) {
    box-sizing: border-box;
  }

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

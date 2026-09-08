// Static performance-budget contract for the live desktop shell.
//
// WHY THIS FILE EXISTS
// --------------------
// HQ Sync felt choppy, and the causes were all structural rather than
// algorithmic. Four of them:
//
//   1. GLASS STACKING. The window is transparent with a real macOS glass layer
//      (NSGlassEffectView) painted behind the webview. Chrome that ALSO carried
//      a CSS `backdrop-filter` made the compositor blur the same pixels twice,
//      per frame, for the element's whole box. On always-on, full-height
//      surfaces (the conversation rail) that is a full-rail blur on every hover
//      and every scroll tick.
//   2. A SESSION SCAN THAT NEVER IDLED. The Rust scanner walked every Claude /
//      Codex session directory every 5 seconds forever, hidden window or not,
//      and re-emitted an identical snapshot each time.
//   3. PRESENCE / TIMER CHURN. Frontend stores ran their own sub-10s
//      `setInterval` refreshes that rewrote reactive state whether or not the
//      window was visible, waking Svelte effects and the compositor with it.
//   4. LAYOUT-ANIMATING CSS. `transition: width` on progress fills and
//      `background-position` keyframe shimmers run style + layout + paint on
//      the main thread every frame, forever, whether or not anyone is looking.
//
// Those fixes are cheap to make and very easy to undo by accident, so this file
// pins them as SHAPE assertions over source text -- the same style as
// scripts/ci-cost-contract.test.ts and scripts/native-seam-wiring.test.ts.
//
// SCOPE. packages/ui/src is "the live shell". `apps/sync/src/desktop-alt/`
// (v4/, panels/, pages/, styles/) is DEAD code: apps/sync/src/desktop-alt/boot.ts
// hard-returns 'hq-work', so only the @hq/ui workspace ever mounts. Budgeting
// dead CSS would generate busywork with no user-visible payoff.
//
// HOW TO ADD AN EXCEPTION. Every rule here is allowlisted, never absolute. Add
// the entry to the relevant allowlist below WITH a comment saying why the cost
// is acceptable (transient surface, user-invisible, no cheaper equivalent).
// A silent allowlist entry is worse than no guard. See docs/performance-budgets.md.
//
// The detectors are pure functions over file CONTENT strings (scripts/perf/),
// and the "detectors" describe block below exercises each one against BOTH a
// passing and a failing inline fixture -- a guard nobody has watched fail is
// not a guard.

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import {
  findBackdropFilters,
  findLayoutTransitions,
  findNonCompositedKeyframes,
  formatFindings,
} from "./perf/style-budget.js";
import {
  POLL_FLOOR_MS,
  collectNumericConstants,
  findFastPollers,
  findIntervalCallSites,
  formatIntervalSites,
  pausesOnVisibility,
} from "./perf/poll-budget.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

interface SourceFile {
  path: string;
  content: string;
}

async function loadTree(
  relativeDir: string,
  extensions: RegExp,
): Promise<SourceFile[]> {
  const abs = resolve(rootDir, relativeDir);
  await stat(abs);
  const files = (await walk(abs)).filter(
    (f) => extensions.test(f) && !/\.test\.[tj]s$/.test(f),
  );
  return Promise.all(
    files.map(async (f) => ({
      path: relative(rootDir, f),
      content: await readFile(f, "utf8"),
    })),
  );
}

let uiStyleFiles: SourceFile[] = [];
let uiScriptFiles: SourceFile[] = [];
let coreScriptFiles: SourceFile[] = [];
let rustSessions = "";
let sessionsCommand = "";
let syncCommand = "";
let glass = "";
let tauriCargo = "";
let syncViteConfig = "";
let projectRow = "";
let chatSidebar = "";
let filesSidebar = "";
let setupChannelIntro = "";
let desktopAltBoot = "";

beforeAll(async () => {
  [uiStyleFiles, uiScriptFiles, coreScriptFiles] = await Promise.all([
    loadTree("packages/ui/src", /\.(svelte|css)$/),
    loadTree("packages/ui/src", /\.(svelte|ts)$/),
    loadTree("packages/core/src", /\.ts$/),
  ]);

  [
    rustSessions,
    sessionsCommand,
    syncCommand,
    glass,
    tauriCargo,
    syncViteConfig,
    projectRow,
    chatSidebar,
    filesSidebar,
    setupChannelIntro,
    desktopAltBoot,
  ] = await Promise.all(
    [
      "crates/hq-desktop-core/src/sessions/mod.rs",
      "apps/sync/src-tauri/src/commands/sessions.rs",
      "apps/sync/src-tauri/src/commands/sync.rs",
      "apps/sync/src-tauri/src/glass.rs",
      "apps/sync/src-tauri/Cargo.toml",
      "apps/sync/vite.config.ts",
      "packages/ui/src/projects/ProjectRow.svelte",
      "packages/ui/src/chat/ChatSidebar.svelte",
      "packages/ui/src/files/FilesModeSidebar.svelte",
      "packages/ui/src/chat/SetupChannelIntro.svelte",
      "apps/sync/src/desktop-alt/boot.ts",
    ].map((p) => readFile(resolve(rootDir, p), "utf8")),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 1. Backdrop-filter budget
// ───────────────────────────────────────────────────────────────────────────

/**
 * `<file>::<selector>` pairs permitted to carry a CSS backdrop blur.
 *
 * The rule: a blur is allowed on a TRANSIENT surface (it exists for a few
 * hundred ms while the user is deliberately looking at it, and the frosted
 * edge is what makes it read as a floating layer) and forbidden on ALWAYS-ON
 * chrome (permanently on screen, so the blur is a permanent per-frame tax on
 * top of the native glass that is already doing the same job).
 */
const BACKDROP_FILTER_ALLOWLIST = new Set([
  // Popovers and cursor-anchored menus: open on click, closed again in seconds.
  "packages/ui/src/chat/ChannelStatusPopover.svelte::.status-popover",
  "packages/ui/src/chat/ChatSidebar.svelte::.chat-popover",
  "packages/ui/src/chat/ChatSidebar.svelte::.chat-context-menu",
  "packages/ui/src/common/LinkContextMenu.svelte::.link-context-menu",
  "packages/ui/src/home/CorePopover.svelte::.core-popover",
  "packages/ui/src/library/LibraryBrowser.svelte::.scope-menu",
  "packages/ui/src/projects/ProjectDetailView.svelte::.status-menu",
  "packages/ui/src/settings/VersionPopout.svelte::.version-popout",
  // Emoji picker + command palette + shortcut sheet: modal-ish, dismissed fast.
  "packages/ui/src/chat/messaging/EmojiPicker.svelte::.emoji-picker",
  "packages/ui/src/common/CommandPalette.svelte::.command-palette",
  "packages/ui/src/common/ShortcutCheatSheet.svelte::.cheat-sheet",
  // Slide-over detail panels: present only while a row is selected, and they
  // float over content (not over the native glass), so the blur is the only
  // thing separating them from the list underneath.
  "packages/ui/src/home/StoryPanel.svelte::.story-panel:not(.is-embedded)",
  "packages/ui/src/library/LibraryDetailPanel.svelte::.detail-panel",
  "packages/ui/src/marketplace/MarketplacePanel.svelte::.detail-panel",
  "packages/ui/src/projects/StoryDetailPanel.svelte::.detail-panel",
  // Small, rarely-rendered chips inside the marketplace detail panel.
  "packages/ui/src/marketplace/MarketplacePanel.svelte::.kind-chip, .cover-version",
  // Sticky settings error banner: only exists when a settings write failed.
  "packages/ui/src/settings/SettingsPage.svelte::.error",
]);

describe("backdrop-filter budget (live shell)", () => {
  it("keeps CSS blur off always-on chrome", () => {
    const offenders = uiStyleFiles
      .flatMap((f) => findBackdropFilters(f.path, f.content))
      .filter((f) => !BACKDROP_FILTER_ALLOWLIST.has(`${f.file}::${f.selector}`));

    expect(
      offenders,
      `New CSS backdrop-filter on the live shell:\n${formatFindings(offenders)}\n\n` +
        "The window already has a NATIVE macOS glass layer behind it " +
        "(apps/sync/src-tauri/src/glass.rs), so a CSS backdrop-filter here is a " +
        "SECOND per-frame GPU blur of the same pixels. On always-on chrome that " +
        "is a full-surface repaint on every hover and scroll.\n" +
        "Carry the extra alpha in the background colour instead (see " +
        "`--side-bg` on .chat-sidebar). If the surface really is transient " +
        "(popover / menu / dialog / palette / tooltip / emoji picker), add it to " +
        "BACKDROP_FILTER_ALLOWLIST with a comment saying why.",
    ).toEqual([]);
  });

  // The three surfaces the perf pass actually stripped. Named explicitly so the
  // failure message can say WHICH regression came back, rather than just
  // "an unexpected selector appeared".
  it(".chat-sidebar stays blur-free", () => {
    const blurred = findBackdropFilters(
      "ChatSidebar.svelte",
      chatSidebar,
    ).filter((f) => f.selector.includes(".chat-sidebar"));
    expect(
      blurred,
      "The conversation rail is full-height and permanently visible: a blur " +
        "here repaints the whole rail on every hover and scroll tick, on top " +
        "of the native glass already showing through. Use --side-bg alpha.",
    ).toEqual([]);
  });

  it("the files sidebar stays blur-free", () => {
    const blurred = findBackdropFilters(
      "FilesModeSidebar.svelte",
      filesSidebar,
    ).filter((f) => !/^\s*@/.test(f.selector));
    expect(
      blurred,
      "Same rail, same cost as .chat-sidebar — the native glass view behind " +
        "the transparent window already provides the frost.",
    ).toEqual([]);
  });

  it(".launch-btn stays blur-free", () => {
    const blurred = findBackdropFilters(
      "SetupChannelIntro.svelte",
      setupChannelIntro,
    ).filter((f) => f.selector.includes(".launch-btn"));
    expect(
      blurred,
      "The setup intro's launch buttons are full-width and on screen for the " +
        "whole onboarding step; blurring them blurred a wide box on every " +
        "hover transition.",
    ).toEqual([]);
  });

  it("documents that desktop-alt is dead code and excluded", () => {
    // If boot.ts ever stops hard-returning 'hq-work', apps/sync/src/desktop-alt
    // is live again and this file's scope comment (and scope) must be revisited.
    expect(desktopAltBoot).toMatch(/return\s+'hq-work'/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Layout-animating transitions
// ───────────────────────────────────────────────────────────────────────────

/**
 * `<file>:<line>` sites still animating a layout property.
 *
 * KNOWN DEBT — this list may only ever SHRINK. Both entries are on
 * low-traffic surfaces (a rendered-markdown progress bar, the prototype
 * settings pane), so they were left for a follow-up rather than touched during
 * a perf pass that had to stay reviewable. Do not add to it: convert to
 * `transform` instead.
 */
const LAYOUT_TRANSITION_ALLOWLIST = new Set([
  "packages/ui/src/chat/messaging/RichMessageContent.svelte::.rich-progress-fill",
  "packages/ui/src/settings/PrototypeSettingsPanes.svelte::.toggle::after",
]);

describe("layout-animating transitions (live shell)", () => {
  it("animates transform, not geometry", () => {
    const offenders = uiScriptFiles
      .flatMap((f) => findLayoutTransitions(f.path, f.content))
      .filter(
        (f) => !LAYOUT_TRANSITION_ALLOWLIST.has(`${f.file}::${f.selector}`),
      );

    expect(
      offenders,
      `Layout-animating transition:\n${formatFindings(offenders)}\n\n` +
        "Transitioning width/height/top/left/margin/padding/flex-basis (or " +
        "`transition: all`, which opts in every property anyone adds later) " +
        "runs style + layout + paint on the main thread for every frame of the " +
        "transition. transform/opacity are composited on the GPU and cost " +
        "effectively nothing.\n" +
        "For a progress fill, use the pattern in " +
        "packages/ui/src/projects/ProjectRow.svelte: set a `--fill` ratio, then " +
        "`transform: scaleX(var(--fill, 0))` with `transform-origin: left`.",
    ).toEqual([]);
  });

  it("ProjectRow's progress fill is the transform-based reference", () => {
    // The failure message above points here, so this must stay true.
    expect(projectRow).toMatch(/transform:\s*scaleX\(var\(--fill/);
    expect(projectRow).toMatch(/transform-origin:\s*left/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Non-composited keyframe animation
// ───────────────────────────────────────────────────────────────────────────

/**
 * `<file>::<@keyframes name>` blocks still animating a non-composited property.
 *
 * KNOWN DEBT — may only SHRINK. The chat skeleton shimmer (the one that ran on
 * every cold start, behind the conversation list) was converted to a
 * translateX'd gradient overlay. These are the secondary skeletons on panels
 * that are not on the boot path, plus one `box-shadow` pulse ring.
 */
const KEYFRAME_ALLOWLIST = new Set([
  "packages/ui/src/common/StatTile.svelte::skeleton-pulse",
  "packages/ui/src/company/DeploymentsPanel.svelte::skeleton",
  "packages/ui/src/company/SecretsPanel.svelte::skeleton",
  "packages/ui/src/files/FilePreviewPane.svelte::preview-skeleton",
  "packages/ui/src/meetings/MeetingsAgenda.svelte::live-pulse",
  "packages/ui/src/settings/ShellSettings.svelte::ss-skel-shimmer",
]);

describe("keyframe animation budget (live shell)", () => {
  it("only animates composited properties", () => {
    const offenders = uiStyleFiles
      .flatMap((f) => findNonCompositedKeyframes(f.path, f.content))
      .filter((f) => !KEYFRAME_ALLOWLIST.has(`${f.file}::${f.animation}`));

    expect(
      offenders,
      `Non-composited @keyframes:\n${formatFindings(offenders)}\n\n` +
        "A keyframe animation runs for its whole duration — usually " +
        "`infinite`, as with a loading shimmer — so a non-composited property " +
        "here burns main thread for as long as the element is on screen, " +
        "whether or not the user is interacting. Only transform / opacity / " +
        "filter / colour are allowed.\n" +
        "A `background-position` shimmer becomes a gradient overlay moved with " +
        "`transform: translateX()`.",
    ).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Poll-interval floors
// ───────────────────────────────────────────────────────────────────────────

/**
 * Rust scanner floors. These are MINIMUMS: raising them is fine, lowering them
 * puts the "walk every session directory" scan back on a cadence the machine
 * can feel. Pinned at the post-fix values.
 */
const SESSIONS_POLL_FLOOR_SECS = 15;
const SESSIONS_HIDDEN_POLL_FLOOR_SECS = 120;

/**
 * `<file>:<line>` sites allowed to tick faster than POLL_FLOOR_MS, each with
 * the reason the cost is acceptable.
 */
const FAST_POLLER_ALLOWLIST = new Map<string, string>([
  [
    "packages/ui/src/settings/update-store.svelte.ts",
    "1s countdown ticker for the visible 'update in Ns' label — it is the " +
      "thing being displayed, and it stops itself at zero.",
  ],
  [
    "packages/ui/src/settings/PrototypeSettingsPanes.svelte",
    "5s live-sync status refresh that only exists while the Settings pane is " +
      "mounted (a deliberately-opened, short-lived surface).",
  ],
  [
    "packages/ui/src/chat/messaging/ReplyPanel.svelte",
    "5s agent-thinking tick driving a visible 'thinking' affordance inside an " +
      "open reply panel; it is animation state, not a fetch.",
  ],
  [
    "packages/ui/src/shell/DesktopApp.svelte",
    "5s agent-thinking tick (visible affordance) and the 8s live-timeline " +
      "catch-up safety net, which only re-runs when the realtime socket has " +
      "not delivered — both are cheap in-memory passes, no IPC per tick.",
  ],
  [
    "packages/ui/src/sessions/sessions-store.svelte.ts",
    "5s refresh, but the store pauses entirely on visibilitychange (asserted " +
      "below), so it only runs while the user is actually looking at sessions.",
  ],
  [
    "packages/ui/src/meetings/meetings-store.svelte.ts",
    "3s connect-provider poll, active only during the OAuth connect flow " +
      "(the steady-state meetings poll is POLL_INTERVAL_MS = 120s).",
  ],
]);

describe("poll-interval floors", () => {
  it("the Rust session scanner keeps its post-fix cadence", () => {
    const visible = /SESSIONS_POLL_INTERVAL_SECS:\s*u64\s*=\s*(\d+)/.exec(
      rustSessions,
    );
    const hidden =
      /SESSIONS_HIDDEN_POLL_INTERVAL_SECS:\s*u64\s*=\s*(\d+)/.exec(
        rustSessions,
      );

    expect(visible, "SESSIONS_POLL_INTERVAL_SECS is missing").not.toBeNull();
    expect(
      hidden,
      "SESSIONS_HIDDEN_POLL_INTERVAL_SECS is missing",
    ).not.toBeNull();

    expect(
      Number(visible![1]),
      "The session scanner walks every Claude/Codex session directory on each " +
        "tick. It used to do that every 5 seconds, forever — the single " +
        "largest source of idle CPU in the app. This is a FLOOR: raise it " +
        "freely, never lower it.",
    ).toBeGreaterThanOrEqual(SESSIONS_POLL_FLOOR_SECS);

    expect(
      Number(hidden![1]),
      "While the window is hidden the scan must back off hard — a menubar app " +
        "spends most of its life behind other windows.",
    ).toBeGreaterThanOrEqual(SESSIONS_HIDDEN_POLL_FLOOR_SECS);
  });

  it("no frontend poller ticks faster than the floor without a reason", () => {
    const all = [...uiScriptFiles, ...coreScriptFiles];

    // Constants are resolved repo-wide: `setInterval(tick, POLL_INTERVAL_MS)`
    // is usually written in a different file from the `const`.
    const constants = new Map<string, number>();
    for (const file of all) {
      for (const [name, value] of collectNumericConstants(file.content)) {
        constants.set(name, value);
      }
    }

    const sites = all.flatMap((f) =>
      findIntervalCallSites(f.path, f.content, constants),
    );
    const fast = findFastPollers(sites).filter(
      (s) => !FAST_POLLER_ALLOWLIST.has(s.file),
    );

    expect(
      fast,
      `Poller faster than ${POLL_FLOOR_MS}ms:\n${formatIntervalSites(fast)}\n\n` +
        "Sub-10s polling in a long-lived store rewrites reactive state on a " +
        "cadence the user can feel: every tick wakes the main thread, re-runs " +
        "Svelte effects, and (on a transparent window with a live glass layer) " +
        "makes the compositor re-blur. If the cadence is genuinely required, " +
        "add the file to FAST_POLLER_ALLOWLIST with the reason — and make the " +
        "poller pause on visibilitychange.",
    ).toEqual([]);
  });

  it("the stores fixed in the perf pass still pause when hidden", () => {
    // These two were the churn sources: they kept refreshing (and rewriting
    // state) while the window was hidden behind other apps.
    const gated = [
      "packages/ui/src/chat/agency-store.svelte.ts",
      "packages/ui/src/sessions/sessions-store.svelte.ts",
    ];

    for (const path of gated) {
      const file = uiScriptFiles.find((f) => f.path === path);
      expect(file, `${path} is missing`).toBeDefined();
      expect(
        pausesOnVisibility(file!.content),
        `${path} no longer references visibilitychange / visibilityState. A ` +
          "long-lived poller must stop while the window is hidden; this store " +
          "was one of the two that did not, and it kept the main thread warm " +
          "for the entire time the app sat in the background.",
      ).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. Broadcast-emit discipline (Rust)
// ───────────────────────────────────────────────────────────────────────────

/**
 * `app.emit(...)` broadcasts to EVERY window. With the popover, the main
 * window, the banner and any detail windows open, one broadcast is N webview
 * wakeups, N deserialisations and N reactive-store writes — most of them for a
 * window that does not care. `emit_to(label, ...)` targets one window.
 *
 * RATCHET THIS DOWN, NEVER UP. The number is the count at the time the perf
 * pass landed; new event plumbing should use `emit_to`.
 */
const BROADCAST_EMIT_CEILING = 153;

describe("broadcast-emit discipline", () => {
  it("does not grow the number of broadcast emit sites", async () => {
    const files = (await loadTree("apps/sync/src-tauri/src", /\.rs$/)).filter(
      (f) => !f.path.includes("/tests/"),
    );

    let broadcasts = 0;
    let targeted = 0;
    for (const file of files) {
      for (const line of file.content.split("\n")) {
        if (line.includes("emit_to(")) targeted += line.split("emit_to(").length - 1;
        // `.emit(` minus the `.emit_to(` occurrences already counted.
        const emits = line.split(".emit(").length - 1;
        broadcasts += emits;
      }
    }

    expect(targeted, "emit_to must stay in use").toBeGreaterThan(0);
    expect(
      broadcasts,
      `${broadcasts} broadcast \`.emit(\` sites (ceiling ${BROADCAST_EMIT_CEILING}, ` +
        `${targeted} targeted \`emit_to(\` sites).\n\n` +
        "A broadcast wakes every open webview — popover, main window, banner — " +
        "even when only one of them subscribes. Prefer " +
        "`app.emit_to(WINDOW_LABEL, ...)`. This ceiling ratchets DOWN, never up: " +
        "if you must broadcast, delete another broadcast first.",
    ).toBeLessThanOrEqual(BROADCAST_EMIT_CEILING);
  });

  it("sync progress keeps its time-based coalescer", () => {
    // Per-file progress used to emit once per file. A sync of a few thousand
    // files was a few thousand renderer wakeups, which is what made the
    // progress bar itself the slowest part of a sync.
    expect(syncCommand).toMatch(
      /const SYNC_PROGRESS_EMIT_INTERVAL:\s*Duration\s*=\s*Duration::from_millis\(\s*\d+\s*\)/,
    );
    expect(syncCommand).toMatch(/last_emit/);
    expect(
      syncCommand,
      "the coalescer must still be consulted on the emit path",
    ).toMatch(/with_progress_coalescer/);
  });

  it("the sessions command still skips unchanged snapshots", () => {
    // Re-emitting a byte-identical MissionControlSnapshot re-ran every
    // downstream Svelte effect for no reason at all.
    expect(sessionsCommand).toMatch(/emit_snapshot_if_changed/);
    expect(sessionsCommand).toMatch(/last_snapshot/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 6. Native glass idempotency
// ───────────────────────────────────────────────────────────────────────────

describe("native glass idempotency", () => {
  it("tags its backing view so re-apply is a no-op", () => {
    // Every window show re-runs the glass setup. Without the identifier tag,
    // each re-apply INSERTS ANOTHER NSGlassEffectView, so a window opened ten
    // times is compositing ten stacked blur layers.
    expect(glass).toMatch(/const GLASS_VIEW_IDENTIFIER:\s*&std::ffi::CStr/);
    expect(glass, "the pre-insert lookup must stay").toMatch(
      /fn content_has_glass_backing/,
    );
    expect(glass, "the tagging call must stay").toMatch(
      /fn tag_as_glass_backing/,
    );
    expect(
      glass,
      "apply must bail out when a tagged backing view is already present",
    ).toMatch(/backing view already present, skipping re-apply/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 7. Release build profile
// ───────────────────────────────────────────────────────────────────────────

describe("release build profile", () => {
  it("keeps cross-crate inlining on the shipped binary", () => {
    const profile = /\[profile\.release\]([\s\S]*?)(?=\n\[|$)/.exec(
      tauriCargo,
    )?.[1];
    expect(profile, "[profile.release] is missing").toBeDefined();

    expect(
      profile,
      "lto must stay enabled: the hot native paths (session scanning, ndjson " +
        "parsing) are split across crates, and without LTO none of it inlines.",
    ).toMatch(/^\s*lto\s*=\s*("thin"|"fat"|true)\s*$/m);

    expect(
      profile,
      "codegen-units = 1 is what lets LLVM see the whole crate at once. " +
        "Raising it trades measurable runtime for build time.",
    ).toMatch(/^\s*codegen-units\s*=\s*1\s*$/m);
  });

  it("keeps the webview build target and the shared chunk", () => {
    // tauri.conf.json's minimumSystemVersion is macOS 13 => WKWebView is
    // Safari 16.4+. Down-levelling to safari13 re-adds class-field, ?? and
    // top-level-await polyfills: more bytes to download, parse and execute.
    const target = /target:\s*"safari(\d+)"/.exec(syncViteConfig);
    expect(target, "build.target must stay pinned").not.toBeNull();
    expect(Number(target![1])).toBeGreaterThanOrEqual(16);

    // Two HTML entries (main + desktop-alt) share the Svelte runtime and the
    // @hq/* workspace UI. Without an explicit shared chunk each entry bundles
    // its own copy and the second window pays full parse/compile again.
    expect(syncViteConfig).toMatch(/manualChunks/);
    expect(syncViteConfig).toMatch(/"hq-shared"/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Detector self-tests: every rule above, proven to fail.
// ───────────────────────────────────────────────────────────────────────────

describe("detectors (inline fixtures)", () => {
  it("backdrop-filter: flags a blur, ignores `none` and comments", () => {
    const bad = `
  .chat-sidebar {
    background: var(--side-bg);
    backdrop-filter: blur(28px) saturate(1.4);
  }`;
    const good = `
  /* No backdrop-filter here: the rail sits on the native window glass. */
  .chat-sidebar {
    background: var(--side-bg);
  }
  @media (prefers-reduced-transparency: reduce) {
    .chat-sidebar {
      backdrop-filter: none;
    }
  }`;

    const found = findBackdropFilters("x.svelte", bad);
    expect(found).toHaveLength(1);
    expect(found[0].selector).toBe(".chat-sidebar");
    expect(found[0].line).toBe(4);
    expect(findBackdropFilters("x.svelte", good)).toEqual([]);
  });

  it("backdrop-filter: attributes a comma-continued selector correctly", () => {
    const source = `
  .kind-chip,
  .cover-version {
    backdrop-filter: blur(8px);
  }`;
    expect(findBackdropFilters("x.svelte", source)[0].selector).toBe(
      ".kind-chip, .cover-version",
    );
  });

  it("transitions: flags layout properties and `all`, allows transform", () => {
    const bad = `
  .fill {
    transition: width 120ms ease-out;
  }
  .toggle::after {
    transition: all 0.15s;
  }
  .row {
    transition: color 120ms, margin-left 200ms;
  }`;
    const good = `
  .fill {
    transform: scaleX(var(--fill, 0));
    transform-origin: left center;
    transition: transform 120ms ease-out, opacity 120ms;
  }`;

    const found = findLayoutTransitions("x.svelte", bad);
    expect(found.map((f) => f.selector)).toEqual([
      ".fill",
      ".toggle::after",
      ".row",
    ]);
    expect(found[0].declaration).toContain("animates: width");
    expect(found[1].declaration).toContain("animates: all");
    expect(found[2].declaration).toContain("animates: margin-left");
    expect(findLayoutTransitions("x.svelte", good)).toEqual([]);
  });

  it("keyframes: flags background-position / box-shadow, allows transform", () => {
    const bad = `
  @keyframes shimmer {
    from {
      background-position: 0 0;
    }
    to {
      background-position: -200% 0;
    }
  }`;
    const good = `
  @keyframes shimmer {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(100%);
      opacity: 0.8;
    }
  }`;

    const found = findNonCompositedKeyframes("x.svelte", bad);
    expect(found).toHaveLength(2);
    expect(found[0].animation).toBe("shimmer");
    expect(findNonCompositedKeyframes("x.svelte", good)).toEqual([]);
  });

  it("keyframes: does not leak into the rule that follows the block", () => {
    const source = `
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .panel {
    width: 100px;
    box-shadow: 0 0 2px red;
  }`;
    expect(findNonCompositedKeyframes("x.svelte", source)).toEqual([]);
  });

  it("pollers: resolves literals and constants, flags sub-floor periods", () => {
    const source = `
const REFRESH_MS = 5000;
const SLOW_MS = 30_000;
timer = setInterval(() => { void refresh(); }, REFRESH_MS);
other = setInterval(() => { void refresh({ a: 1, b: [2, 3] }); }, 15_000);
slow = setInterval(tick, SLOW_MS);
fast = setInterval(tick, 250);`;

    const sites = findIntervalCallSites("x.ts", source);
    expect(sites.map((s) => s.periodMs)).toEqual([5000, 15000, 30000, 250]);

    const fast = findFastPollers(sites);
    expect(fast.map((s) => s.periodMs)).toEqual([5000, 250]);
    expect(findFastPollers(sites, 100)).toEqual([]);
  });

  it("pollers: resolves a constant declared in another file", () => {
    const constants = collectNumericConstants(
      "export const AGENT_TASK_POLL_MS = 15_000;",
    );
    const sites = findIntervalCallSites(
      "x.ts",
      "t = setInterval(tick, AGENT_TASK_POLL_MS);",
      constants,
    );
    expect(sites[0].periodMs).toBe(15_000);
  });

  it("pollers: ignores interface members and unresolvable periods", () => {
    const source = `
interface Timers { setInterval(fn: () => void, ms: number): unknown; }
const h = setInterval(tick, options.pollMs);`;
    const sites = findIntervalCallSites("x.ts", source);
    expect(sites.map((s) => s.periodExpression)).toEqual(["options.pollMs"]);
    expect(findFastPollers(sites)).toEqual([]);
  });

  it("visibility gate: detects both the listener and the state read", () => {
    expect(
      pausesOnVisibility('document.addEventListener("visibilitychange", f);'),
    ).toBe(true);
    expect(pausesOnVisibility('document.visibilityState === "hidden"')).toBe(
      true,
    );
    expect(pausesOnVisibility("timer = setInterval(refresh, 5000);")).toBe(
      false,
    );
  });
});

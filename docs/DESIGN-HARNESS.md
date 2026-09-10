# The design harness

A browser-speed loop for working on the desktop shell's *appearance*: layout,
spacing, colour, type, component states. It mounts the real shipped shell, so
what you change here is what ships — but it is not the desktop app, and the
last section of this doc is the list of things it cannot tell you.

Companion to [`LOCAL-BUILD-AND-TEST.md`](LOCAL-BUILD-AND-TEST.md), which covers
the other end: building the branch into a real installable app to prove the
lifecycle. Rough division of labour — the harness proves how it looks, a test
build proves that it works.

## Run it

```bash
cd apps/work && pnpm dev
```

Then open <http://localhost:5173/dev/shell>.

Guarded by SvelteKit's `dev` flag: a production build of the work app renders
nothing at this route.

### Query parameters

| Parameter | Effect |
|---|---|
| `?stage=off` | Drops the desktop stage — the shell fills the tab edge to edge. |
| `?wallpaper=<url>` | Swaps the gradient behind the window for an image. Useful for judging whether a translucent surface is actually tinting or just grey. |
| `?sessions=empty` | Renders the Sessions page with an empty snapshot. |

The Light / Dark / System control sits under the window and drives the real
`settingsArea.applyColorTheme`, not a CSS class of its own.

## What it actually mounts

`apps/work/src/routes/dev/shell/+page.svelte` renders `DesktopApp` from
`@hq/ui` — the same component `apps/sync` boots through `HqWorkWorkShell`, with
the same stylesheets. Around it:

- **A platform adapter** declaring `TAURI_CAPABILITIES`, not `WEB_CAPABILITIES`.
  This matters more than it sounds: roughly half the window chrome is
  capability-gated, and a web-capability harness silently drops the Launch
  pill, the HQ-folder and Console buttons, the Core popover and the local-only
  rails — none of which announce that they are missing. Unknown adapter slices
  fall through to a proxy that answers any method with an empty `ok()`, so
  turning a capability on cannot crash on the eighteenth host API nobody
  modelled.
- **Fixtures** for the directory, timelines, reactions, board, files and
  channel status (`packages/ui/src/shell/fixtures.ts`). `fetchChannel` answers
  from the same fixtures the shell is seeded with — an adapter that returned an
  empty page here used to wipe the seeded thread a beat after it painted.
- **A stage**: a rounded, translucent window frame over a gradient, with
  stand-in traffic lights drawn to the shipping metrics from
  `titlebar-layout.ts`, so the 78px gutter the titlebar reserves has something
  in it the eye can judge spacing against.

## Comparing against the design concept

The V2 concept is checked in as a built preview. Serve it beside the harness
and diff computed styles rather than eyeballing screenshots:

```bash
cd apps/sync/dist-preview && python3 -m http.server 8787
```

Then <http://127.0.0.1:8787/dev-harness/?view=v2> (add `&theme=light`).

Name-based diffing of the two stylesheets does not work — the concept defines
386 classes, production 2,153, and only 53 names overlap. Run matched selector
probes in both pages and compare the numbers instead. That is how the unstyled
channel-title `<h2>` and the 936px scope menu were found; neither showed up in
any source grep.

## What the harness cannot show you

Anything below the web layer. Use a test build (`LOCAL-BUILD-AND-TEST.md` §3)
before merging work that touches these:

- **The window material.** The stage's glass is `backdrop-filter` over a fake
  wallpaper. The real window is `NSGlassEffectView` on macOS 26+. A surface can
  look right here and wrong on the desktop.
- Native traffic lights, the menubar item, OS notifications, the updater.
- Sessions spawning real Claude Code / Codex processes, LaunchAgents, the
  filesystem, sign-in, and your actual HQ data.

### And the failure mode to watch for

The harness can drift from the shipping window without anything failing.
`apps/sync/src/desktop-alt/styles/desktop-alt.css` applies window-level global
CSS — a `box-sizing: border-box` reset, the scrollbar rule — that the work app
does not. While that reset was missing here, every `width: 100%` element with
padding overflowed its container *in the harness only*, which read as a layout
bug in components that were fine.

`apps/work/src/routes/dev/shell/harness-fidelity.test.ts` locks the pairs that
have bitten so far. When you find another one, fix the harness and add the
assertion in the same commit — a harness you cannot trust is worse than no
harness, because it sends you to edit components that were never wrong.

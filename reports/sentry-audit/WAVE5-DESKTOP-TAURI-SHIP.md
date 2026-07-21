# Wave 5 — Desktop Tauri ship notes

Date: 2026-07-21

## HQ-DESKTOP-38 — `plugin:window|set_size` denied by ACL

The legitimate callers are the main menubar webview's adaptive popover resize
and the onboarding-to-popover handoff. `apps/sync/src-tauri/capabilities/default.json`
targets the `main` window and already grants `core:window:allow-set-size`; this
wave documents that requirement and adds a regression source-contract test that
ties the main label, permission, and all three frontend callers together.

## HQ-DESKTOP-39 — `listeners[eventId].handlerId`

PR #236 (`4c82668d`) fixed late listener cleanup for the swappable
NotificationFeed and V4Sidebar surfaces. The persistent main surface still
registered listeners asynchronously and previously disposed only the handles
that had resolved before teardown. This wave scopes main registrations to a
ListenerRegistry: handles resolving after disposal are unlistened immediately.
The same regression test pins the registry lifecycle.

## Verification completed

From `apps/sync` on 2026-07-21:

```sh
pnpm test -- tauri-window-size-and-listener-cleanup.test.ts
pnpm typecheck
pnpm lint
SENTRY_AUTH_TOKEN='' VITE_SENTRY_DSN='' pnpm build
pnpm test:e2e:desktop-alt
```

All commands passed. The Vitest invocation completed the frontend suite:
114 files / 1,319 tests passed; `svelte-check`, lint (0 errors), and the
production build passed. The desktop-alt source-contract suite also passed:
64 files / 407 tests.

## Release

A patch release is required to deliver the Sentry fixes to installed desktop
clients. This release is stamped as `v0.10.27` and includes the Wave 4 watcher
and listener-cleanup fixes merged after `v0.10.26` as well as this Wave 5 fix.

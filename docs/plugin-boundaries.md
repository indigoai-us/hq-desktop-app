# Plugin boundaries

The desktop app is moving from one undifferentiated source tree to a small stable core
plus feature domains that own their own logic, tests, and eventually their own repos and
release cadence. This document states the rule that makes that possible and records where
the first domain — meetings — currently stands.

## The rule

**Dependency direction is one-way: plugin crates depend on `hq-desktop-core`; nothing in
`hq-desktop-core` may depend on a plugin crate.**

`hq-desktop-core` is the foundation: paths and config dirs, the diagnostic logfile,
ignore rules, the HQ CLI resolver, the feature gate, and the shared event contract. It is
product-neutral. A feature domain — meetings, messaging, widget — lives in its own
`crates/hq-plugin-*` crate that depends on the foundation.

This is enforced by the compiler, not by convention: a plugin crate is absent from
`hq-desktop-core`'s `[dependencies]`, so a reverse reference fails to build. Do not add
one. If foundation code appears to need something from a plugin, the thing it needs is
either (a) genuinely foundational and belongs in the core crate, or (b) a sign the call
should be inverted so the plugin registers with the core instead.

## Layering within a domain

    crates/hq-plugin-<domain>/     pure domain logic — no Tauri
    apps/sync/src-tauri/src/commands/<domain>.rs
                                   thin Tauri command wrappers over that logic
    apps/sync/src/…                the domain's Svelte UI
    apps/sync/sidecar/<name>/      any separate process the domain supervises

Keep the logic crate free of Tauri. That is what makes it testable without an app harness
and what will let it move to its own repo behind a plugin SDK later.

## Meetings — current state

Extracted (this change):

- `crates/hq-plugin-meetings/` — meeting detection and the Recall Desktop SDK bridge
  protocol (`recall_sdk`), the meetings/calendar API surface (`meetings`), and the
  detected-meeting (`meeting_ledger`) and recordings (`recordings_ledger`) ledgers.
  ~3.5k LOC lifted out of `hq-desktop-core`, tests included, no behaviour change.

Still in the core / shared modules, to be addressed before meetings can leave the repo:

| Location | What it holds |
|---|---|
| `crates/hq-desktop-core/src/events.rs` | meeting event payload types and the `meeting:detected` / `meeting:closed` / `notification:meeting-action` channel names |
| `apps/sync/src-tauri/src/commands/permissions.rs` | `meetings_permissions_state`, `open_meeting_permissions_window` |
| `apps/sync/src-tauri/src/commands/banner.rs` | meeting-specific banner preview and routing |
| `apps/sync/src-tauri/src/tray.rs` | `meetings_set_prompt_badge` |
| `apps/sync/src-tauri/src/commands/un_notify.rs` | meeting notification delegate handling |
| `crates/hq-desktop-core/src/settings.rs` | `default_meeting_detect_notify` preference |

The event types are the interesting case: they are the *contract* between core and the
domain, so they are the natural shape of a future plugin SDK rather than something to
delete. The others are core services (tray, permissions, banners, notifications) that a
plugin should reach through a generic registration API instead of by name — that API is
the next piece of work, and meetings is its first consumer.

## Adding a new domain

1. `crates/hq-plugin-<domain>/` with a dependency on `hq-desktop-core` and nothing
   pointing back.
2. Domain logic and its tests in that crate. No Tauri.
3. Tauri command wrappers in `apps/sync/src-tauri/src/commands/<domain>.rs`, registered
   in `main.rs`.
4. If the domain needs a core service by name, raise it — that is a missing registration
   API, not a licence to reach into core.

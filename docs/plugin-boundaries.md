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

Meetings is the first domain to leave this repo entirely. It lives in
[`indigoai-us/hq-plugin-meetings`](https://github.com/indigoai-us/hq-plugin-meetings)
with its own CI and release cadence, and is consumed here as a git dependency pinned
to a tag in `apps/sync/src-tauri/Cargo.toml`. Its git history came with it.

### The `[patch]` you will notice in the app manifest

`hq-desktop-core` now has its own repo,
[`indigoai-us/hq-desktop-core`](https://github.com/indigoai-us/hq-desktop-core), and
the meetings plugin depends on a tag from it. That removed the repo cycle: the plugin
no longer points back at this repo, so the graph is a line rather than a loop.

This repo has not switched over yet, and still carries `hq-desktop-core` as a path
crate under `crates/`. So a build here resolves two copies — ours by path, the
plugin's by git — which cargo treats as unrelated types. The `[patch]` in
`apps/sync/src-tauri/Cargo.toml` collapses them onto this checkout.

**Why this repo has not switched.** 26 test files here read `hq-desktop-core`'s Rust
source directly off disk — `readFileSync('../../crates/hq-desktop-core/src/*.rs')` —
and assert against its text. They cover 18 core modules across `__tests__/stories/`
and `e2e/desktop-alt/`. That style of source-contract test structurally requires the
crate to sit in this working tree, so depending on the tag instead would break all of
them at once. Migrating them (most belong upstream as real Rust tests, which is
strictly stronger than grepping source text) is its own piece of work and has not
been done.

Until it is, keep the tags aligned: every consumer in one build must pin the same
`hq-desktop-core` tag, because cargo unifies git dependencies by source URL *and*
resolved commit.

### `hq-desktop-core` currently exists in two places — keep them identical

Because this repo has not switched to the tag, the foundation crate lives both here
(`crates/hq-desktop-core/`, the copy that actually ships, since the `[patch]` points
builds at it) and in its own repo (the copy `hq-plugin-meetings` builds against in its
CI). They are byte-identical today and must stay that way.

**Any change to `crates/hq-desktop-core/` here must be mirrored to
`indigoai-us/hq-desktop-core`, and vice versa.** Nothing enforces this yet — no CI
check compares them — so it is a discipline, which is the weakest kind of guarantee.
Silent drift would mean the plugin is tested against one version of the foundation and
shipped against another.

This duplication is the direct cost of the 26 source-grep tests above. It ends when
they migrate and this repo depends on the tag like every other consumer, at which
point there is one copy again.

### Cross-repo contracts have no CI owner

Splitting repos split some contracts in half, and neither side's CI checks the other.
The known one: this repo bundles `bridge.mjs` into `Contents/Resources/recall-sdk-bridge/`,
and the plugin's resolver expects exactly that path. Change one without the other and
both test suites stay green while recording breaks at runtime. See the comment in
`apps/sync/e2e/desktop-alt/recall-sidecar-bundle.spec.ts`.

### Couplings still owned by this repo

These are core services meetings reaches by name. Each one is a place where a plugin
should be registering with the core rather than being hardcoded into it, and together
they are the requirements list for the plugin registration API:

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

### The repos are private; CI authenticates with an indigo token

`hq-desktop-core` and `hq-plugin-meetings` are private repos. cargo cannot fetch
them anonymously, so every CI job that compiles across the split configures a git
credential before its first cargo step:

    git config --global \
      url."https://x-access-token:${GH_FETCH_TOKEN}@github.com/indigoai-us/".insteadOf \
      "https://github.com/indigoai-us/"

The token comes from the `INDIGO_GH_TOKEN` Actions secret on each consuming repo
(this repo and `hq-plugin-meetings`). Its value is indigo's `GH_TOKEN` vault secret —
a classic PAT with `repo` scope. The rewrite is scoped to `github.com/indigoai-us/`,
so the credential is only ever sent to this org.

Which jobs carry the step, and which deliberately do not:

- Need it (compile the app crate, which depends on the private plugin): `ci.yml`
  `rust-macos`; `windows-check.yml` both jobs; `release.yml` `macos` + `windows`.
- Do NOT need it: `rust-linux` (root workspace excludes the app crate, so it never
  references the plugin), `frontend` / `e2e-desktop-alt` (no cargo), `release.yml`
  `validate` (JS-only). `hq-desktop-core`'s own CI needs nothing — it fetches no
  private deps.

If a new cargo job is added that builds the app crate, it needs this step or it fails
to fetch the plugin. A fork PR gets no secret and cannot fetch — acceptable, since
this is an internal repo.

# Consuming `@hq/ui` + platform contracts

Sync embeds HQ Work's platform-pure UI (`DesktopApp`) in a later story
(US-103). This document is the consume/pin contract (US-101).

## Chosen mechanism (this branch)

Pinned `file:` dependencies from `apps/sync` onto the sibling HQ worktree
checkout of `hq-work-mono`:

```text
@hq/ui        file:../../../../hq-work-mono/hq-work-sync-handoff/packages/ui
@hq/platform  file:../../../../hq-work-mono/hq-work-sync-handoff/packages/platform
@hq/core      file:../../../../hq-work-mono/hq-work-sync-handoff/packages/core
```

All three are required. `@hq/ui` depends on `@hq/core` and `@hq/platform`; a
naive `file:` of only `@hq/ui` fails because `workspace:*` does not resolve
outside the mono pnpm workspace. The mono packages use in-tree `file:../core`
and `file:../platform` so the graph resolves when the source tree is linked.
Root `.pnpmfile.cjs` rewrites leftover `workspace:*` to those sibling paths.

Install from the **desktop worktree root** (`pnpm install`). Do not treat the
nested `apps/sync/pnpm-lock.yaml` as the source of truth.

If the mono checkout is not at the sibling worktree path, retarget the three
`file:` specifiers (or copy the layout). `HQ_WORK_MONO_ROOT` is not read by
pnpm; the pin is the `file:` path in `apps/sync/package.json`. A checkout of
this repo alone cannot `pnpm install` until those paths exist or the GitHub
Packages aliases replace them.

hq-work-mono packages are **not** desktop workspace members, so turbo does not
typecheck/build them as part of this repo.

Vitest 4 will not strip TypeScript under `node_modules`. `apps/sync/vite.config.ts`
inlines `@hq/ui`, `@hq/platform`, and `@hq/core` for tests.

## Pinning strategy

| Channel | Pin |
| --- | --- |
| This feature branch | Exact `file:` path to the sibling worktree packages (package version `0.0.0`) |
| Sync product release | Exact version of `@indigoai-us/hq-work-ui` (plus platform/core) from GitHub Packages. **Never** `^` / `~` / `workspace:*` |

Example release pin (not shipped in this story). Use npm aliases so source
imports of `@hq/ui` / `@hq/platform` / `@hq/core` keep resolving:

```json
"@hq/ui": "npm:@indigoai-us/hq-work-ui@0.1.24",
"@hq/platform": "npm:@indigoai-us/hq-work-platform@0.1.24",
"@hq/core": "npm:@indigoai-us/hq-work-core@0.1.24"
```

Registry: `https://npm.pkg.github.com` (`@indigoai-us/*`). Local/CI installs
need `read:packages` (see hq-pro-private-package-install-auth).

## Eventual GitHub Packages publish

Do not cut an hq-work-mono product vtag from this story. After a tag-driven
mono release (`versions.toml` is stamped by `scripts/version-app.mjs`):

```bash
pnpm pack:ui -- --publish-names
```

That stages `@hq/ui` / `@hq/platform` / `@hq/core` with `private: false`, exact
in-graph versions, and `publishConfig.name` of `@indigoai-us/hq-work-*`.
Source imports stay `@hq/*`. Publish those tarballs to GitHub Packages, then
replace the Sync `file:` deps with the npm aliases above and drop
`.pnpmfile.cjs` if it is unused.

## ui-purity

`packages/ui` must not touch Tauri/`invoke`. Enforced on the package side:

```bash
node scripts/check-ui-purity.mjs
```

## Out of scope here

- Mounting `DesktopApp` in the Sync window (US-103)
- Implementing the Sync `PlatformAdapter` (US-102)
- Co-install / `launch_hq_work` product path

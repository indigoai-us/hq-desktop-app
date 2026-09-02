# Consuming `@hq/ui` + platform contracts

Sync embeds HQ Work's platform-pure UI (`DesktopApp`) in the desktop-alt window
(US-103) through a Sync-side `PlatformAdapter` (US-102). This document is the
consume contract (US-101).

## Chosen mechanism

`@hq/ui`, `@hq/platform`, and `@hq/core` are **vendored into this repo** as
pnpm workspace members:

```text
packages/core       @hq/core
packages/platform   @hq/platform
packages/ui         @hq/ui
```

`apps/sync/package.json` depends on all three with `workspace:*`, and
`pnpm-workspace.yaml` lists `packages/*`. All three are required: `@hq/ui`
imports `@hq/core` and `@hq/platform`.

Provenance, the copy procedure, and what a copy must include are in
[packages/VENDORED.md](../../../packages/VENDORED.md).

## Why not a sibling checkout or a registry

The previous mechanism pinned `file:` paths onto a sibling `hq-work-mono`
worktree. It worked on the machine that had that worktree and nowhere else — a
bare checkout could not `pnpm install` at all, so frontend CI failed within
seconds:

```text
ENOENT: no such file or directory, scandir '.../hq-work-mono/hq-work-sync-handoff/packages/core'
```

Publishing to GitHub Packages was the documented successor, but nothing backed
it: the packages were `private: true` at version `0.0.0`, hq-work-mono had no
publish workflow and no `pnpm pack:ui` script despite an earlier draft of this
file describing one, and pnpm does not honour `publishConfig.name` (verified
against pnpm 10.33 — the packed tarball keeps the workspace name), so the
`@hq/*` → `@indigoai-us/hq-work-*` rename that plan depended on does not happen
on its own.

Vendoring removes the external dependency entirely: no sibling checkout, no
registry, no publish credentials, and CI installs a bare clone.

The cost is a fork — see the sync procedure in `packages/VENDORED.md`.

## What this means day to day

- The packages ship **source**, not build output. There is no build step.
- `apps/sync/vite.config.ts` inlines `@hq/ui`, `@hq/platform`, and `@hq/core`
  for tests, because Vitest 4 will not strip TypeScript under `node_modules`.
- The packages are workspace members, so `turbo` runs their `typecheck` and
  `test` tasks: 128 test files and ~1,240 tests now run in this repo alongside
  the Sync suite.
- Tooling versions (`svelte`, `vitest`, `happy-dom`, `svelte-check`,
  `typescript`, `@sveltejs/vite-plugin-svelte`) are kept equal to `apps/sync`'s
  so the workspace resolves exactly one copy of each. Two Svelte copies in one
  app break runes and context.

## The seam that actually breaks

`@hq/platform`'s `PlatformAdapter`. When the upstream contract gains or drops a
member, `packages/platform/src/tauri/sync-adapter.ts` must follow — this has already
broken twice:

- Missing members fail `apps/sync/__tests__/stories/hq-work-adapter-contract-parity.test.ts`,
  which derives the required list from `@hq/platform`'s own `adapter.ts`.
- Members the adapter declares that the contract no longer has fail
  `svelte-check` only. The re-copy that produced the current tree surfaced
  three: `IdentityApi` gained `getProfile`/`updateProfile`, `MessagingApi`
  gained `removeChannelMember`, and `applyDockIcon` became
  `setDockVisible(visible)`.

Run `pnpm typecheck && pnpm test` after every re-copy.

## ui-purity

`packages/ui` must not touch Tauri or `invoke` — that is what makes it
mountable in both the web app and this one. Enforced upstream by
`node scripts/check-ui-purity.mjs` in hq-work-mono's lint. The check is not
vendored; keep the guarantee by re-copying only from a green upstream main.

## Out of scope here

- Mounting `DesktopApp` in the Sync window (US-103)
- Implementing the Sync `PlatformAdapter` (US-102)
- Publishing the packages to a registry (superseded by vendoring)

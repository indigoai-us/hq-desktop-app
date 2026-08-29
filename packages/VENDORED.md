# Vendored HQ Work packages

`core/`, `platform/`, and `ui/` are copies of the same-named packages in
[indigoai-us/hq-work-mono](https://github.com/indigoai-us/hq-work-mono).

|             |                                                          |
| ----------- | -------------------------------------------------------- |
| Source      | `indigoai-us/hq-work-mono` `packages/{core,platform,ui}` |
| Copied from | `f85dfb6407d467c44de3133791b40158cfe16ef9` (main)        |
| Copied on   | 2026-08-29                                               |

## Why they live here

The Sync desktop window embeds HQ Work's platform-pure UI. That code previously
arrived through `file:` dependencies pointing at a sibling `hq-work-mono`
worktree, which meant a bare checkout of this repo could not `pnpm install` at
all — frontend CI failed in seconds with
`ENOENT: no such file or directory, scandir '.../hq-work-mono/.../packages/core'`.
As workspace members they install with no external checkout and no registry.

They keep their `@hq/*` package names so every `import … from "@hq/ui"` in both
repos still reads the same.

## What a copy has to include

Not just TypeScript. `ui/src` also carries **5 CSS token sheets** and
**5 JPEG pack covers** that components import directly, so an
extension-filtered copy silently drops them and the Library surface breaks at
runtime rather than at build. Copy whole folders.

There is no build step: the packages ship source, and the consumer compiles
them. `apps/sync/vite.config.ts` inlines `@hq/{ui,platform,core}` for tests
because Vitest will not strip TypeScript under `node_modules`.

Tooling versions (`svelte`, `vitest`, `happy-dom`, `svelte-check`,
`typescript`, `@sveltejs/vite-plugin-svelte`) are pinned to the same ranges as
`apps/sync`. Two Svelte copies in one app break runes and context — keep them
aligned.

## Keeping them in sync

This is a copy, so it forks the moment either side changes. Re-copying is the
whole update procedure:

```bash
for p in core platform ui; do
  rsync -a --delete --exclude node_modules \
    <hq-work-mono>/packages/$p/ packages/$p/
done
```

Then re-align the tooling versions above, update the commit in this file, and
run `pnpm typecheck && pnpm test`.

The seam that actually breaks is `@hq/platform`'s `PlatformAdapter`: when the
contract gains or drops a member, `apps/sync/src/lib/hq-work-adapter.ts` has to
follow. `apps/sync/__tests__/stories/hq-work-adapter-contract-parity.test.ts`
derives the required member list from the contract itself and fails on missing
members; `svelte-check` catches members the adapter declares that the contract
no longer has.

## Local divergences (do not lose these on a re-copy)

The `rsync --delete` above overwrites the vendored tree wholesale, so any fix
made here is silently reverted unless it has also landed upstream. These are
the deliberate divergences as of 2026-08-29 — each carries a regression test in
this repo, so a re-copy that drops one will fail `pnpm test` rather than fail
quietly:

| Area                                                                         | Change                                                                                                                                                                                                     | Test                                                                                         |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ui/src/chat/mentions.ts`                                                    | `applyMentionMarkup` walks tags and text separately instead of `split`/`join` over the whole HTML string, so an `@name` inside an `href` or `title` is left alone and inserted markup is never re-scanned. | `ui/src/chat/mentions.test.ts` — "applyMentionMarkup markup safety"                          |
| `ui/src/chat/mentions.ts`, `ChannelConversation.svelte`, `ReplyPanel.svelte` | New `storedMentionType()` falls back to the uid prefix when the wire row omits `participantType`, so an `agt_*` mention is not rendered as a clickable human profile.                                      | `ui/src/chat/mentions.test.ts` — "stored mention type"; `ReplyPanel.stored-mentions.test.ts` |
| `ui/src/chat/messaging/EmojiPicker.svelte`                                   | The Escape branch calls `stopPropagation()`, so closing the picker no longer also closes the reply panel behind it.                                                                                        | `EmojiPicker.escape.test.ts`                                                                 |
| `ReplyPanel.svelte`, `ChannelConversation.svelte`                            | `@media (hover: none)` keeps the quick-react toolbars visible and clickable, since touch input never fires `:hover`.                                                                                       | `quick-react-touch.test.ts`                                                                  |
| `platform/src/adapter.ts`, `platform/src/{tauri,web}/index.ts`, `ui/src/marketplace/marketplace.ts` | `MarketplaceApi.yank` carries the required moderation reason across every adapter, so Sync can invoke Rust's reason-required yank command without dropping the audit trail. | `platform/src/marketplace-yank.test.ts` — "MarketplaceApi.yank audit reason"; `apps/sync/__tests__/stories/hq-work-adapter-gaps.test.ts` — "maps marketplace.yank with its audit reason"; `ui/src/marketplace/marketplace.test.ts` — "calls the yank method with the id and returns the result" |
| `ui/src/settings/PrototypeSettingsPanes.svelte` | Hydrates Dock and desktop-widget toggles from host settings only when their native boolean keys are present, under the tray capability, and never overwrites a user click that races the read. Each control retains its last authoritative host value, updating it from every boolean hydration result, a latest successful write, and a successful reconciliation read. A latest error write re-reads authoritative host settings, rechecks the control-specific sequence, and reconciles only boolean keys; if that read fails or omits the key, it restores the retained authoritative value when one exists, otherwise preserves the optimistic value and clears dirty state. Unavailable writes never reread, reconcile, or update authority. | `ui/src/settings/PrototypeSettingsPanes.host-settings.test.ts` — "hydrates Dock and widget toggles from native settings without driving host setters"; "leaves local toggle values alone when native settings omit booleans"; "keeps a user toggle when the native settings read resolves later"; "reconciles a failed Dock write from the native read"; "keeps a Dock preference when the host reports it unavailable"; "does not clobber a newer Dock toggle when an earlier write fails"; "keeps the third Dock toggle and its dirty state when the first write fails"; "reverts a failed desktop widget write"; "keeps the third desktop widget toggle and its dirty state when the first write fails"; "reconciles failed Dock and desktop widget writes independently"; "reconciles the reported failed Dock sequence from persisted settings"; "reconciles the reported failed desktop widget sequence from persisted settings"; "clears a failed Dock write's dirty state when its authoritative read fails"; "does not clobber a newer Dock click while reconciliation rereads settings"; "restores the hydrated Dock value when a failed write cannot reconcile"; "restores the hydrated desktop widget value when a failed write cannot reconcile"; "uses the latest successful Dock write when a later failed write cannot reconcile"; "keeps the optimistic Dock value when the host has never reported one" |

Before re-copying, check whether upstream has taken equivalent fixes. If it
has, drop the row; if it has not, re-apply the change after the copy and
consider upstreaming it so the fork shrinks.

# Idea board E2E + capture-latency benchmark

`pnpm test:e2e:idea-board` runs the source-contract and component specs here.
The latency benchmark (`scripts/idea-board-bench.mjs`, `npm run
bench:idea-board`) is the project's primary acceptance gate (US-001): it must
stay green on every change to the capture path.

## The benchmark app bundle (read this before benching)

`--drive` measures the real capture path, which needs macOS **Screen
Recording** permission. macOS (TCC) keys that grant on a bundle identifier +
code signature, so the benchmark runs against a dedicated debug `.app` with a
**pinned** identifier:

| | |
|---|---|
| Identifier | `ai.indigo.hq-idea-board-bench` |
| Product name | `HQ Idea Board Bench` |
| Built by | `npm run bundle:bench` (`apps/sync/scripts/build-bench-bundle.sh`) |
| Path | `apps/sync/src-tauri/target/debug/bundle/macos/HQ Idea Board Bench.app` |

```bash
cd apps/sync
npm run bundle:bench          # build / rebuild the bench bundle
npm run bench:idea-board -- --drive
```

**The Screen Recording grant is one-time.** Add the `.app` above once under
System Settings → Privacy & Security → Screen & System Audio Recording.
Because the identifier is pinned (and the bundle is ad-hoc signed, so its
identity does not change), **rebuilding no longer voids the grant** — which is
the whole reason this bundle exists. Two benchmark runs were previously lost to
TCC re-grants after `npm run bundle:debug` re-signed the shipping identifier.

Two more consequences of the pinned identifier:

- The bench app has its own identifier, so it does **not** collide with the
  developer's running HQ dev app on the single-instance socket, `~/Library`
  state, or the LaunchAgent. Both can run at once.
- `--drive` launches this bundle, never `target/debug/hq-sync-menubar`. The
  raw binary has no bundle identity, so TCC cannot match the grant and every
  capture comes back empty. If the bundle is missing, or its identifier drifts,
  or Screen Recording is denied, the bench **fails loudly** instead of
  reporting zero samples. `hq-idea-board-bench-bundle.spec.ts` guards this.

This follows `docs/LOCAL-BUILD-AND-TEST.md` §3 (`--config`-overridden debug
bundle, own identifier, updater disabled, ad-hoc signed).

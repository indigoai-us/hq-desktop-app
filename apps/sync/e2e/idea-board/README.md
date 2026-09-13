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
| Signed with | `Developer ID Application: Stefan Johnson (FSZQ97X3V6)` |
| Path | `apps/sync/src-tauri/target/debug/bundle/macos/HQ Idea Board Bench.app` |

```bash
cd apps/sync
npm run bundle:bench          # build / rebuild the bench bundle
npm run bench:idea-board -- --drive
```

**The Screen Recording grant is one-time — but only because the bundle is
signed with a real certificate.** Add the `.app` above once under System
Settings → Privacy & Security → Screen & System Audio Recording.

TCC keys a grant on the code's **identity**, and what counts as "identity"
depends on how the code is signed:

- **Ad-hoc (`codesign -s -`)** — there is no certificate, so there is nothing
  stable to key on and TCC falls back to the binary's **cdhash**. The cdhash is
  a hash of the code itself, so it changes on *every single build*. **An ad-hoc
  signature voids the Screen Recording grant on every rebuild**, no matter how
  firmly the `CFBundleIdentifier` is pinned. This bundle was originally ad-hoc
  signed and the claim that a pinned identifier alone preserved the grant was
  simply wrong: the owner granted Screen Recording to it twice and both grants
  were destroyed by the next rebuild (a fresh launch logged
  `meetings_permissions_state: … sc=Denied`).
- **Developer ID (what this bundle uses now)** — the signature carries a
  certificate chain, so TCC keys the grant on the bundle's *designated
  requirement*: identifier `ai.indigo.hq-idea-board-bench` + Team ID
  `FSZQ97X3V6` + the Apple-anchored cert chain. None of those change when the
  code is rebuilt, so **the stable Developer ID signature — not the pinned
  identifier — is what actually preserves the grant.** The cdhash still churns
  every build; it just no longer matters.

The build script refuses to run if that identity is missing from the keychain
rather than silently falling back to ad-hoc, and asserts the finished bundle is
not ad-hoc before it reports success.

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
bundle, own identifier, updater disabled) — with one deliberate departure: the
guide's ad-hoc signing is replaced by the Developer ID Application identity
mandated by company policy `indigo-hq-desktop-app-signing-release-identity`,
because ad-hoc signing cannot hold a TCC grant across rebuilds. Notarization is
still **not** required (this bundle never ships), so the signing pass runs
without the hardened runtime and without a secure timestamp; both are
notarization requirements and neither affects the code identity TCC keys on.

//! Shared @indigoai-us/hq-cloud package coordinates for desktop sync.

/// Semver range for `@indigoai-us/hq-cloud` that ships `hq-sync-runner`.
///
/// Format is npm's `package-spec` — a tilde-prefixed minor floor
/// (`~MAJOR.MINOR.0`) selects the *minor line* but lets patches flow
/// automatically: `~5.19.0` resolves to the newest published `5.19.x` at
/// spawn time. Bumping the minor (e.g. to `~5.20.0`) is the deliberate
/// "select a new line" lever; patch-only fixes (5.18.1, 5.18.2, …) ship
/// to users automatically on their next sync without a Rust rebuild.
///
/// npx resolves the range at each spawn (the resolved version becomes
/// the on-disk cache key under `~/.npm/_npx/`), so a freshly published
/// patch causes a single re-fetch then steady-state cache reuse — same
/// shape as an exact-version bump, just driven by the registry instead
/// of source. The `commands::prewarm` task fires this same fetch on app
/// startup so the cost lands in the background rather than during the
/// user's first click of "Sync Now".
///
/// 5.19.x switches the sync runner's slug resolution to the per-user
/// namespace endpoint (`/entity/check-slug/me` → `entity.get(uid)`).
/// On 2026-05-15 hq-pro#67 went live and flipped the legacy global
/// `/entity/by-slug/{type}/{slug}` to `requireUnique: true` semantics:
/// any slug shared across tenants now returns HTTP 409
/// `SlugNotUniqueError` instead of silently resolving to the caller's
/// own entity. The 5.18.x runner still calls the global endpoint, so
/// `~5.18.0` clients keep working only until the first cross-tenant
/// slug collision in prod — `~5.19.0` is the minimum pin that stays
/// correct under the new server semantics. See indigoai-us/hq-cloud#3
/// + indigoai-us/hq-pro#67.
///
/// 5.18.x adds two corrections downstream of the 5.17.x reconciliation
/// fixes. 5.18.0 made symlinks round-trip as first-class entries (zero-
/// knowledge target, ETag-distinguishable from same-content regular
/// files), instead of silently dereferencing top-level symlinks or
/// dropping nested ones during walk. 5.18.1 filters S3 directory-marker
/// objects (0-byte, key ends in `/`) at `listRemoteFiles` so neither
/// the pull-planner (`hashFile` on existing local dir → EISDIR "read")
/// nor `downloadFile` (`writeFileSync` on trailing-slash path → EISDIR
/// "open") ever sees them — closes the regression introduced in 5.13.0
/// when the 0-byte filter was widened to admit legitimate `.gitkeep`
/// placeholders. See indigoai-us/hq-cloud#2 (5.18.0) + #4 (5.18.1) for
/// the wire-format details.
///
/// 5.17.x earlier shipped the journal-direction + ignore-filter guard
/// on `propagateDeletes` (defaults to `"owned-only"`). The 5.15.x line
/// still followed the legacy "delete every journal entry whose local
/// file is missing" semantics, which would erase peer uploads when the
/// first menubar sync ran on a behind machine and would erase legacy/
/// filtered paths when the local hqRoot's ignore filter rejected them.
/// See indigoai-us/hq#142 + the 2026-05-14 incident report.
///
/// 5.24.0 (2026-05-21) ships two related fixes, both motivated by a
/// real incident where a user's personal vault accumulated ~2,600 zombie
/// objects (~1,700 from old HQ layouts + ~900 from conflict-mirror
/// pollution + 196 cross-scope `companies/{slug}/**` leaks).
///   - Conflict-mirror exclusion in the push walker AND delete plan:
///     `*.conflict-<ISO>-<hash>.<ext>` files never round-trip to S3.
///     Active for ALL policies, not just the new default. Stops new
///     litter accretion immediately.
///   - `currency-gated` delete-propagation policy (opt-in in 5.24,
///     scheduled default in 5.25). Per-file HEAD + ETag verification
///     before any local-delete propagates. Strictly safer than
///     `owned-only` because it lets files arriving via `/update-hq`
///     (direction:"down") be cleanly deleted by the device that wrote
///     them, as long as no other device touched them since.
///   - Plus: new `filesTombstoned` / `filesRefusedStale` counters on
///     ShareResult, a `delete-refused-stale-etag` event variant, and
///     the `HQ_SYNC_DELETE_POLICY=currency-gated|owned-only|all` env
///     override honored by `sync-runner`.
/// See indigoai-us/hq-cloud#14 + 2026-05-21 reconcile incident report.
///
/// 5.25.0 (2026-05-21) ships two more fixes building on 5.24:
///   - PERSONAL_VAULT_DEFAULT_EXCLUSIONS — a hard exclusion list applied
///     when personalMode is true, complementing the existing top-level
///     filter (PERSONAL_VAULT_EXCLUDED_TOP_LEVEL) and the ephemeral
///     conflict-mirror filter (EPHEMERAL_PATH_PATTERN). Categories:
///     secrets (.env, .env.*, .mcp.json), machine-local state (.beads/,
///     .obsidian/, .vercel/, .cache_*), update-flow scratch (output/,
///     _legacy-*), pre-5.24 conflict mirror dir (.hq-conflicts/), OS /
///     build cruft (.DS_Store, node_modules/, dist/, .next/, build/).
///     Wired into both the upload walk and the delete-plan walk so
///     existing journaled entries matching a new exclusion get orphaned
///     (no DELETE issued). Emits a single `personal-vault-out-of-policy`
///     event per share() call when count > 0.
///   - Default delete policy flipped owned-only -> currency-gated (the
///     5.24-promised flip after the soak window). Rollback knob:
///     HQ_SYNC_DELETE_POLICY=owned-only.
///   - New CLI flag `--skip-personal` + env `HQ_SYNC_SKIP_PERSONAL=1`
///     drops the personal target from the --companies fanout. Used by
///     the menubar's "Sync personal vault" Settings toggle.
/// See indigoai-us/hq-cloud#15.
///
/// 5.26.0 (2026-05-22) adds the event-driven push watcher (`--event-push`,
/// gated to @getindigo.ai in the menubar; default poll-only otherwise).
/// 5.27.0 (2026-05-22) fixes the watcher never firing for `--companies`
/// edits: the runner no longer forces `personalMode: true` (which excluded
/// the `companies/` subtree it actually syncs), and the chokidar `ignored`
/// predicate no longer prunes ancestor dirs of allowlisted leaves on its
/// stat-less descent probe. Without this, instant sync silently fell back
/// to the 10-minute poll. The `~5.26` -> `~5.27` bump is required to pick it
/// up (tilde ranges don't cross the minor boundary).
/// 5.28.0 (2026-05-22) replaces the watcher's per-directory chokidar watch
/// with a SINGLE recursive `fs.watch` on macOS (FSEvents). chokidar 4 dropped
/// `fsevents`, so it watched via kqueue at ~1 fd per path (~11,600 fds over a
/// real HQ tree) — which EMFILEs under the default soft `ulimit -n` (256) and
/// silently kills the watcher. After: 1 OS handle for the whole tree. The
/// `~5.27` -> `~5.28` bump is required to pick it up.
/// 5.29.0 (2026-05-22) stamps `direction` ("up"/"down") on per-file progress
/// events so the menubar's Recent Changes activity log can label each file
/// uploaded vs downloaded. The `~5.28` -> `~5.29` bump is required to pick it up.
/// 5.30.0 (2026-05-22) fixes the personal-vault journal-slug collision: the
/// personal-vault fanout slot and a real `companies/personal` company both
/// resolved to journal slug `personal`, sharing one journal — so the company's
/// whole-tree delete-plan tombstoned the vault's hq-root keys every cycle and
/// the vault re-uploaded them (~190 `.claude/skills/*` files churned per sync).
/// 5.30 reserves a distinct vault journal slug (with a one-time seed migration).
/// The `~5.29` -> `~5.30` bump is required to pick it up.
/// 5.31.0 (2026-05-22) returns the downloaded object's S3 `created-by` metadata
/// and stamps it as `author` on download `progress` events, so the Recent
/// Changes activity log can attribute downloaded files to whoever uploaded
/// them. The `~5.30` -> `~5.31` bump is required to pick it up.
/// 5.32.0 (2026-05-23) extends sync to cloud:false companies via the
/// personal-vault fanout slot — the menubar can sync local-only company
/// trees through the same engine without registering them as cloud-backed.
/// 5.33.0 (2026-05-23) closes the original conflict-loop incident: lifts
/// machine-id provisioning into hq-cloud (4-tier resolver with SHA-1 hex
/// normalization for non-hex tier-1/tier-3 sources) and widens
/// `EPHEMERAL_PATH_PATTERN` to accept the `unknown` sentinel and
/// extensionless originals. Pre-5.33 Lightsail outposts stamped
/// `-unknown` short tokens that the share filter then refused, looping
/// `.conflict-*` litter through S3 forever. See indigoai-us/hq-cloud#23.
/// 5.34.0 (2026-05-24) ships the 10-bug cross-machine sync cleanup
/// (indigoai-us/hq-cloud#24) — three of those bugs directly destroy the
/// menubar's user-facing promises:
///   - Bug #9: cross-machine deletes now propagate via journal-vs-LIST
///     diff + HEAD-verify scope guard. Pre-5.34 the pull walker had no
///     tombstone-consumption mechanism, so the menubar's "drifted files"
///     count never zeroed (root cause of the operator's
///     `sync-app-is-still-showing-24-drifted-files-after-update` project).
///   - Bug #7: first-time-upload-with-cloud-collision now writes a
///     mirror instead of silently overwriting peer content. Pre-fix two
///     open laptops editing the same file before either synced silently
///     destroyed the slower-to-sync side with no conflict event → no tray
///     badge → invisible data loss.
///   - Bug #10: dir-vs-file `(local-file, cloud-dir)` no longer throws
///     `ENOTDIR` and aborts the whole company sync. Pre-fix one stale
///     path wedged auto-sync indefinitely.
/// Plus #1/#6/#8 (`.hq/` leak channel), #2 (pull-side ephemeral filter),
/// #3 (conflictPaths dedup), #4 (dir-vs-file warning), #5 (file mode
/// preserved across sync). Codex P1/P2 follow-ups: HEAD-verify STS scope,
/// EACCES journal retention, local-edit-vs-remote-delete race detection
/// for both files and symlinks, strict-octal `hq-mode` parse.
/// 5.35.0 (2026-05-24) adds `.claude/state/` + `.claude/audit/` to
/// `DEFAULT_IGNORES`. Those directories are session-/host-scoped by
/// design and were the dominant source of conflict mirrors in the 5.34.0
/// live cross-machine test (~25 of 30 mirrors traced directly there).
/// See indigoai-us/hq-cloud#25.
/// 5.36.0 (2026-05-24) ships two sync speedups: lstat fast-path skips
/// SHA-256 when `(size, mtimeMs)` match the journal baseline (~5–10× on
/// no-op syncs — most syncs) and a bounded-parallel transfer pool
/// (default 16, knob `HQ_SYNC_TRANSFER_CONCURRENCY`) for uploads +
/// downloads (4–8× on transfer-heavy syncs). Codex P1 follow-ups
/// serialize the interactive conflict prompt under the pool and drain
/// in-flight transfers on worker error. See indigoai-us/hq-cloud#26.
/// 5.37.0 (2026-05-25) ships file mtime + birthtime preservation across
/// sync. Push stamps source-side `lstat.mtimeMs` (and `birthtimeMs` when
/// the filesystem supports it AND differs from mtime) into S3 metadata
/// as `hq-mtime` / `hq-btime`. Pull applies the stamped value via
/// `utimesSync` after the byte write, falling back to write-time when
/// metadata is absent (back-compat). Symlinks skipped on both sides.
/// Composes cleanly with the 5.36 fast-path — the journal records the
/// post-utimes mtime, so the next sync correctly skips re-hashing. Codex
/// P2 widened the accepted mtime domain to include `0` (Unix epoch,
/// reproducible-builds clamp value) and negative epochs (pre-1970). See
/// indigoai-us/hq-cloud#27. The `~5.31` -> `~5.37` bump is required to
/// pick the whole chain up.
///
/// **5.38.0 (bulk-asymmetry circuit-breaker)** — `computeDeletePlan` now
/// refuses to convert >=10% / >=10-abs of in-scope journal entries into
/// remote `DeleteObject` calls when their local files have gone missing
/// all at once (moved hqRoot, partial restore, fresh clone over inherited
/// `~/.hq/`, unmounted volume, accidental `rm -rf`). Closes the failure
/// mode behind the 2026-05-25 indigo vault mass-delete (269 signals/ +
/// 290 sources/ delete-markers in one afternoon). Bypass paths preserved:
/// `HQ_SYNC_DELETE_BULK_OVERRIDE=1` env or `propagateDeletePolicy: "all"`.
/// See indigoai-us/hq-cloud#28.
///
/// **6.4.0 (listJournals — `hq sync status` blindness fix)** — adds the
/// `listJournals` enumeration API so `hq sync status` reads every journal
/// shard the runner writes (personal-vault + per-company) instead of one
/// path. No runner-behavior change for hq-sync; the `~6.3.5` -> `~6.4.0`
/// bump keeps the menubar's npx pin on the same release train as hq-cli.
/// See indigoai-us/hq-cloud#66.
///
/// **6.5.0 (rescue classify-before-delete — no half-applied wipe)** — the
/// `hq rescue` wipe-set classifier now classifies the ENTIRE wipe set
/// read-only before any destructive apply, so a classifier error deletes
/// nothing instead of stranding a half-applied HQ (the menubar drives
/// `hq-rescue` via npx for the prod Update / Restore rescue flow, so it must
/// ride this fix). Dry-run and the live run share one classification path.
/// The `~6.4.0` -> `~6.5.0` bump keeps the menubar's npx pin on the same
/// release train as hq-cli. See indigoai-us/hq-cloud#67 (DEV-1767).
///
/// **6.6.0 (unwedge all→shared scope-shrink + non-destructive recovery)** — a
/// customer's menubar sync was permanently wedged (exit 2 every run): a buggy
/// hq-cli pull seeded an all-mode PullRecord, so the runner's real shared/custom
/// pull scope-shrank against `[""]` and threw `ScopeShrinkBlockedError(all→shared)`
/// forever, with un-followable "pass --force-scope-shrink" advice. 6.6.0 makes
/// the runner's pull self-heal: dirty out-of-scope files are KEPT on disk +
/// un-tracked, clean ones are QUARANTINED (recoverable, never silently deleted),
/// and the wedged journal clears itself on the next sync. The menubar MUST ride
/// this — it's the surface that was stuck. The `~6.5.0` -> `~6.6.0` bump keeps
/// the npx pin on the same release train as hq-cli. See
/// indigoai-us/hq-cloud#70 (DEV-1768).
///
/// **6.7.x (machine-identity auth for company agents)** — rides along on the
/// jump to the 6.8 line; additive, gated auth mode that does not change the
/// human-Cognito menubar flow. See indigoai-us/hq-cloud#71/#72.
///
/// **6.8.0 (op-lock waits for a live holder instead of refusing fast)** — the
/// per-HQ-root operation mutex (sync/rescue/reindex) now WAITS and acquires the
/// instant the holder releases, instead of exiting 17. This is the surface that
/// matters for DEV-1772 (feedback_28a1833f): the menubar instant-sync one-shot
/// (`hq-sync-runner --companies`, which DOES take the lock — the `--watch`
/// daemon is exempt) used to collide with the frequent ~1-min reindex hook,
/// exit 17, and silently die. With this pin it WAITS out the short reindex and
/// proceeds. The wait is bounded only by this command's existing 1-hour HARD
/// timeout (not idle-based, see `SYNC_TIMEOUT`), so a long wait is safely
/// capped and never killed by silence; the runner's stderr-only "Waiting for …"
/// line never pollutes the ndjson stdout stream. Scripts can bound the wait
/// with `HQ_OP_LOCK_TIMEOUT=<secs>` (0 = refuse immediately). The `~6.6.0` ->
/// `~6.8.0` bump keeps the npx pin on the same release train as hq-cli. See
/// indigoai-us/hq-cloud#73 (DEV-1772). Floored at `~6.11.14` so the spawned
/// runner always carries the cross-process `sync-progress.json` producer
/// (hq-cloud#107) that powers live menubar progress for ANY sync — auto-sync
/// and CLI, not just a menubar-spawned Sync Now.
///
/// `~6.11.x` -> `~6.12.0`: adopt hq-cloud#127 — local (non-cloud) companies now
/// sync to the personal vault by default (the `HQ_SYNC_LOCAL_COMPANIES_TO_PERSONAL`
/// gate and the `cloud: false` marker requirement are removed). Without this
/// bump the tilde pin stayed on the 6.11 line and the menubar runner never
/// pulled local companies down. Cloud-backed companies are still excluded and
/// their stale personal-vault copies decommissioned via the membership path.
///
/// `~6.12.0` -> `~6.12.1`: floor the tilde pin at the hq-cloud release carrying
/// the S3 presign fix (atop the cert-panic fix). Without this the pin could
/// resolve back to 6.12.0 and miss the presign correction.
///
/// `~6.12.1` -> `~6.13.5`: pull in the runner fixes for transient offline blips
/// and the exit-2 path, matching the legacy hq-sync pin.
///
/// `~6.13.5` -> `~6.14.3`: adopt the 6.14 line so the menubar runner ships the
/// session-log capture + `workspace/.session-logs` S3-sync carve-out
/// (hq-cloud#173) — without this the tilde pin stays on 6.13 and the runner
/// never uploads the reindex-captured Claude Code transcripts. Also inherits
/// the 6.14.0-6.14.2 changes (default local-company personal sync, the
/// `sessions/` push-only pull exclusion, and the doubled-path key-poisoning
/// hardening) the pin was behind.
///
/// `~6.14.3` -> `~6.14.4`: floor the pin at the hq-cloud release that extends
/// reindex's session-log capture to Codex + Grok (hq-cloud#175). That change is
/// reindex-only and does not affect the sync runner this pin selects — the bump
/// just keeps the floor current with the latest 6.14 line so the runner can't
/// resolve back to an earlier 6.14.x.
///
/// `~6.14.4` -> `~6.14.5`: floor the pin at hq-cloud 6.14.5, which ships two
/// sync-engine bug fixes (hq-cloud#177, #178): the fresh-push collision detector
/// no longer mistakes an SSE-KMS ETag for a plaintext MD5 (byte-identical files
/// were being flagged as conflicts), and `hq-rescue` now surfaces redacted git
/// clone/checkout stderr instead of discarding it. Both are in the runner /
/// rescue paths this pin selects. Raising the tilde floor also changes the npx
/// cache key so an existing `~6.14.4` resolution can't keep serving 6.14.4.
///
/// `~6.14.5` -> `~6.14.15`: ship the open Wave-1 delete/tombstone + Windows
/// rescue stack that landed across 6.14.6–6.14.15 but was still outside the
/// menubar pin floor. Notable pickups for auto-sync / rescue:
/// - intentional local-delete (no respawn) + FILE_TOMBSTONE consult on
///   push/pull (DEV-1952 resurrection class)
/// - personal-overlay marker vs core-dir collision (hq-cloud#147 / DEV-1833)
/// - Windows drive-letter rsync path + vault colon-key materialization
///   (hq-cloud#185 / DEV-1933–1934 class)
/// - version-bound tombstones + CAS before delete/overwrite (hq-cloud#182)
/// - machine-mint identity binding fix (hq-cloud#207, 6.14.15)
/// Runtime npx pin only; no menubar logic change. Tilde keeps later 6.14.x
/// patches auto-applied without jumping to an unreleased 6.15 line.
pub const HQ_CLOUD_VERSION: &str = "~6.14.15";

/// Package name for the runner. Used by both the spawn site below and the
/// startup prewarm. Paired with `HQ_CLOUD_VERSION` to form the full
/// `npx --package=<pkg>@<ver>` argument.
pub const HQ_CLOUD_PACKAGE: &str = "@indigoai-us/hq-cloud";

/// Bin name shipped by `HQ_CLOUD_PACKAGE` (per its package.json `bin` entry).
/// npx needs this separately from the package because the bin name does
/// not match the package name.
pub const RUNNER_BIN: &str = "hq-sync-runner";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_is_canonical() {
        assert_eq!(HQ_CLOUD_PACKAGE, "@indigoai-us/hq-cloud");
    }

    #[test]
    fn version_is_nonempty_tilde_pin() {
        assert!(!HQ_CLOUD_VERSION.is_empty());
        assert!(HQ_CLOUD_VERSION.starts_with('~'));
    }

    #[test]
    fn runner_bin_is_hq_sync_runner() {
        assert_eq!(RUNNER_BIN, "hq-sync-runner");
    }
}

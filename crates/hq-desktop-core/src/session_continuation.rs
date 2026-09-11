//! Browser session continuation — the decisions, not the plumbing.
//!
//! When someone signs up on the website and then opens the desktop app for the
//! first time, today they are shown a sign-in screen for an account they
//! created minutes ago. Continuation finishes that sign-in through the SAME
//! Cognito authorization-code + PKCE flow the app already uses, and only
//! activates the resulting session after the person confirms the account.
//!
//! ## Why this module exists separately from the Tauri commands
//!
//! Everything here is pure: no Tauri handle, no network, no clock of its own.
//! That is deliberate. The interesting failures in this feature are all
//! ordering and lifetime failures — a callback arriving after Cancel, a stale
//! attempt confirming over a newer sign-in, a config response that fails open —
//! and none of them can be tested through a GUI app crate that needs a
//! GTK/WebKit toolchain to compile. The state machine lives here so it can be
//! exercised directly, and `commands/desktop_auth.rs` is a thin binding over it.
//!
//! ## The one rule
//!
//! Tokens are held, never written, until [`ContinuationAttempt::confirm`]
//! returns [`ConfirmOutcome::Activate`]. Every other path — expiry, cancel,
//! sign-out, a newer attempt, a mismatched account generation — discards them.
//! A late exchange that comes back after any of those transitions is refused,
//! because at that point nobody is waiting for it and the person may well have
//! signed in as somebody else.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The protocol version this build implements. A config document announcing a
/// different one is not understood, and not understood means disabled.
pub const SUPPORTED_PROTOCOL_VERSION: u32 = 1;

/// How long a pending attempt may live. Matches the loopback listener's own
/// five-minute timeout, so neither side outlives the other.
pub const ATTEMPT_LIFETIME: Duration = Duration::from_secs(300);

/// How long the "Continue as …" confirmation stays answerable, bounded by the
/// attempt deadline — a confirmation window cannot extend an expired attempt.
pub const CONFIRMATION_WINDOW: Duration = Duration::from_secs(120);

/// Longest a config response is trusted before it is fetched again.
pub const CONFIG_CACHE_TTL: Duration = Duration::from_secs(120);

/// The rollout document, exactly as `GET /v1/desktop/onboarding/config` returns
/// it. Every field is optional on the wire so a response from an older or newer
/// backend deserializes instead of failing, and is then judged by
/// [`ContinuationConfig::decide`] rather than by serde.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationConfig {
    #[serde(default)]
    pub protocol_version: Option<u32>,
    #[serde(default)]
    pub minimum_desktop_version: Option<String>,
    #[serde(default)]
    pub variant: Option<String>,
    #[serde(default)]
    pub rollout_percent: Option<i64>,
}

/// Why continuation is not running. Every variant is a bounded label — these
/// reach telemetry, and a free-text reason there would be a leak waiting to
/// happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisabledReason {
    /// No config was obtained at all: offline, a 5xx, a timeout, a proxy.
    Unavailable,
    /// The document did not parse, or announced a protocol we do not implement.
    Unrecognised,
    /// The backend says control.
    Control,
    /// This installation fell outside the rollout percentage.
    NotInRollout,
    /// This build is older than the minimum the backend will accept.
    BuildTooOld,
}

/// What the app should do on this launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RolloutDecision {
    /// Run one browser-continuation attempt.
    Continue,
    /// Show the existing provider buttons and nothing else.
    Disabled(DisabledReason),
}

impl RolloutDecision {
    pub fn is_enabled(self) -> bool {
        matches!(self, RolloutDecision::Continue)
    }
}

/// The decision for an ABSENT config: disabled, because the app cannot tell the
/// difference between "the backend has not enabled this" and "the backend could
/// not be reached", and only one of those answers is safe.
pub fn decide_without_config() -> RolloutDecision {
    RolloutDecision::Disabled(DisabledReason::Unavailable)
}

impl ContinuationConfig {
    /// Judge a fetched config against this build and this installation.
    ///
    /// Fails closed on every axis. The backend applies the same rule on its own
    /// side; this is the second half of the same fail-closed pair, not a
    /// duplicate of it — a desktop that trusted whatever it was handed would
    /// turn a backend misconfiguration into a fleet-wide behaviour change.
    pub fn decide(&self, app_version: &str, install_attempt_id: &str) -> RolloutDecision {
        if self.protocol_version != Some(SUPPORTED_PROTOCOL_VERSION) {
            return RolloutDecision::Disabled(DisabledReason::Unrecognised);
        }
        if self.variant.as_deref() != Some("continuation") {
            return RolloutDecision::Disabled(DisabledReason::Control);
        }
        let Some(minimum) = self.minimum_desktop_version.as_deref() else {
            return RolloutDecision::Disabled(DisabledReason::Unrecognised);
        };
        match compare_versions(app_version, minimum) {
            Some(std::cmp::Ordering::Less) => {
                return RolloutDecision::Disabled(DisabledReason::BuildTooOld)
            }
            // An unparseable version on either side is not evidence that this
            // build is new enough.
            None => return RolloutDecision::Disabled(DisabledReason::Unrecognised),
            _ => {}
        }
        let percent = match self.rollout_percent {
            Some(percent) if (0..=100).contains(&percent) => percent as u64,
            _ => return RolloutDecision::Disabled(DisabledReason::Unrecognised),
        };
        if percent == 0 {
            return RolloutDecision::Disabled(DisabledReason::NotInRollout);
        }
        if rollout_bucket(install_attempt_id) < percent {
            RolloutDecision::Continue
        } else {
            RolloutDecision::Disabled(DisabledReason::NotInRollout)
        }
    }
}

/// A stable 0–99 bucket for one installation.
///
/// Derived from the installation attempt id so a given install stays on the
/// same side of the rollout across restarts — an installation that flipped
/// arms every launch would make the experiment unreadable and would show some
/// people two different sign-in screens on consecutive days.
pub fn rollout_bucket(install_attempt_id: &str) -> u64 {
    let digest = Sha256::digest(install_attempt_id.as_bytes());
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&digest[..8]);
    u64::from_be_bytes(bytes) % 100
}

/// Compare two `major.minor.patch` strings. `None` if either is not that shape.
fn compare_versions(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    let parse = |value: &str| -> Option<[u64; 3]> {
        let mut parts = value.trim().split('.');
        let mut out = [0u64; 3];
        for slot in out.iter_mut() {
            *slot = parts.next()?.parse().ok()?;
        }
        if parts.next().is_some() {
            return None;
        }
        Some(out)
    };
    Some(parse(left)?.cmp(&parse(right)?))
}

/// Reasons the app must not start a continuation attempt even when the rollout
/// says yes. These are about the state of THIS machine, not the experiment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartRefusal {
    /// A usable native session already exists. It wins over any incoming link.
    AlreadySignedIn,
    /// The person signed out on purpose. Signing them back in silently would be
    /// the single most hostile thing this feature could do.
    ExplicitlySignedOut,
    /// Another login is already in flight.
    AttemptInFlight,
    /// An update is being applied; the process is about to be replaced.
    UpdateInProgress,
    /// This installation is not a new one — an upgrade is not a first launch.
    NotAFirstLaunch,
}

/// What the app knows about itself when it is deciding whether to start.
#[derive(Debug, Clone, Copy, Default)]
pub struct LaunchContext {
    pub has_valid_session: bool,
    pub signed_out_explicitly: bool,
    pub attempt_in_flight: bool,
    pub update_in_progress: bool,
    pub is_first_launch: bool,
}

/// Decide whether to start one attempt. Ordered most-authoritative first so the
/// reported reason is the one a human would give.
pub fn may_start(context: LaunchContext, decision: RolloutDecision) -> Result<(), StartRefusal> {
    if context.has_valid_session {
        return Err(StartRefusal::AlreadySignedIn);
    }
    if context.signed_out_explicitly {
        return Err(StartRefusal::ExplicitlySignedOut);
    }
    if context.update_in_progress {
        return Err(StartRefusal::UpdateInProgress);
    }
    if context.attempt_in_flight {
        return Err(StartRefusal::AttemptInFlight);
    }
    if !context.is_first_launch {
        return Err(StartRefusal::NotAFirstLaunch);
    }
    if !decision.is_enabled() {
        return Err(StartRefusal::NotAFirstLaunch);
    }
    Ok(())
}

/// Milliseconds since the Unix epoch. Passed in rather than read, so tests can
/// drive expiry without sleeping and without a mockable clock trait.
pub type EpochMillis = i64;

/// Where a pending attempt is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttemptPhase {
    /// Browser opened; waiting for the loopback callback.
    AwaitingCallback,
    /// Tokens are held in memory, unwritten, waiting for the person to confirm.
    AwaitingConfirmation { confirm_deadline: EpochMillis },
    /// Over. Nothing further will be accepted.
    Finished(AttemptEnd),
}

/// How an attempt ended. All bounded labels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptEnd {
    Activated,
    Cancelled,
    Expired,
    Superseded,
    SignedOut,
    Failed,
}

/// What the caller should do with the tokens it is holding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmOutcome {
    /// Persist, publish, and emit `auth:session-ready` — the same completion
    /// the manual OAuth path performs.
    Activate,
    /// Discard the pending tokens without writing anything.
    Discard(AttemptEnd),
}

/// One browser-continuation attempt.
///
/// Holds no tokens itself — the caller does — precisely so a credential cannot
/// be reached through a value that gets cloned into a log line or an event
/// payload. This type owns only the identifiers and the deadlines that decide
/// whether the caller's tokens may be written.
#[derive(Debug, Clone)]
pub struct ContinuationAttempt {
    attempt_id: String,
    state: String,
    nonce: String,
    /// The account generation at the moment this attempt began. Sign-out and a
    /// completed sign-in both bump it, so a stale confirmation is detectable
    /// without any of the transitions having to find and cancel this attempt.
    auth_generation: u64,
    started_at: EpochMillis,
    deadline: EpochMillis,
    phase: AttemptPhase,
}

impl ContinuationAttempt {
    pub fn start(
        attempt_id: impl Into<String>,
        state: impl Into<String>,
        nonce: impl Into<String>,
        auth_generation: u64,
        now: EpochMillis,
    ) -> Self {
        Self {
            attempt_id: attempt_id.into(),
            state: state.into(),
            nonce: nonce.into(),
            auth_generation,
            started_at: now,
            deadline: now + ATTEMPT_LIFETIME.as_millis() as i64,
            phase: AttemptPhase::AwaitingCallback,
        }
    }

    pub fn attempt_id(&self) -> &str {
        &self.attempt_id
    }

    pub fn auth_generation(&self) -> u64 {
        self.auth_generation
    }

    pub fn phase(&self) -> &AttemptPhase {
        &self.phase
    }

    pub fn is_finished(&self) -> bool {
        matches!(self.phase, AttemptPhase::Finished(_))
    }

    /// Elapsed milliseconds, for the `durationMs` telemetry dimension.
    pub fn elapsed_ms(&self, now: EpochMillis) -> i64 {
        (now - self.started_at).max(0)
    }

    /// Constant-time-ish equality for the callback state. The values are random
    /// per attempt and neither is a long-lived secret, but a short-circuiting
    /// compare on an attacker-supplied value is a habit worth not forming.
    pub fn state_matches(&self, candidate: &str) -> bool {
        constant_time_eq(self.state.as_bytes(), candidate.as_bytes())
    }

    /// Compare the ID token's `nonce` claim against this attempt's nonce.
    pub fn nonce_matches(&self, candidate: &str) -> bool {
        constant_time_eq(self.nonce.as_bytes(), candidate.as_bytes())
    }

    pub fn nonce(&self) -> &str {
        &self.nonce
    }

    /// The `state` this attempt armed the authorize request with.
    ///
    /// Needed by exactly one caller: cancelling the attempt has to cancel the
    /// loopback listener too, and that listener is addressed by state. Without
    /// it, pressing **Use another account** would drop the custody entry while
    /// the native listener kept both sockets and the blur-suppression flag
    /// alive until a callback or the five-minute timeout — a Cancel that
    /// visibly cancels nothing.
    ///
    /// Not a secret in the sense a token is: it is a per-attempt random value
    /// whose whole job is to be echoed back by the browser. It still never
    /// crosses the Tauri bridge; only Rust reads this.
    pub fn state(&self) -> &str {
        &self.state
    }

    /// Fold in the passage of time. Call before every decision.
    pub fn tick(&mut self, now: EpochMillis) {
        if self.is_finished() {
            return;
        }
        let confirm_deadline = match &self.phase {
            AttemptPhase::AwaitingConfirmation { confirm_deadline } => Some(*confirm_deadline),
            _ => None,
        };
        let effective = confirm_deadline.map_or(self.deadline, |c| c.min(self.deadline));
        if now >= effective {
            self.phase = AttemptPhase::Finished(AttemptEnd::Expired);
        }
    }

    /// The exchange came back with tokens. They are held, not written.
    ///
    /// Refused once the attempt is over, which is the whole point: a token
    /// exchange that completes after Cancel, sign-out, or a newer login must
    /// not be able to resurrect the attempt that requested it.
    pub fn tokens_received(&mut self, now: EpochMillis) -> Result<(), AttemptEnd> {
        self.tick(now);
        match self.phase {
            AttemptPhase::AwaitingCallback => {
                let confirm_deadline =
                    (now + CONFIRMATION_WINDOW.as_millis() as i64).min(self.deadline);
                self.phase = AttemptPhase::AwaitingConfirmation { confirm_deadline };
                Ok(())
            }
            AttemptPhase::AwaitingConfirmation { .. } => Err(AttemptEnd::Failed),
            AttemptPhase::Finished(end) => Err(end),
        }
    }

    /// The person pressed **Continue as …**.
    ///
    /// `current_generation` is read at the moment of confirmation, under the
    /// caller's auth-transition lock. If it moved, something else — a sign-out,
    /// a manual sign-in that completed first — changed the account underneath
    /// this attempt, and the held tokens are discarded rather than written over
    /// whatever is there now.
    pub fn confirm(&mut self, now: EpochMillis, current_generation: u64) -> ConfirmOutcome {
        self.tick(now);
        match self.phase {
            AttemptPhase::AwaitingConfirmation { .. } => {
                if current_generation != self.auth_generation {
                    self.phase = AttemptPhase::Finished(AttemptEnd::Superseded);
                    return ConfirmOutcome::Discard(AttemptEnd::Superseded);
                }
                self.phase = AttemptPhase::Finished(AttemptEnd::Activated);
                ConfirmOutcome::Activate
            }
            AttemptPhase::AwaitingCallback => {
                // Nothing to confirm yet. Not an error state to end on, but not
                // an activation either.
                ConfirmOutcome::Discard(AttemptEnd::Failed)
            }
            AttemptPhase::Finished(end) => ConfirmOutcome::Discard(end),
        }
    }

    /// **Use another account**, Cancel, sign-out, or a newer attempt.
    pub fn end(&mut self, end: AttemptEnd) -> AttemptEnd {
        if let AttemptPhase::Finished(existing) = self.phase {
            return existing;
        }
        self.phase = AttemptPhase::Finished(end);
        end
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        difference |= a ^ b;
    }
    difference == 0
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: EpochMillis = 1_800_000_000_000;
    const INSTALL: &str = "11111111-1111-4111-8111-111111111111";

    fn enabled_config() -> ContinuationConfig {
        ContinuationConfig {
            protocol_version: Some(SUPPORTED_PROTOCOL_VERSION),
            minimum_desktop_version: Some("1.0.0".into()),
            variant: Some("continuation".into()),
            rollout_percent: Some(100),
        }
    }

    fn attempt() -> ContinuationAttempt {
        ContinuationAttempt::start("attempt-1", "state-1", "nonce-1", 7, NOW)
    }

    // ── Configuration fails closed ──────────────────────────────────────

    #[test]
    fn no_config_at_all_is_disabled() {
        assert_eq!(
            decide_without_config(),
            RolloutDecision::Disabled(DisabledReason::Unavailable)
        );
    }

    #[test]
    fn an_empty_document_is_disabled() {
        assert_eq!(
            ContinuationConfig::default().decide("9.9.9", INSTALL),
            RolloutDecision::Disabled(DisabledReason::Unrecognised)
        );
    }

    #[test]
    fn a_response_from_a_backend_that_predates_this_feature_is_disabled() {
        // A JSON body with none of our fields deserializes into all-None rather
        // than failing, so this is the shape an old backend actually produces.
        let config: ContinuationConfig =
            serde_json::from_str(r#"{"message":"Not Found"}"#).expect("tolerant parse");
        assert_eq!(
            config.decide("9.9.9", INSTALL),
            RolloutDecision::Disabled(DisabledReason::Unrecognised)
        );
    }

    #[test]
    fn an_unknown_protocol_version_is_disabled() {
        let mut config = enabled_config();
        config.protocol_version = Some(SUPPORTED_PROTOCOL_VERSION + 1);
        assert_eq!(
            config.decide("9.9.9", INSTALL),
            RolloutDecision::Disabled(DisabledReason::Unrecognised)
        );
    }

    #[test]
    fn the_control_arm_is_disabled() {
        let mut config = enabled_config();
        config.variant = Some("control".into());
        assert_eq!(
            config.decide("9.9.9", INSTALL),
            RolloutDecision::Disabled(DisabledReason::Control)
        );
    }

    #[test]
    fn an_unknown_variant_is_not_treated_as_continuation() {
        let mut config = enabled_config();
        config.variant = Some("continuation-v2".into());
        assert!(!config.decide("9.9.9", INSTALL).is_enabled());
    }

    #[test]
    fn the_backends_unreachable_minimum_version_disables_every_build() {
        // The backend answers 999.999.999 when its own minimum is unset or
        // malformed. No shipped build is newer than that, which is the point.
        let mut config = enabled_config();
        config.minimum_desktop_version = Some("999.999.999".into());
        assert_eq!(
            config.decide("1.4.2", INSTALL),
            RolloutDecision::Disabled(DisabledReason::BuildTooOld)
        );
    }

    #[test]
    fn a_build_at_the_minimum_is_allowed_and_one_below_is_not() {
        let mut config = enabled_config();
        config.minimum_desktop_version = Some("1.4.2".into());
        assert!(config.decide("1.4.2", INSTALL).is_enabled());
        assert_eq!(
            config.decide("1.4.1", INSTALL),
            RolloutDecision::Disabled(DisabledReason::BuildTooOld)
        );
        assert!(config.decide("1.10.0", INSTALL).is_enabled());
    }

    #[test]
    fn an_unparseable_version_on_either_side_is_disabled() {
        let mut config = enabled_config();
        assert!(!config.decide("1.4.2-beta.1", INSTALL).is_enabled());
        config.minimum_desktop_version = Some("latest".into());
        assert!(!config.decide("1.4.2", INSTALL).is_enabled());
    }

    #[test]
    fn a_percentage_outside_the_range_is_disabled_not_clamped() {
        for percent in [-1, 101, i64::MAX, i64::MIN] {
            let mut config = enabled_config();
            config.rollout_percent = Some(percent);
            assert_eq!(
                config.decide("9.9.9", INSTALL),
                RolloutDecision::Disabled(DisabledReason::Unrecognised),
                "percent {percent} should be refused, never clamped to 100"
            );
        }
    }

    #[test]
    fn zero_percent_enables_nobody() {
        let mut config = enabled_config();
        config.rollout_percent = Some(0);
        assert_eq!(
            config.decide("9.9.9", INSTALL),
            RolloutDecision::Disabled(DisabledReason::NotInRollout)
        );
    }

    #[test]
    fn one_hundred_percent_enables_every_installation() {
        let config = enabled_config();
        for n in 0..200 {
            let install = format!("install-{n}");
            assert!(config.decide("9.9.9", &install).is_enabled());
        }
    }

    #[test]
    fn an_installation_stays_on_the_same_side_of_the_rollout() {
        let mut config = enabled_config();
        config.rollout_percent = Some(50);
        let first = config.decide("9.9.9", INSTALL);
        for _ in 0..50 {
            assert_eq!(config.decide("9.9.9", INSTALL), first);
        }
    }

    #[test]
    fn the_rollout_bucket_spreads_across_the_range() {
        // Not a statistics test — just proof that the bucket is not constant,
        // which a broken hash would make it.
        let buckets: std::collections::HashSet<u64> =
            (0..200).map(|n| rollout_bucket(&format!("install-{n}"))).collect();
        assert!(buckets.len() > 50, "buckets collapsed to {}", buckets.len());
    }

    // ── Whether to start at all ─────────────────────────────────────────

    #[test]
    fn an_existing_session_wins_over_the_rollout() {
        let context = LaunchContext {
            has_valid_session: true,
            is_first_launch: true,
            ..Default::default()
        };
        assert_eq!(
            may_start(context, RolloutDecision::Continue),
            Err(StartRefusal::AlreadySignedIn)
        );
    }

    #[test]
    fn an_explicit_sign_out_is_never_undone_silently() {
        let context = LaunchContext {
            signed_out_explicitly: true,
            is_first_launch: true,
            ..Default::default()
        };
        assert_eq!(
            may_start(context, RolloutDecision::Continue),
            Err(StartRefusal::ExplicitlySignedOut)
        );
    }

    #[test]
    fn nothing_starts_during_an_update_or_beside_another_login() {
        let updating = LaunchContext {
            update_in_progress: true,
            is_first_launch: true,
            ..Default::default()
        };
        assert_eq!(
            may_start(updating, RolloutDecision::Continue),
            Err(StartRefusal::UpdateInProgress)
        );

        let busy = LaunchContext {
            attempt_in_flight: true,
            is_first_launch: true,
            ..Default::default()
        };
        assert_eq!(
            may_start(busy, RolloutDecision::Continue),
            Err(StartRefusal::AttemptInFlight)
        );
    }

    #[test]
    fn an_upgrade_is_not_a_first_launch() {
        let context = LaunchContext {
            is_first_launch: false,
            ..Default::default()
        };
        assert!(may_start(context, RolloutDecision::Continue).is_err());
    }

    #[test]
    fn a_clean_first_launch_in_the_rollout_starts() {
        let context = LaunchContext {
            is_first_launch: true,
            ..Default::default()
        };
        assert_eq!(may_start(context, RolloutDecision::Continue), Ok(()));
    }

    #[test]
    fn a_disabled_rollout_starts_nothing_even_on_a_clean_first_launch() {
        let context = LaunchContext {
            is_first_launch: true,
            ..Default::default()
        };
        assert!(may_start(
            context,
            RolloutDecision::Disabled(DisabledReason::Unavailable)
        )
        .is_err());
    }

    // ── The attempt lifecycle ───────────────────────────────────────────

    #[test]
    fn the_happy_path_holds_then_activates() {
        let mut attempt = attempt();
        assert_eq!(attempt.tokens_received(NOW + 4_000), Ok(()));
        assert!(matches!(
            attempt.phase(),
            AttemptPhase::AwaitingConfirmation { .. }
        ));
        assert_eq!(attempt.confirm(NOW + 6_000, 7), ConfirmOutcome::Activate);
        assert!(attempt.is_finished());
    }

    #[test]
    fn confirming_twice_activates_once() {
        let mut attempt = attempt();
        attempt.tokens_received(NOW).unwrap();
        assert_eq!(attempt.confirm(NOW, 7), ConfirmOutcome::Activate);
        assert_eq!(
            attempt.confirm(NOW, 7),
            ConfirmOutcome::Discard(AttemptEnd::Activated)
        );
    }

    #[test]
    fn cancel_during_the_exchange_refuses_the_tokens_that_arrive_after_it() {
        // The exchange is already in flight when Cancel is pressed. The tokens
        // still come back. Nothing may be written.
        let mut attempt = attempt();
        attempt.end(AttemptEnd::Cancelled);
        assert_eq!(
            attempt.tokens_received(NOW + 1_000),
            Err(AttemptEnd::Cancelled)
        );
        assert_eq!(
            attempt.confirm(NOW + 1_000, 7),
            ConfirmOutcome::Discard(AttemptEnd::Cancelled)
        );
    }

    #[test]
    fn sign_out_during_the_exchange_refuses_the_tokens_that_arrive_after_it() {
        let mut attempt = attempt();
        attempt.end(AttemptEnd::SignedOut);
        assert_eq!(
            attempt.tokens_received(NOW + 1_000),
            Err(AttemptEnd::SignedOut)
        );
    }

    #[test]
    fn a_newer_login_supersedes_a_pending_confirmation() {
        // Someone gets bored of the confirmation prompt and signs in manually
        // with the provider buttons. That completes, bumping the generation.
        // The old prompt is still on screen; pressing Continue must not
        // overwrite the session that just landed.
        let mut attempt = attempt();
        attempt.tokens_received(NOW).unwrap();
        assert_eq!(
            attempt.confirm(NOW + 1_000, 8),
            ConfirmOutcome::Discard(AttemptEnd::Superseded)
        );
    }

    #[test]
    fn an_attempt_expires_after_five_minutes() {
        let mut attempt = attempt();
        assert_eq!(
            attempt.tokens_received(NOW + ATTEMPT_LIFETIME.as_millis() as i64),
            Err(AttemptEnd::Expired)
        );
    }

    #[test]
    fn a_confirmation_window_cannot_outlive_the_attempt() {
        // Tokens arrive 30 seconds before the attempt deadline. The two-minute
        // confirmation window would run past it; the attempt deadline wins.
        let mut attempt = attempt();
        let late = NOW + ATTEMPT_LIFETIME.as_millis() as i64 - 30_000;
        attempt.tokens_received(late).unwrap();
        match attempt.phase() {
            AttemptPhase::AwaitingConfirmation { confirm_deadline } => {
                assert_eq!(*confirm_deadline, NOW + ATTEMPT_LIFETIME.as_millis() as i64);
            }
            other => panic!("expected a confirmation window, got {other:?}"),
        }
        assert_eq!(
            attempt.confirm(late + 60_000, 7),
            ConfirmOutcome::Discard(AttemptEnd::Expired)
        );
    }

    #[test]
    fn an_unanswered_confirmation_expires_after_two_minutes() {
        let mut attempt = attempt();
        attempt.tokens_received(NOW).unwrap();
        assert_eq!(
            attempt.confirm(NOW + CONFIRMATION_WINDOW.as_millis() as i64, 7),
            ConfirmOutcome::Discard(AttemptEnd::Expired)
        );
    }

    #[test]
    fn a_second_callback_for_the_same_attempt_is_refused() {
        let mut attempt = attempt();
        attempt.tokens_received(NOW).unwrap();
        assert_eq!(attempt.tokens_received(NOW), Err(AttemptEnd::Failed));
    }

    #[test]
    fn confirming_before_any_tokens_arrived_activates_nothing() {
        let mut attempt = attempt();
        assert_eq!(
            attempt.confirm(NOW, 7),
            ConfirmOutcome::Discard(AttemptEnd::Failed)
        );
    }

    #[test]
    fn the_first_ending_is_the_one_that_sticks() {
        let mut attempt = attempt();
        assert_eq!(attempt.end(AttemptEnd::Cancelled), AttemptEnd::Cancelled);
        assert_eq!(attempt.end(AttemptEnd::Expired), AttemptEnd::Cancelled);
    }

    // ── State and nonce ─────────────────────────────────────────────────

    #[test]
    fn state_and_nonce_must_match_exactly() {
        let attempt = attempt();
        assert!(attempt.state_matches("state-1"));
        assert!(!attempt.state_matches("state-2"));
        assert!(!attempt.state_matches("state-1 "));
        assert!(!attempt.state_matches("state-11"));
        assert!(!attempt.state_matches(""));
        assert!(attempt.nonce_matches("nonce-1"));
        assert!(!attempt.nonce_matches("nonce-2"));
        assert!(!attempt.nonce_matches(""));
    }

    #[test]
    fn two_attempts_do_not_share_a_state() {
        // Simultaneous callbacks: whichever arrives, only the attempt whose own
        // state it carries may accept it.
        let first = ContinuationAttempt::start("a", "state-a", "nonce-a", 0, NOW);
        let second = ContinuationAttempt::start("b", "state-b", "nonce-b", 0, NOW);
        assert!(first.state_matches("state-a"));
        assert!(!first.state_matches("state-b"));
        assert!(second.state_matches("state-b"));
        assert!(!second.state_matches("state-a"));
    }

    #[test]
    fn elapsed_never_goes_backwards() {
        let attempt = attempt();
        assert_eq!(attempt.elapsed_ms(NOW - 10_000), 0);
        assert_eq!(attempt.elapsed_ms(NOW + 2_500), 2_500);
    }

    #[test]
    fn constant_time_eq_agrees_with_equality() {
        assert!(constant_time_eq(b"", b""));
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}

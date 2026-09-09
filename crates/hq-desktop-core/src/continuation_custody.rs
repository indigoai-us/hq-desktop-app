//! Custody of the credentials a continuation attempt is holding but has not
//! written.
//!
//! Browser continuation exists so that someone who signed up on the website two
//! minutes ago does not get asked to sign in again. The awkward part is the
//! middle: the desktop has real, working tokens for an account, and it must not
//! write them anywhere until the person in front of the screen has said "yes,
//! that is me". A copied installer, a shared laptop, and a browser signed in as
//! somebody's colleague all land in exactly that middle.
//!
//! So this module is where the tokens sit, and everything about it is arranged
//! so that they cannot leak or be written by accident:
//!
//! * [`PendingCredentials`] has a hand-written `Debug` that prints a placeholder
//!   and no `Serialize` at all. `CognitoTokens` derives both, so a struct that
//!   merely contained one would happily print a refresh token into a log the
//!   day someone adds `{:?}` to a diagnostic line.
//! * Exactly one attempt is in custody at a time. A second sign-in supersedes
//!   the first rather than racing it, which is what makes two callbacks
//!   arriving together a resolved question instead of a coin flip.
//! * `confirm` is the only way to get the credentials out, it consumes them,
//!   and it refuses if the attempt expired, was cancelled, or if the account
//!   generation moved underneath it.
//!
//! There is no clock and no I/O here. The caller passes `now` and does the
//! writing, which is what lets every rule above be tested directly.

use crate::cognito::CognitoTokens;
use crate::session_continuation::{
    AttemptEnd, AttemptPhase, ConfirmOutcome, ContinuationAttempt, EpochMillis,
};

/// The non-secret identity a confirmation prompt is allowed to show.
///
/// This is the *only* thing that crosses out of custody before confirmation,
/// and it is deliberately the smallest set that lets a person recognise their
/// own account. It carries nothing replayable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedIdentity {
    pub email: String,
    pub display_name: Option<String>,
}

/// Tokens held in memory, unwritten, for one attempt.
///
/// Deliberately not `Clone`: a second copy is a second thing to remember to
/// discard. Deliberately not `Serialize`: there is no correct reason to put
/// this in an event payload, a command result, or a file.
pub struct PendingCredentials {
    /// `Option` only so `into_tokens` can move the value out past the `Drop`
    /// impl below. It is `Some` for the whole useful life of the value.
    tokens: Option<CognitoTokens>,
    identity: VerifiedIdentity,
}

impl PendingCredentials {
    pub fn new(tokens: CognitoTokens, identity: VerifiedIdentity) -> Self {
        Self {
            tokens: Some(tokens),
            identity,
        }
    }

    pub fn identity(&self) -> &VerifiedIdentity {
        &self.identity
    }

    /// Consume custody and hand the tokens to the writer. The only way out.
    pub fn into_tokens(mut self) -> CognitoTokens {
        self.tokens
            .take()
            .expect("credentials are taken exactly once")
    }
}

impl std::fmt::Debug for PendingCredentials {
    /// Prints no credential material. `CognitoTokens` derives `Debug`, so the
    /// derived impl on this struct would print an access token and a refresh
    /// token in full; a diagnostic line added in a hurry three months from now
    /// would then put both in the log file, and Sentry would carry them off the
    /// machine. The email is the account being confirmed and is already on
    /// screen, so it stays — it makes the log readable without making it
    /// dangerous.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PendingCredentials")
            .field("email", &self.identity.email)
            .field("tokens", &"<redacted>")
            .finish()
    }
}

impl Drop for PendingCredentials {
    /// Best-effort overwrite when custody is dropped without being confirmed.
    ///
    /// This is not a hard guarantee — `String` may have reallocated, and the
    /// allocator owes us nothing — so it is a reduction in exposure window, not
    /// a security control. The controls are the ones above: no clone, no
    /// serialize, no debug. This just means the common case does not leave a
    /// readable refresh token sitting in a freed heap page.
    fn drop(&mut self) {
        let Some(tokens) = self.tokens.as_mut() else {
            return; // handed to the writer; not ours to scrub.
        };
        let mut scrub = |field: &mut String| {
            let len = field.len();
            field.clear();
            field.push_str(&"\0".repeat(len));
            field.clear();
        };
        scrub(&mut tokens.access_token);
        scrub(&mut tokens.refresh_token);
        if let Some(id_token) = tokens.id_token.as_mut() {
            scrub(id_token);
        }
    }
}

/// Why custody refused.
///
/// A closed set, and every variant is safe to send to the renderer: none of
/// them distinguishes "wrong value" from "no such attempt" in a way that would
/// help someone guessing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CustodyError {
    /// No attempt with that id is in custody. Covers "never existed", "already
    /// finished and cleared", and "superseded by a newer one".
    NoSuchAttempt,
    /// The attempt exists but is over.
    Finished(AttemptEnd),
    /// The callback did not match the attempt that requested it.
    StateMismatch,
    /// The ID token's `nonce` claim did not match the attempt's nonce.
    NonceMismatch,
    /// Confirmation arrived with nothing held — no exchange has completed.
    NothingHeld,
}

struct CustodyEntry {
    attempt: ContinuationAttempt,
    credentials: Option<PendingCredentials>,
}

/// The single in-flight continuation attempt and whatever it is holding.
///
/// One at a time is a design decision, not a simplification. Two concurrent
/// attempts would mean two sets of unwritten tokens and an ordering question at
/// confirmation time; superseding turns that into an answered one.
pub struct ContinuationCustody {
    /// Bumped by anything that changes which account this machine is signed in
    /// as. An attempt records the generation it started under and refuses to
    /// activate if it moved — so a sign-out or a manual sign-in that lands
    /// mid-flight invalidates the pending one without having to find it.
    generation: u64,
    entry: Option<CustodyEntry>,
}

impl Default for ContinuationCustody {
    fn default() -> Self {
        Self::new()
    }
}

impl ContinuationCustody {
    pub fn new() -> Self {
        Self {
            generation: 0,
            entry: None,
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Something changed the signed-in account. Any pending attempt is now
    /// stale, and its credentials go without being written.
    pub fn bump_generation(&mut self, end: AttemptEnd) -> u64 {
        self.generation += 1;
        if let Some(entry) = self.entry.as_mut() {
            entry.attempt.end(end);
            entry.credentials = None;
        }
        self.entry = None;
        self.generation
    }

    pub fn active_attempt_id(&self) -> Option<&str> {
        self.entry
            .as_ref()
            .filter(|entry| !entry.attempt.is_finished())
            .map(|entry| entry.attempt.attempt_id())
    }

    /// The OAuth `state` of the live attempt with this id, if it is still live.
    ///
    /// Read before cancelling, never after: cancelling finishes the attempt and
    /// this then answers `None`. The id is required rather than optional so a
    /// stale Cancel for a superseded attempt cannot tear down the listener the
    /// *current* attempt is waiting on.
    pub fn active_state_for(&self, attempt_id: &str) -> Option<&str> {
        self.entry
            .as_ref()
            .filter(|entry| !entry.attempt.is_finished())
            .filter(|entry| entry.attempt.attempt_id() == attempt_id)
            .map(|entry| entry.attempt.state())
    }

    pub fn holds_credentials(&self) -> bool {
        self.entry
            .as_ref()
            .is_some_and(|entry| entry.credentials.is_some())
    }

    /// Begin an attempt, superseding any attempt already in custody.
    ///
    /// Returns how the previous attempt ended, if there was one.
    pub fn begin(&mut self, attempt: ContinuationAttempt) -> Option<AttemptEnd> {
        let previous = self.entry.take().map(|mut entry| {
            // Dropping `entry` drops its credentials, which is the discard.
            let end = entry.attempt.end(AttemptEnd::Superseded);
            entry.credentials = None;
            end
        });
        self.entry = Some(CustodyEntry {
            attempt,
            credentials: None,
        });
        previous
    }

    /// Fold in the passage of time and clear anything that expired.
    pub fn tick(&mut self, now: EpochMillis) {
        let Some(entry) = self.entry.as_mut() else {
            return;
        };
        entry.attempt.tick(now);
        if entry.attempt.is_finished() {
            entry.credentials = None;
        }
    }

    /// The loopback callback arrived. Checked before any token exchange runs,
    /// so a callback for the wrong attempt never costs a network round trip.
    pub fn accept_callback(
        &mut self,
        attempt_id: &str,
        state: &str,
        now: EpochMillis,
    ) -> Result<(), CustodyError> {
        self.tick(now);
        let entry = self.entry_for(attempt_id)?;
        if let AttemptPhase::Finished(end) = entry.attempt.phase() {
            return Err(CustodyError::Finished(*end));
        }
        if !entry.attempt.state_matches(state) {
            return Err(CustodyError::StateMismatch);
        }
        Ok(())
    }

    /// The exchange returned tokens. They go into custody unwritten, and the
    /// attempt moves to awaiting confirmation.
    ///
    /// `id_token_nonce` is the `nonce` claim read off the ID token. An absent
    /// claim is a mismatch: the authorize request always sends a nonce, so a
    /// token that comes back without one did not come from this attempt.
    pub fn hold(
        &mut self,
        attempt_id: &str,
        id_token_nonce: Option<&str>,
        credentials: PendingCredentials,
        now: EpochMillis,
    ) -> Result<VerifiedIdentity, CustodyError> {
        self.tick(now);
        let entry = self.entry_for(attempt_id)?;
        let nonce_ok = id_token_nonce.is_some_and(|value| entry.attempt.nonce_matches(value));
        if !nonce_ok {
            // Drop before ending the attempt so the credentials are gone even
            // if a later edit adds an early return between the two.
            drop(credentials);
            entry.attempt.end(AttemptEnd::Failed);
            entry.credentials = None;
            return Err(CustodyError::NonceMismatch);
        }
        if let Err(end) = entry.attempt.tokens_received(now) {
            drop(credentials);
            entry.credentials = None;
            return Err(CustodyError::Finished(end));
        }
        let identity = credentials.identity().clone();
        entry.credentials = Some(credentials);
        Ok(identity)
    }

    /// The person pressed **Continue as …**.
    ///
    /// This is the only way credentials leave custody, and it consumes them.
    pub fn confirm(
        &mut self,
        attempt_id: &str,
        now: EpochMillis,
    ) -> Result<PendingCredentials, CustodyError> {
        self.tick(now);
        let generation = self.generation;
        let entry = self.entry_for(attempt_id)?;
        match entry.attempt.confirm(now, generation) {
            ConfirmOutcome::Activate => {
                let credentials = entry.credentials.take().ok_or(CustodyError::NothingHeld)?;
                self.entry = None;
                Ok(credentials)
            }
            ConfirmOutcome::Discard(end) => {
                entry.credentials = None;
                self.entry = None;
                Err(CustodyError::Finished(end))
            }
        }
    }

    /// **Use another account**, Cancel, or a window closing.
    ///
    /// Idempotent, because the renderer may well send it twice — a Cancel click
    /// and a component teardown are two different code paths to the same wish.
    pub fn cancel(&mut self, attempt_id: &str, end: AttemptEnd) -> Option<AttemptEnd> {
        let matches = self
            .entry
            .as_ref()
            .is_some_and(|entry| entry.attempt.attempt_id() == attempt_id);
        if !matches {
            return None;
        }
        let mut entry = self.entry.take()?;
        entry.credentials = None;
        Some(entry.attempt.end(end))
    }

    fn entry_for(&mut self, attempt_id: &str) -> Result<&mut CustodyEntry, CustodyError> {
        match self.entry.as_mut() {
            Some(entry) if entry.attempt.attempt_id() == attempt_id => Ok(entry),
            _ => Err(CustodyError::NoSuchAttempt),
        }
    }
}

// ── Tests ──────────────────────────────────────────────────────────────
//
// Placeholder credential values below are obviously fake on sight. None of
// them is a real token, and none of them needs to be: nothing here parses or
// validates a JWT, it only decides who is allowed to hand one over.

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: EpochMillis = 1_800_000_000_000;

    fn credentials(email: &str) -> PendingCredentials {
        PendingCredentials::new(
            CognitoTokens {
                access_token: "placeholder-access-value".to_string(),
                id_token: Some("placeholder-id-value".to_string()),
                refresh_token: "placeholder-refresh-value".to_string(),
                expires_at: NOW + 3_600_000,
            },
            VerifiedIdentity {
                email: email.to_string(),
                display_name: Some("Placeholder Person".to_string()),
            },
        )
    }

    fn attempt(custody: &ContinuationCustody, id: &str) -> ContinuationAttempt {
        ContinuationAttempt::start(id, "state-value", "nonce-value", custody.generation(), NOW)
    }

    #[test]
    fn the_live_attempts_state_is_readable_so_cancel_can_tear_down_the_listener() {
        let mut custody = ContinuationCustody::new();
        custody.begin(attempt(&custody, "attempt-1"));
        assert_eq!(custody.active_state_for("attempt-1"), Some("state-value"));
    }

    #[test]
    fn a_stale_cancel_cannot_read_the_current_attempts_state() {
        // The listener is addressed by state. If a Cancel for a superseded
        // attempt could read the live one's state, pressing Cancel on a stale
        // card would tear down the listener the current attempt is waiting on.
        let mut custody = ContinuationCustody::new();
        custody.begin(attempt(&custody, "attempt-1"));
        custody.begin(attempt(&custody, "attempt-2"));
        assert_eq!(custody.active_state_for("attempt-1"), None);
        assert_eq!(custody.active_state_for("attempt-2"), Some("state-value"));
    }

    #[test]
    fn a_finished_attempt_has_no_state_to_cancel() {
        let mut custody = ContinuationCustody::new();
        custody.begin(attempt(&custody, "attempt-1"));
        custody.cancel("attempt-1", AttemptEnd::Cancelled);
        assert_eq!(custody.active_state_for("attempt-1"), None);
    }

    fn holding(id: &str) -> ContinuationCustody {
        let mut custody = ContinuationCustody::new();
        let started = attempt(&custody, id);
        custody.begin(started);
        custody
            .hold(id, Some("nonce-value"), credentials("a@example.test"), NOW)
            .expect("hold");
        custody
    }

    #[test]
    fn the_happy_path_hands_the_tokens_over_exactly_once() {
        let mut custody = holding("attempt-1");
        assert!(custody.holds_credentials());

        let confirmed = custody.confirm("attempt-1", NOW + 1_000).expect("confirm");
        assert_eq!(confirmed.identity().email, "a@example.test");

        // Custody is empty afterwards, so a replayed confirm gets nothing.
        assert!(!custody.holds_credentials());
        assert_eq!(
            custody.confirm("attempt-1", NOW + 2_000).unwrap_err(),
            CustodyError::NoSuchAttempt
        );
    }

    #[test]
    fn the_confirmation_prompt_only_ever_sees_an_email_and_a_name() {
        let mut custody = ContinuationCustody::new();
        let started = attempt(&custody, "attempt-1");
        custody.begin(started);
        let identity = custody
            .hold(
                "attempt-1",
                Some("nonce-value"),
                credentials("a@example.test"),
                NOW,
            )
            .expect("hold");
        // The returned type has exactly two fields and neither is a credential.
        assert_eq!(identity.email, "a@example.test");
        assert_eq!(identity.display_name.as_deref(), Some("Placeholder Person"));
    }

    #[test]
    fn debug_output_carries_no_token_material() {
        let rendered = format!("{:?}", credentials("a@example.test"));
        assert!(rendered.contains("a@example.test"), "{rendered}");
        for secret in [
            "placeholder-access-value",
            "placeholder-id-value",
            "placeholder-refresh-value",
        ] {
            assert!(!rendered.contains(secret), "leaked {secret} in {rendered}");
        }
    }

    #[test]
    fn a_callback_whose_state_does_not_match_is_refused() {
        let mut custody = ContinuationCustody::new();
        let started = attempt(&custody, "attempt-1");
        custody.begin(started);
        assert_eq!(
            custody
                .accept_callback("attempt-1", "not-the-state", NOW)
                .unwrap_err(),
            CustodyError::StateMismatch
        );
        // The matching value still works — the refusal was about the value, not
        // about the attempt being unusable.
        assert!(custody
            .accept_callback("attempt-1", "state-value", NOW)
            .is_ok());
    }

    #[test]
    fn a_callback_for_an_unknown_attempt_is_refused() {
        let mut custody = ContinuationCustody::new();
        let started = attempt(&custody, "attempt-1");
        custody.begin(started);
        assert_eq!(
            custody
                .accept_callback("attempt-2", "state-value", NOW)
                .unwrap_err(),
            CustodyError::NoSuchAttempt
        );
    }

    #[test]
    fn a_token_whose_nonce_does_not_match_is_discarded_not_held() {
        let mut custody = ContinuationCustody::new();
        let started = attempt(&custody, "attempt-1");
        custody.begin(started);
        assert_eq!(
            custody
                .hold(
                    "attempt-1",
                    Some("someone-elses-nonce"),
                    credentials("a@example.test"),
                    NOW
                )
                .unwrap_err(),
            CustodyError::NonceMismatch
        );
        assert!(!custody.holds_credentials());
    }

    #[test]
    fn a_token_with_no_nonce_claim_is_refused() {
        // Every authorize request this app builds sends a nonce, so a token
        // that comes back without one did not come from this attempt.
        let mut custody = ContinuationCustody::new();
        let started = attempt(&custody, "attempt-1");
        custody.begin(started);
        assert_eq!(
            custody
                .hold("attempt-1", None, credentials("a@example.test"), NOW)
                .unwrap_err(),
            CustodyError::NonceMismatch
        );
        assert!(!custody.holds_credentials());
    }

    #[test]
    fn signing_out_mid_flight_discards_the_pending_credentials() {
        let mut custody = holding("attempt-1");
        custody.bump_generation(AttemptEnd::SignedOut);
        assert!(!custody.holds_credentials());
        assert_eq!(
            custody.confirm("attempt-1", NOW + 1_000).unwrap_err(),
            CustodyError::NoSuchAttempt
        );
    }

    #[test]
    fn a_confirmation_under_a_moved_generation_is_superseded() {
        // The generation moves without going through custody — a manual sign-in
        // completing on the other path is exactly this shape.
        let mut custody = ContinuationCustody::new();
        let started = attempt(&custody, "attempt-1");
        custody.begin(started);
        custody
            .hold(
                "attempt-1",
                Some("nonce-value"),
                credentials("a@example.test"),
                NOW,
            )
            .expect("hold");
        custody.generation += 1;

        assert_eq!(
            custody.confirm("attempt-1", NOW + 1_000).unwrap_err(),
            CustodyError::Finished(AttemptEnd::Superseded)
        );
        assert!(!custody.holds_credentials());
    }

    #[test]
    fn a_second_attempt_supersedes_the_first_rather_than_racing_it() {
        let mut custody = holding("attempt-1");
        let second = ContinuationAttempt::start(
            "attempt-2",
            "state-two",
            "nonce-two",
            custody.generation(),
            NOW,
        );
        assert_eq!(custody.begin(second), Some(AttemptEnd::Superseded));

        // The first attempt's held credentials are gone, not merely shadowed.
        assert!(!custody.holds_credentials());
        assert_eq!(
            custody.confirm("attempt-1", NOW + 1_000).unwrap_err(),
            CustodyError::NoSuchAttempt
        );
        assert_eq!(custody.active_attempt_id(), Some("attempt-2"));
    }

    #[test]
    fn cancelling_discards_and_is_safe_to_repeat() {
        let mut custody = holding("attempt-1");
        assert_eq!(
            custody.cancel("attempt-1", AttemptEnd::Cancelled),
            Some(AttemptEnd::Cancelled)
        );
        assert!(!custody.holds_credentials());
        // The renderer sends Cancel from a click and again from teardown.
        assert_eq!(custody.cancel("attempt-1", AttemptEnd::Cancelled), None);
    }

    #[test]
    fn cancelling_someone_elses_attempt_does_nothing() {
        let mut custody = holding("attempt-1");
        assert_eq!(custody.cancel("attempt-2", AttemptEnd::Cancelled), None);
        assert!(custody.holds_credentials());
    }

    #[test]
    fn an_expired_attempt_drops_its_credentials_without_being_asked() {
        let mut custody = holding("attempt-1");
        // Past the confirmation window with nobody at the keyboard.
        custody.tick(NOW + 10 * 60 * 1_000);
        assert!(!custody.holds_credentials());
        assert_eq!(
            custody.confirm("attempt-1", NOW + 10 * 60 * 1_000).unwrap_err(),
            CustodyError::Finished(AttemptEnd::Expired)
        );
    }

    #[test]
    fn confirming_before_any_exchange_completes_activates_nothing() {
        let mut custody = ContinuationCustody::new();
        let started = attempt(&custody, "attempt-1");
        custody.begin(started);
        assert_eq!(
            custody.confirm("attempt-1", NOW + 1_000).unwrap_err(),
            CustodyError::Finished(AttemptEnd::Failed)
        );
    }

    #[test]
    fn a_second_exchange_for_the_same_attempt_is_refused() {
        // Two callbacks arriving together must not both get to hand tokens in.
        let mut custody = holding("attempt-1");
        assert_eq!(
            custody
                .hold(
                    "attempt-1",
                    Some("nonce-value"),
                    credentials("b@example.test"),
                    NOW
                )
                .unwrap_err(),
            CustodyError::Finished(AttemptEnd::Failed)
        );
    }

    #[test]
    fn a_callback_after_cancel_cannot_resurrect_the_attempt() {
        let mut custody = ContinuationCustody::new();
        let started = attempt(&custody, "attempt-1");
        custody.begin(started);
        custody.cancel("attempt-1", AttemptEnd::Cancelled);
        assert_eq!(
            custody
                .accept_callback("attempt-1", "state-value", NOW)
                .unwrap_err(),
            CustodyError::NoSuchAttempt
        );
    }

    /// Build a JWT-shaped string whose payload is real, decodable JSON.
    ///
    /// The signature segment is a placeholder: nothing on this path verifies a
    /// signature — the backend's `/v1/desktop/session/verify` route does that —
    /// so a fabricated one here would be pretending to test something this code
    /// does not do. What IS under test is that the nonce actually reaches
    /// custody through the real decoder.
    fn id_token_with_nonce(nonce: Option<&str>) -> String {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        let payload = match nonce {
            Some(value) => format!(r#"{{"sub":"placeholder-sub","email":"a@example.test","nonce":"{value}"}}"#),
            None => r#"{"sub":"placeholder-sub","email":"a@example.test"}"#.to_string(),
        };
        format!(
            "placeholder-header.{}.placeholder-signature",
            URL_SAFE_NO_PAD.encode(payload)
        )
    }

    #[test]
    fn the_real_decoder_carries_the_nonce_through_to_custody() {
        let token = id_token_with_nonce(Some("nonce-value"));
        let claims = crate::cognito::decode_id_token_claims(&token).expect("decode");
        assert_eq!(claims.nonce.as_deref(), Some("nonce-value"));

        let mut custody = ContinuationCustody::new();
        let started = attempt(&custody, "attempt-1");
        custody.begin(started);
        assert!(custody
            .hold(
                "attempt-1",
                claims.nonce.as_deref(),
                credentials("a@example.test"),
                NOW
            )
            .is_ok());
    }

    #[test]
    fn a_token_from_the_old_provider_button_flow_has_no_nonce_and_is_refused() {
        // Tokens minted by the existing provider-button path carry no nonce.
        // Continuation must not accept one: it would mean any token this app
        // happens to obtain could satisfy a pending confirmation.
        let token = id_token_with_nonce(None);
        let claims = crate::cognito::decode_id_token_claims(&token).expect("decode");
        assert_eq!(claims.nonce, None);

        let mut custody = ContinuationCustody::new();
        let started = attempt(&custody, "attempt-1");
        custody.begin(started);
        assert_eq!(
            custody
                .hold(
                    "attempt-1",
                    claims.nonce.as_deref(),
                    credentials("a@example.test"),
                    NOW
                )
                .unwrap_err(),
            CustodyError::NonceMismatch
        );
    }

    #[test]
    fn a_fresh_custody_holds_nothing_and_names_no_attempt() {
        let custody = ContinuationCustody::new();
        assert!(!custody.holds_credentials());
        assert_eq!(custody.active_attempt_id(), None);
        assert_eq!(custody.generation(), 0);
    }
}

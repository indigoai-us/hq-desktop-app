//! Idea Board settings panel (US-012) — the host side of the Ideas section.
//!
//! Two commands back the panel: [`ideas_get_settings`] reads the resolved
//! state (extraction mode, sync, default company, retention, chord), and
//! [`ideas_set_capture_chord`] rebinds the global capture chord *immediately*,
//! reporting inline when the new chord is unavailable.
//!
//! Every preference here is a USER PREFERENCE, not a feature flag — the pure
//! resolution rules and that reasoning live in
//! [`hq_desktop_core::ideas::settings`]. The one genuinely opt-in choice,
//! model extraction, is never flipped by this module.
//!
//! Nothing in this file logs or returns a credential or model configuration
//! value; the only Ideas value that reaches a log line is a chord label.

use std::path::Path;
use std::str::FromStr;
use std::sync::Mutex;

use hq_desktop_core::ideas::settings::{
    chord_display, format_chord, parse_chord, resolve_capture_chord, resolve_company,
    resolve_image_max_edge, sync_enabled, ChordSpec, IMAGE_MAX_EDGE_CHOICES,
};
use hq_desktop_core::ideas::{ideas_root, parse_mode, MODEL_DISCLOSURE};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

use crate::util::logfile::log;

const LOG_TAG: &str = "ideas";

/// Plain-language refusal when the OS will not hand us the chord. The most
/// common cause by far is another app already holding it.
const CHORD_TAKEN: &str =
    "That chord is already in use by another app. The previous chord is still active — try a different combination.";

/// Plain-language refusal when the new chord registered but we could not write
/// it down. We undo the registration rather than leave the OS and the stored
/// preference disagreeing.
const CHORD_NOT_SAVED: &str =
    "HQ couldn't save that chord, so it kept the one you had. Check that your HQ settings file is writable, then try again.";

/// Non-fatal warning when the OS would not give the old chord back. Nothing is
/// broken — the new chord works — but the old combination may stay reserved.
const STALE_CHORD_WARNING: &str =
    "Your previous chord may stay reserved until HQ restarts, so other apps might not see it yet.";

/// Non-fatal warning for the OTHER direction of the same problem: a persist
/// failure whose rollback `unregister(next)` ALSO failed, so the chord the user
/// just tried is grabbed system-wide while HQ is still listening on the old
/// one. Same shape as [`STALE_CHORD_WARNING`] — the user is told, not the log.
const STALE_NEW_CHORD_WARNING: &str =
    "The chord you tried may also stay reserved until HQ restarts, so other apps might not see it yet.";

/// What the user is told after a failed persist.
///
/// `rollback_failed` is true when we could not hand the NEW chord back to the
/// OS either. Pure so the double-fault wording is reachable from a test without
/// a global-shortcut plugin.
pub fn persist_failure_message(rollback_failed: bool) -> String {
    if rollback_failed {
        format!("{CHORD_NOT_SAVED} {STALE_NEW_CHORD_WARNING}")
    } else {
        CHORD_NOT_SAVED.to_string()
    }
}

/// HQ's own global chords, in canonical [`format_chord`] spelling.
///
/// These are the SINGLE source for both ends: `main.rs` registers exactly
/// these two (via [`popover_shortcut`] / [`desktop_window_shortcut`]), and the
/// rebind guard below refuses them. The capture branch runs FIRST in the
/// shortcut handler, so letting a user bind ⌥⇧H here would permanently shadow
/// the popover with no way back in-app.
pub const RESERVED_CHORDS: &[(&str, &str)] = &[
    ("Alt+Shift+KeyH", "show the popover"),
    ("Alt+Shift+KeyO", "open the HQ window"),
];

/// Parse-and-map one of our own constants. Infallible by construction; the
/// unit test below proves every [`RESERVED_CHORDS`] entry maps.
fn reserved_shortcut(chord: &str) -> Shortcut {
    let spec = parse_chord(chord).expect("reserved chord parses");
    shortcut_for(&spec).expect("reserved chord maps to a Shortcut")
}

/// ⌥⇧H — toggles the popover.
pub fn popover_shortcut() -> Shortcut {
    reserved_shortcut(RESERVED_CHORDS[0].0)
}

/// ⌥⇧O — opens the expanded desktop window.
pub fn desktop_window_shortcut() -> Shortcut {
    reserved_shortcut(RESERVED_CHORDS[1].0)
}

/// `Some(message)` when `spec` is one of HQ's own chords.
///
/// The message names OUR shortcut rather than blaming "another app" — the code
/// knows perfectly well who holds it, and saying otherwise sends the user
/// hunting through their other applications.
pub fn reserved_chord_message(spec: &ChordSpec) -> Option<String> {
    let canonical = format_chord(spec);
    RESERVED_CHORDS
        .iter()
        .find(|(chord, _)| *chord == canonical)
        .map(|(_, purpose)| {
            format!(
                "{} is already used by HQ to {purpose}. Pick a different combination.",
                chord_display(spec)
            )
        })
}

/// A chord we are willing to both STORE and REGISTER, or the default ⌥⇧C.
///
/// Two rejections, and they must be the same two everywhere:
/// - one of HQ's own chords (menubar.json can be hand-edited or arrive over
///   sync, so the reserved guard has to hold on the read path too), and
/// - a spec this system cannot map onto a `Shortcut`.
///
/// The second one exists so [`stored_chord_spec`] and [`ACTIVE_CHORD`] can
/// never disagree. They used to: `init_active_chord_from_prefs` left
/// `ACTIVE_CHORD` as `None` (i.e. ⌥⇧C) when `shortcut_for` failed, while
/// `stored_chord_spec` kept handing back the unusable spec — so the next
/// rebind unregistered a chord that had never been registered and left ⌥⇧C
/// grabbed, silently.
pub fn usable_or_default(spec: ChordSpec) -> ChordSpec {
    if reserved_chord_message(&spec).is_some() || shortcut_for(&spec).is_err() {
        return resolve_capture_chord(None);
    }
    spec
}

/// [`usable_or_default`] over a raw stored string.
pub fn resolve_usable_chord(raw: Option<&str>) -> ChordSpec {
    usable_or_default(resolve_capture_chord(raw))
}

/// The chord currently registered with the OS. `None` until
/// [`init_active_chord_from_prefs`] runs, which means "the built-in default".
static ACTIVE_CHORD: Mutex<Option<Shortcut>> = Mutex::new(None);

/// Map a parsed [`ChordSpec`] onto a plugin `Shortcut`.
pub fn shortcut_for(spec: &ChordSpec) -> Result<Shortcut, String> {
    let mut modifiers = Modifiers::empty();
    if spec.ctrl {
        modifiers |= Modifiers::CONTROL;
    }
    if spec.alt {
        modifiers |= Modifiers::ALT;
    }
    if spec.shift {
        modifiers |= Modifiers::SHIFT;
    }
    if spec.meta {
        modifiers |= Modifiers::META;
    }
    let code = Code::from_str(&spec.code)
        .map_err(|_| format!("{:?} isn't a key this system can bind.", spec.code))?;
    let mods = if modifiers.is_empty() {
        None
    } else {
        Some(modifiers)
    };
    Ok(Shortcut::new(mods, code))
}

/// Lenient menubar.json read — `None` for every soft failure (no file,
/// unreadable, malformed JSON), which the resolvers treat as "no preference".
fn read_prefs() -> Option<hq_desktop_core::config::MenubarPrefs> {
    crate::util::paths::menubar_json_path()
        .ok()
        .filter(|p| p.exists())
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|c| serde_json::from_str::<hq_desktop_core::config::MenubarPrefs>(&c).ok())
}

/// Read the stored chord preference leniently. Any soft failure (no file,
/// malformed JSON, unparseable chord) resolves to the default ⌥⇧C.
fn stored_chord_spec() -> ChordSpec {
    let raw = read_prefs().and_then(|p| p.ideas_capture_chord);
    resolve_usable_chord(raw.as_deref())
}

/// Seed [`ACTIVE_CHORD`] from disk. MUST run before the launch-time shortcut
/// registration so the user's rebound chord is what gets registered.
///
/// [`stored_chord_spec`] applies the same reserved-chord AND bindability
/// guards the rebind command applies, so a menubar.json carrying ⌥⇧H —
/// hand-edited, or synced from a machine running an older build — falls back to
/// the default instead of shadowing the popover on the next launch, and an
/// unmappable spec falls back too rather than leaving `ACTIVE_CHORD` and
/// `stored_chord_spec` disagreeing about what is registered.
pub fn init_active_chord_from_prefs() {
    let spec = stored_chord_spec();
    match shortcut_for(&spec) {
        Ok(shortcut) => {
            if let Ok(mut guard) = ACTIVE_CHORD.lock() {
                *guard = Some(shortcut);
            }
        }
        Err(error) => log(
            LOG_TAG,
            &format!(
                "capture chord {} unusable on this system ({error}); using the default",
                format_chord(&spec)
            ),
        ),
    }
}

/// The chord the capture overlay is bound to right now.
pub fn active_capture_shortcut() -> Shortcut {
    ACTIVE_CHORD
        .lock()
        .ok()
        .and_then(|g| *g)
        .unwrap_or_else(crate::commands::capture::capture_shortcut)
}

/// Does this shortcut press mean "capture"?
pub fn is_capture_chord(shortcut: &Shortcut) -> bool {
    shortcut == &active_capture_shortcut()
}

/// What a rebind request resolves to, decided without touching the OS so the
/// decision is testable (mirrors `capture::escape_binding_op`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RebindOutcome {
    /// The requested chord is already active — persist nothing, change nothing.
    Noop,
    /// Registration succeeded; unregister the previous chord and persist.
    Applied,
    /// Registration failed. The previous chord stays registered and stored.
    Rejected(String),
}

/// Is the "nothing changed" branch actually a no-op?
///
/// Only when the OS is genuinely holding `next`. `current` comes from DISK, so
/// re-entering the chord you already have would otherwise return `Noop` even
/// when launch-time registration failed and nothing is registered at all —
/// leaving no in-app recovery short of a restart.
pub fn noop_needs_reregister(active: Option<Shortcut>, next: &Shortcut) -> bool {
    active != Some(*next)
}

/// `register_error` is `Some(err)` when `global_shortcut().register(next)`
/// failed, and is only consulted when the chord actually changed.
pub fn rebind_outcome(
    current: &ChordSpec,
    next: &ChordSpec,
    register_error: Option<&str>,
) -> RebindOutcome {
    if current == next {
        return RebindOutcome::Noop;
    }
    match register_error {
        None => RebindOutcome::Applied,
        Some(_) => RebindOutcome::Rejected(CHORD_TAKEN.to_string()),
    }
}

/// The resolved Ideas settings the panel renders. camelCase over the wire.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IdeasSettingsState {
    /// `"local"` or `"model"`. Local unless the user explicitly opted in.
    pub extraction_mode: String,
    pub sync_enabled: bool,
    /// `None` = follow the active company.
    pub default_company: Option<String>,
    pub active_company: String,
    pub image_max_edge: u32,
    pub image_max_edge_choices: Vec<u32>,
    /// Canonical storage form, e.g. `Alt+Shift+KeyC`.
    pub capture_chord: String,
    /// Mac-style display form, e.g. `⌥⇧C`.
    pub capture_chord_display: String,
    /// The data-leaves-device + cost copy, from one canonical constant.
    pub model_disclosure: String,
    pub local_only: bool,
    /// Where captures would be written under the current sync preference.
    ///
    /// NOT always the local-only root — with sync ON this is the SYNCED vault
    /// path `companies/{slug}/ideas`, which is why it is no longer called
    /// `local_only_root`. The panel renders it as "where your captures go".
    pub captures_root: String,
}

/// Compose the panel state from already-resolved inputs.
///
/// Split out of [`ideas_get_settings`] so the composition — not just the
/// individual resolvers — is reachable from a test: the captures-root
/// derivation and the trim-to-`None` of a blank stored company are both
/// decisions made here, and neither was covered while this lived inside a
/// `#[tauri::command]` that needs an `AppHandle`.
pub(crate) fn build_settings_state(
    prefs: Option<&hq_desktop_core::config::MenubarPrefs>,
    hq_root: &Path,
    active_slug: &str,
) -> Result<IdeasSettingsState, String> {
    let synced = sync_enabled(prefs.and_then(|p| p.ideas_sync_enabled));
    let stored_default = prefs.and_then(|p| p.ideas_default_company.as_deref());
    let company = resolve_company(stored_default, active_slug);
    let spec = resolve_usable_chord(prefs.and_then(|p| p.ideas_capture_chord.as_deref()));
    let stored_company = stored_default
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let active_slug = active_slug.to_string();

    Ok(IdeasSettingsState {
        extraction_mode: parse_mode(
            prefs
                .and_then(|p| p.ideas_extraction_mode.as_deref())
                .unwrap_or("local"),
        )
        .as_str()
        .to_string(),
        sync_enabled: synced,
        default_company: stored_company,
        active_company: active_slug,
        image_max_edge: resolve_image_max_edge(prefs.and_then(|p| p.ideas_image_max_edge)),
        image_max_edge_choices: IMAGE_MAX_EDGE_CHOICES.to_vec(),
        capture_chord: format_chord(&spec),
        capture_chord_display: chord_display(&spec),
        model_disclosure: MODEL_DISCLOSURE.to_string(),
        local_only: !synced,
        // `resolve_company` already screened the slug, so this cannot fail in
        // practice — but it is a Result precisely so no caller assumes that.
        captures_root: ideas_root(hq_root, &company, synced)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string(),
    })
}

/// Resolved Ideas settings for this install.
#[tauri::command]
pub async fn ideas_get_settings(app: AppHandle) -> Result<IdeasSettingsState, String> {
    let active = app
        .try_state::<crate::commands::desktop_alt::DesktopSessionScope>()
        .and_then(|s| s.active_company_slug());
    let (hq_root, active_slug) =
        crate::commands::capture::resolve_vault_target_with_active(active)?;

    // Read leniently: a missing or malformed menubar.json means "no stored
    // preference", which resolves to the documented defaults, not an error.
    build_settings_state(read_prefs().as_ref(), &hq_root, &active_slug)
}

/// The chord that was applied, for the panel to display.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChordApplied {
    pub chord: String,
    pub display: String,
    /// Set when the OS refused to release the PREVIOUS chord. The rebind
    /// succeeded; this is a non-fatal note the panel renders inline so a
    /// system-wide grab we could not undo is at least visible to the user
    /// instead of living only in a log file.
    pub stale_chord_warning: Option<String>,
}

impl ChordApplied {
    fn ok(spec: &ChordSpec) -> Self {
        Self {
            chord: format_chord(spec),
            display: chord_display(spec),
            stale_chord_warning: None,
        }
    }
}

/// Decide what to tell the user after trying (and retrying) to hand the
/// previous chord back to the OS. Pure so the decision is testable without a
/// global-shortcut plugin.
///
/// `first` / `retry` are `Some(err)` for a failed attempt. A stale grab is
/// only reported when BOTH attempts failed — a transient failure that clears
/// on retry is not worth a warning.
pub fn stale_chord_warning(first: Option<&str>, retry: Option<&str>) -> Option<String> {
    match (first, retry) {
        (None, _) => None,
        (Some(_), None) => None,
        (Some(_), Some(_)) => Some(STALE_CHORD_WARNING.to_string()),
    }
}

/// The persist step of a rebind, as its own seam.
///
/// Path-injected for the same reason `save_settings_at` is: the failure branch
/// (read-only disk, bad permissions, unwritable config dir) is the one that
/// used to leave the user with NO working chord, so it has to be reachable
/// from a test.
pub(crate) fn persist_capture_chord(path: &Path, chord: &str) -> Result<(), String> {
    let mut prefs = crate::commands::settings::get_settings_at(path)?;
    prefs.ideas_capture_chord = Some(chord.to_string());
    crate::commands::settings::save_settings_at(path, &prefs)
}

/// Rebind the global capture chord, taking effect immediately.
///
/// Ordering is the whole safety story, and it is: reject a reserved chord →
/// register the NEW chord → PERSIST → unregister the old one → swap
/// `ACTIVE_CHORD`.
///
/// - If registration fails, nothing has changed: the previous chord is still
///   registered, still stored, still active.
/// - If the PERSIST fails, we unregister the new chord and return without
///   touching the previous one or `ACTIVE_CHORD` — so a read-only disk costs
///   the user a rebind, never their capture chord. (Persisting after the
///   unregister, as an earlier revision did, left BOTH chords dead until
///   restart: the OS held `next` while `is_capture_chord` still compared
///   against `previous`.)
/// - If handing the OLD chord back fails even on a retry, the rebind still
///   succeeded; the user gets a non-fatal warning instead of a silent
///   system-wide grab that only a log file knows about.
#[tauri::command]
pub async fn ideas_set_capture_chord(
    app: AppHandle,
    chord: String,
) -> Result<ChordApplied, String> {
    let next = parse_chord(&chord)?;
    // Before the OS is touched: HQ's own chords are not available. Doing this
    // after `register` would report "another app" for a collision the code
    // knows is ours.
    if let Some(message) = reserved_chord_message(&next) {
        return Err(message);
    }
    let next_shortcut = shortcut_for(&next)?;
    let current = stored_chord_spec();

    if current == next {
        // Same chord as stored — but "stored" is not "registered". If
        // launch-time registration failed, retry it here so the user has a way
        // back without restarting HQ.
        let active = ACTIVE_CHORD.lock().ok().and_then(|g| *g);
        if noop_needs_reregister(active, &next_shortcut) {
            if let Err(error) = app.global_shortcut().register(next_shortcut) {
                log(
                    LOG_TAG,
                    &format!(
                        "capture chord {} re-register FAILED: {error}",
                        format_chord(&next)
                    ),
                );
                return Err(CHORD_TAKEN.to_string());
            }
            if let Ok(mut guard) = ACTIVE_CHORD.lock() {
                *guard = Some(next_shortcut);
            }
            log(
                LOG_TAG,
                &format!("capture chord {} re-registered", format_chord(&next)),
            );
        }
        return Ok(ChordApplied::ok(&next));
    }

    let register_error = app
        .global_shortcut()
        .register(next_shortcut)
        .err()
        .map(|e| e.to_string());

    match rebind_outcome(&current, &next, register_error.as_deref()) {
        RebindOutcome::Noop => Ok(ChordApplied::ok(&next)),
        RebindOutcome::Rejected(message) => {
            // Same log-and-continue shape as register_global_shortcuts.
            log(
                LOG_TAG,
                &format!(
                    "capture chord {} register FAILED: {}",
                    format_chord(&next),
                    register_error.as_deref().unwrap_or("unknown error")
                ),
            );
            Err(message)
        }
        RebindOutcome::Applied => {
            // 1. PERSIST FIRST. Until the new chord is written down, the old
            //    one must stay registered and active.
            let persisted = crate::util::paths::menubar_json_path()
                .and_then(|path| persist_capture_chord(&path, &format_chord(&next)));
            if let Err(error) = persisted {
                let rollback_failed = match app.global_shortcut().unregister(next_shortcut) {
                    Ok(()) => false,
                    Err(undo) => {
                        log(
                            LOG_TAG,
                            &format!("capture chord rollback unregister FAILED: {undo}"),
                        );
                        true
                    }
                };
                log(
                    LOG_TAG,
                    &format!(
                        "capture chord {} persist FAILED: {error}; keeping {}",
                        format_chord(&next),
                        format_chord(&current)
                    ),
                );
                // Plain language, and never the raw filesystem error. A failed
                // rollback is a double fault — `next` is grabbed system-wide
                // while HQ still listens on `current` — so the user gets the
                // same stale-chord note we already surface in the other
                // direction rather than silence.
                return Err(persist_failure_message(rollback_failed));
            }

            // 2. Hand the previous chord back, with one retry. A leftover grab
            //    swallows that combination for every other app on the machine.
            let mut warning = None;
            if let Ok(previous) = shortcut_for(&current) {
                let first = app
                    .global_shortcut()
                    .unregister(previous)
                    .err()
                    .map(|e| e.to_string());
                let retry = match first {
                    None => None,
                    Some(_) => app
                        .global_shortcut()
                        .unregister(previous)
                        .err()
                        .map(|e| e.to_string()),
                };
                if let Some(error) = first.as_deref() {
                    log(
                        LOG_TAG,
                        &format!(
                            "capture chord {} unregister FAILED: {error}{}",
                            format_chord(&current),
                            retry
                                .as_deref()
                                .map(|r| format!(" (retry FAILED: {r})"))
                                .unwrap_or_else(|| " (retry succeeded)".to_string())
                        ),
                    );
                }
                warning = stale_chord_warning(first.as_deref(), retry.as_deref());
            }

            // 3. Only now does `is_capture_chord` start matching the new chord.
            if let Ok(mut guard) = ACTIVE_CHORD.lock() {
                *guard = Some(next_shortcut);
            }
            log(
                LOG_TAG,
                &format!("capture chord rebound to {}", format_chord(&next)),
            );
            Ok(ChordApplied {
                stale_chord_warning: warning,
                ..ChordApplied::ok(&next)
            })
        }
    }
}

#[cfg(test)]
mod hq_idea_board_us_012_tests {
    use super::*;

    fn spec(raw: &str) -> ChordSpec {
        parse_chord(raw).expect("test chord parses")
    }

    #[test]
    fn maps_every_modifier_and_key_family_onto_a_shortcut() {
        assert_eq!(
            shortcut_for(&spec("Alt+Shift+KeyC")).unwrap(),
            Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyC)
        );
        // Identical to the hardcoded pre-US-012 chord, so an install that has
        // never rebound keeps exactly the shortcut it had.
        assert_eq!(
            shortcut_for(&spec("Alt+Shift+KeyC")).unwrap(),
            crate::commands::capture::capture_shortcut()
        );
        assert_eq!(
            shortcut_for(&spec("Ctrl+Cmd+Digit4")).unwrap(),
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::META), Code::Digit4)
        );
        assert_eq!(
            shortcut_for(&spec("Ctrl+F9")).unwrap(),
            Shortcut::new(Some(Modifiers::CONTROL), Code::F9)
        );
    }

    #[test]
    fn an_unbindable_key_name_is_an_error_not_a_panic() {
        let bogus = ChordSpec {
            alt: true,
            shift: false,
            ctrl: false,
            meta: false,
            code: "NotAKey".to_string(),
        };
        assert!(shortcut_for(&bogus).is_err());
    }

    #[test]
    fn an_identical_chord_is_a_noop_even_when_registration_would_fail() {
        let current = spec("Alt+Shift+KeyC");
        let next = spec("opt+shift+c");
        assert_eq!(
            rebind_outcome(&current, &next, Some("HotKey already registered")),
            RebindOutcome::Noop
        );
        assert_eq!(rebind_outcome(&current, &next, None), RebindOutcome::Noop);
    }

    #[test]
    fn a_failed_registration_keeps_the_previous_chord_and_explains_why() {
        let current = spec("Alt+Shift+KeyC");
        let next = spec("Ctrl+Alt+KeyS");
        let outcome = rebind_outcome(&current, &next, Some("HotKey already registered"));
        match outcome {
            RebindOutcome::Rejected(message) => {
                assert!(message.contains("already in use"), "{message}");
                assert!(message.contains("previous chord is still active"), "{message}");
                // Never leak the raw OS error or any config value to the user.
                assert!(!message.contains("HotKey already registered"), "{message}");
            }
            other => panic!("expected Rejected, got {other:?}"),
        }
    }

    #[test]
    fn a_successful_registration_applies() {
        assert_eq!(
            rebind_outcome(&spec("Alt+Shift+KeyC"), &spec("Ctrl+Alt+KeyS"), None),
            RebindOutcome::Applied
        );
    }

    // ---- CRITICAL-6: HQ's own chords are not bindable -------------------

    #[test]
    fn hq_idea_board_us_012_reserved_chords_are_refused_and_name_hq_not_another_app() {
        for (chord, purpose) in RESERVED_CHORDS {
            let parsed = spec(chord);
            let message = reserved_chord_message(&parsed)
                .unwrap_or_else(|| panic!("{chord} must be reserved"));
            assert!(message.contains(purpose), "{message}");
            assert!(message.contains(&chord_display(&parsed)), "{message}");
            // The code knows who holds it — it must not blame another app.
            assert!(!message.contains("another app"), "{message}");
        }
        // Alternate spellings normalize to the same canonical chord, so the
        // guard cannot be walked around by typing it differently.
        assert!(reserved_chord_message(&spec("opt+shift+h")).is_some());
        assert!(reserved_chord_message(&spec("⌥+⇧+O")).is_some());
        // Everything else is still bindable.
        assert!(reserved_chord_message(&spec("Ctrl+Alt+KeyS")).is_none());
        assert!(reserved_chord_message(&spec("Alt+Shift+KeyC")).is_none());
    }

    #[test]
    fn hq_idea_board_us_012_reserved_chords_are_exactly_what_main_registers() {
        // The guard is only honest if it lists the chords `main.rs` actually
        // registers. Both come from RESERVED_CHORDS, and these two accessors
        // are what main.rs calls.
        assert_eq!(
            popover_shortcut(),
            Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyH)
        );
        assert_eq!(
            desktop_window_shortcut(),
            Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyO)
        );
        // Every entry parses and maps — `reserved_shortcut` expects as much.
        for (chord, _) in RESERVED_CHORDS {
            let parsed = parse_chord(chord).expect("reserved chord parses");
            assert!(shortcut_for(&parsed).is_ok(), "{chord}");
            assert_eq!(&format_chord(&parsed), chord, "must be canonical spelling");
        }
    }

    #[test]
    fn hq_idea_board_us_012_a_stored_reserved_chord_falls_back_to_the_default() {
        // REGRESSION for the launch path: menubar.json can be hand-edited or
        // synced from another machine. Seeding ACTIVE_CHORD with ⌥⇧H would let
        // the capture branch (which runs first in the handler) permanently
        // shadow the popover, with no in-app way to recover.
        let default = resolve_capture_chord(None);
        assert_eq!(resolve_usable_chord(Some("Alt+Shift+KeyH")), default);
        assert_eq!(resolve_usable_chord(Some("opt+shift+o")), default);
        assert_eq!(resolve_usable_chord(Some("garbage")), default);
        assert_eq!(resolve_usable_chord(None), default);
        // A legitimate stored chord is still honored.
        assert_eq!(
            resolve_usable_chord(Some("ctrl+alt+k")),
            spec("Ctrl+Alt+KeyK")
        );
    }

    // ---- CRITICAL-4: a stale system-wide grab must reach the user -------

    #[test]
    fn hq_idea_board_us_012_a_stale_previous_chord_is_surfaced_not_just_logged() {
        // Clean release, or a release that only needed the retry: nothing to say.
        assert_eq!(stale_chord_warning(None, None), None);
        assert_eq!(stale_chord_warning(None, Some("ignored")), None);
        assert_eq!(stale_chord_warning(Some("HotKey busy"), None), None);
        // Both attempts failed — the old combination is still grabbed
        // system-wide, doing nothing, and the user has to be told.
        let warning = stale_chord_warning(Some("HotKey busy"), Some("HotKey busy"))
            .expect("a twice-failed unregister must warn");
        assert!(warning.contains("previous chord"), "{warning}");
        assert!(warning.contains("restart"), "{warning}");
        // Never leak the raw OS error.
        assert!(!warning.contains("HotKey busy"), "{warning}");
    }

    #[test]
    fn hq_idea_board_us_012_a_clean_rebind_carries_no_warning() {
        let applied = ChordApplied::ok(&spec("Ctrl+Alt+KeyS"));
        assert_eq!(applied.chord, "Ctrl+Alt+KeyS");
        assert_eq!(applied.display, "⌃⌥S");
        assert_eq!(applied.stale_chord_warning, None);
    }

    // ---- CRITICAL-3: a persist failure must not cost the capture chord --

    #[test]
    fn hq_idea_board_us_012_persist_failure_is_an_error_the_caller_can_roll_back_from() {
        // A writable path round-trips…
        let tmp = std::env::temp_dir().join(format!(
            "hq-idea-board-us-012-chord-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).expect("scratch dir");
        let good = tmp.join("menubar.json");
        persist_capture_chord(&good, "Ctrl+Alt+KeyS").expect("writable path persists");
        let reread = crate::commands::settings::get_settings_at(&good).expect("reread");
        assert_eq!(reread.ideas_capture_chord.as_deref(), Some("Ctrl+Alt+KeyS"));

        // …and an unwritable one fails instead of silently succeeding. The
        // parent here is a FILE, so creating the config directory cannot work.
        let blocker = tmp.join("not-a-dir");
        std::fs::write(&blocker, b"x").expect("blocker file");
        let bad = blocker.join("menubar.json");
        let error = persist_capture_chord(&bad, "Alt+Shift+KeyJ")
            .expect_err("an unwritable config path must fail");
        // The raw error is a filesystem error about THAT path — not the
        // user-facing constant. (Asserting only `!error.is_empty()` passed for
        // any string at all, including an accidental success message.)
        // It is a raw filesystem error, NOT the user-facing constant — the
        // command's translation is deliberate, not incidental. (Asserting only
        // `!error.is_empty()` passed for any string at all, an accidental
        // success message included.)
        assert!(error.contains("os error"), "{error}");
        assert_ne!(error, CHORD_NOT_SAVED);

        // A failed persist leaves what is already on disk untouched: the chord
        // written above is still the chord stored.
        let after = crate::commands::settings::get_settings_at(&good).expect("reread after failure");
        assert_eq!(after.ideas_capture_chord.as_deref(), Some("Ctrl+Alt+KeyS"));

        // What the command turns that raw error into, via the same function
        // the command calls: plain language, the old chord kept, and no
        // filesystem detail.
        let shown = persist_failure_message(false);
        assert_eq!(shown, CHORD_NOT_SAVED);
        assert!(shown.contains("kept the one you had"), "{shown}");
        assert!(!shown.contains("os error"), "{shown}");
        assert!(!shown.contains("directory"), "{shown}");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ---- review follow-up: the double fault on the rollback path ---------

    #[test]
    fn hq_idea_board_us_012_a_failed_rollback_warns_instead_of_going_quiet() {
        // Persist failed AND `unregister(next)` failed: `next` is grabbed
        // system-wide while HQ still listens on the previous chord. Staying
        // silent here is the same defect CRITICAL-4 fixed in the other
        // direction, so it gets the same shape of warning.
        let quiet = persist_failure_message(false);
        let loud = persist_failure_message(true);
        assert_ne!(quiet, loud);
        assert!(loud.starts_with(CHORD_NOT_SAVED), "{loud}");
        assert!(loud.contains("reserved until HQ restarts"), "{loud}");
        // Same promise-shape as the previous-chord warning.
        assert!(STALE_CHORD_WARNING.contains("reserved until HQ restarts"));
    }

    // ---- review follow-up: stored and active must never disagree ---------

    #[test]
    fn hq_idea_board_us_012_an_unbindable_stored_chord_falls_back_like_a_reserved_one() {
        // REGRESSION: `init_active_chord_from_prefs` used to leave ACTIVE_CHORD
        // as None (⌥⇧C) when `shortcut_for` failed while `stored_chord_spec`
        // kept returning the unusable spec — so a later rebind unregistered a
        // chord that was never registered and left ⌥⇧C grabbed, with no stale
        // warning. Both now run through `usable_or_default`.
        let default = resolve_capture_chord(None);
        let unbindable = ChordSpec {
            alt: true,
            shift: true,
            ctrl: false,
            meta: false,
            code: "NotAKey".to_string(),
        };
        assert!(shortcut_for(&unbindable).is_err());
        assert_eq!(usable_or_default(unbindable), default);
        // The reserved rejection still holds, and a good chord is untouched.
        assert_eq!(usable_or_default(spec("Alt+Shift+KeyH")), default);
        assert_eq!(
            usable_or_default(spec("Ctrl+Alt+KeyS")),
            spec("Ctrl+Alt+KeyS")
        );
        // Whatever `usable_or_default` returns is bindable, so
        // `init_active_chord_from_prefs` always has a Shortcut to seed with.
        assert!(shortcut_for(&resolve_usable_chord(Some("Alt+Shift+KeyH"))).is_ok());
    }

    // ---- review follow-up: re-entering the same chord can recover ---------

    #[test]
    fn hq_idea_board_us_012_re_entering_the_stored_chord_retries_a_failed_registration() {
        let next = shortcut_for(&spec("Ctrl+Alt+KeyS")).unwrap();
        // Launch-time registration failed, so nothing is registered: re-entering
        // the chord must retry rather than report a no-op and strand the user.
        assert!(noop_needs_reregister(None, &next));
        // A different chord is registered — also a disagreement worth fixing.
        assert!(noop_needs_reregister(
            Some(shortcut_for(&spec("Alt+Shift+KeyC")).unwrap()),
            &next
        ));
        // Already holding it: genuinely nothing to do.
        assert!(!noop_needs_reregister(Some(next), &next));
    }

    // ---- review follow-up: the composition, not just the resolvers -------

    #[test]
    fn hq_idea_board_us_012_settings_state_composes_root_and_trims_stored_company() {
        let root = Path::new("/tmp/HQ");
        // A fresh-install prefs value, the same way `get_settings` produces one
        // when no menubar.json exists — MenubarPrefs has no `Default`.
        let fresh = || {
            crate::commands::settings::get_settings_at(Path::new(
                "/hq-idea-board-us-012/does-not-exist/menubar.json",
            ))
            .expect("a missing menubar.json yields fresh prefs")
        };

        // No prefs at all → documented defaults, and the captures root is the
        // SYNCED vault path (which is exactly why the field is not called
        // `local_only_root`).
        let bare = build_settings_state(None, root, "indigo").expect("defaults compose");
        assert_eq!(bare.extraction_mode, "local");
        assert!(bare.sync_enabled);
        assert!(!bare.local_only);
        assert_eq!(bare.default_company, None);
        assert_eq!(bare.active_company, "indigo");
        assert_eq!(bare.image_max_edge, 2000);
        assert_eq!(bare.capture_chord, "Alt+Shift+KeyC");
        assert_eq!(bare.capture_chord_display, "⌥⇧C");
        assert_eq!(
            bare.captures_root,
            ideas_root(root, "indigo", true).unwrap().to_string_lossy()
        );

        // Sync off → the local-only root, for the resolved company.
        let mut prefs = fresh();
        prefs.ideas_sync_enabled = Some(false);
        prefs.ideas_default_company = Some("liverecover".to_string());
        let off = build_settings_state(Some(&prefs), root, "indigo").expect("local-only composes");
        assert!(!off.sync_enabled);
        assert!(off.local_only);
        assert_eq!(off.default_company.as_deref(), Some("liverecover"));
        assert_eq!(
            off.captures_root,
            ideas_root(root, "liverecover", false)
                .unwrap()
                .to_string_lossy()
        );

        // A blank or whitespace-only stored company is "follow the active
        // company", not a company named "   ".
        for blank in ["", "   "] {
            let mut prefs = fresh();
            prefs.ideas_default_company = Some(blank.to_string());
            let state =
                build_settings_state(Some(&prefs), root, "indigo").expect("blank slug composes");
            assert_eq!(state.default_company, None, "{blank:?} must trim to None");
            assert_eq!(
                state.captures_root,
                ideas_root(root, "indigo", true).unwrap().to_string_lossy(),
                "{blank:?} must fall back to the active company"
            );
        }
    }
}

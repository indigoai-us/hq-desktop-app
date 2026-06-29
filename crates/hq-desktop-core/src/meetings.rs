use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// Google calendar event as returned by hq-pro `GET /v1/calendar/events`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingEvent {
    pub id: String,
    #[serde(default)]
    pub summary: Option<String>,
    pub start: EventTime,
    pub end: EventTime,
    /// "confirmed" | "tentative" | "cancelled"
    pub status: String,
    #[serde(default, rename = "hangoutLink")]
    pub hangout_link: Option<String>,
    #[serde(default, rename = "sourceCalendarId")]
    pub source_calendar_id: Option<String>,
    #[serde(default, rename = "sourceCompanyUid")]
    pub source_company_uid: Option<String>,
    #[serde(default, rename = "sourceAccountId")]
    pub source_account_id: Option<String>,
    #[serde(default, rename = "meetingUrl")]
    pub meeting_url: Option<String>,
    #[serde(default)]
    pub signals: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventTime {
    #[serde(default, rename = "dateTime")]
    pub date_time: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default, rename = "timeZone")]
    pub time_zone: Option<String>,
}

/// Subset of hq-pro `BotRecord` that the modal renders.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledBot {
    #[serde(alias = "recallBotId")]
    pub bot_id: String,
    pub meeting_url: String,
    pub platform: String,
    pub status: String,
    pub calendar_event_id: Option<String>,
    #[serde(alias = "title")]
    pub meeting_title: Option<String>,
    pub scheduled_start_time: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default, alias = "company")]
    pub company_id: Option<String>,
    #[serde(default)]
    pub auto_scheduled: bool,
    pub error_message: Option<String>,
    #[serde(default)]
    pub source_landed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCompanyBody {
    pub company_id: String,
    pub apply_to_series: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCompanyResult {
    pub ok: bool,
    pub meeting_id: String,
    pub company_id: String,
    #[serde(default)]
    pub series_key: Option<String>,
    #[serde(default)]
    pub applied_to_series: Option<bool>,
    #[serde(default)]
    pub refiled: Option<bool>,
    #[serde(default)]
    pub occurrences_updated: Option<u32>,
    #[serde(default)]
    pub refiled_count: Option<u32>,
    #[serde(default)]
    pub refile_warning: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCompanyErrorBody {
    pub ok: bool,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Mirrors hq-pro's `OntologyParticipant`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OntologyParticipant {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<String>,
    pub canonical_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    /// "invitee" | "organizer" | "ontology" | "historical" | "recall"
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteBotBody {
    pub meeting_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calendar_event_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub participants: Vec<OntologyParticipant>,
}

#[derive(Deserialize)]
pub struct EventsResponse {
    #[serde(default)]
    pub events: Vec<MeetingEvent>,
}

/// One connected Google account on the signed-in person.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleAccount {
    #[serde(rename = "accountId")]
    pub account_id: String,
    pub email: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default, rename = "connectedAt")]
    pub connected_at: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Deserialize)]
pub struct AccountsResponse {
    #[serde(default)]
    pub accounts: Vec<GoogleAccount>,
}

/// One calendar from `GET /v1/calendar/calendars?accountId=...`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleCalendar {
    pub id: String,
    pub summary: String,
    #[serde(default)]
    pub primary: bool,
    #[serde(default, rename = "accessRole")]
    pub access_role: Option<String>,
}

/// Combined response from `meetings_list_calendars_for_account`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCalendars {
    pub calendars: Vec<GoogleCalendar>,
    pub selected_calendar_ids: Vec<String>,
}

#[derive(Deserialize)]
pub struct CalendarsResponse {
    #[serde(default)]
    pub calendars: Vec<GoogleCalendar>,
    #[serde(default, rename = "selectedCalendars")]
    pub selected_calendars: Vec<SelectedCalendarRef>,
}

#[derive(Deserialize)]
pub struct SelectedCalendarRef {
    pub id: String,
}

#[derive(Deserialize)]
pub struct BotsResponse {
    #[serde(default)]
    pub bots: Vec<ScheduledBot>,
}

/// `GET /membership/me` projection used by the modal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyMembership {
    pub company_uid: String,
    #[serde(default)]
    pub company_name: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    pub status: String,
}

/// Payload for the meeting-detected notification command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyDetectedPayload {
    pub meeting_url: Option<String>,
    pub window_id: Option<String>,
    pub platform: Option<String>,
    pub summary: Option<String>,
    pub source_event_id: Option<String>,
}

pub fn is_unattributed(bot: &ScheduledBot) -> bool {
    bot.company_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.eq_ignore_ascii_case("unknown"))
        .unwrap_or(true)
}

pub fn select_unattributed(bots: &[ScheduledBot]) -> Vec<&ScheduledBot> {
    bots.iter()
        .filter(|bot| is_unattributed(bot) && !bot.status.trim().eq_ignore_ascii_case("cancelled"))
        .collect()
}

pub fn is_recorded(bot: &ScheduledBot) -> bool {
    bot.status.trim().eq_ignore_ascii_case("completed") || bot.source_landed
}

pub fn select_recorded(bots: &[ScheduledBot]) -> Vec<&ScheduledBot> {
    bots.iter().filter(|bot| is_recorded(bot)).collect()
}

pub fn build_set_company_body(company_id: &str, apply_to_series: bool) -> SetCompanyBody {
    SetCompanyBody {
        company_id: company_id.to_string(),
        apply_to_series,
    }
}

pub fn set_company_error_message(body: Option<SetCompanyErrorBody>) -> String {
    if let Some(body) = body {
        if let Some(error) = body.error.filter(|s| !s.trim().is_empty()) {
            return error;
        }
        match body.code.as_deref() {
            Some("company-access-denied") => {
                return "You don't have access to that company.".to_string()
            }
            Some("meeting-not-found") => return "That meeting no longer exists.".to_string(),
            Some("invalid-company") | Some("missing-company") => {
                return "Pick a valid company.".to_string()
            }
            _ => {}
        }
    }
    "Couldn't update the meeting's company.".to_string()
}

/// Pick the first bot whose status is active.
pub fn first_active_bot(bots: Vec<ScheduledBot>) -> Option<ScheduledBot> {
    bots.into_iter().find(|b| {
        matches!(
            b.status.as_str(),
            "scheduled" | "joining" | "recording" | "processing"
        )
    })
}

pub fn dedupe_new(seen: &mut HashSet<String>, candidates: &[&ScheduledBot]) -> Vec<String> {
    let mut out = Vec::new();
    for bot in candidates {
        if bot.bot_id.trim().is_empty() {
            continue;
        }
        if seen.insert(bot.bot_id.clone()) {
            out.push(bot.bot_id.clone());
        }
    }
    out
}

/// Build the notification body for a detected meeting.
pub fn build_notification_body(
    platform_lc: &str,
    summary: Option<&str>,
    meeting_url: Option<&str>,
) -> String {
    let display = {
        let mut p = if platform_lc.is_empty() {
            "Meeting".to_string()
        } else {
            platform_lc.to_string()
        };
        if let Some(c) = p.get_mut(0..1) {
            c.make_ascii_uppercase();
        }
        p
    };
    let is_synthetic_url = |u: &str| u.starts_with("recall-window:");
    match summary.filter(|s| !s.is_empty()) {
        Some(s) => format!("{display}: {s}"),
        None => match meeting_url.filter(|s| !s.is_empty()) {
            Some(u) if !is_synthetic_url(u) => format!("{display}: {u}"),
            _ => format!("{display} meeting"),
        },
    }
}

/// Build the notification title for a detected meeting.
pub fn build_notification_title(platform_lc: &str) -> String {
    if platform_lc.is_empty() {
        return "Meeting detected".to_string();
    }
    let mut display = platform_lc.to_string();
    if let Some(c) = display.get_mut(0..1) {
        c.make_ascii_uppercase();
    }
    format!("{display} meeting detected")
}

/// Allows only `[a-zA-Z0-9._-]+`.
pub fn is_url_safe_id(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

#[cfg(test)]
mod tests {
    use super::*;

    // The Meetings feature graduated from the Indigo dogfood to GA: the gate
    // now admits any signed-in user (`feature_gate::email_present`), not just
    // `@getindigo.ai`. These pin the GA presence contract the command path is
    // bound to.
    #[test]
    fn meetings_gate_admits_any_signed_in_user() {
        use crate::feature_gate::email_present;
        assert!(email_present(Some("stefan@getindigo.ai")));
        assert!(email_present(Some("someone@gmail.com")));
        assert!(email_present(Some("qa@example.com")));
        // Former dogfood look-alike — now admitted, GA only checks presence.
        assert!(email_present(Some("attacker@forgetindigo.ai")));
    }

    #[test]
    fn meetings_gate_rejects_signed_out() {
        use crate::feature_gate::email_present;
        assert!(!email_present(None));
        assert!(!email_present(Some("")));
        assert!(!email_present(Some("   ")));
    }

    fn bot_with_status(status: &str) -> ScheduledBot {
        ScheduledBot {
            bot_id: "bot-1".into(),
            meeting_url: "https://zoom.us/j/1".into(),
            platform: "zoom".into(),
            status: status.into(),
            calendar_event_id: None,
            meeting_title: None,
            scheduled_start_time: None,
            created_at: None,
            updated_at: None,
            company_id: None,
            auto_scheduled: false,
            error_message: None,
            source_landed: false,
        }
    }

    #[test]
    fn first_active_bot_recognizes_hqpro_normalized_statuses() {
        // Regression: hq-pro returns mapRecallStatus-NORMALIZED statuses
        // (scheduled/joining/recording/processing). A prior filter matched
        // Recall's RAW codes (joining_call/in_call_recording/in_call_not_recording),
        // so a scheduled meeting's bot stopped suppressing the detect-meeting
        // notification the moment it joined the call (status → recording). Every
        // normalized active status must be recognized as an active bot.
        for status in ["scheduled", "joining", "recording", "processing"] {
            assert!(
                first_active_bot(vec![bot_with_status(status)]).is_some(),
                "normalized active status {status:?} must count as an active bot"
            );
        }
    }

    #[test]
    fn first_active_bot_ignores_terminal_and_empty() {
        // Terminal/unknown statuses are not active (a completed/failed bot no
        // longer covers the meeting), and an empty list is None.
        for status in ["completed", "failed", "error", "unknown", ""] {
            assert!(
                first_active_bot(vec![bot_with_status(status)]).is_none(),
                "non-active status {status:?} must not count as an active bot"
            );
        }
        assert!(first_active_bot(vec![]).is_none());
    }

    #[test]
    fn first_active_bot_skips_terminal_and_returns_active() {
        // A mixed list (e.g. a stale completed bot + the live recording bot for
        // the same URL) must still surface the active one, not the terminal one.
        let bots = vec![bot_with_status("completed"), bot_with_status("recording")];
        assert_eq!(
            first_active_bot(bots).map(|b| b.status),
            Some("recording".to_string())
        );
    }

    /// Serde shape lock-in — what the frontend gets is what the modal needs.
    #[test]
    fn scheduled_bot_round_trips_camel_case() {
        let json = r#"{
            "botId": "bot-abc",
            "meetingUrl": "https://meet.google.com/abc",
            "platform": "google_meet",
            "status": "scheduled",
            "calendarEventId": "evt-1",
            "meetingTitle": "Standup",
            "scheduledStartTime": "2026-05-15T10:00:00Z",
            "autoScheduled": true,
            "errorMessage": null
        }"#;
        let bot: ScheduledBot = serde_json::from_str(json).expect("parse");
        assert_eq!(bot.bot_id, "bot-abc");
        assert_eq!(bot.status, "scheduled");
        assert_eq!(bot.calendar_event_id.as_deref(), Some("evt-1"));
        assert!(bot.auto_scheduled);
        assert!(bot.error_message.is_none());
    }

    /// Regression — `POST /v1/bot/invite` returns a slimmer body than
    /// `GET /v1/bot/list`, omitting `autoScheduled` (and the Optional
    /// fields). The invite command deserializes that response into
    /// `ScheduledBot`; if the struct treats `autoScheduled` as required the
    /// parse fails and the UI shows a spurious "Couldn't invite the bot."
    /// toast even though the bot was scheduled successfully. The slim body
    /// must parse, defaulting `auto_scheduled` to false.
    #[test]
    fn scheduled_bot_parses_slim_invite_response_without_auto_scheduled() {
        let json = r#"{
            "botId": "bot-abc",
            "status": "scheduled",
            "meetingUrl": "https://us06web.zoom.us/j/85906",
            "platform": "zoom",
            "createdAt": "2026-05-29T12:00:00Z"
        }"#;
        let bot: ScheduledBot = serde_json::from_str(json).expect("slim invite body must parse");
        assert_eq!(bot.bot_id, "bot-abc");
        assert_eq!(bot.status, "scheduled");
        assert_eq!(bot.platform, "zoom");
        assert!(
            !bot.auto_scheduled,
            "manual invite defaults to not auto-scheduled"
        );
        assert!(bot.calendar_event_id.is_none());
        assert!(bot.meeting_title.is_none());
    }

    #[test]
    fn scheduled_bot_accepts_bot_and_company_aliases() {
        let json = r#"{
            "recallBotId": "bot-alias",
            "status": "scheduled",
            "meetingUrl": "https://us06web.zoom.us/j/85906",
            "platform": "zoom",
            "title": "Alias title",
            "company": "cmp_alias"
        }"#;
        let bot: ScheduledBot = serde_json::from_str(json).expect("aliases parse");
        assert_eq!(bot.bot_id, "bot-alias");
        assert_eq!(bot.meeting_title.as_deref(), Some("Alias title"));
        assert_eq!(bot.company_id.as_deref(), Some("cmp_alias"));
    }

    #[test]
    fn unattributed_detection_handles_missing_empty_and_unknown() {
        let mut bot = bot_with_status("scheduled");
        assert!(is_unattributed(&bot));
        bot.company_id = Some("".to_string());
        assert!(is_unattributed(&bot));
        bot.company_id = Some(" UnKnOwN ".to_string());
        assert!(is_unattributed(&bot));
        bot.company_id = Some("cmp_123".to_string());
        assert!(!is_unattributed(&bot));
    }

    #[test]
    fn select_unattributed_excludes_cancelled_and_attributed() {
        let mut unknown = bot_with_status("scheduled");
        unknown.bot_id = "bot_unknown".to_string();
        unknown.company_id = Some("unknown".to_string());

        let mut missing = bot_with_status("recording");
        missing.bot_id = "bot_missing".to_string();

        let mut cancelled = bot_with_status("cancelled");
        cancelled.bot_id = "bot_cancelled".to_string();
        cancelled.company_id = Some("unknown".to_string());

        let mut attributed = bot_with_status("scheduled");
        attributed.bot_id = "bot_attributed".to_string();
        attributed.company_id = Some("cmp_a".to_string());

        let bots = vec![unknown, missing, cancelled, attributed];
        let selected = select_unattributed(&bots)
            .into_iter()
            .map(|b| b.bot_id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(selected, vec!["bot_unknown", "bot_missing"]);
    }

    #[test]
    fn recorded_detection_matches_completed_or_landed_source() {
        let completed = bot_with_status(" completed ");
        assert!(is_recorded(&completed));

        let mut landed = bot_with_status("processing");
        landed.source_landed = true;
        assert!(is_recorded(&landed));

        let neither = bot_with_status("processing");
        assert!(!is_recorded(&neither));
    }

    #[test]
    fn select_recorded_filters_completed_or_landed_bots() {
        let mut completed = bot_with_status("completed");
        completed.bot_id = "bot_completed".to_string();

        let mut landed = bot_with_status("processing");
        landed.bot_id = "bot_landed".to_string();
        landed.source_landed = true;

        let mut pending = bot_with_status("processing");
        pending.bot_id = "bot_pending".to_string();

        let bots = vec![completed, landed, pending];
        let selected = select_recorded(&bots)
            .into_iter()
            .map(|b| b.bot_id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(selected, vec!["bot_completed", "bot_landed"]);
    }

    #[test]
    fn build_set_company_body_serializes_camel_case() {
        let body = build_set_company_body("cmp_a", false);
        let json = serde_json::to_value(&body).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "companyId": "cmp_a",
                "applyToSeries": false
            })
        );
    }

    #[test]
    fn set_company_result_deserializes_success() {
        let json = r#"{
            "ok": true,
            "meetingId": "bot_1",
            "companyId": "cmp_a",
            "seriesKey": "series_1",
            "appliedToSeries": true,
            "refiled": false,
            "occurrencesUpdated": 3,
            "refiledCount": 2,
            "refileWarning": "some transcripts could not be moved"
        }"#;
        let result: SetCompanyResult = serde_json::from_str(json).expect("parse");
        assert!(result.ok);
        assert_eq!(result.meeting_id, "bot_1");
        assert_eq!(result.company_id, "cmp_a");
        assert_eq!(result.series_key.as_deref(), Some("series_1"));
        assert_eq!(result.applied_to_series, Some(true));
        assert_eq!(result.refiled, Some(false));
        assert_eq!(result.occurrences_updated, Some(3));
        assert_eq!(result.refiled_count, Some(2));
        assert_eq!(
            result.refile_warning.as_deref(),
            Some("some transcripts could not be moved")
        );
    }

    #[test]
    fn set_company_result_tolerates_missing_backfill_fields() {
        let json = r#"{
            "ok": true,
            "meetingId": "bot_1",
            "companyId": "cmp_a"
        }"#;
        let result: SetCompanyResult = serde_json::from_str(json).expect("parse");
        assert_eq!(result.occurrences_updated, None);
        assert_eq!(result.refiled_count, None);
        assert_eq!(result.refile_warning, None);
    }

    #[test]
    fn set_company_error_deserializes_and_maps_codes() {
        let body: SetCompanyErrorBody = serde_json::from_str(
            r#"{"ok":false,"code":"company-access-denied","error":"No access"}"#,
        )
        .expect("parse");
        assert_eq!(set_company_error_message(Some(body)), "No access");

        let body: SetCompanyErrorBody =
            serde_json::from_str(r#"{"ok":false,"code":"meeting-not-found"}"#).expect("parse");
        assert_eq!(
            set_company_error_message(Some(body)),
            "That meeting no longer exists."
        );

        let body: SetCompanyErrorBody =
            serde_json::from_str(r#"{"ok":false,"code":"invalid-company"}"#).expect("parse");
        assert_eq!(
            set_company_error_message(Some(body)),
            "Pick a valid company."
        );
        assert_eq!(
            set_company_error_message(None),
            "Couldn't update the meeting's company."
        );
    }

    #[test]
    fn dedupe_new_returns_only_first_time_meeting_ids() {
        let mut seen = std::collections::HashSet::from(["bot_seen".to_string()]);
        let mut seen_bot = bot_with_status("scheduled");
        seen_bot.bot_id = "bot_seen".to_string();
        let mut new_bot = bot_with_status("scheduled");
        new_bot.bot_id = "bot_new".to_string();
        let mut duplicate_new = bot_with_status("scheduled");
        duplicate_new.bot_id = "bot_new".to_string();
        let mut empty = bot_with_status("scheduled");
        empty.bot_id = "".to_string();
        let candidates = vec![&seen_bot, &new_bot, &duplicate_new, &empty];

        assert_eq!(dedupe_new(&mut seen, &candidates), vec!["bot_new"]);
        assert!(seen.contains("bot_seen"));
        assert!(seen.contains("bot_new"));
    }

    #[test]
    fn url_safe_id_accepts_uuid_shapes() {
        assert!(is_url_safe_id("abc123"));
        assert!(is_url_safe_id("550e8400-e29b-41d4-a716-446655440000"));
        assert!(is_url_safe_id("bot_abc.123"));
    }

    #[test]
    fn url_safe_id_rejects_path_traversal_and_specials() {
        assert!(!is_url_safe_id(""));
        assert!(!is_url_safe_id("../etc/passwd"));
        assert!(!is_url_safe_id("bot/abc"));
        assert!(!is_url_safe_id("bot abc"));
        assert!(!is_url_safe_id("bot?x=1"));
        assert!(!is_url_safe_id("bot#frag"));
    }

    #[test]
    fn meeting_event_parses_with_only_required_fields() {
        let json = r#"{
            "id": "evt-1",
            "start": {"dateTime": "2026-05-15T14:00:00Z"},
            "end": {"dateTime": "2026-05-15T15:00:00Z"},
            "status": "confirmed"
        }"#;
        let evt: MeetingEvent = serde_json::from_str(json).expect("parse");
        assert_eq!(evt.id, "evt-1");
        assert_eq!(evt.status, "confirmed");
        assert!(evt.summary.is_none());
        assert!(evt.hangout_link.is_none());
        assert!(evt.source_calendar_id.is_none());
        assert!(evt.source_company_uid.is_none());
        assert!(evt.signals.is_none());
        assert_eq!(evt.start.date_time.as_deref(), Some("2026-05-15T14:00:00Z"));
    }

    /// BE-4 enhancement — events tagged with source calendar + company.
    #[test]
    fn meeting_event_includes_source_calendar_tagging() {
        let json = r#"{
            "id": "evt-1",
            "summary": "Sync w/ Spencer",
            "start": {"dateTime": "2026-05-15T14:00:00Z"},
            "end": {"dateTime": "2026-05-15T15:00:00Z"},
            "status": "confirmed",
            "hangoutLink": "https://meet.google.com/abc-defg-hij",
            "sourceCalendarId": "stefan@getindigo.ai",
            "sourceCompanyUid": "cmp_indigo",
            "signals": {
                "actions": ["Send notes"],
                "decisions": [{"title": "Ship"}],
                "risks": []
            }
        }"#;
        let evt: MeetingEvent = serde_json::from_str(json).expect("parse");
        assert_eq!(evt.summary.as_deref(), Some("Sync w/ Spencer"));
        assert_eq!(
            evt.source_calendar_id.as_deref(),
            Some("stefan@getindigo.ai"),
        );
        assert_eq!(evt.source_company_uid.as_deref(), Some("cmp_indigo"));
        assert_eq!(
            evt.hangout_link.as_deref(),
            Some("https://meet.google.com/abc-defg-hij"),
        );
        assert_eq!(
            evt.signals
                .as_ref()
                .and_then(|signals| signals["actions"].as_array())
                .map(Vec::len),
            Some(1),
        );
    }

    // ── build_notification_body ──────────────────────────────────────────────
    // Regression: URL-less SDK detections (typically unscheduled Zoom from
    // the desktop app) reach us with a synthetic `recall-window:<id>` URL
    // from the bridge. The notification body must NOT leak that key — it
    // should render as "<Platform> meeting" instead.

    #[test]
    fn build_notification_body_uses_summary_when_present() {
        let body = build_notification_body(
            "zoom",
            Some("Weekly standup"),
            Some("https://zoom.us/j/123"),
        );
        assert_eq!(body, "Zoom: Weekly standup");
    }

    #[test]
    fn build_notification_body_uses_url_when_no_summary() {
        let body =
            build_notification_body("meet", None, Some("https://meet.google.com/abc-defg-hij"));
        assert_eq!(body, "Meet: https://meet.google.com/abc-defg-hij");
    }

    #[test]
    fn build_notification_body_hides_synthetic_recall_window_url() {
        // The bridge emits this shape when the SDK detects a meeting window
        // but can't scrape a real join URL.
        let body = build_notification_body(
            "zoom",
            None,
            Some("recall-window:43F5EBF4-8949-4DD4-B075-2E8EF68AAA30"),
        );
        assert_eq!(body, "Zoom meeting");
        // Hard check: no part of the synthetic key leaks.
        assert!(
            !body.contains("recall-window"),
            "synthetic key leaked: {body}"
        );
        assert!(!body.contains("43F5EBF4"), "windowId leaked: {body}");
    }

    #[test]
    fn build_notification_body_summary_wins_over_synthetic_url() {
        // If for some reason the SDK gave us both, summary should still win.
        let body = build_notification_body("zoom", Some("Quick chat"), Some("recall-window:abc"));
        assert_eq!(body, "Zoom: Quick chat");
    }

    #[test]
    fn build_notification_body_falls_back_when_url_and_summary_missing() {
        let body = build_notification_body("teams", None, None);
        assert_eq!(body, "Teams meeting");
    }

    #[test]
    fn build_notification_body_handles_unknown_platform() {
        // Bridge maps unrecognised platforms to "other" — verify graceful
        // rendering without panicking on the first-char uppercase.
        let body = build_notification_body("", None, None);
        assert_eq!(body, "Meeting meeting");
        // ^^ ugly-but-stable; this path requires both platform AND url AND
        // summary to be missing, which currently can't happen — the bridge
        // always sends at least the synthetic URL. Keeps the function total.
    }

    // ── build_notification_title ─────────────────────────────────────────────
    // The title names the platform so the banner isn't the generic
    // "Meeting detected" — e.g. "Zoom meeting detected". Empty platform must
    // degrade gracefully to the bare "Meeting detected" (no doubled words, no
    // leading space).

    #[test]
    fn build_notification_title_names_known_platform() {
        assert_eq!(build_notification_title("zoom"), "Zoom meeting detected");
        assert_eq!(build_notification_title("meet"), "Meet meeting detected");
        assert_eq!(build_notification_title("teams"), "Teams meeting detected");
    }

    #[test]
    fn build_notification_title_falls_back_on_empty_platform() {
        // Must not produce " meeting detected" or "Meeting meeting detected".
        let title = build_notification_title("");
        assert_eq!(title, "Meeting detected");
        assert!(!title.starts_with(' '), "leading space leaked: {title:?}");
    }

    #[test]
    fn build_notification_body_treats_empty_strings_as_missing() {
        // The Svelte handler can forward `meetingUrl: ""` / `summary: ""`
        // depending on how the payload was constructed.
        let body = build_notification_body("zoom", Some(""), Some(""));
        assert_eq!(body, "Zoom meeting");
    }
}

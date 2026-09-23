//! Fine-grained notification preferences (client mirror of the server policy).
//!
//! hq-pro stores one prefs row per person (`GET/PUT /v1/notify/prefs`) and a
//! per-channel level on each membership (`membership.notifyLevel`). It uses
//! them to gate native push and to stamp a per-recipient `notify` hint on
//! channel wakes. The desktop polls instead of receiving push, so it applies the
//! same rules locally:
//!
//!   * when a wake carried `notify`, that hint wins;
//!   * otherwise the rule is computed here from the prefs and the channel level
//!     ([`should_push`] is a line-for-line port of hq-pro `notify-policy.ts`).
//!
//! Everything in this module is pure so the truth table is unit-testable.

use std::collections::{HashMap, VecDeque};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Literal stored in `pausedUntil` for an open-ended pause.
pub const PAUSE_FOREVER: &str = "forever";

/// The four per-channel levels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyLevel {
    All,
    Mentions,
    Files,
    Muted,
}

impl NotifyLevel {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "all" => Some(Self::All),
            "mentions" => Some(Self::Mentions),
            "files" => Some(Self::Files),
            "muted" => Some(Self::Muted),
            _ => None,
        }
    }
}

/// One event class a notification can belong to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyEventClass {
    Dm,
    Mention,
    File,
    Activity,
    Added,
}

/// The `prefs` object of `GET /v1/notify/prefs`. Missing fields fall back to
/// the server defaults (dmsDuringPause off, everything else on).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyPrefs {
    #[serde(default)]
    pub paused_until: Option<String>,
    #[serde(default)]
    pub dms_during_pause: bool,
    #[serde(default = "default_true")]
    pub dms: bool,
    #[serde(default = "default_true")]
    pub mentions: bool,
    #[serde(default = "default_true")]
    pub files: bool,
    #[serde(default = "default_true")]
    pub all_activity: bool,
    #[serde(default = "default_true")]
    pub added_to_channel: bool,
    #[serde(default)]
    pub updated_at: Option<String>,
}

fn default_true() -> bool {
    true
}

impl Default for NotifyPrefs {
    fn default() -> Self {
        Self {
            paused_until: None,
            dms_during_pause: false,
            dms: true,
            mentions: true,
            files: true,
            all_activity: true,
            added_to_channel: true,
            updated_at: None,
        }
    }
}

/// `{ prefs, paused }` envelope of the prefs routes.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyPrefsResponse {
    #[serde(default)]
    pub prefs: NotifyPrefs,
}

/// Parse a prefs response body. Accepts the `{ prefs }` envelope or a bare
/// prefs object; anything else is `None` (the caller keeps legacy behaviour).
pub fn parse_prefs_body(body: &str) -> Option<NotifyPrefs> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let prefs = value.get("prefs").cloned().unwrap_or(value);
    if !prefs.is_object() {
        return None;
    }
    serde_json::from_value(prefs).ok()
}

/// True while a global pause is active at `now`.
pub fn is_paused(prefs: &NotifyPrefs, now: DateTime<Utc>) -> bool {
    let Some(until) = prefs.paused_until.as_deref().map(str::trim) else {
        return false;
    };
    if until.is_empty() {
        return false;
    }
    if until == PAUSE_FOREVER {
        return true;
    }
    DateTime::parse_from_rfc3339(until)
        .map(|ts| ts.with_timezone(&Utc) > now)
        .unwrap_or(false)
}

/// Decide one notification. Same precedence as hq-pro `shouldPush`:
///
///   1. A global pause silences everything; only DMs pass, and only when
///      `dmsDuringPause` is on.
///   2. dm → `dms`; added → `addedToChannel` (channel levels do not apply).
///   3. muted → nothing, mentions included.
///   4. mention → `mentions`.
///   5. file → `files` and level all|files.
///   6. activity → `allActivity` and level all.
///
/// A missing level resolves to `mentions`, as on the server.
pub fn should_push(
    prefs: &NotifyPrefs,
    level: Option<NotifyLevel>,
    class: NotifyEventClass,
    now: DateTime<Utc>,
) -> bool {
    if is_paused(prefs, now) && !(class == NotifyEventClass::Dm && prefs.dms_during_pause) {
        return false;
    }
    match class {
        NotifyEventClass::Dm => return prefs.dms,
        NotifyEventClass::Added => return prefs.added_to_channel,
        _ => {}
    }
    let level = level.unwrap_or(NotifyLevel::Mentions);
    if level == NotifyLevel::Muted {
        return false;
    }
    match class {
        NotifyEventClass::Mention => prefs.mentions,
        NotifyEventClass::File => {
            prefs.files && matches!(level, NotifyLevel::All | NotifyLevel::Files)
        }
        NotifyEventClass::Activity => prefs.all_activity && level == NotifyLevel::All,
        NotifyEventClass::Dm | NotifyEventClass::Added => false,
    }
}

/// The classes one channel message carries for one recipient, most specific
/// first (mirrors hq-pro `channelEventClasses`).
pub fn channel_event_classes(mentioned: bool, has_file: bool) -> Vec<NotifyEventClass> {
    let mut classes = Vec::with_capacity(3);
    if mentioned {
        classes.push(NotifyEventClass::Mention);
    }
    if has_file {
        classes.push(NotifyEventClass::File);
    }
    classes.push(NotifyEventClass::Activity);
    classes
}

/// Where a channel-message decision came from (logged for diagnosis).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelNotifySource {
    /// The wake carried `notify`.
    WakeHint,
    /// Computed from the fetched prefs and the channel level.
    Prefs,
    /// No prefs and no hint: pre-prefs behaviour (mentions only).
    Legacy,
}

/// Decide whether a channel message should raise an OS notification.
///
/// * `wake_hint` — the `notify` flag from the message's wake, when one arrived.
/// * `prefs` — `None` when the prefs route is unavailable (404 / old server /
///   fetch failure); the desktop then keeps its legacy mentions-only rule.
pub fn decide_channel_notify(
    wake_hint: Option<bool>,
    prefs: Option<&NotifyPrefs>,
    level: Option<NotifyLevel>,
    mentioned: bool,
    has_file: bool,
    now: DateTime<Utc>,
) -> (bool, ChannelNotifySource) {
    if let Some(hint) = wake_hint {
        return (hint, ChannelNotifySource::WakeHint);
    }
    match prefs {
        Some(prefs) => {
            let notify = channel_event_classes(mentioned, has_file)
                .into_iter()
                .any(|class| should_push(prefs, level, class, now));
            (notify, ChannelNotifySource::Prefs)
        }
        None => (mentioned, ChannelNotifySource::Legacy),
    }
}

/// DM gate. Without prefs the DM passes (legacy behaviour; the local
/// `dmNotifications` master switch is checked separately by the poller).
pub fn dm_allowed(prefs: Option<&NotifyPrefs>, now: DateTime<Utc>) -> bool {
    prefs.map_or(true, |prefs| {
        should_push(prefs, None, NotifyEventClass::Dm, now)
    })
}

/// "Added to a channel" gate. Without prefs the desktop never raised this
/// notification, so it stays silent.
pub fn added_allowed(prefs: Option<&NotifyPrefs>, now: DateTime<Utc>) -> bool {
    prefs.is_some_and(|prefs| should_push(prefs, None, NotifyEventClass::Added, now))
}

/// Title for the "you were added to a channel" notification, matching the
/// server's CHAN_ADDED push title.
pub fn added_notification_title(channel_name: &str) -> String {
    let name = channel_name.trim().trim_start_matches('#').trim();
    if name.is_empty() {
        "Added to a conversation".to_string()
    } else {
        format!("Added to #{name}")
    }
}

/// Title for a non-mention channel notification (file or other activity):
/// "{author} in #{channel}", matching the server's channel push title.
pub fn channel_activity_title(author: &str, channel_name: &str) -> String {
    let author = author.trim();
    let author = if author.is_empty() { "Someone" } else { author };
    let channel = channel_name.trim().trim_start_matches('#').trim();
    let channel = if channel.is_empty() {
        "channel"
    } else {
        channel
    };
    format!("{author} in #{channel}")
}

/// Title for the capped-overflow summary when it is not all mentions.
pub fn activity_summary_title(extra_count: usize) -> String {
    if extra_count == 1 {
        "1 more new message".to_string()
    } else {
        format!("{extra_count} more new messages")
    }
}

/// True when a channel that newly appeared in the caller's list should raise
/// an "added" notification: joined, added explicitly by someone else (company
/// auto-joins are silent), and not created by the caller.
pub fn is_notifiable_added_channel(
    joined: bool,
    membership_source: Option<&str>,
    created_by: Option<&str>,
    self_uids: &[&str],
) -> bool {
    if !joined {
        return false;
    }
    if matches!(
        membership_source.map(str::trim),
        Some("company-auto") | Some("company")
    ) {
        return false;
    }
    if let Some(creator) = created_by.map(str::trim).filter(|c| !c.is_empty()) {
        if self_uids
            .iter()
            .map(|uid| uid.trim())
            .any(|uid| !uid.is_empty() && uid == creator)
        {
            return false;
        }
    }
    true
}

/// Parse the `notify` hint out of a realtime wake payload. Returns
/// `(eventId, notify)` for channel and thread wakes that carry the flag, and
/// `None` for everything else (including wakes from older producers).
pub fn parse_wake_notify_hint(payload: &[u8]) -> Option<(String, bool)> {
    let value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    let kind = value.get("type").and_then(|v| v.as_str())?;
    if kind != "channel" && kind != "thread" {
        return None;
    }
    let notify = value.get("notify").and_then(|v| v.as_bool())?;
    let event_id = value
        .get("eventId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|id| !id.is_empty())?;
    Some((event_id.to_string(), notify))
}

/// Bounded eventId → notify map filled from wakes and read by the poller.
#[derive(Debug, Default)]
pub struct WakeNotifyHints {
    by_event: HashMap<String, bool>,
    order: VecDeque<String>,
}

/// Enough for several poll cycles of busy channels.
pub const WAKE_HINT_CAPACITY: usize = 512;

impl WakeNotifyHints {
    pub fn record(&mut self, event_id: String, notify: bool) {
        if self.by_event.insert(event_id.clone(), notify).is_none() {
            self.order.push_back(event_id);
        }
        while self.order.len() > WAKE_HINT_CAPACITY {
            if let Some(old) = self.order.pop_front() {
                self.by_event.remove(&old);
            }
        }
    }

    pub fn get(&self, event_id: &str) -> Option<bool> {
        self.by_event.get(event_id).copied()
    }

    pub fn len(&self) -> usize {
        self.by_event.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_event.is_empty()
    }

    pub fn clear(&mut self) {
        self.by_event.clear();
        self.order.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 23, 12, 0, 0).unwrap()
    }

    fn paused(until: &str) -> NotifyPrefs {
        NotifyPrefs {
            paused_until: Some(until.to_string()),
            ..NotifyPrefs::default()
        }
    }

    #[test]
    fn defaults_match_server() {
        let prefs = parse_prefs_body("{}").unwrap();
        assert_eq!(prefs, NotifyPrefs::default());
        assert!(!prefs.dms_during_pause);
        assert!(prefs.dms && prefs.mentions && prefs.files && prefs.all_activity);
        assert!(prefs.added_to_channel);
    }

    #[test]
    fn parses_live_envelope() {
        let body = r#"{"prefs":{"pausedUntil":null,"dmsDuringPause":true,"dms":false,"mentions":true,"files":false,"allActivity":true,"addedToChannel":false,"updatedAt":"2026-09-23T19:19:03.904Z"},"paused":false}"#;
        let prefs = parse_prefs_body(body).unwrap();
        assert!(prefs.dms_during_pause);
        assert!(!prefs.dms);
        assert!(!prefs.files);
        assert!(!prefs.added_to_channel);
        assert_eq!(prefs.paused_until, None);
    }

    #[test]
    fn rejects_non_object_bodies() {
        assert!(parse_prefs_body("not json").is_none());
        assert!(parse_prefs_body("[]").is_none());
        assert!(parse_prefs_body(r#"{"prefs":5}"#).is_none());
    }

    #[test]
    fn pause_states() {
        assert!(!is_paused(&NotifyPrefs::default(), now()));
        assert!(is_paused(&paused("forever"), now()));
        assert!(is_paused(&paused("2026-09-23T13:00:00Z"), now()));
        assert!(!is_paused(&paused("2026-09-23T11:00:00Z"), now()));
        assert!(is_paused(&paused("2026-09-23T14:00:00+01:00"), now()));
        assert!(!is_paused(&paused("tomorrow"), now()));
    }

    #[test]
    fn pause_silences_everything_but_dms_when_allowed() {
        let mut prefs = paused("forever");
        for class in [
            NotifyEventClass::Dm,
            NotifyEventClass::Mention,
            NotifyEventClass::File,
            NotifyEventClass::Activity,
            NotifyEventClass::Added,
        ] {
            assert!(!should_push(&prefs, Some(NotifyLevel::All), class, now()));
        }
        prefs.dms_during_pause = true;
        assert!(should_push(&prefs, None, NotifyEventClass::Dm, now()));
        assert!(!should_push(
            &prefs,
            Some(NotifyLevel::All),
            NotifyEventClass::Mention,
            now()
        ));
        prefs.dms = false;
        assert!(!should_push(&prefs, None, NotifyEventClass::Dm, now()));
    }

    #[test]
    fn muted_blocks_mentions() {
        let prefs = NotifyPrefs::default();
        assert!(!should_push(
            &prefs,
            Some(NotifyLevel::Muted),
            NotifyEventClass::Mention,
            now()
        ));
        assert!(!should_push(
            &prefs,
            Some(NotifyLevel::Muted),
            NotifyEventClass::File,
            now()
        ));
        assert!(!should_push(
            &prefs,
            Some(NotifyLevel::Muted),
            NotifyEventClass::Activity,
            now()
        ));
    }

    #[test]
    fn level_truth_table() {
        let prefs = NotifyPrefs::default();
        use NotifyEventClass::*;
        use NotifyLevel::*;
        let cases = [
            (All, Mention, true),
            (All, File, true),
            (All, Activity, true),
            (Mentions, Mention, true),
            (Mentions, File, false),
            (Mentions, Activity, false),
            (Files, Mention, true),
            (Files, File, true),
            (Files, Activity, false),
        ];
        for (level, class, expected) in cases {
            assert_eq!(
                should_push(&prefs, Some(level), class, now()),
                expected,
                "{level:?} {class:?}"
            );
        }
        // Missing level resolves to mentions.
        assert!(should_push(&prefs, None, Mention, now()));
        assert!(!should_push(&prefs, None, Activity, now()));
    }

    #[test]
    fn global_toggles_apply() {
        let prefs = NotifyPrefs {
            mentions: false,
            files: false,
            all_activity: false,
            added_to_channel: false,
            ..NotifyPrefs::default()
        };
        use NotifyEventClass::*;
        assert!(!should_push(&prefs, Some(NotifyLevel::All), Mention, now()));
        assert!(!should_push(&prefs, Some(NotifyLevel::All), File, now()));
        assert!(!should_push(
            &prefs,
            Some(NotifyLevel::All),
            Activity,
            now()
        ));
        assert!(!should_push(&prefs, None, Added, now()));
        assert!(should_push(&prefs, None, Dm, now()));
    }

    #[test]
    fn mention_in_all_channel_passes_via_activity_when_mentions_off() {
        let prefs = NotifyPrefs {
            mentions: false,
            ..NotifyPrefs::default()
        };
        let (notify, source) = decide_channel_notify(
            None,
            Some(&prefs),
            Some(NotifyLevel::All),
            true,
            false,
            now(),
        );
        assert!(notify);
        assert_eq!(source, ChannelNotifySource::Prefs);
    }

    #[test]
    fn wake_hint_wins_over_local_rule() {
        let prefs = NotifyPrefs::default();
        assert_eq!(
            decide_channel_notify(
                Some(false),
                Some(&prefs),
                Some(NotifyLevel::All),
                true,
                false,
                now()
            ),
            (false, ChannelNotifySource::WakeHint)
        );
        assert_eq!(
            decide_channel_notify(
                Some(true),
                None,
                Some(NotifyLevel::Muted),
                false,
                false,
                now()
            ),
            (true, ChannelNotifySource::WakeHint)
        );
    }

    #[test]
    fn no_prefs_keeps_legacy_mentions_only() {
        assert_eq!(
            decide_channel_notify(None, None, Some(NotifyLevel::All), false, true, now()),
            (false, ChannelNotifySource::Legacy)
        );
        assert_eq!(
            decide_channel_notify(None, None, Some(NotifyLevel::Muted), true, false, now()),
            (true, ChannelNotifySource::Legacy)
        );
    }

    #[test]
    fn file_in_files_channel_notifies_activity_does_not() {
        let prefs = NotifyPrefs::default();
        let level = Some(NotifyLevel::Files);
        assert!(decide_channel_notify(None, Some(&prefs), level, false, true, now()).0);
        assert!(!decide_channel_notify(None, Some(&prefs), level, false, false, now()).0);
    }

    #[test]
    fn dm_and_added_gates() {
        assert!(dm_allowed(None, now()));
        assert!(!added_allowed(None, now()));
        let prefs = NotifyPrefs::default();
        assert!(dm_allowed(Some(&prefs), now()));
        assert!(added_allowed(Some(&prefs), now()));
        let off = NotifyPrefs {
            dms: false,
            ..NotifyPrefs::default()
        };
        assert!(!dm_allowed(Some(&off), now()));
        assert!(!dm_allowed(Some(&paused("forever")), now()));
        assert!(!added_allowed(Some(&paused("forever")), now()));
    }

    #[test]
    fn added_title_matches_server() {
        assert_eq!(added_notification_title("#design"), "Added to #design");
        assert_eq!(added_notification_title("ops"), "Added to #ops");
        assert_eq!(added_notification_title("  "), "Added to a conversation");
    }

    #[test]
    fn activity_titles() {
        assert_eq!(channel_activity_title("Ada", "#eng"), "Ada in #eng");
        assert_eq!(channel_activity_title(" ", ""), "Someone in #channel");
        assert_eq!(activity_summary_title(1), "1 more new message");
        assert_eq!(activity_summary_title(4), "4 more new messages");
    }

    #[test]
    fn added_channel_filter() {
        let me = ["prs_me", "sub_me"];
        assert!(is_notifiable_added_channel(
            true,
            Some("explicit"),
            Some("prs_other"),
            &me
        ));
        assert!(is_notifiable_added_channel(true, None, None, &me));
        assert!(!is_notifiable_added_channel(
            false,
            Some("explicit"),
            None,
            &me
        ));
        assert!(!is_notifiable_added_channel(
            true,
            Some("company-auto"),
            None,
            &me
        ));
        assert!(!is_notifiable_added_channel(
            true,
            Some("company"),
            None,
            &me
        ));
        assert!(!is_notifiable_added_channel(
            true,
            Some("explicit"),
            Some("prs_me"),
            &me
        ));
        assert!(!is_notifiable_added_channel(
            true,
            Some("explicit"),
            Some("sub_me"),
            &me
        ));
    }

    #[test]
    fn parses_wake_hints() {
        assert_eq!(
            parse_wake_notify_hint(
                br#"{"type":"channel","channelId":"chn_1","eventId":"evt_1","createdAt":"x","fromPersonUid":"p","notify":false}"#
            ),
            Some(("evt_1".to_string(), false))
        );
        assert_eq!(
            parse_wake_notify_hint(
                br#"{"type":"thread","scope":"channel","rootEventId":"r","eventId":"evt_2","notify":true}"#
            ),
            Some(("evt_2".to_string(), true))
        );
        // Absent notify: old producer, no hint.
        assert_eq!(
            parse_wake_notify_hint(br#"{"type":"channel","eventId":"evt_3"}"#),
            None
        );
        assert_eq!(
            parse_wake_notify_hint(br#"{"type":"reaction","eventId":"evt_4","notify":true}"#),
            None
        );
        assert_eq!(parse_wake_notify_hint(b"not json"), None);
    }

    #[test]
    fn wake_hints_are_bounded() {
        let mut hints = WakeNotifyHints::default();
        for i in 0..(WAKE_HINT_CAPACITY + 10) {
            hints.record(format!("evt_{i}"), i % 2 == 0);
        }
        assert_eq!(hints.len(), WAKE_HINT_CAPACITY);
        assert_eq!(hints.get("evt_0"), None);
        assert_eq!(
            hints.get(&format!("evt_{}", WAKE_HINT_CAPACITY + 9)),
            Some(false)
        );
        hints.record("evt_x".into(), true);
        hints.record("evt_x".into(), false);
        assert_eq!(hints.get("evt_x"), Some(false));
        hints.clear();
        assert!(hints.is_empty());
    }

    #[test]
    fn level_parse() {
        assert_eq!(NotifyLevel::parse("all"), Some(NotifyLevel::All));
        assert_eq!(NotifyLevel::parse("muted"), Some(NotifyLevel::Muted));
        assert_eq!(NotifyLevel::parse("loud"), None);
    }
}

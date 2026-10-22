//! Plan-limit refusals from hq-pro, for native callers (hard-stop-readiness).
//!
//! hq-pro refuses a create that would take a Starter company past a limit with
//! HTTP 402 and one body shape:
//!
//! ```text
//! { error: "plan_limit_reached", code: "PLAN_LIMIT_EXCEEDED", status: 402,
//!   blocked, resources: [{ resource, used, limit }], message, fixOptions,
//!   freeMonth?, upgradeUrl }
//! ```
//!
//! The legacy membership block `{ code: "PLAN_LIMIT_EXCEEDED", resource, used,
//! limit, requiredPlan, upgradeUrl, message? }` and the personal presign item
//! `{ error: "<sentence>", code: "PLAN_LIMIT_REACHED", upgradeUrl }` are still
//! in the field. This module turns any of them into a readable sentence plus an
//! approved upgrade link. It mirrors `packages/platform/src/plan-limit.ts`; the
//! two share fixtures in their tests so they cannot drift apart.
//!
//! Usage-only pricing (US-024) adds a `usagePause` block to the same 402 body
//! when a company's cloud sync is paused for usage:
//!
//! ```text
//! usagePause: { code: "usage_paused", reason, message, actionUrl }
//! ```
//!
//! `reason` is one of `usage_trial_cap`, `usage_card_required` or
//! `usage_spend_limit`, and `actionUrl` links to the company's Billing page.
//! A valid block wins over the legacy fields; see [`parse_usage_pause`].
//!
//! A refusal is an expected product state. Nothing here reports to Sentry, and
//! [`is_plan_limit_refusal_message`] lets the runner-exit classifier keep a
//! plan-limit refusal out of the alertable set.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Current hard-stop code (and the legacy membership code).
pub const PLAN_LIMIT_EXCEEDED: &str = "PLAN_LIMIT_EXCEEDED";
/// Legacy personal-scope presign skip code.
pub const PLAN_LIMIT_REACHED: &str = "PLAN_LIMIT_REACHED";
/// `error` token of the current hard-stop body.
pub const PLAN_LIMIT_REACHED_ERROR: &str = "plan_limit_reached";

/// Hosts hq-pro puts in `upgradeUrl`. Every builder on hq-pro main derives the
/// link from `CONSOLE_BASE_URL`, which every deployed stage leaves at
/// `https://hq.computer`. The retired `app.indigo-hq.com/billing/upgrade` link
/// 404s and is deliberately not allowed.
pub const PLAN_UPGRADE_HOSTS: &[&str] = &["hq.computer"];

const DEFAULT_PLAN_LIMIT_MESSAGE: &str = "Your plan limit is reached.";

/// `usagePause.code` for a usage pause.
pub const USAGE_PAUSE_CODE: &str = "usage_paused";
/// The trial allowance is used up.
pub const USAGE_REASON_TRIAL_CAP: &str = "usage_trial_cap";
/// A card is needed before more usage is allowed.
pub const USAGE_REASON_CARD_REQUIRED: &str = "usage_card_required";
/// The company's spend limit is reached.
pub const USAGE_REASON_SPEND_LIMIT: &str = "usage_spend_limit";
/// Every reason hq-pro sends in `usagePause.reason`.
pub const USAGE_PAUSE_REASONS: &[&str] = &[
    USAGE_REASON_TRIAL_CAP,
    USAGE_REASON_CARD_REQUIRED,
    USAGE_REASON_SPEND_LIMIT,
];

/// Shown for a usage pause when the server sentence cannot be read.
pub const USAGE_PAUSE_FALLBACK_MESSAGE: &str = "Cloud sync is paused for this company. Open Billing to add a card or raise the spend limit. Files on this computer are not affected.";

/// A company's cloud sync is paused for usage (US-024). Built only by
/// [`parse_usage_pause`], so every field has been checked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsagePause {
    /// Always [`USAGE_PAUSE_CODE`].
    pub code: String,
    /// One of [`USAGE_PAUSE_REASONS`].
    pub reason: String,
    /// The server's sentence, shown as is.
    pub message: String,
    /// Billing link, normalized by [`approved_plan_upgrade_url`].
    pub action_url: String,
}

/// Read a `usagePause` block. `None` unless `code` is `usage_paused`, the
/// reason is known, the message is not empty, and `actionUrl` is an approved
/// https link.
pub fn parse_usage_pause(value: &Value) -> Option<UsagePause> {
    let rec = value.as_object()?;
    if non_empty_str(rec, "code")? != USAGE_PAUSE_CODE {
        return None;
    }
    let reason = non_empty_str(rec, "reason")?;
    if !USAGE_PAUSE_REASONS.contains(&reason) {
        return None;
    }
    let message = non_empty_str(rec, "message")?;
    let action_url = approved_plan_upgrade_url(non_empty_str(rec, "actionUrl")?)?;
    Some(UsagePause {
        code: USAGE_PAUSE_CODE.to_string(),
        reason: reason.to_string(),
        message: message.to_string(),
        action_url,
    })
}

/// True for every code or error token hq-pro uses for a plan-limit refusal.
pub fn is_plan_limit_token(value: &str) -> bool {
    matches!(
        value.trim(),
        PLAN_LIMIT_EXCEEDED | PLAN_LIMIT_REACHED | PLAN_LIMIT_REACHED_ERROR
    )
}

/// The normalized upgrade URL when it is a credential-free HTTPS link on a host
/// hq-pro returns, otherwise `None`.
pub fn approved_plan_upgrade_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let url = url::Url::parse(trimmed).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    if !PLAN_UPGRADE_HOSTS.contains(&host.as_str()) {
        return None;
    }
    Some(url.to_string())
}

/// A readable plan-limit refusal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanLimitRefusal {
    pub message: String,
    /// Present only when the body carried an approved upgrade link. For a
    /// usage pause this is the Billing link from `usagePause.actionUrl`.
    pub upgrade_url: Option<String>,
    /// Set when the body carried a valid `usagePause` block.
    pub usage_pause: Option<UsagePause>,
}

fn resource_label(resource: &str) -> &str {
    match resource {
        "users" => "Members",
        "secrets" => "Secrets",
        "deployments" => "Deployments",
        "storageBytes" => "Storage",
        "integrations" => "Integrations",
        "agents" => "Agents",
        other => other,
    }
}

fn format_storage(bytes: f64) -> String {
    let gb = bytes / 1024f64.powi(3);
    if gb >= 1.0 {
        let rounded = (gb * 10.0).round() / 10.0;
        if rounded.fract() == 0.0 {
            format!("{rounded:.0} GB")
        } else {
            format!("{rounded:.1} GB")
        }
    } else {
        format!("{:.0} MB", (bytes / 1024f64.powi(2)).round().max(0.0))
    }
}

fn format_amount(resource: &str, value: f64) -> String {
    if resource == "storageBytes" {
        format_storage(value)
    } else {
        format!("{}", value.floor() as u64)
    }
}

/// "Storage: 10.2 GB of 10 GB used." — one sentence per over-limit resource.
pub fn describe_plan_limit_resource(
    resource: &str,
    used: Option<f64>,
    limit: Option<f64>,
) -> String {
    let label = resource_label(resource);
    match (used, limit) {
        (Some(used), Some(limit)) => format!(
            "{label}: {} of {} used.",
            format_amount(resource, used),
            format_amount(resource, limit)
        ),
        _ => format!("{label}: limit reached."),
    }
}

fn count(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
}

fn non_empty_str<'a>(rec: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    rec.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn usage_sentences(rec: &Map<String, Value>) -> Vec<String> {
    if let Some(rows) = rec.get("resources").and_then(Value::as_array) {
        return rows
            .iter()
            .filter_map(Value::as_object)
            .filter_map(|row| {
                let resource = non_empty_str(row, "resource")?;
                Some(describe_plan_limit_resource(
                    resource,
                    count(row.get("used")),
                    count(row.get("limit")),
                ))
            })
            .collect();
    }
    match non_empty_str(rec, "resource") {
        Some(resource) => vec![describe_plan_limit_resource(
            resource,
            count(rec.get("used")),
            count(rec.get("limit")),
        )],
        None => Vec::new(),
    }
}

/// Parse a plan-limit refusal body. `None` when the body is not a plan-limit
/// refusal (other errors keep their own handling).
pub fn parse_plan_limit_body(body: &str) -> Option<PlanLimitRefusal> {
    let value: Value = serde_json::from_str(body.trim()).ok()?;
    let rec = value.as_object()?;
    if let Some(pause) = rec.get("usagePause").and_then(parse_usage_pause) {
        return Some(PlanLimitRefusal {
            message: pause.message.clone(),
            upgrade_url: Some(pause.action_url.clone()),
            usage_pause: Some(pause),
        });
    }
    let is_limit = non_empty_str(rec, "code").is_some_and(is_plan_limit_token)
        || non_empty_str(rec, "error").is_some_and(is_plan_limit_token);
    if !is_limit {
        return None;
    }
    let base = non_empty_str(rec, "message")
        .or_else(|| non_empty_str(rec, "error").filter(|e| !is_plan_limit_token(e)))
        .unwrap_or(DEFAULT_PLAN_LIMIT_MESSAGE);
    let usage = usage_sentences(rec);
    let message = if usage.is_empty() {
        base.to_string()
    } else {
        format!("{base} {}", usage.join(" "))
    };
    Some(PlanLimitRefusal {
        message,
        upgrade_url: rec
            .get("upgradeUrl")
            .and_then(Value::as_str)
            .and_then(approved_plan_upgrade_url),
        usage_pause: None,
    })
}

/// Maximum characters of a non-JSON error body shown to a person.
const READABLE_BODY_CAP: usize = 200;

/// A readable sentence for an hq-pro error body: the plan-limit sentence, else
/// the body's `message` / `error`, else the trimmed text. Never raw JSON.
pub fn readable_error_body(body: &str) -> Option<String> {
    if let Some(refusal) = parse_plan_limit_body(body) {
        return Some(refusal.message);
    }
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return value.as_object().and_then(|rec| {
            non_empty_str(rec, "message")
                .or_else(|| non_empty_str(rec, "error"))
                .map(str::to_string)
        });
    }
    let capped: String = trimmed.chars().take(READABLE_BODY_CAP).collect();
    Some(capped)
}

/// True when a runner error message (hq-cloud `describeError` output) is a
/// plan-limit refusal: `code=PLAN_LIMIT_EXCEEDED`, `code=PLAN_LIMIT_REACHED`,
/// the `plan_limit_reached` token, or the vault's `http=402` status. 402 is
/// only ever sent by hq-pro's plan gates.
pub fn is_plan_limit_refusal_message(message: &str) -> bool {
    if usage_pause_runner_message(message).is_some() {
        return true;
    }
    if message.contains("code=PLAN_LIMIT_EXCEEDED")
        || message.contains("code=PLAN_LIMIT_REACHED")
        || message.contains(PLAN_LIMIT_REACHED_ERROR)
    {
        return true;
    }
    message.match_indices("http=402").any(|(index, token)| {
        let rest = &message[index + token.len()..];
        !rest.starts_with(|c: char| c.is_ascii_digit())
    })
}

/// The JSON object embedded in a runner error message, if one parses.
fn embedded_json_object(message: &str) -> Option<Value> {
    let start = message.find('{')?;
    let end = message.rfind('}')?;
    if end <= start {
        return None;
    }
    let value: Value = serde_json::from_str(&message[start..=end]).ok()?;
    value.is_object().then_some(value)
}

/// The sentence to show for a runner error message (hq-cloud `describeError`
/// output such as `VaultClientError code=PLAN_LIMIT_EXCEEDED http=402 ...`)
/// that is a usage pause. Returns the server's usage sentence when the message
/// carries a valid `usagePause` block, else [`USAGE_PAUSE_FALLBACK_MESSAGE`]
/// when it names a usage reason or `usage_paused`. `None` for anything else,
/// including legacy plan-limit refusals.
pub fn usage_pause_runner_message(message: &str) -> Option<String> {
    if let Some(value) = embedded_json_object(message) {
        let pause = value
            .get("usagePause")
            .and_then(parse_usage_pause)
            .or_else(|| parse_usage_pause(&value));
        if let Some(pause) = pause {
            return Some(pause.message);
        }
    }
    let names_usage_pause = message.contains(USAGE_PAUSE_CODE)
        || USAGE_PAUSE_REASONS
            .iter()
            .any(|reason| message.contains(reason));
    names_usage_pause.then(|| USAGE_PAUSE_FALLBACK_MESSAGE.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const UPGRADE_URL: &str = "https://hq.computer/companies/acme/billing?upgrade=1";

    /// `evaluatePlanHardStopFromInputs` for files.create over storage — the
    /// same fixture `packages/platform/src/plan-limit.test.ts` uses.
    fn hard_stop_body() -> String {
        serde_json::json!({
            "error": "plan_limit_reached",
            "code": "PLAN_LIMIT_EXCEEDED",
            "status": 402,
            "blocked": "files.create",
            "resources": [
                { "resource": "storageBytes", "used": 10_995_116_278u64, "limit": 10_737_418_240u64 }
            ],
            "message": "New files are paused while Acme is over its Starter limits.",
            "fixOptions": { "storageBytes": 10_737_418_240u64 },
            "upgradeUrl": UPGRADE_URL,
        })
        .to_string()
    }

    #[test]
    fn parses_the_hard_stop_body() {
        assert_eq!(
            parse_plan_limit_body(&hard_stop_body()),
            Some(PlanLimitRefusal {
                message: "New files are paused while Acme is over its Starter limits. Storage: 10.2 GB of 10 GB used.".into(),
                upgrade_url: Some(UPGRADE_URL.into()),
                usage_pause: None,
            })
        );
    }

    #[test]
    fn parses_the_members_hard_stop_without_code() {
        let body = serde_json::json!({
            "error": "plan_limit_reached",
            "status": 402,
            "blocked": "members.create",
            "resources": [{ "resource": "users", "used": 5, "limit": 5 }],
            "message": "New members cannot be added while Acme is over its Starter limits.",
            "fixOptions": { "users": 5 },
            "upgradeUrl": "https://hq.computer/billing",
        })
        .to_string();
        let refusal = parse_plan_limit_body(&body).unwrap();
        assert_eq!(
            refusal.message,
            "New members cannot be added while Acme is over its Starter limits. Members: 5 of 5 used."
        );
        assert_eq!(
            refusal.upgrade_url.as_deref(),
            Some("https://hq.computer/billing")
        );
    }

    #[test]
    fn parses_the_legacy_membership_block() {
        let body = r#"{"code":"PLAN_LIMIT_EXCEEDED","resource":"users","used":5,"limit":5,"requiredPlan":"team","upgradeUrl":"https://hq.computer/billing"}"#;
        assert_eq!(
            parse_plan_limit_body(body),
            Some(PlanLimitRefusal {
                message: "Your plan limit is reached. Members: 5 of 5 used.".into(),
                upgrade_url: Some("https://hq.computer/billing".into()),
                usage_pause: None,
            })
        );
    }

    #[test]
    fn parses_the_legacy_personal_presign_item() {
        let body = r#"{"key":"k","op":"put","error":"New files are paused while your personal HQ is over its limits.","code":"PLAN_LIMIT_REACHED","upgradeUrl":"https://hq.computer/billing"}"#;
        let refusal = parse_plan_limit_body(body).unwrap();
        assert_eq!(
            refusal.message,
            "New files are paused while your personal HQ is over its limits."
        );
    }

    #[test]
    fn ignores_other_errors() {
        assert_eq!(parse_plan_limit_body(r#"{"error":"Forbidden"}"#), None);
        assert_eq!(
            parse_plan_limit_body(
                r#"{"code":"MEETING_PLAN_REQUIRED","upgradeUrl":"https://hq.computer/billing"}"#
            ),
            None
        );
        assert_eq!(parse_plan_limit_body("<html>"), None);
    }

    #[test]
    fn allows_exactly_the_host_hq_pro_returns() {
        assert_eq!(PLAN_UPGRADE_HOSTS, &["hq.computer"]);
        for ok in [
            "https://hq.computer/billing",
            "https://hq.computer/companies/acme/billing?upgrade=1",
            "https://hq.computer/signin?callbackUrl=%2Fapi%2Fcompanies%2Fcmp_1%2Fbilling%2Fupgrade",
        ] {
            assert!(approved_plan_upgrade_url(ok).is_some(), "{ok}");
        }
        for bad in [
            "https://app.indigo-hq.com/billing/upgrade",
            "https://hqforwork.com/pricing",
            "https://hq.computer.example.com/billing",
            "https://evil.hq.computer/billing",
            "http://hq.computer/billing",
            "https://user:pw@hq.computer/billing",
            "https://hq.computer:8443/billing",
            "file:///etc/passwd",
            "",
        ] {
            assert_eq!(approved_plan_upgrade_url(bad), None, "{bad}");
        }
    }

    #[test]
    fn drops_an_unapproved_link_but_keeps_the_sentence() {
        let body =
            hard_stop_body().replace(UPGRADE_URL, "https://app.indigo-hq.com/billing/upgrade");
        let refusal = parse_plan_limit_body(&body).unwrap();
        assert!(refusal.message.starts_with("New files are paused"));
        assert_eq!(refusal.upgrade_url, None);
    }

    #[test]
    fn readable_error_body_never_returns_json() {
        assert_eq!(
            readable_error_body(&hard_stop_body()).unwrap(),
            "New files are paused while Acme is over its Starter limits. Storage: 10.2 GB of 10 GB used."
        );
        assert_eq!(
            readable_error_body(r#"{"error":"Invite expired"}"#).as_deref(),
            Some("Invite expired")
        );
        assert_eq!(
            readable_error_body(r#"{"message":"Try later","error":"x"}"#).as_deref(),
            Some("Try later")
        );
        assert_eq!(readable_error_body(r#"{"ok":false}"#), None);
        assert_eq!(readable_error_body("  "), None);
        assert_eq!(
            readable_error_body("Bad gateway").as_deref(),
            Some("Bad gateway")
        );
        assert_eq!(readable_error_body(&"x".repeat(500)).unwrap().len(), 200);
    }

    #[test]
    fn recognises_runner_plan_limit_messages() {
        assert!(is_plan_limit_refusal_message(
            "VaultClientError code=PLAN_LIMIT_EXCEEDED http=402 New files are paused while Acme is over its Starter limits."
        ));
        assert!(is_plan_limit_refusal_message(
            "VaultClientError http=402 New files are paused while Acme is over its Starter limits."
        ));
        assert!(is_plan_limit_refusal_message(
            "presign refused: plan_limit_reached"
        ));
        assert!(is_plan_limit_refusal_message(
            "code=PLAN_LIMIT_REACHED path=a.md"
        ));
        assert!(!is_plan_limit_refusal_message(
            "VaultClientError http=4020 odd"
        ));
        assert!(!is_plan_limit_refusal_message(
            "VaultClientError http=403 Forbidden"
        ));
        assert!(!is_plan_limit_refusal_message(
            "ENOSPC: no space left on device"
        ));
    }

    const BILLING_URL: &str = "https://hq.computer/companies/acme/billing";
    const USAGE_MESSAGE: &str = "Cloud sync is paused. Acme used its $10.00 monthly allowance. Add a card on the Billing page to resume. Files on this computer are not affected.";

    fn usage_block(reason: &str) -> Value {
        serde_json::json!({
            "code": "usage_paused",
            "reason": reason,
            "message": USAGE_MESSAGE,
            "actionUrl": BILLING_URL,
        })
    }

    fn usage_pause_body() -> String {
        serde_json::json!({
            "error": "plan_limit_reached",
            "code": "PLAN_LIMIT_EXCEEDED",
            "message": "New files are paused while Acme is over its Starter limits.",
            "upgradeUrl": UPGRADE_URL,
            "usagePause": usage_block("usage_card_required"),
        })
        .to_string()
    }

    #[test]
    fn parses_every_known_usage_pause_reason() {
        for reason in USAGE_PAUSE_REASONS {
            assert_eq!(
                parse_usage_pause(&usage_block(reason)),
                Some(UsagePause {
                    code: USAGE_PAUSE_CODE.into(),
                    reason: (*reason).into(),
                    message: USAGE_MESSAGE.into(),
                    action_url: BILLING_URL.into(),
                }),
                "{reason}"
            );
        }
    }

    #[test]
    fn rejects_an_invalid_usage_pause_block() {
        let mut bad = Vec::new();
        for (key, value) in [
            ("code", Value::from("usage_limit")),
            ("code", Value::Null),
            ("reason", Value::from("usage_other")),
            ("reason", Value::from(7)),
            ("message", Value::from("   ")),
            (
                "actionUrl",
                Value::from("https://app.indigo-hq.com/billing"),
            ),
            ("actionUrl", Value::from("http://hq.computer/billing")),
            ("actionUrl", Value::from("")),
        ] {
            let mut block = usage_block("usage_trial_cap");
            block[key] = value;
            bad.push(block);
        }
        let mut missing = usage_block("usage_trial_cap");
        missing.as_object_mut().unwrap().remove("actionUrl");
        bad.push(missing);
        bad.push(Value::from("usage_paused"));
        bad.push(Value::Null);
        for block in bad {
            assert_eq!(parse_usage_pause(&block), None, "{block}");
        }
    }

    #[test]
    fn usage_pause_serializes_with_camel_case_names() {
        let pause = parse_usage_pause(&usage_block("usage_spend_limit")).unwrap();
        let wire = serde_json::to_value(&pause).unwrap();
        assert_eq!(wire, usage_block("usage_spend_limit"));
        let back: UsagePause = serde_json::from_value(wire).unwrap();
        assert_eq!(back, pause);
    }

    #[test]
    fn a_valid_usage_pause_wins_over_the_legacy_fields() {
        let refusal = parse_plan_limit_body(&usage_pause_body()).unwrap();
        assert_eq!(refusal.message, USAGE_MESSAGE);
        assert_eq!(refusal.upgrade_url.as_deref(), Some(BILLING_URL));
        assert_eq!(
            refusal.usage_pause.as_ref().map(|p| p.reason.as_str()),
            Some("usage_card_required")
        );
        assert_eq!(
            readable_error_body(&usage_pause_body()).as_deref(),
            Some(USAGE_MESSAGE)
        );
    }

    #[test]
    fn a_usage_pause_counts_without_the_legacy_markers() {
        let body = serde_json::json!({ "usagePause": usage_block("usage_trial_cap") }).to_string();
        let refusal = parse_plan_limit_body(&body).unwrap();
        assert_eq!(refusal.message, USAGE_MESSAGE);
        assert!(refusal.usage_pause.is_some());
    }

    #[test]
    fn an_invalid_usage_pause_keeps_the_legacy_behaviour() {
        let mut value: Value = serde_json::from_str(&usage_pause_body()).unwrap();
        value["usagePause"]["reason"] = Value::from("usage_unknown");
        let refusal = parse_plan_limit_body(&value.to_string()).unwrap();
        assert_eq!(
            refusal.message,
            "New files are paused while Acme is over its Starter limits."
        );
        assert_eq!(refusal.upgrade_url.as_deref(), Some(UPGRADE_URL));
        assert_eq!(refusal.usage_pause, None);
        // Without legacy markers an invalid block is not a refusal at all.
        let body = serde_json::json!({ "usagePause": { "code": "usage_paused" } }).to_string();
        assert_eq!(parse_plan_limit_body(&body), None);
    }

    #[test]
    fn usage_pause_runner_message_shows_the_server_sentence_or_a_fallback() {
        let with_body = format!(
            "VaultClientError code=PLAN_LIMIT_EXCEEDED http=402 {}",
            usage_pause_body()
        );
        assert_eq!(
            usage_pause_runner_message(&with_body).as_deref(),
            Some(USAGE_MESSAGE)
        );
        let bare_block = format!("presign refused {}", usage_block("usage_trial_cap"));
        assert_eq!(
            usage_pause_runner_message(&bare_block).as_deref(),
            Some(USAGE_MESSAGE)
        );
        for text in [
            "VaultClientError code=PLAN_LIMIT_EXCEEDED http=402 reason=usage_spend_limit",
            "VaultClientError http=402 usage_paused",
            "usage_card_required",
        ] {
            assert_eq!(
                usage_pause_runner_message(text).as_deref(),
                Some(USAGE_PAUSE_FALLBACK_MESSAGE),
                "{text}"
            );
            assert!(is_plan_limit_refusal_message(text), "{text}");
        }
        for text in [
            "VaultClientError code=PLAN_LIMIT_EXCEEDED http=402 New files are paused while Acme is over its Starter limits.",
            "VaultClientError http=403 Forbidden",
            "bad json {",
        ] {
            assert_eq!(usage_pause_runner_message(text), None, "{text}");
        }
    }

    #[test]
    fn formats_small_and_round_storage() {
        assert_eq!(
            describe_plan_limit_resource(
                "storageBytes",
                Some(10_737_418_240.0),
                Some(10_737_418_240.0)
            ),
            "Storage: 10 GB of 10 GB used."
        );
        assert_eq!(
            describe_plan_limit_resource(
                "storageBytes",
                Some(5.0 * 1024.0 * 1024.0),
                Some(10_737_418_240.0)
            ),
            "Storage: 5 MB of 10 GB used."
        );
        assert_eq!(
            describe_plan_limit_resource("secrets", None, Some(10.0)),
            "Secrets: limit reached."
        );
    }
}

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
//! A refusal is an expected product state. Nothing here reports to Sentry, and
//! [`is_plan_limit_refusal_message`] lets the runner-exit classifier keep a
//! plan-limit refusal out of the alertable set.

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
    /// Present only when the body carried an approved upgrade link.
    pub upgrade_url: Option<String>,
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

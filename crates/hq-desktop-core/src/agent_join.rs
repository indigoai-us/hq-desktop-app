//! Agent membership announcements ("🤖 Izzy (an agent) just joined Indigo.").
//!
//! Creating an agent DMs every member of the company. Each of those DMs used
//! to fire its own macOS banner, so a fleet run that stood up thirty agents
//! rang thirty times on every teammate's Mac for something none of them asked
//! for. This module is the pure predicate that keeps those announcements out
//! of the banner path. They are still ACKed, still counted, and still emitted
//! to the in-app feed (which bundles them) — only the OS banner is skipped.
//!
//! Mirrors `packages/ui/src/inbox/automated-notices.ts`: the copy alone is not
//! authoritative, because a human can quote the same words. A trusted agent
//! identity (an `agt_*` / `agent_*` uid, or an `@agents.getindigo.ai` sender)
//! decides it; an explicit human uid always wins and always banners.

/// True when this DM is the server-authored agent membership announcement.
///
/// `details` / `prompt` being present means a rich DM, which a join notice
/// never is.
pub fn is_agent_join_notice(
    from_person_uid: &str,
    from_email: &str,
    from_display_name: &str,
    body: &str,
    details: Option<&str>,
    prompt: Option<&str>,
) -> bool {
    let sender = from_person_uid.trim().to_lowercase();
    let agent_uid = sender.starts_with("agt_") || sender.starts_with("agent_");
    if !sender.is_empty() && !agent_uid {
        return false;
    }
    if details.map(|d| !d.trim().is_empty()).unwrap_or(false) {
        return false;
    }
    if prompt.map(|p| !p.trim().is_empty()).unwrap_or(false) {
        return false;
    }

    let normalized = normalize(body);
    let Some(announced) = announced_agent_name(&normalized) else {
        return false;
    };

    if agent_uid {
        return true;
    }
    let trusted_email = from_email
        .trim()
        .to_lowercase()
        .ends_with("@agents.getindigo.ai");
    if trusted_email {
        return true;
    }
    normalize(from_display_name).to_lowercase() == announced.to_lowercase()
}

/// Collapse runs of whitespace and trim — the TS predicate normalizes the same
/// way before matching, so a re-wrapped body still matches.
fn normalize(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Match `🤖 {name} (an agent|a bot) just joined {company}.` and return
/// `{name}`. Hand-rolled rather than pulling in a regex dependency.
fn announced_agent_name(normalized: &str) -> Option<String> {
    let rest = normalized.strip_prefix("🤖 ")?;
    // The name runs up to the FIRST kind marker; a name may itself contain
    // parentheses, so search for the marker rather than the first '('.
    let lower = rest.to_lowercase();
    let (marker_at, marker_len) = ["(an agent)", "(a bot)"]
        .iter()
        .filter_map(|marker| lower.find(marker).map(|at| (at, marker.len())))
        .min_by_key(|(at, _)| *at)?;
    let name = rest[..marker_at].trim();
    if name.is_empty() {
        return None;
    }
    let tail = rest[marker_at + marker_len..].trim();
    let company = tail.strip_prefix("just joined")?.trim();
    // A company name must be present and the sentence must end in a period.
    if company.len() < 2 || !company.ends_with('.') {
        return None;
    }
    Some(name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENT_UID: &str = "agt_123";

    #[test]
    fn agent_uid_join_notice_is_suppressed() {
        assert!(is_agent_join_notice(
            AGENT_UID,
            "izzy@agents.getindigo.ai",
            "Izzy",
            "🤖 Izzy (an agent) just joined Indigo.",
            None,
            None,
        ));
    }

    #[test]
    fn bot_wording_and_ragged_whitespace_still_match() {
        assert!(is_agent_join_notice(
            AGENT_UID,
            "",
            "Izzy",
            "  🤖  Izzy   (a bot)  just joined   Indigo. ",
            None,
            None,
        ));
    }

    #[test]
    fn a_human_quoting_the_copy_still_banners() {
        assert!(!is_agent_join_notice(
            "usr_9",
            "cherie@indigo.com",
            "Cherie",
            "🤖 Izzy (an agent) just joined Indigo.",
            None,
            None,
        ));
    }

    #[test]
    fn an_ordinary_agent_message_still_banners() {
        assert!(!is_agent_join_notice(
            AGENT_UID,
            "izzy@agents.getindigo.ai",
            "Izzy",
            "Story US-004 is ready for review.",
            None,
            None,
        ));
    }

    #[test]
    fn a_rich_dm_is_never_a_join_notice() {
        assert!(!is_agent_join_notice(
            AGENT_UID,
            "izzy@agents.getindigo.ai",
            "Izzy",
            "🤖 Izzy (an agent) just joined Indigo.",
            Some("here is the detail"),
            None,
        ));
        assert!(!is_agent_join_notice(
            AGENT_UID,
            "izzy@agents.getindigo.ai",
            "Izzy",
            "🤖 Izzy (an agent) just joined Indigo.",
            None,
            Some("run this"),
        ));
    }

    #[test]
    fn legacy_rows_without_a_uid_need_a_trusted_sender_or_matching_name() {
        assert!(is_agent_join_notice(
            "",
            "izzy@agents.getindigo.ai",
            "Someone Else",
            "🤖 Izzy (an agent) just joined Indigo.",
            None,
            None,
        ));
        assert!(is_agent_join_notice(
            "",
            "",
            "Izzy",
            "🤖 Izzy (an agent) just joined Indigo.",
            None,
            None,
        ));
        assert!(!is_agent_join_notice(
            "",
            "",
            "Someone Else",
            "🤖 Izzy (an agent) just joined Indigo.",
            None,
            None,
        ));
    }

    #[test]
    fn a_truncated_announcement_is_not_a_join_notice() {
        assert!(!is_agent_join_notice(
            AGENT_UID,
            "",
            "Izzy",
            "🤖 Izzy (an agent) just joined",
            None,
            None,
        ));
    }
}

//! Pure parser for the policy mentions HQ's hooks inject into a session.
//!
//! When a Claude session starts in the HQ root, `inject-policy-on-trigger.sh`
//! prints a `<policy-reminder>` block whose lines look like
//!
//! ```text
//! > Policy `slug` (HARD — binding rule from `core/policies/slug.md`):
//! > (quoted full text of the rule…)
//! > Policy `other-slug` applies here: one-line rule summary
//! ```
//!
//! and `hq-session.sh` prints a `<company-policy-digest co="indigo">` block
//! on company bind whose entries look like
//!
//! ```text
//! - [hard] **slug**: rule summary. Full text: `companies/co/policies/slug.md`.
//! ```
//!
//! This module reduces that text to `{slug, hard, excerpt}` entries plus the
//! bound company. It is deliberately regex-free and line-oriented so the
//! TypeScript mirror (`apps/sync/src/components/sessions/policy-digest.ts`)
//! can be a line-for-line port; both parse the SAME fixture file
//! (`apps/sync/src/components/sessions/__fixtures__/hook-policy-reminder.txt`)
//! in their tests, which is what keeps them from drifting.
//!
//! No I/O, no state: text in, digest out. A future `hq_session_policies`
//! command can fold every [`SessionEvent::HookNotice`] of a session through
//! [`merge_policy_digest`] and hand the UI the same shape it computes today.
//!
//! [`SessionEvent::HookNotice`]: super::types::SessionEvent::HookNotice

use serde::{Deserialize, Serialize};

/// One policy a hook said applies to the session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PolicyEntry {
    pub slug: String,
    /// The line named it HARD (binding) rather than advisory.
    pub hard: bool,
    /// One line of the rule, capped at [`EXCERPT_CAP`] characters.
    pub excerpt: String,
}

/// Every policy mentioned so far, deduped by slug, plus the bound company.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDigest {
    /// The `co` of the LAST `<company-policy-digest>` seen — a later bind
    /// supersedes an earlier one.
    pub company: Option<String>,
    pub entries: Vec<PolicyEntry>,
}

/// Longest excerpt kept, in characters.
pub const EXCERPT_CAP: usize = 160;

const POLICY_LINE_PREFIX: &str = "Policy `";
const DIGEST_OPEN: &str = "<company-policy-digest co=\"";
const DIGEST_CLOSE: &str = "</company-policy-digest>";
const DIGEST_HARD_PREFIX: &str = "- [hard] **";

/// A block-quoted line with its `>` marker and one following space removed;
/// `None` when the line is not quoted at all.
fn unquote(line: &str) -> Option<&str> {
    let rest = line.trim_start().strip_prefix('>')?;
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}

/// Cap an excerpt at [`EXCERPT_CAP`] characters (never mid-codepoint).
fn cap_excerpt(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= EXCERPT_CAP {
        return text.to_owned();
    }
    let head: String = text.chars().take(EXCERPT_CAP - 1).collect();
    format!("{}…", head.trim_end())
}

/// Markdown emphasis and a trailing colon are decoration, not the rule.
fn clean_excerpt(text: &str) -> String {
    let stripped = text.replace("**", "");
    let stripped = stripped.trim();
    let stripped = stripped.strip_suffix(':').unwrap_or(stripped);
    cap_excerpt(stripped)
}

/// The excerpt for a `> Policy \`slug\` …` line.
///
/// The one-line form carries its rule after `applies here:`. The full-text
/// form ends in a colon and quotes the rule's body on the lines that follow,
/// so its excerpt is the first prose line of that body — headings and blank
/// quote lines are skipped, and the next `Policy` line ends the search. With
/// no body at all, the parenthetical itself is kept so the entry is never
/// blank.
fn excerpt_for(rest: &str, following: &[&str]) -> String {
    if let Some((_, rule)) = rest.split_once("applies here:") {
        return clean_excerpt(rule);
    }
    for line in following {
        let Some(body) = unquote(line) else { break };
        let body = body.trim();
        if body.starts_with(POLICY_LINE_PREFIX) {
            break;
        }
        if body.is_empty() || body.starts_with('#') {
            continue;
        }
        return clean_excerpt(body);
    }
    let bare = rest.trim();
    let bare = bare.strip_suffix(':').unwrap_or(bare).trim();
    let bare = bare
        .strip_prefix('(')
        .and_then(|s| s.strip_suffix(')'))
        .unwrap_or(bare);
    clean_excerpt(bare)
}

/// Parse one hook's text into the policies it mentions.
///
/// Entries are deduped by slug within the text (first mention keeps its
/// excerpt; `hard` is true if ANY mention said so).
pub fn parse_policy_digest(text: &str) -> PolicyDigest {
    let lines: Vec<&str> = text.lines().collect();
    let mut digest = PolicyDigest::default();
    let mut in_company_block = false;

    for (index, raw) in lines.iter().enumerate() {
        let line = raw.trim();

        if let Some(after) = line.find(DIGEST_OPEN).map(|at| &line[at + DIGEST_OPEN.len()..]) {
            if let Some(end) = after.find('"') {
                let co = after[..end].trim();
                if !co.is_empty() {
                    digest.company = Some(co.to_owned());
                }
            }
            in_company_block = true;
            continue;
        }
        if line.starts_with(DIGEST_CLOSE) {
            in_company_block = false;
            continue;
        }

        if in_company_block {
            if let Some(after) = line.strip_prefix(DIGEST_HARD_PREFIX) {
                if let Some((slug, rest)) = after.split_once("**") {
                    let rest = rest.trim_start_matches(':').trim();
                    let rule = rest.split(" Full text:").next().unwrap_or(rest);
                    push_entry(&mut digest, slug.trim(), true, clean_excerpt(rule));
                }
            }
            continue;
        }

        let Some(body) = unquote(raw) else { continue };
        let Some(after) = body.trim_start().strip_prefix(POLICY_LINE_PREFIX) else {
            continue;
        };
        let Some((slug, rest)) = after.split_once('`') else {
            continue;
        };
        let slug = slug.trim();
        if slug.is_empty() {
            continue;
        }
        let hard = rest.contains("HARD");
        let excerpt = excerpt_for(rest, &lines[index + 1..]);
        push_entry(&mut digest, slug, hard, excerpt);
    }

    digest
}

fn push_entry(digest: &mut PolicyDigest, slug: &str, hard: bool, excerpt: String) {
    if let Some(existing) = digest.entries.iter_mut().find(|e| e.slug == slug) {
        existing.hard = existing.hard || hard;
        if existing.excerpt.is_empty() {
            existing.excerpt = excerpt;
        }
        return;
    }
    digest.entries.push(PolicyEntry {
        slug: slug.to_owned(),
        hard,
        excerpt,
    });
}

/// Fold a later hook's digest into an accumulated one: entries dedupe by
/// slug (first excerpt wins, `hard` is sticky), and a later company bind
/// replaces the earlier one.
pub fn merge_policy_digest(into: &mut PolicyDigest, from: PolicyDigest) {
    if from.company.is_some() {
        into.company = from.company;
    }
    for entry in from.entries {
        push_entry(into, &entry.slug, entry.hard, entry.excerpt);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The SAME text the TypeScript mirror parses in `policy-digest.test.ts`.
    /// One file, two parsers: any drift between them fails here or there.
    const FIXTURE: &str = include_str!(
        "../../../../apps/sync/src/components/sessions/__fixtures__/hook-policy-reminder.txt"
    );

    fn slugs(digest: &PolicyDigest) -> Vec<&str> {
        digest.entries.iter().map(|e| e.slug.as_str()).collect()
    }

    fn entry<'a>(digest: &'a PolicyDigest, slug: &str) -> &'a PolicyEntry {
        digest
            .entries
            .iter()
            .find(|e| e.slug == slug)
            .unwrap_or_else(|| panic!("no entry for {slug}"))
    }

    #[test]
    fn the_shared_fixture_parses_to_the_pinned_shape() {
        let digest = parse_policy_digest(FIXTURE);
        assert_eq!(digest.company.as_deref(), Some("indigo"));
        // Six distinct slugs: two repeats (one inside the reminder, one from
        // the company digest) collapse onto their first mention.
        assert_eq!(
            slugs(&digest),
            vec![
                "hq-git-discipline",
                "hq-share-session-urls-are-capabilities",
                "quiet-by-default-narration",
                "image-context-isolation",
                "credential-access-protocol",
                "indigo-no-client-data-in-commits",
            ]
        );
        assert_eq!(digest.entries.iter().filter(|e| e.hard).count(), 4);
    }

    #[test]
    fn a_full_text_hard_policy_takes_its_first_prose_line_as_the_excerpt() {
        let digest = parse_policy_digest(FIXTURE);
        let git = entry(&digest, "hq-git-discipline");
        assert!(git.hard);
        // The `# HQ git discipline` heading and the blank quote line are
        // skipped; the rule's first sentence is the excerpt.
        assert_eq!(
            git.excerpt,
            "Every git or gh mutation carries its own explicit repo anchor in the same command."
        );
        let share = entry(&digest, "hq-share-session-urls-are-capabilities");
        assert!(share.hard);
        assert_eq!(
            share.excerpt,
            "Never paste a share-session URL into a later turn, summary, journal, commit, or handoff."
        );
    }

    #[test]
    fn a_one_line_policy_takes_the_text_after_applies_here() {
        let digest = parse_policy_digest(FIXTURE);
        let quiet = entry(&digest, "quiet-by-default-narration");
        assert!(!quiet.hard);
        assert_eq!(
            quiet.excerpt,
            "Default to quiet, plain-language status; surface only completion, blockers, decisions, irreversible actions, and security signals."
        );
        // "HARD" anywhere on the line marks it binding, even in the summary form.
        assert!(entry(&digest, "credential-access-protocol").hard);
    }

    #[test]
    fn the_company_digest_contributes_hard_entries_and_the_company() {
        let digest = parse_policy_digest(FIXTURE);
        let client = entry(&digest, "indigo-no-client-data-in-commits");
        assert!(client.hard);
        assert_eq!(
            client.excerpt,
            "Never commit client data, exports, or credentials to any repo."
        );
        // The digest's repeat of `hq-git-discipline` did not add a second entry.
        assert_eq!(
            slugs(&digest)
                .iter()
                .filter(|s| **s == "hq-git-discipline")
                .count(),
            1
        );
    }

    #[test]
    fn text_without_policies_is_an_empty_digest() {
        assert_eq!(parse_policy_digest(""), PolicyDigest::default());
        assert_eq!(
            parse_policy_digest("<journal-index>\n## Today's session journal\n</journal-index>\n"),
            PolicyDigest::default()
        );
        // A quote line that merely mentions the word is not an entry.
        assert!(parse_policy_digest("> Read the full rule(s) at `core/policies/{slug}.md`.")
            .entries
            .is_empty());
    }

    #[test]
    fn a_full_text_policy_with_no_body_keeps_its_parenthetical() {
        let digest =
            parse_policy_digest("> Policy `lonely` (HARD — binding rule from `x.md`):\n");
        assert_eq!(digest.entries.len(), 1);
        assert!(digest.entries[0].hard);
        assert_eq!(
            digest.entries[0].excerpt,
            "HARD — binding rule from `x.md`"
        );
    }

    #[test]
    fn excerpts_are_capped_on_a_char_boundary() {
        let long = format!("> Policy `big` applies here: {}", "é".repeat(400));
        let digest = parse_policy_digest(&long);
        let excerpt = &digest.entries[0].excerpt;
        assert_eq!(excerpt.chars().count(), EXCERPT_CAP);
        assert!(excerpt.ends_with('…'));
    }

    #[test]
    fn merging_dedupes_by_slug_and_keeps_hard_sticky() {
        let mut acc = parse_policy_digest("> Policy `a` applies here: first\n> Policy `b` applies here: b\n");
        merge_policy_digest(
            &mut acc,
            parse_policy_digest(
                "> Policy `a` (HARD — binding rule from `a.md`):\n> a is now binding\n> Policy `c` applies here: c\n<company-policy-digest co=\"indigo\">\n</company-policy-digest>\n",
            ),
        );
        assert_eq!(slugs(&acc), vec!["a", "b", "c"]);
        let a = entry(&acc, "a");
        assert!(a.hard, "a later HARD mention upgrades the entry");
        assert_eq!(a.excerpt, "first", "the first excerpt is kept");
        assert_eq!(acc.company.as_deref(), Some("indigo"));

        // A merge with no company leaves the bound one alone.
        merge_policy_digest(&mut acc, parse_policy_digest("> Policy `d` applies here: d"));
        assert_eq!(acc.company.as_deref(), Some("indigo"));
        assert_eq!(slugs(&acc), vec!["a", "b", "c", "d"]);
    }

    #[test]
    fn the_wire_shape_is_camel_case() {
        let digest = parse_policy_digest(FIXTURE);
        let raw = serde_json::to_value(&digest).expect("serialize");
        assert_eq!(raw["company"], "indigo");
        assert_eq!(raw["entries"][0]["slug"], "hq-git-discipline");
        assert_eq!(raw["entries"][0]["hard"], true);
        assert!(raw["entries"][0].get("excerpt").is_some());
        let back: PolicyDigest = serde_json::from_value(raw).expect("parse");
        assert_eq!(back, digest);
    }
}

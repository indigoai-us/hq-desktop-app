//! Local reader/writer helpers for the **Agency** surface in Mission Control.
//!
//! These pure helpers scan and append to the local agency chat files under the
//! resolved HQ folder (`workspace/agency/<company>/<team>/...`). They contain no
//! Tauri coupling; app crates provide the async command/auth boundary.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::{read_hq_config_lenient, MenubarPrefs};
use crate::paths;

// ---- wire types (camelCase) ------------------------------------------------

/// One worker (a `(worker, instance)`) in a team.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgencyWorker {
    pub worker: String,
    pub instance: String,
    /// From the team's `status.json` (`running` | `stopped` | …); `unknown` when absent.
    pub status: String,
    /// True once the worker has posted its `type:"ready"` handshake to its inbox.
    pub ready: bool,
    /// ISO `started_at` from `status.json` — when the worker was last spawned;
    /// empty when absent. Drives the "up 12m" uptime label.
    pub started_at: String,
    /// ISO `updated_at` from `status.json` — last status write for this worker;
    /// empty when absent. Drives the "seen 30s ago" freshness label.
    pub updated_at: String,
}

/// One running agency team.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgencyTeam {
    pub company: String,
    pub team: String,
    pub workers: Vec<AgencyWorker>,
}

/// A pending question the team-manager routed to the liaison and that has not
/// yet been answered into the manager inbox.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgencyQuestion {
    pub company: String,
    pub team: String,
    /// Stable dedup id — the POSIX cksum of the question text (matches the liaison).
    pub id: String,
    pub question: String,
    pub ts: String,
    /// Bounded answer choices the manager attached to the ASK (`"options"` on the
    /// chat line); empty for a free-text question. Rendered as one-tap answer chips.
    pub options: Vec<String>,
}

/// One line of the Manager ⇄ Liaison conversation, normalised for display so the
/// operator can read the full context behind a pending question.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgencyMessage {
    /// Sender — `manager` | `liaison` | `operator` | a worker name.
    pub from: String,
    /// Classified kind — `ask` | `fyi` | `answer` | `learn` | `ready` | `reply` | `close` | `msg`.
    pub kind: String,
    /// Display text with the known prefix and any trailing `[ans:<id>]` tag stripped.
    pub text: String,
    pub ts: String,
    /// Which inbox the line lives in — `team-manager` | `team-liaison`.
    pub inbox: String,
}

// ---- POSIX cksum (the [ans:<id>] dedup key the liaison uses) ----------------

pub fn crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut c = (i as u32) << 24;
        let mut k = 0;
        while k < 8 {
            c = if c & 0x8000_0000 != 0 {
                (c << 1) ^ 0x04C1_1DB7
            } else {
                c << 1
            };
            k += 1;
        }
        t[i] = c;
        i += 1;
    }
    t
}

/// POSIX `cksum` CRC-32 of `bytes` — byte-for-byte identical to `cksum(1)`.
pub fn cksum(bytes: &[u8]) -> u32 {
    let t = crc_table();
    let mut crc: u32 = 0;
    for &b in bytes {
        crc = (crc << 8) ^ t[(((crc >> 24) as u8) ^ b) as usize];
    }
    let mut len = bytes.len();
    while len != 0 {
        let b = (len & 0xFF) as u8;
        crc = (crc << 8) ^ t[(((crc >> 24) as u8) ^ b) as usize];
        len >>= 8;
    }
    !crc
}

// ---- helpers ---------------------------------------------------------------

/// Bounded answer choices the manager attached to an ASK line (`"options"` — an
/// array of strings). Empty when the field is absent, not an array, or carries
/// no non-blank string entries — i.e. a free-text question. Mirrors how the
/// producer (`agency.sh ask --option …`) writes them, and is forward-compatible:
/// older ASK lines with no `options` key simply yield `[]`.
pub fn parse_options(line: &serde_json::Value) -> Vec<String> {
    line.get("options")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Normalise one chat.jsonl line from `inbox_owner`'s inbox into a display
/// message: resolve the sender, classify the kind, and strip the `ASK:`/`FYI:`/
/// `ANSWER:`/`LEARN:` prefix + the trailing `[ans:<id>]` dedup tag so the chat
/// reads cleanly. Pure + lenient — unit-tested.
pub fn classify_message(inbox_owner: &str, line: &serde_json::Value) -> AgencyMessage {
    let role = line.get("role").and_then(|v| v.as_str()).unwrap_or("");
    let typ = line.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let from_field = line.get("from").and_then(|v| v.as_str()).unwrap_or("");
    let raw = line
        .get("text")
        .and_then(|v| v.as_str())
        .or_else(|| line.get("reason").and_then(|v| v.as_str()))
        .unwrap_or("");

    let owner_short = match inbox_owner {
        "team-manager" => "manager",
        "team-liaison" => "liaison",
        other => other,
    };
    // Assistant lines are authored by the inbox owner; `user` lines carry a
    // `from` tag (an empty `from` on a user line is an operator-posted message).
    let from = match role {
        "assistant" => owner_short.to_string(),
        "manager" => "manager".to_string(),
        "user" if from_field.is_empty() => "operator".to_string(),
        _ => from_field.to_string(),
    };

    let (kind, text) = if !typ.is_empty() {
        (typ.to_string(), raw.to_string())
    } else if let Some(r) = raw.strip_prefix("ASK: ") {
        ("ask".to_string(), r.to_string())
    } else if let Some(r) = raw.strip_prefix("FYI: ") {
        ("fyi".to_string(), r.to_string())
    } else if let Some(r) = raw.strip_prefix("ANSWER: ") {
        let clean = r.rfind(" [ans:").map(|i| &r[..i]).unwrap_or(r);
        ("answer".to_string(), clean.to_string())
    } else if let Some(r) = raw.strip_prefix("LEARN: ") {
        ("learn".to_string(), r.to_string())
    } else {
        ("msg".to_string(), raw.to_string())
    };

    AgencyMessage {
        from,
        kind,
        text,
        ts: line
            .get("ts")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        inbox: inbox_owner.to_string(),
    }
}

pub fn resolve_hq_folder() -> PathBuf {
    let menubar_prefs: Option<MenubarPrefs> = paths::menubar_json_path()
        .ok()
        .filter(|p| p.exists())
        .and_then(|p| std::fs::read_to_string(&p).ok())
        .and_then(|s| serde_json::from_str(&s).ok());
    let config = read_hq_config_lenient().ok().flatten();
    paths::resolve_hq_folder(
        config.as_ref().and_then(|c| c.hq_folder_path.as_deref()),
        menubar_prefs.as_ref().and_then(|p| p.hq_path.as_deref()),
    )
}

pub fn agency_root(hq: &Path) -> PathBuf {
    hq.join("workspace").join("agency")
}

/// Immediate subdirectory names of `dir`, sorted. Empty when `dir` is missing.
pub fn child_dirs(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| e.path().is_dir())
            .filter_map(|e| e.file_name().into_string().ok())
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    names
}

/// Parse a JSONL file into `serde_json::Value` rows; malformed lines skipped.
pub fn read_jsonl(path: &Path) -> Vec<serde_json::Value> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .collect()
}

/// `true` if the inbox carries a `type:"ready"` handshake line.
pub fn inbox_ready(inbox: &Path) -> bool {
    read_jsonl(inbox)
        .iter()
        .any(|o| o.get("type").and_then(|v| v.as_str()) == Some("ready"))
}

/// Read the team's `status.json` → the `workers` map (lenient; `{}` on any error).
pub fn read_status_map(path: &Path) -> serde_json::Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("workers").cloned())
        .unwrap_or_else(|| serde_json::json!({}))
}

pub fn now_iso() -> String {
    // Matches chat.sh's `date -u +%FT%TZ` (e.g. 2026-06-18T20:30:00Z).
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn is_within(root: &Path, candidate: &Path) -> bool {
    lexically_normalize(candidate).starts_with(lexically_normalize(root))
}

pub fn lexically_normalize(path: &Path) -> PathBuf {
    let mut stack: Vec<Component> = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match stack.last() {
                Some(Component::Normal(_)) => {
                    stack.pop();
                }
                _ => stack.push(component),
            },
            other => stack.push(other),
        }
    }
    let mut out = PathBuf::new();
    for c in stack {
        out.push(c.as_os_str());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pinned against real `cksum(1)` output (printf '%s' "<s>" | cksum). If the
    // CRC drifts from POSIX cksum the liaison and Mission Control would compute
    // different [ans:<id>]s and double-answer — so this is a hard contract.
    #[test]
    fn cksum_matches_posix() {
        assert_eq!(cksum(b"Ship it?"), 780_494_884);
        assert_eq!(cksum(b"test"), 3_076_352_578);
        assert_eq!(cksum(b"Approve deploy to prod?"), 1_221_633_456);
        assert_eq!(
            cksum(b"Deploy nick to prod & resolve #1234?"),
            2_811_623_944
        );
    }

    #[test]
    fn parse_options_reads_string_array() {
        // Trims, drops blanks + non-strings, preserves order.
        let line = serde_json::json!({
            "text": "ASK: Deploy?",
            "options": ["Ship it", "  Hold  ", "", "   ", 42, true]
        });
        assert_eq!(
            parse_options(&line),
            vec!["Ship it".to_string(), "Hold".to_string()]
        );
    }

    #[test]
    fn parse_options_absent_or_malformed_is_empty() {
        // No key, wrong type, and all-blank all collapse to a free-text question.
        assert!(parse_options(&serde_json::json!({"text": "ASK: x"})).is_empty());
        assert!(parse_options(&serde_json::json!({"options": "yes/no"})).is_empty());
        assert!(parse_options(&serde_json::json!({"options": ["", "  "]})).is_empty());
    }

    #[test]
    fn classify_message_resolves_sender_kind_and_clean_text() {
        // manager's ASK lives in the liaison inbox; prefix stripped, kind=ask.
        let ask = classify_message(
            "team-liaison",
            &serde_json::json!({"role":"user","from":"manager","text":"ASK: Deploy?","ts":"t1"}),
        );
        assert_eq!(
            (ask.from.as_str(), ask.kind.as_str(), ask.text.as_str()),
            ("manager", "ask", "Deploy?")
        );

        // liaison's ANSWER lives in the manager inbox; prefix + [ans:] tag stripped.
        let ans = classify_message(
            "team-manager",
            &serde_json::json!({"role":"user","from":"liaison","text":"ANSWER: Ship it [ans:123]","ts":"t2"}),
        );
        assert_eq!(
            (ans.from.as_str(), ans.kind.as_str(), ans.text.as_str()),
            ("liaison", "answer", "Ship it")
        );

        // user line with no `from` is an operator-posted message.
        let op = classify_message(
            "team-manager",
            &serde_json::json!({"role":"user","text":"hold off until QA signs off","ts":"t3"}),
        );
        assert_eq!((op.from.as_str(), op.kind.as_str()), ("operator", "msg"));

        // assistant `ready` line is authored by the inbox owner.
        let rdy = classify_message(
            "team-manager",
            &serde_json::json!({"role":"assistant","type":"ready","text":"online","ts":"t0"}),
        );
        assert_eq!((rdy.from.as_str(), rdy.kind.as_str()), ("manager", "ready"));
    }
}

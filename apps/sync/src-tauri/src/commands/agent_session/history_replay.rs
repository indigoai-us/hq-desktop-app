//! Bounded transcript hydration for a resumed in-app session.
//!
//! Resuming either provider restores the model's context, but does not replay
//! old messages over the live protocol. This reader converts only durable user
//! and assistant prose into the shared event contract. Tool payloads, hidden
//! Claude metadata, reasoning, and provider bookkeeping stay out of the UI.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use hq_desktop_core::agent_session::{SessionEvent, SessionTool};
use serde::Serialize;
use serde_json::Value;

const HISTORY_READ_CHUNK_BYTES: u64 = 1024 * 1024;
pub(super) const HISTORY_PAGE_EVENTS: usize = 256;
const MAX_MESSAGE_CHARS: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoricalEvent {
    pub received_at_ms: u64,
    pub event: SessionEvent,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub events: Vec<HistoricalEvent>,
    /// Exclusive byte offset for the next older page. `None` means the
    /// beginning of the durable provider transcript has been reached.
    pub before: Option<u64>,
}

pub(super) fn load_resume_history(tool: SessionTool, session_id: &str) -> HistoryPage {
    load_resume_history_before(tool, session_id, None)
}

pub(super) fn load_resume_history_before(
    tool: SessionTool,
    session_id: &str,
    before: Option<u64>,
) -> HistoryPage {
    if !valid_session_id(session_id) {
        return empty_page();
    }
    let path = match tool {
        SessionTool::Claude => find_claude_transcript(session_id),
        SessionTool::Codex => find_codex_rollout(session_id),
    };
    let Some(path) = path else {
        return empty_page();
    };
    load_history_page(&path, tool, before)
}

fn empty_page() -> HistoryPage {
    HistoryPage {
        events: Vec::new(),
        before: None,
    }
}

/// Read one page from the end backwards. The response is bounded by visible
/// messages, while scanning skips tool/protocol records without imposing a
/// fixed byte tail that silently chops long conversations.
fn load_history_page(path: &Path, tool: SessionTool, before: Option<u64>) -> HistoryPage {
    let Ok(mut file) = File::open(path) else {
        return empty_page();
    };
    let Ok(metadata) = file.metadata() else {
        return empty_page();
    };
    let end = before.unwrap_or(metadata.len()).min(metadata.len());
    if end == 0 {
        return empty_page();
    }
    let fallback_ms = file_mtime_ms(&path);
    let mut scan_start = end;
    let mut bytes = Vec::new();

    loop {
        let next_start = scan_start.saturating_sub(HISTORY_READ_CHUNK_BYTES);
        let len = (scan_start - next_start) as usize;
        let mut chunk = vec![0; len];
        if file.seek(SeekFrom::Start(next_start)).is_err() || file.read_exact(&mut chunk).is_err() {
            return empty_page();
        }
        chunk.extend_from_slice(&bytes);
        bytes = chunk;
        scan_start = next_start;

        let starts_mid_record = if scan_start == 0 {
            false
        } else {
            let mut previous = [0u8; 1];
            file.seek(SeekFrom::Start(scan_start - 1)).is_err()
                || file.read_exact(&mut previous).is_err()
                || previous[0] != b'\n'
        };
        let parsed = parse_history_bytes(tool, &bytes, scan_start, starts_mid_record, fallback_ms);
        if parsed.len() >= HISTORY_PAGE_EVENTS || scan_start == 0 {
            let first = parsed.len().saturating_sub(HISTORY_PAGE_EVENTS);
            let before = if first > 0 || scan_start > 0 {
                parsed.get(first).map(|(offset, _)| *offset)
            } else {
                None
            };
            return HistoryPage {
                events: parsed
                    .into_iter()
                    .skip(first)
                    .map(|(_, event)| event)
                    .collect(),
                before,
            };
        }
    }
}

fn parse_history_bytes(
    tool: SessionTool,
    bytes: &[u8],
    absolute_start: u64,
    starts_mid_record: bool,
    fallback_ms: u64,
) -> Vec<(u64, HistoricalEvent)> {
    let mut events = Vec::new();
    let mut relative = 0usize;
    for raw in bytes.split_inclusive(|byte| *byte == b'\n') {
        let line_start = absolute_start + relative as u64;
        relative += raw.len();
        // A non-zero chunk starts in the middle of a JSONL record. Ignore
        // that partial record; the preceding chunk will complete it.
        if starts_mid_record && line_start == absolute_start {
            continue;
        }
        let raw = raw.strip_suffix(b"\n").unwrap_or(raw);
        let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
        let Ok(line) = std::str::from_utf8(raw) else {
            continue;
        };
        let Some(event) = parse_history_line(tool, line.to_owned(), fallback_ms) else {
            continue;
        };
        // Codex has used two durable representations for visible dialogue.
        // Keep the fallback without painting duplicate adjacent bubbles.
        if events
            .last()
            .is_some_and(|(_, previous)| same_visible_event(previous, &event))
        {
            continue;
        }
        events.push((line_start, event));
    }
    events
}

fn valid_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn find_claude_transcript(session_id: &str) -> Option<PathBuf> {
    for projects_dir in hq_desktop_core::sessions::claude::claude_projects_dirs() {
        let Ok(projects) = std::fs::read_dir(projects_dir) else {
            continue;
        };
        for project in projects.flatten() {
            if !project
                .file_type()
                .map(|kind| kind.is_dir())
                .unwrap_or(false)
            {
                continue;
            }
            let candidate = project.path().join(format!("{session_id}.jsonl"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn find_codex_rollout(session_id: &str) -> Option<PathBuf> {
    let rollouts = hq_desktop_core::sessions::codex::enumerate_rollout_files(
        &hq_desktop_core::sessions::codex::codex_dir(),
    );
    if let Some(rollout) = rollouts.get(session_id) {
        return Some(rollout.path.clone());
    }
    // Forked rollout names can carry both the origin and current thread ids.
    // Match only a validated id within the filename, never a caller path.
    rollouts
        .values()
        .find(|rollout| {
            rollout
                .path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(session_id))
        })
        .map(|rollout| rollout.path.clone())
}

fn file_mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn parse_history_line(
    tool: SessionTool,
    line: String,
    fallback_ms: u64,
) -> Option<HistoricalEvent> {
    let value: Value = serde_json::from_str(&line).ok()?;
    let timestamp = value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_timestamp_ms)
        .unwrap_or(fallback_ms);
    let event = match tool {
        SessionTool::Claude => parse_claude_message(&value),
        SessionTool::Codex => parse_codex_message(&value),
    }?;
    Some(HistoricalEvent {
        received_at_ms: timestamp,
        event,
    })
}

fn parse_claude_message(value: &Value) -> Option<SessionEvent> {
    if value.get("isMeta").and_then(Value::as_bool) == Some(true)
        || value.get("isSidechain").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let kind = value.get("type").and_then(Value::as_str)?;
    let content = value.get("message")?.get("content")?;
    match kind {
        "user" => bounded_text(content, Some("text"))
            .and_then(normalize_claude_user_text)
            .map(|text| SessionEvent::UserMessage {
                text,
                image_count: 0,
            }),
        "assistant" => {
            bounded_text(content, Some("text")).map(|text| SessionEvent::AssistantMessage {
                text,
                parent_tool_use_id: None,
            })
        }
        _ => None,
    }
}

/// Claude Desktop stores slash-command invocations as a small XML-like
/// envelope and writes a few control messages through the user role. Neither
/// is operator-authored chat as-is, so normalize them once at the provider
/// boundary before any history page reaches the UI.
fn normalize_claude_user_text(text: String) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.starts_with("<system-reminder>")
        || trimmed.starts_with("[Request interrupted")
        || hq_desktop_core::sessions::codex::is_injected_user_context(trimmed)
    {
        return None;
    }

    if let Some(name) = tagged_value(trimmed, "command-name") {
        let command = if name.starts_with('/') {
            name.to_owned()
        } else {
            format!("/{name}")
        };
        let args = tagged_value(trimmed, "command-args");
        return Some(match args {
            Some(args) if !args.is_empty() => format!("{command} {args}"),
            _ => command,
        });
    }

    normalize_portable_skill_references(trimmed)
}

/// Codex persists a selected skill as a Markdown link to its local `SKILL.md`.
/// Native clients render that as a skill token, never as an absolute path. The
/// shared transcript represents the same intent as a portable slash command.
fn normalize_portable_skill_references(text: &str) -> Option<String> {
    let normalized = text
        .lines()
        .map(normalize_portable_skill_reference_line)
        .collect::<Vec<_>>()
        .join("\n");
    let normalized = normalized.trim();
    (!normalized.is_empty()).then(|| normalized.to_owned())
}

fn normalize_portable_skill_reference_line(line: &str) -> String {
    let leading_len = line.len() - line.trim_start().len();
    let leading = &line[..leading_len];
    let trimmed = &line[leading_len..];
    let Some(label_end) = trimmed.find("](") else {
        return line.to_owned();
    };
    let Some(name) = trimmed.get(2..label_end) else {
        return line.to_owned();
    };
    if !trimmed.starts_with("[$")
        || name.is_empty()
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':'))
    {
        return line.to_owned();
    }
    let path_start = label_end + 2;
    let Some(path_end_offset) = trimmed[path_start..].find(')') else {
        return line.to_owned();
    };
    let path_end = path_start + path_end_offset;
    let path = &trimmed[path_start..path_end];
    if !path.ends_with("/SKILL.md") {
        return line.to_owned();
    }
    format!("{leading}/{name}{}", &trimmed[path_end + 1..])
}

fn tagged_value<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let value = text.split_once(&open)?.1.split_once(&close)?.0.trim();
    (!value.is_empty()).then_some(value)
}

fn parse_codex_message(value: &Value) -> Option<SessionEvent> {
    let record_type = value.get("type").and_then(Value::as_str)?;
    let payload = value.get("payload")?;
    match record_type {
        "event_msg" => {
            let text = bounded_text(payload.get("message")?, None)?;
            match payload.get("type").and_then(Value::as_str)? {
                "user_message"
                    if !hq_desktop_core::sessions::codex::is_injected_user_context(&text) =>
                {
                    normalize_portable_skill_references(&text).map(|text| {
                        SessionEvent::UserMessage {
                            text,
                            image_count: 0,
                        }
                    })
                }
                "agent_message" => Some(SessionEvent::AssistantMessage {
                    text,
                    parent_tool_use_id: None,
                }),
                _ => None,
            }
        }
        "response_item" if payload.get("type").and_then(Value::as_str) == Some("message") => {
            let role = payload.get("role").and_then(Value::as_str)?;
            match role {
                "user" => bounded_codex_user_text(payload.get("content")?).map(|text| {
                    SessionEvent::UserMessage {
                        text,
                        image_count: 0,
                    }
                }),
                "assistant" => bounded_text(payload.get("content")?, None).map(|text| {
                    SessionEvent::AssistantMessage {
                        text,
                        parent_tool_use_id: None,
                    }
                }),
                // Developer/system messages are session machinery, not chat.
                _ => None,
            }
        }
        _ => None,
    }
}

fn bounded_codex_user_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => (!hq_desktop_core::sessions::codex::is_injected_user_context(text))
            .then(|| text.clone())
            .and_then(|text| bounded_text(&Value::String(text), None))
            .and_then(|text| normalize_portable_skill_references(&text)),
        Value::Array(items) => {
            let visible = items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .or_else(|| item.get("content"))
                        .and_then(Value::as_str)
                })
                .filter(|text| !hq_desktop_core::sessions::codex::is_injected_user_context(text))
                .collect::<Vec<_>>()
                .join("\n");
            bounded_text(&Value::String(visible), None)
                .and_then(|text| normalize_portable_skill_references(&text))
        }
        _ => None,
    }
}

fn same_visible_event(left: &HistoricalEvent, right: &HistoricalEvent) -> bool {
    match (&left.event, &right.event) {
        (
            SessionEvent::UserMessage { text: left, .. },
            SessionEvent::UserMessage { text: right, .. },
        )
        | (
            SessionEvent::AssistantMessage { text: left, .. },
            SessionEvent::AssistantMessage { text: right, .. },
        ) => left == right,
        _ => false,
    }
}

/// Coerce provider text at the parse boundary: string, or an array of objects
/// whose optional `type` matches and whose `text`/`content` is a string.
fn bounded_text(value: &Value, block_kind: Option<&str>) -> Option<String> {
    let raw = match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter(|item| {
                block_kind.is_none() || item.get("type").and_then(Value::as_str) == block_kind
            })
            .filter_map(|item| {
                item.get("text")
                    .or_else(|| item.get("content"))
                    .and_then(Value::as_str)
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(MAX_MESSAGE_CHARS).collect())
}

fn parse_timestamp_ms(value: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis().max(0) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event_text(event: &HistoricalEvent) -> &str {
        match &event.event {
            SessionEvent::UserMessage { text, .. }
            | SessionEvent::AssistantMessage { text, .. } => text,
            other => panic!("expected dialogue, got {other:?}"),
        }
    }

    #[test]
    fn long_transcripts_page_back_to_the_beginning_without_a_fixed_tail() {
        let path = std::env::temp_dir().join(format!(
            "hq-history-page-{}-{}.jsonl",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let contents = (0..300)
            .flat_map(|index| {
                let visible = serde_json::json!({
                    "type": "user",
                    "timestamp": "2026-09-02T12:00:00Z",
                    "message": {"content": format!("message {index}")}
                })
                .to_string();
                // Provider bookkeeping can dwarf visible dialogue. This file
                // is deliberately larger than the old 4 MB tail so the test
                // proves paging scans past it rather than silently cutting.
                let hidden = serde_json::json!({
                    "type": "progress",
                    "payload": "x".repeat(20_000)
                })
                .to_string();
                [visible, hidden]
            })
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&path, contents).unwrap();

        let latest = load_history_page(&path, SessionTool::Claude, None);
        assert_eq!(latest.events.len(), HISTORY_PAGE_EVENTS);
        assert_eq!(event_text(&latest.events[0]), "message 44");
        assert_eq!(event_text(latest.events.last().unwrap()), "message 299");
        let earlier = load_history_page(&path, SessionTool::Claude, latest.before);
        assert_eq!(earlier.events.len(), 44);
        assert_eq!(event_text(&earlier.events[0]), "message 0");
        assert_eq!(event_text(earlier.events.last().unwrap()), "message 43");
        assert_eq!(earlier.before, None);

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn claude_history_keeps_visible_dialogue_and_skips_meta_and_tools() {
        let visible_user = serde_json::json!({
            "type": "user",
            "timestamp": "2026-09-02T12:00:00Z",
            "message": {"content": "Hello"}
        });
        let meta = serde_json::json!({
            "type": "user",
            "isMeta": true,
            "message": {"content": [{"type": "text", "text": "hidden policy"}]}
        });
        let assistant = serde_json::json!({
            "type": "assistant",
            "message": {"content": [
                {"type": "thinking", "thinking": "secret"},
                {"type": "text", "text": "Hi back"},
                {"type": "tool_use", "name": "Bash"}
            ]}
        });

        let user = parse_history_line(SessionTool::Claude, visible_user.to_string(), 7).unwrap();
        assert!(
            matches!(user.event, SessionEvent::UserMessage { ref text, .. } if text == "Hello")
        );
        assert!(parse_history_line(SessionTool::Claude, meta.to_string(), 7).is_none());
        let reply = parse_history_line(SessionTool::Claude, assistant.to_string(), 7).unwrap();
        assert!(
            matches!(reply.event, SessionEvent::AssistantMessage { ref text, .. } if text == "Hi back")
        );
    }

    #[test]
    fn claude_history_turns_desktop_command_envelopes_into_visible_slash_commands() {
        let command = serde_json::json!({
            "type": "user",
            "isSidechain": false,
            "origin": {"kind": "human"},
            "message": {"content": concat!(
                "<command-message>new-hire</command-message>\n",
                "<command-name>/new-hire</command-name>\n",
                "<command-args>bobby@lilosocial.com to indigo</command-args>"
            )}
        });

        let event = parse_history_line(SessionTool::Claude, command.to_string(), 7).unwrap();
        assert!(
            matches!(event.event, SessionEvent::UserMessage { ref text, .. }
                if text == "/new-hire bobby@lilosocial.com to indigo")
        );
    }

    #[test]
    fn claude_history_drops_control_markers_and_sidechain_traffic() {
        for value in [
            serde_json::json!({
                "type": "user",
                "message": {"content": "[Request interrupted by user]"}
            }),
            serde_json::json!({
                "type": "user",
                "message": {"content": "[Request interrupted by user for tool use]"}
            }),
            serde_json::json!({
                "type": "user",
                "message": {"content": "<system-reminder>internal context</system-reminder>"}
            }),
            serde_json::json!({
                "type": "user",
                "isSidechain": true,
                "message": {"content": "subagent prompt"}
            }),
        ] {
            assert!(
                parse_history_line(SessionTool::Claude, value.to_string(), 7).is_none(),
                "provider control traffic must not become a user bubble: {value}"
            );
        }
    }

    #[test]
    fn codex_history_accepts_response_items_and_deduplicates_dual_written_turns() {
        let user = serde_json::json!({
            "timestamp": "2026-09-02T12:00:00Z",
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "Build it"}
        });
        let duplicate_user = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "Build it"}]
            }
        });
        let reply = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "Done"}]
            }
        });
        let duplicate_reply = serde_json::json!({
            "type": "event_msg",
            "payload": {"type": "agent_message", "message": "Done"}
        });

        let mut events = Vec::new();
        for value in [user, duplicate_user, reply, duplicate_reply] {
            let event = parse_history_line(SessionTool::Codex, value.to_string(), 7).unwrap();
            if !events
                .last()
                .is_some_and(|previous| same_visible_event(previous, &event))
            {
                events.push(event);
            }
        }
        assert_eq!(events.len(), 2);
        assert!(
            matches!(events[0].event, SessionEvent::UserMessage { ref text, .. } if text == "Build it")
        );
        assert!(
            matches!(events[1].event, SessionEvent::AssistantMessage { ref text, .. } if text == "Done")
        );
    }

    #[test]
    fn malformed_and_nullable_content_is_ignored_at_the_parse_boundary() {
        for line in [
            "not json".to_string(),
            serde_json::json!({"type":"user", "message":{"content":null}}).to_string(),
            serde_json::json!({"type":"event_msg", "payload":{"type":"agent_message", "message":[]}}).to_string(),
        ] {
            assert!(parse_history_line(SessionTool::Claude, line.clone(), 7).is_none());
            assert!(parse_history_line(SessionTool::Codex, line, 7).is_none());
        }
    }

    #[test]
    fn codex_history_filters_injected_user_blocks_but_keeps_the_real_prompt() {
        let value = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "<recommended_plugins>\nAirtable"},
                    {"type": "input_text", "text": "# AGENTS.md instructions for /tmp/HQ\n<INSTRUCTIONS>hidden</INSTRUCTIONS>"},
                    {"type": "input_text", "text": "/startwork indigo\n\nBuild the session picker"}
                ]
            }
        });
        let event = parse_history_line(SessionTool::Codex, value.to_string(), 7).unwrap();
        assert!(
            matches!(event.event, SessionEvent::UserMessage { ref text, .. } if text == "/startwork indigo\n\nBuild the session picker")
        );

        let injected_only = serde_json::json!({
            "type": "response_item",
            "payload": {"type": "message", "role": "user", "content": [
                {"type": "input_text", "text": "<environment_context>hidden</environment_context>"}
            ]}
        });
        assert!(parse_history_line(SessionTool::Codex, injected_only.to_string(), 7).is_none());
    }

    #[test]
    fn codex_history_hides_skill_expansions_and_cleans_portable_skill_references() {
        let invocation = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": concat!(
                        "[$startwork](/Users/jacobposel/Documents/HQ/.claude/skills/startwork/SKILL.md) indigo\n\n",
                        "Have a look at all HQ case studies\n\n",
                        "What are the HQ wow moments?"
                    )
                }]
            }
        });
        let event = parse_history_line(SessionTool::Codex, invocation.to_string(), 7).unwrap();
        assert!(
            matches!(event.event, SessionEvent::UserMessage { ref text, .. }
                if text == "/startwork indigo\n\nHave a look at all HQ case studies\n\nWhat are the HQ wow moments?")
        );

        let expansion = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": "<skill>\n<name>startwork</name>\n<path>/tmp/SKILL.md</path>\n---\nsecret instructions\n</skill>"
                }]
            }
        });
        assert!(
            parse_history_line(SessionTool::Codex, expansion.to_string(), 7).is_none(),
            "provider-expanded skill instructions are not user-authored chat"
        );
    }
}

//! Grok ACP `session/update` / permission request → [`SessionEvent`] mapping.
//!
//! Pure and synchronous, mirroring [`super::codex_normalize`]: the only state
//! is whether WE sent `session/cancel`, because a cancelled prompt response
//! and a real failure are the same shape on the wire.
//!
//! Unknown `sessionUpdate` kinds map to nothing rather than to an error: a
//! Grok release that adds a notification must not turn a working session into
//! a red transcript.

use std::collections::HashSet;

use serde_json::Value;

use super::grok_wire::{
    permission_tool_input, permission_tool_name, request_key, PermissionOption,
};
use super::types::{cap_hook_text, DoneStatus, SessionEvent};

/// Per-session normalization state.
#[derive(Debug, Default)]
pub struct GrokNormalizer {
    /// Set by the driver when IT sent `session/cancel`. The turn then ends as
    /// [`DoneStatus::Interrupted`] instead of an error, and the flag clears.
    interrupted: bool,
    /// Tool ids already announced as [`SessionEvent::ToolCall`]. Grok repeats
    /// the same toolCallId on `tool_call_update` with a title; a second
    /// ToolCall event leaves a stuck spinner in the transcript.
    seen_tool_ids: HashSet<String>,
}

impl GrokNormalizer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn mark_interrupted(&mut self) {
        self.interrupted = true;
    }

    pub fn is_interrupted(&self) -> bool {
        self.interrupted
    }

    /// Map one inbound JSON-RPC message to zero or more events. Responses to
    /// OUR requests are the driver's business and produce nothing here.
    pub fn normalize(&mut self, msg: &Value) -> Vec<SessionEvent> {
        let Some(method) = msg.get("method").and_then(Value::as_str) else {
            return Vec::new();
        };
        let params = msg.get("params").cloned().unwrap_or(Value::Null);

        if let Some(id) = msg.get("id") {
            return self.server_request(method, id, &params);
        }

        match method {
            "session/update" => {
                map_update(params.get("update").unwrap_or(&Value::Null), &mut self.seen_tool_ids)
            }
            "_x.ai/session/prompt_complete" => {
                let status = if self.interrupted {
                    self.interrupted = false;
                    DoneStatus::Interrupted
                } else {
                    DoneStatus::Success
                };
                vec![SessionEvent::TurnDone {
                    status,
                    error: None,
                    session_id: params
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                }]
            }
            _ => Vec::new(),
        }
    }

    fn server_request(&mut self, method: &str, id: &Value, params: &Value) -> Vec<SessionEvent> {
        match method {
            "session/request_permission" => vec![SessionEvent::PermissionRequest {
                request_id: request_key(id),
                tool_name: permission_tool_name(params),
                input: permission_tool_input(params),
                suggestions: params.get("options").cloned().unwrap_or(Value::Array(vec![])),
            }],
            _ => Vec::new(),
        }
    }

    /// Map a settled `session/prompt` result to the turn's terminal status.
    pub fn turn_from_prompt(&mut self, result: &Value) -> SessionEvent {
        if self.interrupted {
            self.interrupted = false;
            return SessionEvent::TurnDone {
                status: DoneStatus::Interrupted,
                error: None,
                session_id: None,
            };
        }
        match result.get("stopReason").and_then(Value::as_str) {
            Some("cancelled") => SessionEvent::TurnDone {
                status: DoneStatus::Interrupted,
                error: None,
                session_id: None,
            },
            Some("refusal") => SessionEvent::TurnDone {
                status: DoneStatus::Error,
                error: Some("The agent refused to continue.".into()),
                session_id: None,
            },
            _ => SessionEvent::TurnDone {
                status: DoneStatus::Success,
                error: None,
                session_id: None,
            },
        }
    }
}

/// Options parked with a permission request so the driver can pick an id.
pub fn options_from_event(event: &SessionEvent) -> Vec<PermissionOption> {
    match event {
        SessionEvent::PermissionRequest { suggestions, .. } => suggestions
            .as_array()
            .map(|a| a.as_slice())
            .unwrap_or_default()
            .iter()
            .filter_map(|option| {
                let option_id = option
                    .get("optionId")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())?;
                Some(PermissionOption {
                    option_id: option_id.to_owned(),
                    kind: option
                        .get("kind")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                })
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn str_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn content_block_text(block: &Value) -> Option<&str> {
    (block.get("type").and_then(Value::as_str) == Some("text"))
        .then(|| block.get("text").and_then(Value::as_str))
        .flatten()
}

fn chunk_text(update: &Value) -> Option<String> {
    let text = content_block_text(update.get("content")?)?;
    (!text.is_empty()).then(|| text.to_owned())
}

fn xai_tool_name(update: &Value) -> Option<&str> {
    update
        .get("_meta")?
        .get("x.ai/tool")?
        .get("name")?
        .as_str()
        .filter(|name| !name.is_empty())
}

fn tool_name(update: &Value) -> String {
    xai_tool_name(update)
        .or_else(|| update.get("title").and_then(Value::as_str))
        .or_else(|| update.get("kind").and_then(Value::as_str))
        .unwrap_or("tool")
        .to_owned()
}

fn tool_input(update: &Value) -> Value {
    update
        .get("rawInput")
        .cloned()
        .filter(|value| !value.is_null())
        .unwrap_or(Value::Object(serde_json::Map::new()))
}

fn tool_output(update: &Value) -> Value {
    let Some(content) = update.get("content").and_then(Value::as_array) else {
        return Value::Null;
    };
    let parts: Vec<&str> = content
        .iter()
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("content"))
        .filter_map(|entry| content_block_text(entry.get("content")?))
        .filter(|text| !text.is_empty())
        .collect();
    if parts.is_empty() {
        return Value::Null;
    }
    Value::String(parts.join("\n"))
}

fn map_update(update: &Value, seen_tool_ids: &mut HashSet<String>) -> Vec<SessionEvent> {
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or("");
    match kind {
        "agent_message_chunk" => chunk_text(update)
            .map(|text| {
                vec![SessionEvent::TextDelta {
                    text,
                    parent_tool_use_id: None,
                }]
            })
            .unwrap_or_default(),
        "agent_thought_chunk" => chunk_text(update)
            .map(|text| vec![SessionEvent::ThinkingDelta { text }])
            .unwrap_or_default(),
        "user_message_chunk" => Vec::new(),
        "tool_call" => {
            let id = str_field(update, "toolCallId");
            if !id.is_empty() {
                seen_tool_ids.insert(id.clone());
            }
            let mut events = vec![SessionEvent::ToolCall {
                id: id.clone(),
                name: tool_name(update),
                input: tool_input(update),
                parent_tool_use_id: None,
            }];
            if let Some(result) = resolved_result(update, id) {
                events.push(result);
            }
            events
        }
        "tool_call_update" => {
            let id = str_field(update, "toolCallId");
            let mut events = Vec::new();
            // A later title/input patch is not a new call. Re-emitting ToolCall
            // duplicates the row in the transcript fold; the original stays
            // `running` after the result. Only announce when this id is new.
            if !id.is_empty() && !seen_tool_ids.contains(&id) {
                if update.get("kind").is_some()
                    || update.get("title").is_some()
                    || update.get("rawInput").is_some()
                {
                    seen_tool_ids.insert(id.clone());
                    events.push(SessionEvent::ToolCall {
                        id: id.clone(),
                        name: tool_name(update),
                        input: tool_input(update),
                        parent_tool_use_id: None,
                    });
                }
            }
            if let Some(result) = resolved_result(update, id) {
                events.push(result);
            }
            events
        }
        "session_info_update" => hook_from_session_info(update).into_iter().collect(),
        _ => Vec::new(),
    }
}

fn resolved_result(update: &Value, id: String) -> Option<SessionEvent> {
    let status = update.get("status").and_then(Value::as_str)?;
    let is_error = match status {
        "completed" => false,
        "failed" => true,
        _ => return None,
    };
    Some(SessionEvent::ToolResult {
        id,
        is_error,
        content: tool_output(update),
        parent_tool_use_id: None,
    })
}

fn hook_from_session_info(update: &Value) -> Option<SessionEvent> {
    let text = update
        .get("title")
        .and_then(Value::as_str)
        .or_else(|| update.get("text").and_then(Value::as_str))
        .filter(|text| !text.is_empty())?;
    Some(SessionEvent::HookNotice {
        hook_event: "session_info_update".into(),
        hook_name: str_field(update, "sessionUpdate"),
        text: cap_hook_text(text),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn message_and_thought_chunks_map_to_deltas() {
        let mut n = GrokNormalizer::new();
        let events = n.normalize(&json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "hello" },
                }
            }
        }));
        assert_eq!(
            events,
            vec![SessionEvent::TextDelta {
                text: "hello".into(),
                parent_tool_use_id: None,
            }]
        );
        let thought = n.normalize(&json!({
            "method": "session/update",
            "params": { "update": {
                "sessionUpdate": "agent_thought_chunk",
                "content": { "type": "text", "text": "hmm" },
            }}
        }));
        assert_eq!(
            thought,
            vec![SessionEvent::ThinkingDelta { text: "hmm".into() }]
        );
    }

    #[test]
    fn tool_call_update_does_not_reannounce_a_known_id() {
        let mut n = GrokNormalizer::new();
        let start = n.normalize(&json!({
            "method": "session/update",
            "params": { "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "t1",
                "kind": "execute",
                "status": "pending",
            }}
        }));
        assert_eq!(start.len(), 1);
        let update = n.normalize(&json!({
            "method": "session/update",
            "params": { "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "t1",
                "title": "bash",
                "rawInput": { "command": "ls" },
                "status": "in_progress",
            }}
        }));
        assert!(update.is_empty());
        let done = n.normalize(&json!({
            "method": "session/update",
            "params": { "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "t1",
                "status": "completed",
                "content": [{
                    "type": "content",
                    "content": { "type": "text", "text": "ok" }
                }],
            }}
        }));
        assert_eq!(done.len(), 1);
        assert!(matches!(
            &done[0],
            SessionEvent::ToolResult { id, is_error, .. } if id == "t1" && !*is_error
        ));
    }

    #[test]
    fn grok_tool_call_prefers_xai_name_and_resolves_on_completed() {
        let mut n = GrokNormalizer::new();
        let events = n.normalize(&json!({
            "method": "session/update",
            "params": { "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "t1",
                "kind": "execute",
                "title": "Terminal",
                "rawInput": { "command": "ls" },
                "_meta": { "x.ai/tool": { "name": "bash" } },
                "status": "completed",
                "content": [{
                    "type": "content",
                    "content": { "type": "text", "text": "ok" }
                }],
            }}
        }));
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            SessionEvent::ToolCall { id, name, .. } if id == "t1" && name == "bash"
        ));
        assert!(matches!(
            &events[1],
            SessionEvent::ToolResult { id, is_error, content, .. }
                if id == "t1" && !*is_error && content == "ok"
        ));
    }

    #[test]
    fn permission_request_parks_under_the_json_rpc_id() {
        let mut n = GrokNormalizer::new();
        let events = n.normalize(&json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "session/request_permission",
            "params": {
                "toolCall": {
                    "toolCallId": "t1",
                    "title": "bash",
                    "rawInput": { "command": "rm" },
                },
                "options": [
                    { "optionId": "once", "kind": "allow_once", "name": "Once" },
                    { "optionId": "always", "kind": "allow_always", "name": "Always" },
                ]
            }
        }));
        assert!(matches!(
            &events[0],
            SessionEvent::PermissionRequest { request_id, tool_name, .. }
                if request_id == "7" && tool_name == "bash"
        ));
        assert_eq!(options_from_event(&events[0]).len(), 2);
    }

    #[test]
    fn prompt_complete_is_authoritative_turn_end_and_honours_interrupt() {
        let mut n = GrokNormalizer::new();
        let done = n.normalize(&json!({
            "method": "_x.ai/session/prompt_complete",
            "params": { "sessionId": "s1" }
        }));
        assert!(matches!(
            &done[0],
            SessionEvent::TurnDone { status: DoneStatus::Success, .. }
        ));
        n.mark_interrupted();
        let stopped = n.normalize(&json!({
            "method": "_x.ai/session/prompt_complete",
            "params": { "sessionId": "s1" }
        }));
        assert!(matches!(
            &stopped[0],
            SessionEvent::TurnDone { status: DoneStatus::Interrupted, .. }
        ));
    }

    #[test]
    fn unknown_updates_are_silent() {
        let mut n = GrokNormalizer::new();
        assert!(n
            .normalize(&json!({
                "method": "session/update",
                "params": { "update": { "sessionUpdate": "usage_update" } }
            }))
            .is_empty());
        assert!(n
            .normalize(&json!({ "method": "session/unknown_notice", "params": {} }))
            .is_empty());
    }
}

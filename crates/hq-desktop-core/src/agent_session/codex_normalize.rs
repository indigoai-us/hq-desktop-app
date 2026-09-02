//! Codex `app-server` message → [`SessionEvent`] normalization.
//!
//! Pure and synchronous, mirroring [`super::claude_normalize`]: the only state
//! is whether WE sent an interrupt, because `turn/aborted` and a failed
//! `turn/completed` are the same shape on the wire whether the user pressed
//! Stop or the model fell over.
//!
//! # What is deliberately dropped
//!
//! Codex is a chattier protocol than Claude's `stream-json`. `hook/*`,
//! `mcpServer/*`, `thread/settings/*`, `thread/status/*`, `account/*`,
//! `remoteControl/*`, `warning`, and `thread/started` are bookkeeping with no
//! transcript meaning, and `item/* userMessage` is Codex echoing back the turn
//! we just sent — which the registry already recorded as a
//! [`SessionEvent::UserMessage`] at send time. Emitting it again would double
//! every prompt in the transcript.
//!
//! Unknown methods and unknown item types map to NOTHING rather than to an
//! error: a Codex release that adds a notification must not turn a working
//! session into a red transcript.

use serde_json::{json, Map, Value};

use super::codex_wire::{
    command_text, parse_approval_request, parse_user_input_request,
};
use super::types::{DoneStatus, SessionEvent};

/// Which half of an item's lifecycle a frame is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Started,
    Completed,
}

fn field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| value.get(*k))
}

fn str_field(value: &Value, keys: &[&str]) -> String {
    field(value, keys)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

/// The JSON-RPC id of a server→client request, as the string the registry
/// keys a parked request on. Numbers and strings are both legal ids.
pub fn request_key(id: &Value) -> String {
    match id {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Per-session normalization state.
#[derive(Debug, Default)]
pub struct CodexNormalizer {
    /// Set by the driver when IT sent `turn/interrupt`. The turn then ends as
    /// [`DoneStatus::Interrupted`] instead of an error, and the flag clears —
    /// the next turn in the same session ends normally.
    interrupted: bool,
}

impl CodexNormalizer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that we sent an interrupt.
    pub fn mark_interrupted(&mut self) {
        self.interrupted = true;
    }

    /// Map one inbound JSON-RPC message — a notification, or a server→client
    /// request — to zero or more events. Responses to OUR requests are the
    /// driver's business and produce nothing here.
    pub fn normalize(&mut self, msg: &Value) -> Vec<SessionEvent> {
        let Some(method) = msg.get("method").and_then(Value::as_str) else {
            return Vec::new();
        };
        let params = msg.get("params").cloned().unwrap_or(Value::Null);

        // A `method` WITH an `id` is a request the server expects answered.
        if let Some(id) = msg.get("id") {
            return self.server_request(method, id, &params);
        }

        match method {
            "item/agentMessage/delta" => delta_text(&params)
                .map(|text| {
                    vec![SessionEvent::TextDelta {
                        text,
                        parent_tool_use_id: None,
                    }]
                })
                .unwrap_or_default(),

            // Reasoning streams on two channels depending on build: raw text
            // and summary text. Both are the same thinking channel to us.
            "item/reasoning/textDelta"
            | "item/reasoning/summaryTextDelta"
            | "item/reasoning/delta" => delta_text(&params)
                .map(|text| vec![SessionEvent::ThinkingDelta { text }])
                .unwrap_or_default(),

            "item/started" => map_item(Phase::Started, params.get("item").unwrap_or(&Value::Null)),
            "item/completed" => {
                map_item(Phase::Completed, params.get("item").unwrap_or(&Value::Null))
            }

            "thread/tokenUsage/updated" => usage_event(&params).into_iter().collect(),

            "turn/completed" => vec![self.turn_done(&params)],
            "turn/failed" => {
                self.interrupted = false;
                vec![SessionEvent::TurnDone {
                    status: DoneStatus::Error,
                    error: Some(
                        turn_error(&params).unwrap_or_else(|| "The turn failed.".to_owned()),
                    ),
                    session_id: None,
                }]
            }
            "turn/aborted" => {
                self.interrupted = false;
                vec![SessionEvent::TurnDone {
                    status: DoneStatus::Interrupted,
                    error: None,
                    session_id: None,
                }]
            }

            "error" => {
                let message = str_field(&params, &["message"]);
                vec![SessionEvent::Error {
                    message: if message.is_empty() {
                        "Codex reported an error.".to_owned()
                    } else {
                        message
                    },
                    code: field(&params, &["code", "codexErrorInfo"])
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                }]
            }

            _ => Vec::new(),
        }
    }

    /// `turn/completed` carries the turn's own verdict. An interrupt we sent
    /// wins over that verdict: the wire cannot tell "the user pressed Stop"
    /// from "it broke", and only we know which happened.
    fn turn_done(&mut self, params: &Value) -> SessionEvent {
        if std::mem::take(&mut self.interrupted) {
            return SessionEvent::TurnDone {
                status: DoneStatus::Interrupted,
                error: None,
                session_id: None,
            };
        }
        let status = params
            .get("turn")
            .map(|t| str_field(t, &["status"]))
            .unwrap_or_default();
        let error = turn_error(params);
        if error.is_some() || matches!(status.as_str(), "failed" | "error") {
            return SessionEvent::TurnDone {
                status: DoneStatus::Error,
                error: Some(error.unwrap_or_else(|| "The turn ended with an error.".to_owned())),
                session_id: None,
            };
        }
        SessionEvent::TurnDone {
            status: DoneStatus::Success,
            error: None,
            session_id: None,
        }
    }

    fn server_request(&mut self, method: &str, id: &Value, params: &Value) -> Vec<SessionEvent> {
        match method {
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                let request = parse_approval_request(method, params);
                vec![SessionEvent::PermissionRequest {
                    request_id: request_key(id),
                    tool_name: request.tool_name,
                    input: request.input,
                    suggestions: request.suggestions,
                }]
            }
            "item/tool/requestUserInput" => {
                let questions = parse_user_input_request(params);
                if questions.is_empty() {
                    return Vec::new();
                }
                vec![SessionEvent::QuestionRequest {
                    request_id: request_key(id),
                    questions,
                }]
            }
            _ => Vec::new(),
        }
    }
}

/// Delta text under either spelling the app server has shipped.
fn delta_text(params: &Value) -> Option<String> {
    field(params, &["delta", "textDelta", "text"])
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// `params.turn.error.message`, when the turn carries one.
fn turn_error(params: &Value) -> Option<String> {
    let error = params.get("turn")?.get("error")?;
    if error.is_null() {
        return None;
    }
    let message = str_field(error, &["message"]);
    Some(if message.is_empty() {
        error.to_string()
    } else {
        message
    })
}

/// `thread/tokenUsage/updated` → the LAST turn's tokens.
///
/// `last`, not `total`: the total is cumulative across the thread, and a
/// per-turn cost line that only ever grows is not a per-turn cost line.
fn usage_event(params: &Value) -> Option<SessionEvent> {
    let last = field(params, &["tokenUsage", "token_usage"])?.get("last")?;
    let count = |keys: &[&str]| field(last, keys).and_then(Value::as_u64).unwrap_or(0);
    Some(SessionEvent::Usage {
        input_tokens: count(&["inputTokens", "input_tokens"]),
        output_tokens: count(&["outputTokens", "output_tokens"]),
        cost_usd: None,
        duration_ms: None,
    })
}

/// The tool name a `fileChange` item's `changes` array describes.
///
/// A lone add is a write, a lone update an edit, and anything else (a delete,
/// or a multi-file change) is a patch — one name for one visible action, so a
/// user reading the transcript sees what happened rather than a generic
/// "fileChange".
fn file_change_tool(changes: &[Value]) -> &'static str {
    match changes {
        [one] => match one.get("kind").and_then(Value::as_str) {
            Some("add") => "Write",
            Some("delete") => "ApplyPatch",
            _ => "Edit",
        },
        _ => "ApplyPatch",
    }
}

/// Map one `item/started` / `item/completed` item to events.
///
/// The lifecycle is strictly `ToolCall` on started and `ToolResult` on
/// completed — never both on completed. The transcript renders a call and its
/// result as one pair keyed on the item id, so re-emitting the call would draw
/// the same command twice.
fn map_item(phase: Phase, item: &Value) -> Vec<SessionEvent> {
    let id = str_field(item, &["id"]);
    let status = str_field(item, &["status"]);
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");

    match item_type {
        // Text arrives as deltas AND as a completed item. Only the completed
        // one becomes a message; `phase` is not filtered on the assistant's
        // `phase` field, because a commentary line ("Running the requested
        // command") is prose the user should see, same as the final answer.
        "agentMessage" | "agent_message" => match phase {
            Phase::Started => Vec::new(),
            Phase::Completed => {
                let text = str_field(item, &["text"]);
                if text.trim().is_empty() {
                    Vec::new()
                } else {
                    vec![SessionEvent::AssistantMessage {
                        text,
                        parent_tool_use_id: None,
                    }]
                }
            }
        },

        "commandExecution" | "command_execution" => match phase {
            Phase::Started => {
                let mut input = Map::new();
                input.insert("command".into(), json!(command_text(item)));
                let cwd = str_field(item, &["cwd"]);
                if !cwd.is_empty() {
                    input.insert("cwd".into(), json!(cwd));
                }
                vec![SessionEvent::ToolCall {
                    id,
                    name: "Bash".into(),
                    input: Value::Object(input),
                    parent_tool_use_id: None,
                }]
            }
            Phase::Completed => {
                let exit_code = field(item, &["exitCode", "exit_code"])
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                vec![SessionEvent::ToolResult {
                    id,
                    is_error: status != "completed" || exit_code != 0,
                    content: field(item, &["aggregatedOutput", "aggregated_output"])
                        .cloned()
                        .unwrap_or(Value::Null),
                    parent_tool_use_id: None,
                }]
            }
        },

        "fileChange" | "file_change" => {
            let changes = item
                .get("changes")
                .and_then(Value::as_array)
                .map(|a| a.as_slice())
                .unwrap_or_default();
            match phase {
                Phase::Started => vec![SessionEvent::ToolCall {
                    id,
                    name: file_change_tool(changes).into(),
                    input: json!({ "changes": changes }),
                    parent_tool_use_id: None,
                }],
                Phase::Completed => vec![SessionEvent::ToolResult {
                    id,
                    is_error: matches!(status.as_str(), "failed" | "declined"),
                    content: json!({ "changes": changes }),
                    parent_tool_use_id: None,
                }],
            }
        }

        "mcpToolCall" | "mcp_tool_call" => {
            let server = str_field(item, &["server"]);
            let tool = str_field(item, &["tool"]);
            match phase {
                Phase::Started => vec![SessionEvent::ToolCall {
                    id,
                    name: format!("mcp__{server}__{tool}"),
                    input: item
                        .get("arguments")
                        .filter(|v| !v.is_null())
                        .cloned()
                        .unwrap_or(Value::Null),
                    parent_tool_use_id: None,
                }],
                Phase::Completed => vec![SessionEvent::ToolResult {
                    id,
                    is_error: status == "failed" || item.get("error").is_some_and(|e| !e.is_null()),
                    content: field(item, &["result", "contentItems"])
                        .cloned()
                        .unwrap_or(Value::Null),
                    parent_tool_use_id: None,
                }],
            }
        }

        "webSearch" | "web_search" => match phase {
            Phase::Started => vec![SessionEvent::ToolCall {
                id,
                name: "WebSearch".into(),
                input: json!({ "query": str_field(item, &["query"]) }),
                parent_tool_use_id: None,
            }],
            Phase::Completed => vec![SessionEvent::ToolResult {
                id,
                is_error: status == "failed",
                content: field(item, &["result", "query"])
                    .cloned()
                    .unwrap_or(Value::Null),
                parent_tool_use_id: None,
            }],
        },

        "error" => vec![SessionEvent::Error {
            message: str_field(item, &["message"]),
            code: None,
        }],

        // `reasoning` flows through its delta channel; `userMessage` is our
        // own turn echoed back; everything else is not yet modelled.
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> Value {
        serde_json::from_str(raw).expect("fixture is valid JSON")
    }

    fn normalize(raw: &str) -> Vec<SessionEvent> {
        CodexNormalizer::new().normalize(&parse(raw))
    }

    // ── Verbatim frames from workspace/tmp/claude-spike/cx*.codex.jsonl ──

    const USER_MESSAGE_STARTED: &str = r#"{"method":"item/started","params":{"item":{"type":"userMessage","id":"01a06219-5f0e-7580-a0ff-7c69962e7fc0","clientId":null,"content":[{"type":"text","text":"Run the shell command: ls core | head -3 . Then reply with exactly the three names you saw.","text_elements":[]}]},"threadId":"01a06218-e436-7963-827b-6103963b4320","turnId":"01a06218-f3a3-7f51-992d-618a3c6b3c6b","startedAtMs":1788352225038}}"#;

    const AGENT_MESSAGE_DELTA: &str = r#"{"method":"item/agentMessage/delta","params":{"threadId":"01a06218-e436-7963-827b-6103963b4320","turnId":"01a06218-f3a3-7f51-992d-618a3c6b3c6b","itemId":"msg_0de5","delta":"Running"}}"#;

    const AGENT_MESSAGE_COMPLETED: &str = r#"{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg_0de5","text":"Running the requested read-only shell command.","phase":"commentary","memoryCitation":null},"threadId":"01a06218-e436-7963-827b-6103963b4320","turnId":"01a06218-f3a3-7f51-992d-618a3c6b3c6b","completedAtMs":1788352226750}}"#;

    const COMMAND_STARTED: &str = r#"{"method":"item/started","params":{"item":{"type":"commandExecution","id":"exec-ab8b7fc6","command":"/bin/zsh -lc 'ls core | head -3'","cwd":"/Users/jacobposel/Documents/HQ","processId":"30781","source":"unifiedExecStartup","status":"inProgress","commandActions":[{"type":"listFiles","command":"ls core","path":"core"}],"aggregatedOutput":null,"exitCode":null,"durationMs":null},"threadId":"th","turnId":"tu","startedAtMs":1788352231755}}"#;

    const COMMAND_COMPLETED: &str = r#"{"method":"item/completed","params":{"item":{"type":"commandExecution","id":"exec-ab8b7fc6","command":"/bin/zsh -lc 'ls core | head -3'","cwd":"/Users/jacobposel/Documents/HQ","processId":"30781","source":"unifiedExecStartup","status":"completed","commandActions":[],"aggregatedOutput":"core.yaml\ndocs\nhook-tests\n","exitCode":0,"durationMs":0},"threadId":"th","turnId":"tu","completedAtMs":1788352231755}}"#;

    const TOKEN_USAGE: &str = r#"{"method":"thread/tokenUsage/updated","params":{"threadId":"th","turnId":"tu","tokenUsage":{"total":{"totalTokens":48000,"inputTokens":47000,"cachedInputTokens":10624,"outputTokens":1000,"reasoningOutputTokens":0},"last":{"totalTokens":24018,"inputTokens":23944,"cachedInputTokens":10624,"outputTokens":74,"reasoningOutputTokens":0},"modelContextWindow":258400}}}"#;

    const TURN_COMPLETED: &str = r#"{"method":"turn/completed","params":{"threadId":"th","turn":{"id":"tu","items":[],"itemsView":"notLoaded","status":"completed","error":null,"startedAt":1788352197,"completedAt":1788352245,"durationMs":47797}}}"#;

    const APPROVAL_REQUEST: &str = r#"{"jsonrpc":"2.0","method":"item/commandExecution/requestApproval","id":0,"params":{"threadId":"th","turnId":"tu","itemId":"exec-6d0b851e","startedAtMs":1788352401007,"environmentId":"local","reason":"Allow creating the requested cx3-hello.txt file outside the read-only sandbox?","command":"/bin/zsh -lc 'echo hello > /tmp/cx3-hello.txt'","cwd":"/Users/jacobposel/Documents/HQ","commandActions":[{"type":"unknown","command":"echo hello > /tmp/cx3-hello.txt"}],"availableDecisions":["accept","cancel"]}}"#;

    const IGNORED: &[&str] = &[
        r#"{"method":"thread/started","params":{"thread":{"id":"th"}}}"#,
        r#"{"method":"mcpServer/startupStatus/updated","params":{"threadId":"th","name":"node_repl","status":"starting"}}"#,
        r#"{"method":"thread/settings/updated","params":{"threadId":"th","threadSettings":{}}}"#,
        r#"{"method":"thread/status/changed","params":{"threadId":"th","status":{"type":"active"}}}"#,
        r#"{"method":"hook/started","params":{"threadId":"th","run":{"id":"session-start:3"}}}"#,
        r#"{"method":"hook/completed","params":{"threadId":"th","run":{"id":"session-start:3"}}}"#,
        r#"{"method":"account/rateLimits/updated","params":{"rateLimits":{"limitId":"codex"}}}"#,
        r#"{"method":"remoteControl/status/changed","params":{"status":"disabled"}}"#,
        r#"{"method":"warning","params":{"threadId":"th","message":"Skill descriptions were shortened"}}"#,
        r#"{"method":"turn/started","params":{"threadId":"th","turn":{"id":"tu","status":"inProgress"}}}"#,
        r#"{"method":"serverRequest/resolved","params":{"threadId":"th","requestId":0}}"#,
    ];

    #[test]
    fn the_bookkeeping_half_of_the_protocol_produces_no_transcript() {
        for raw in IGNORED {
            assert!(
                normalize(raw).is_empty(),
                "should be ignored but produced events: {raw}"
            );
        }
        // Our own turn, echoed back by the server, must not double the prompt.
        assert!(normalize(USER_MESSAGE_STARTED).is_empty());
        assert!(normalize(
            &USER_MESSAGE_STARTED.replace("item/started", "item/completed")
        )
        .is_empty());
        // A response to one of OUR requests is the driver's business.
        assert!(normalize(r#"{"id":3,"result":{"turn":{"id":"tu"}}}"#).is_empty());
    }

    #[test]
    fn assistant_text_streams_as_deltas_and_lands_as_a_message() {
        assert_eq!(
            normalize(AGENT_MESSAGE_DELTA),
            vec![SessionEvent::TextDelta {
                text: "Running".into(),
                parent_tool_use_id: None
            }]
        );
        assert_eq!(
            normalize(AGENT_MESSAGE_COMPLETED),
            vec![SessionEvent::AssistantMessage {
                text: "Running the requested read-only shell command.".into(),
                parent_tool_use_id: None
            }],
            "a commentary-phase message is prose the user should see"
        );
        // The final answer is the same shape with a different phase.
        let final_answer = AGENT_MESSAGE_COMPLETED.replace("commentary", "final_answer");
        assert!(matches!(
            normalize(&final_answer).as_slice(),
            [SessionEvent::AssistantMessage { .. }]
        ));
        // An empty completed message (the started stub) is not a message.
        assert!(normalize(
            r#"{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"m","text":""}}}"#
        )
        .is_empty());
    }

    #[test]
    fn reasoning_deltas_become_thinking() {
        assert_eq!(
            normalize(
                r#"{"method":"item/reasoning/summaryTextDelta","params":{"itemId":"rs_1","delta":"Considering"}}"#
            ),
            vec![SessionEvent::ThinkingDelta {
                text: "Considering".into()
            }]
        );
        assert_eq!(
            normalize(
                r#"{"method":"item/reasoning/textDelta","params":{"itemId":"rs_1","textDelta":"more"}}"#
            ),
            vec![SessionEvent::ThinkingDelta { text: "more".into() }]
        );
    }

    #[test]
    fn a_command_execution_is_one_bash_call_and_one_result() {
        assert_eq!(
            normalize(COMMAND_STARTED),
            vec![SessionEvent::ToolCall {
                id: "exec-ab8b7fc6".into(),
                name: "Bash".into(),
                input: serde_json::json!({
                    "command": "/bin/zsh -lc 'ls core | head -3'",
                    "cwd": "/Users/jacobposel/Documents/HQ"
                }),
                parent_tool_use_id: None,
            }]
        );
        assert_eq!(
            normalize(COMMAND_COMPLETED),
            vec![SessionEvent::ToolResult {
                id: "exec-ab8b7fc6".into(),
                is_error: false,
                content: serde_json::json!("core.yaml\ndocs\nhook-tests\n"),
                parent_tool_use_id: None,
            }]
        );
    }

    #[test]
    fn a_nonzero_exit_or_unfinished_status_is_an_error_result() {
        let failed = COMMAND_COMPLETED.replace("\"exitCode\":0", "\"exitCode\":1");
        assert!(matches!(
            normalize(&failed).as_slice(),
            [SessionEvent::ToolResult { is_error: true, .. }]
        ));
        let aborted = COMMAND_COMPLETED.replace("\"status\":\"completed\"", "\"status\":\"failed\"");
        assert!(matches!(
            normalize(&aborted).as_slice(),
            [SessionEvent::ToolResult { is_error: true, .. }]
        ));
    }

    #[test]
    fn file_changes_name_the_action_they_perform() {
        let call = |kind: &str, count: usize| {
            let changes: Vec<Value> = (0..count)
                .map(|i| serde_json::json!({"path": format!("/a{i}.rs"), "kind": kind}))
                .collect();
            let raw = serde_json::json!({
                "method": "item/started",
                "params": {"item": {"type": "fileChange", "id": "f1", "changes": changes}}
            });
            match CodexNormalizer::new().normalize(&raw).pop() {
                Some(SessionEvent::ToolCall { name, .. }) => name,
                other => panic!("expected a ToolCall, got {other:?}"),
            }
        };
        assert_eq!(call("add", 1), "Write");
        assert_eq!(call("update", 1), "Edit");
        assert_eq!(call("delete", 1), "ApplyPatch");
        assert_eq!(call("update", 2), "ApplyPatch");

        let declined = serde_json::json!({
            "method": "item/completed",
            "params": {"item": {"type": "fileChange", "id": "f1", "status": "declined",
                                 "changes": [{"path": "/a.rs", "kind": "update"}]}}
        });
        assert!(matches!(
            CodexNormalizer::new().normalize(&declined).as_slice(),
            [SessionEvent::ToolResult { is_error: true, .. }]
        ));
    }

    #[test]
    fn mcp_and_web_search_calls_keep_their_recognisable_names() {
        let mcp = serde_json::json!({
            "method": "item/started",
            "params": {"item": {"type": "mcpToolCall", "id": "m1", "server": "hq",
                                 "tool": "search", "arguments": {"q": "x"}}}
        });
        assert!(matches!(
            CodexNormalizer::new().normalize(&mcp).as_slice(),
            [SessionEvent::ToolCall { name, .. }] if name == "mcp__hq__search"
        ));
        let web = serde_json::json!({
            "method": "item/started",
            "params": {"item": {"type": "webSearch", "id": "w1", "query": "rust"}}
        });
        assert!(matches!(
            CodexNormalizer::new().normalize(&web).as_slice(),
            [SessionEvent::ToolCall { name, input, .. }]
                if name == "WebSearch" && input["query"] == "rust"
        ));
    }

    #[test]
    fn token_usage_reports_the_last_turn_not_the_running_total() {
        assert_eq!(
            normalize(TOKEN_USAGE),
            vec![SessionEvent::Usage {
                input_tokens: 23944,
                output_tokens: 74,
                cost_usd: None,
                duration_ms: None,
            }]
        );
    }

    #[test]
    fn a_completed_turn_is_a_success_and_a_failed_one_carries_its_message() {
        assert_eq!(
            normalize(TURN_COMPLETED),
            vec![SessionEvent::TurnDone {
                status: DoneStatus::Success,
                error: None,
                session_id: None,
            }]
        );

        let failed = TURN_COMPLETED
            .replace("\"status\":\"completed\"", "\"status\":\"failed\"")
            .replace("\"error\":null", "\"error\":{\"message\":\"model overloaded\"}");
        assert_eq!(
            normalize(&failed),
            vec![SessionEvent::TurnDone {
                status: DoneStatus::Error,
                error: Some("model overloaded".into()),
                session_id: None,
            }]
        );

        assert!(matches!(
            normalize(r#"{"method":"turn/failed","params":{"turn":{"id":"tu","error":{"message":"boom"}}}}"#).as_slice(),
            [SessionEvent::TurnDone { status: DoneStatus::Error, error: Some(e), .. }] if e == "boom"
        ));
        assert!(matches!(
            normalize(r#"{"method":"turn/aborted","params":{"threadId":"th","turnId":"tu"}}"#).as_slice(),
            [SessionEvent::TurnDone { status: DoneStatus::Interrupted, error: None, .. }]
        ));
    }

    /// An interrupted turn ends as `Interrupted`, not as the error the wire
    /// reports — the same distinction the Claude driver draws, for the same
    /// reason: the user pressed Stop and must not see red for it.
    #[test]
    fn an_interrupt_we_sent_wins_over_the_turns_own_verdict_exactly_once() {
        let mut normalizer = CodexNormalizer::new();
        normalizer.mark_interrupted();
        let failed = TURN_COMPLETED
            .replace("\"status\":\"completed\"", "\"status\":\"failed\"")
            .replace("\"error\":null", "\"error\":{\"message\":\"aborted\"}");
        assert_eq!(
            normalizer.normalize(&parse(&failed)),
            vec![SessionEvent::TurnDone {
                status: DoneStatus::Interrupted,
                error: None,
                session_id: None,
            }]
        );
        // The flag is one-shot: the next turn ends on its own merits.
        assert_eq!(
            normalizer.normalize(&parse(&failed)),
            vec![SessionEvent::TurnDone {
                status: DoneStatus::Error,
                error: Some("aborted".into()),
                session_id: None,
            }]
        );
    }

    #[test]
    fn an_approval_request_becomes_a_permission_request_keyed_by_its_jsonrpc_id() {
        let events = normalize(APPROVAL_REQUEST);
        assert!(matches!(
            events.as_slice(),
            [SessionEvent::PermissionRequest { request_id, tool_name, input, suggestions }]
                if request_id == "0"
                    && tool_name == "Bash"
                    && input["command"].as_str().unwrap().contains("echo hello")
                    && suggestions[0] == "accept"
        ), "{events:?}");

        // A string id round-trips as itself, not as a quoted string.
        let string_id = APPROVAL_REQUEST.replace("\"id\":0", "\"id\":\"req-7\"");
        assert!(matches!(
            normalize(&string_id).as_slice(),
            [SessionEvent::PermissionRequest { request_id, .. }] if request_id == "req-7"
        ));
    }

    #[test]
    fn a_tool_user_input_request_becomes_a_question_request() {
        let raw = r#"{"jsonrpc":"2.0","id":9,"method":"item/tool/requestUserInput","params":{"threadId":"th","turnId":"tu","questions":[{"id":"q_a","header":"Pick","question":"Which?","options":["A","B"]}]}}"#;
        assert!(matches!(
            normalize(raw).as_slice(),
            [SessionEvent::QuestionRequest { request_id, questions }]
                if request_id == "9" && questions[0].id == "q_a" && questions[0].options.len() == 2
        ));
        // No questions is nothing to ask; the driver answers it empty.
        assert!(normalize(
            r#"{"jsonrpc":"2.0","id":9,"method":"item/tool/requestUserInput","params":{"questions":[]}}"#
        )
        .is_empty());
    }

    /// The point of the whole split: two entirely different wire protocols
    /// reduce to the SAME event, so the permission UI, the phase machine, and
    /// the replay buffer never learn which CLI is running.
    ///
    /// Claude asks with a `control_request { subtype: "can_use_tool" }`; Codex
    /// asks with a JSON-RPC request carrying an id. Both must arrive as a
    /// [`SessionEvent::PermissionRequest`] naming a tool the registry's
    /// session-scoped allow list can key on.
    #[test]
    fn a_codex_approval_and_a_claude_can_use_tool_produce_the_same_event() {
        use super::super::claude_wire::frame_from_value;
        use super::super::ClaudeNormalizer;

        let claude_frame = frame_from_value(parse(
            r#"{"type":"control_request","request_id":"req_perm_1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"echo hello"},"permission_suggestions":[]}}"#,
        ));
        let claude = ClaudeNormalizer::new().normalize(claude_frame);
        let codex = normalize(APPROVAL_REQUEST);

        for (label, events) in [("claude", &claude), ("codex", &codex)] {
            assert!(
                matches!(
                    events.as_slice(),
                    [SessionEvent::PermissionRequest { request_id, tool_name, input, .. }]
                        if !request_id.is_empty()
                            && tool_name == "Bash"
                            && input["command"].as_str().is_some_and(|c| c.contains("echo hello"))
                ),
                "{label} did not produce one Bash PermissionRequest: {events:?}"
            );
        }

        // Same variant, same tag on the wire — the UI reads one shape.
        let tag = |event: &SessionEvent| serde_json::to_value(event).unwrap()["kind"].clone();
        assert_eq!(tag(&claude[0]), tag(&codex[0]));
        assert_eq!(tag(&claude[0]), serde_json::json!("permissionRequest"));
    }

    #[test]
    fn an_unknown_method_or_item_type_degrades_to_silence_not_to_an_error() {
        assert!(normalize(r#"{"method":"turn/plan/updated","params":{"plan":[]}}"#).is_empty());
        assert!(normalize(
            r#"{"method":"item/started","params":{"item":{"type":"somethingNew","id":"x"}}}"#
        )
        .is_empty());
        assert!(
            normalize(r#"{"jsonrpc":"2.0","id":4,"method":"someServer/request","params":{}}"#)
                .is_empty(),
            "an unsupported server request is the driver's to refuse, not ours to invent"
        );
    }
}

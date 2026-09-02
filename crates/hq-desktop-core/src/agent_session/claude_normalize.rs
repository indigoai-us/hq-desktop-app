//! [`Frame`] → [`SessionEvent`] normalization for the Claude CLI.
//!
//! Pure and synchronous: the only state is the small amount the wire itself
//! forces (init dedupe, the last-seen session id, and whether WE sent an
//! interrupt). Everything else is a straight per-frame mapping.

use serde_json::Value;

use super::claude_wire::{
    parse_ask_user_questions, parse_can_use_tool, parse_init_slash_commands, Frame,
};
use super::types::{DoneStatus, SessionEvent, SessionTool};

/// Human-readable text for the CLI's assistant-level error codes. These arrive
/// as a terse `error` field on an `assistant` frame — usually with NO text
/// content and NOT as a `result` error — so a usage-limited or otherwise
/// failed turn looks like the agent simply never replied unless we surface it.
fn assistant_error_text(code: &str) -> String {
    match code {
        "authentication_failed" => "Authentication failed — sign in to Claude again.".into(),
        "oauth_org_not_allowed" => "This organization isn't allowed to use Claude here.".into(),
        "billing_error" => "Billing error — check your Claude plan or payment method.".into(),
        "rate_limit" => "Claude usage limit reached — try again after the limit resets.".into(),
        "overloaded" => "Claude is overloaded right now — try again shortly.".into(),
        "invalid_request" => "The request was rejected as invalid.".into(),
        "model_not_found" => "The selected model isn't available.".into(),
        "server_error" => "Claude had a server error — try again.".into(),
        "max_output_tokens" => "The reply hit the maximum output length.".into(),
        "unknown" => "Claude returned an unspecified error.".into(),
        other => format!("Claude error: {other}"),
    }
}

/// Which claude.ai usage window a `rate_limit_event` refers to.
fn rate_window_label(kind: &str) -> &'static str {
    match kind {
        "five_hour" => "5-hour",
        "seven_day" | "seven_day_overage_included" => "weekly",
        "seven_day_opus" => "weekly (Opus)",
        "seven_day_sonnet" => "weekly (Sonnet)",
        "overage" => "overage",
        _ => "usage",
    }
}

/// Fallback wording for a failed `result` whose `errors` are empty, so a
/// failed turn never ends blank (and therefore invisible).
fn result_error_text(subtype: &str) -> &'static str {
    match subtype {
        "error_max_turns" => "The run hit the maximum number of turns.",
        "error_max_budget_usd" => "The run hit its cost budget.",
        "error_max_structured_output_retries" => "The run exhausted its structured-output retries.",
        _ => "The run ended with an error.",
    }
}

/// The CLI seeds `result.errors` with internal `[ede_diagnostic]` breadcrumbs
/// for its own turn-accounting telemetry ("result_type=… stop_reason=…").
/// They are not user-relevant errors and must never reach the transcript.
fn is_internal_diagnostic(message: &str) -> bool {
    message.contains("[ede_diagnostic]")
}

fn str_at(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

/// Normalize a `resetsAt` that may arrive as an epoch number or a string.
fn resets_at(info: &Value) -> Option<String> {
    ["resetsAt", "resets_at"]
        .iter()
        .find_map(|k| info.get(*k))
        .and_then(|v| match v {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        })
}

/// Content blocks of an `assistant`/`user` message, as a slice.
fn blocks(message: &Value) -> &[Value] {
    message
        .get("content")
        .and_then(Value::as_array)
        .map(|a| a.as_slice())
        .unwrap_or_default()
}

/// Per-session normalization state.
#[derive(Debug, Default)]
pub struct ClaudeNormalizer {
    /// `system:init` is re-emitted whenever the model is re-invoked WITHIN one
    /// session (a background-subagent wake turn, a scheduled wakeup), not just
    /// at start. Only the first one starts a session; later ones silently
    /// refresh the id.
    saw_init: bool,
    session_id: Option<String>,
    /// Set by the runner when IT sent an interrupt control request. The CLI
    /// then ends the turn with `error_during_execution` + `is_error`, which is
    /// indistinguishable from a real failure on the wire alone.
    interrupted: bool,
}

impl ClaudeNormalizer {
    pub fn new() -> Self {
        Self::default()
    }

    /// The most recent session id seen on an `init` or `result` frame.
    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    /// Record that we sent an interrupt. The next `result` closes the turn as
    /// [`DoneStatus::Interrupted`] with no error text, and the flag clears —
    /// a later turn in the same session ends normally.
    pub fn mark_interrupted(&mut self) {
        self.interrupted = true;
    }

    /// Normalize one stdout frame into 0+ unified events.
    pub fn normalize(&mut self, frame: Frame) -> Vec<SessionEvent> {
        match frame {
            Frame::System {
                subtype,
                session_id,
                model,
                tools,
                cwd,
                raw,
            } => {
                // `status`, `hook_started`, `hook_response`, `hook_progress`,
                // `thinking_tokens`, `task_started`, `task_notification` and
                // anything else newer are lifecycle chatter with no event.
                if subtype != "init" {
                    return Vec::new();
                }
                if self.saw_init {
                    // A wake turn's init: refresh the id, stay quiet, so the
                    // UI does not restart the transcript mid-session.
                    if !session_id.is_empty() {
                        self.session_id = Some(session_id);
                    }
                    return Vec::new();
                }
                self.saw_init = true;
                self.session_id = Some(session_id.clone());
                vec![SessionEvent::Started {
                    session_id,
                    tool: SessionTool::Claude,
                    model,
                    cwd,
                    tools,
                    commands: parse_init_slash_commands(&raw),
                    permission_mode: ["permissionMode", "permission_mode"]
                        .iter()
                        .find_map(|k| raw.get(*k))
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    capabilities: raw
                        .get("capabilities")
                        .and_then(Value::as_array)
                        .map(|a| a.as_slice())
                        .unwrap_or_default()
                        .iter()
                        .filter_map(|c| c.as_str().map(str::to_owned))
                        .collect(),
                }]
            }

            Frame::StreamEvent {
                event,
                parent_tool_use_id,
            } => {
                if event.get("type").and_then(Value::as_str) != Some("content_block_delta") {
                    return Vec::new();
                }
                let delta = event.get("delta").cloned().unwrap_or(Value::Null);
                match delta.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text_delta" => vec![SessionEvent::TextDelta {
                        text: str_at(&delta, "text"),
                        parent_tool_use_id,
                    }],
                    // Redacted thinking arrives with an empty `thinking` and
                    // only `estimated_tokens`; it is still a liveness beat, so
                    // it is passed through rather than dropped.
                    "thinking_delta" => vec![SessionEvent::ThinkingDelta {
                        text: str_at(&delta, "thinking"),
                    }],
                    // A tool input being generated, and the thinking-block
                    // signature: neither is renderable.
                    _ => Vec::new(),
                }
            }

            Frame::Assistant {
                message,
                error,
                parent_tool_use_id,
            } => {
                let mut out: Vec<SessionEvent> = blocks(&message)
                    .iter()
                    .filter_map(
                        |b| match b.get("type").and_then(Value::as_str).unwrap_or("") {
                            // A completed text block. The same text already
                            // streamed as `text_delta`s; the consumer uses this to
                            // seal the block (and it is the ONLY text a subagent
                            // ever produces — the wire streams no tagged deltas).
                            "text" => Some(SessionEvent::AssistantMessage {
                                text: str_at(b, "text"),
                                parent_tool_use_id: parent_tool_use_id.clone(),
                            }),
                            "tool_use" => Some(SessionEvent::ToolCall {
                                id: str_at(b, "id"),
                                name: str_at(b, "name"),
                                input: b.get("input").cloned().unwrap_or(Value::Null),
                                parent_tool_use_id: parent_tool_use_id.clone(),
                            }),
                            // `thinking` blocks already streamed as deltas.
                            _ => None,
                        },
                    )
                    .collect();
                if let Some(code) = error {
                    out.push(SessionEvent::Error {
                        message: assistant_error_text(&code),
                        code: Some(code),
                    });
                }
                out
            }

            Frame::User {
                message,
                parent_tool_use_id,
            } => blocks(&message)
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
                .map(|b| SessionEvent::ToolResult {
                    id: str_at(b, "tool_use_id"),
                    // Success results omit `is_error` entirely.
                    is_error: b.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                    content: b.get("content").cloned().unwrap_or(Value::Null),
                    parent_tool_use_id: parent_tool_use_id.clone(),
                })
                // Text blocks on a user frame are the CLI echoing a steer or
                // stamping `[Request interrupted by user]` — never new content.
                .collect(),

            // Emitted once per turn even when nothing is blocked; only a hard
            // `rejected` stopped the turn and is worth surfacing.
            Frame::RateLimitEvent { info } => {
                if info.get("status").and_then(Value::as_str) != Some("rejected") {
                    return Vec::new();
                }
                let window = rate_window_label(
                    info.get("rateLimitType")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                );
                vec![SessionEvent::RateLimit {
                    message: format!(
                        "Claude {window} limit reached — the turn was blocked. Try again after it resets."
                    ),
                    resets_at: resets_at(&info),
                }]
            }

            Frame::Result {
                subtype,
                is_error,
                result,
                errors,
                usage,
                session_id,
                total_cost_usd,
                duration_ms,
            } => {
                if let Some(id) = &session_id {
                    self.session_id = Some(id.clone());
                }
                let usage_event = SessionEvent::Usage {
                    input_tokens: usage
                        .get("input_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    output_tokens: usage
                        .get("output_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    cost_usd: total_cost_usd,
                    duration_ms,
                };

                // A turn WE interrupted ends as `error_during_execution` +
                // `is_error` — identical on the wire to a real failure, so the
                // runner's own signal decides.
                if std::mem::take(&mut self.interrupted) {
                    return vec![
                        usage_event,
                        SessionEvent::TurnDone {
                            status: DoneStatus::Interrupted,
                            error: None,
                            session_id,
                        },
                    ];
                }

                // `is_error` is authoritative: a recorded auth failure carries
                // `subtype:"success"` with `is_error:true`.
                if !is_error && subtype == "success" {
                    return vec![
                        usage_event,
                        SessionEvent::TurnDone {
                            status: DoneStatus::Success,
                            error: None,
                            session_id,
                        },
                    ];
                }

                // Split the CLI's internal telemetry breadcrumbs off the real
                // errors; only the real ones may reach the transcript.
                let (diagnostics, real): (Vec<String>, Vec<String>) =
                    errors.into_iter().partition(|m| is_internal_diagnostic(m));
                let error = if !real.is_empty() {
                    Some(real.join("; "))
                } else if let Some(text) = result.filter(|t| !t.trim().is_empty()) {
                    // A failed turn's `result` holds the user-facing reason
                    // ("Failed to authenticate: …").
                    Some(text)
                } else if matches!(
                    subtype.as_str(),
                    "error_max_turns"
                        | "error_max_budget_usd"
                        | "error_max_structured_output_retries"
                ) {
                    Some(result_error_text(&subtype).to_owned())
                } else if !diagnostics.is_empty() {
                    // Diagnostic-only end (typically `error_during_execution`
                    // after an abort): nothing user-relevant to show.
                    None
                } else {
                    Some(result_error_text(&subtype).to_owned())
                };
                vec![
                    usage_event,
                    SessionEvent::TurnDone {
                        status: DoneStatus::Error,
                        error,
                        session_id,
                    },
                ]
            }

            Frame::ControlRequest {
                request_id,
                subtype: _,
                request,
            } => {
                let Some(call) = parse_can_use_tool(&request) else {
                    // `interrupt` receipts and any other subtype are the
                    // runner's business, not the transcript's.
                    return Vec::new();
                };
                if call.tool_name == "AskUserQuestion" {
                    vec![SessionEvent::QuestionRequest {
                        request_id,
                        questions: parse_ask_user_questions(&call.input),
                    }]
                } else {
                    vec![SessionEvent::PermissionRequest {
                        request_id,
                        tool_name: call.tool_name,
                        input: call.input,
                        suggestions: call.permission_suggestions,
                    }]
                }
            }

            // Replies to OUR control requests are correlated by the runner.
            Frame::ControlResponse { .. } | Frame::Other(_) => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_session::claude_wire::parse_frame;
    use crate::agent_session::fixtures;
    use crate::agent_session::types::{Question, QuestionOption, SlashCommand};
    use serde_json::json;

    /// Feed raw lines through a fresh normalizer, concatenating the events.
    fn run(lines: &[&str]) -> Vec<SessionEvent> {
        let mut normalizer = ClaudeNormalizer::new();
        lines
            .iter()
            .flat_map(|line| normalizer.normalize(parse_frame(line).expect("frame parses")))
            .collect()
    }

    fn one(line: &str) -> Vec<SessionEvent> {
        run(&[line])
    }

    #[test]
    fn init_produces_started_from_the_recorded_frame() {
        assert_eq!(
            one(fixtures::SYSTEM_INIT),
            vec![SessionEvent::Started {
                session_id: "c34ee513-e375-415f-ae7b-1fb9a71b5953".into(),
                tool: SessionTool::Claude,
                model: "claude-haiku-4-5-20251001".into(),
                cwd: "/Users/jacobposel/Documents/HQ".into(),
                tools: vec!["Task".into(), "AskUserQuestion".into(), "Bash".into()],
                commands: vec![
                    SlashCommand {
                        name: "ask-andrew".into(),
                        description: String::new(),
                        argument_hint: None,
                    },
                    SlashCommand {
                        name: "ask-hormozi".into(),
                        description: String::new(),
                        argument_hint: None,
                    },
                ],
                permission_mode: Some("default".into()),
                capabilities: vec![
                    "interrupt_receipt_v1".into(),
                    "interrupt_cancel_queued_v1".into(),
                    "msg_lifecycle_v1".into(),
                ],
            }]
        );
    }

    #[test]
    fn a_repeat_init_is_deduped_but_still_refreshes_the_session_id() {
        let mut normalizer = ClaudeNormalizer::new();
        let first = normalizer.normalize(parse_frame(fixtures::SYSTEM_INIT).expect("parses"));
        assert_eq!(first.len(), 1);
        assert_eq!(
            normalizer.session_id(),
            Some("c34ee513-e375-415f-ae7b-1fb9a71b5953")
        );

        let second =
            normalizer.normalize(parse_frame(fixtures::SYSTEM_INIT_SECOND).expect("parses"));
        assert!(
            second.is_empty(),
            "a wake turn must not restart the session"
        );
        assert_eq!(normalizer.session_id(), Some("second-session-id"));
    }

    #[test]
    fn lifecycle_system_subtypes_are_silent() {
        for line in [
            fixtures::SYSTEM_STATUS,
            fixtures::SYSTEM_HOOK_STARTED,
            fixtures::SYSTEM_HOOK_RESPONSE,
            fixtures::SYSTEM_HOOK_PROGRESS,
            fixtures::SYSTEM_THINKING_TOKENS,
        ] {
            assert!(one(line).is_empty(), "expected no event for: {line}");
        }
        // Subagent lifecycle subtypes are equally silent (the events they
        // would carry are not part of this slice's model).
        for line in [
            r#"{"type":"system","subtype":"task_started","task_id":"agent_7","tool_use_id":"toolu_parent","subagent_type":"Explore"}"#,
            r#"{"type":"system","subtype":"task_notification","tool_use_id":"toolu_parent","status":"completed"}"#,
            r#"{"type":"system","subtype":"some_future_subtype"}"#,
        ] {
            assert!(one(line).is_empty(), "expected no event for: {line}");
        }
    }

    #[test]
    fn only_text_and_thinking_deltas_become_events() {
        assert_eq!(
            one(fixtures::STREAM_TEXT_DELTA),
            vec![SessionEvent::TextDelta {
                text: "core.yaml\ndocs\nhook-tests".into(),
                parent_tool_use_id: None,
            }]
        );
        assert_eq!(
            one(fixtures::STREAM_THINKING_DELTA),
            vec![SessionEvent::ThinkingDelta {
                text: "The user is asking me to run".into(),
            }]
        );
        for line in [
            fixtures::STREAM_MESSAGE_START,
            fixtures::STREAM_BLOCK_START,
            fixtures::STREAM_SIGNATURE_DELTA,
            fixtures::STREAM_INPUT_JSON_DELTA,
            fixtures::STREAM_BLOCK_STOP,
            fixtures::STREAM_MESSAGE_DELTA,
            fixtures::STREAM_MESSAGE_STOP,
        ] {
            assert!(one(line).is_empty(), "expected no event for: {line}");
        }
        // Redacted thinking still beats, so the UI does not read as stalled.
        assert_eq!(
            one(
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"","estimated_tokens":50}}}"#
            ),
            vec![SessionEvent::ThinkingDelta {
                text: String::new()
            }]
        );
    }

    #[test]
    fn subagent_frames_carry_their_parent_tool_use_id() {
        assert_eq!(
            one(fixtures::STREAM_TEXT_DELTA_SUBAGENT),
            vec![SessionEvent::TextDelta {
                text: "child".into(),
                parent_tool_use_id: Some("toolu_parent".into()),
            }]
        );
        assert_eq!(
            one(fixtures::ASSISTANT_SUBAGENT),
            vec![
                SessionEvent::AssistantMessage {
                    text: "child text".into(),
                    parent_tool_use_id: Some("toolu_parent".into()),
                },
                SessionEvent::ToolCall {
                    id: "toolu_child".into(),
                    name: "Read".into(),
                    input: json!({"file_path": "/a"}),
                    parent_tool_use_id: Some("toolu_parent".into()),
                },
            ]
        );
        assert_eq!(
            one(fixtures::USER_TOOL_RESULT_SUBAGENT),
            vec![SessionEvent::ToolResult {
                id: "toolu_child".into(),
                is_error: false,
                content: json!(
                    "File created successfully at: /Users/jacobposel/Documents/HQ/workspace/tmp/claude-spike/hello-allow.txt (file state is current in your context — no need to Read it back)"
                ),
                parent_tool_use_id: Some("toolu_parent".into()),
            }]
        );
    }

    #[test]
    fn assistant_blocks_map_in_order_and_thinking_never_repeats_as_text() {
        assert_eq!(
            one(fixtures::ASSISTANT_TEXT),
            vec![SessionEvent::AssistantMessage {
                text: "core.yaml\ndocs\nhook-tests".into(),
                parent_tool_use_id: None,
            }]
        );
        // The thinking block already streamed as deltas.
        assert!(one(fixtures::ASSISTANT_THINKING).is_empty());
        assert_eq!(
            one(fixtures::ASSISTANT_TOOL_USE),
            vec![SessionEvent::ToolCall {
                id: "toolu_01XBi6iRqmAPhVzA57VVYt2U".into(),
                name: "Write".into(),
                input: json!({
                    "file_path": "/Users/jacobposel/Documents/HQ/workspace/tmp/claude-spike/hello-allow.txt",
                    "content": "hello"
                }),
                parent_tool_use_id: None,
            }]
        );
    }

    #[test]
    fn an_assistant_error_code_is_surfaced_after_its_blocks() {
        assert_eq!(
            one(fixtures::ASSISTANT_AUTH_ERROR),
            vec![
                SessionEvent::AssistantMessage {
                    text:
                        "Failed to authenticate: OAuth session expired and could not be refreshed"
                            .into(),
                    parent_tool_use_id: None,
                },
                SessionEvent::Error {
                    message: "Authentication failed — sign in to Claude again.".into(),
                    code: Some("authentication_failed".into()),
                },
            ]
        );
    }

    #[test]
    fn the_assistant_error_code_mapping_table() {
        let cases = [
            (
                "authentication_failed",
                "Authentication failed — sign in to Claude again.",
            ),
            (
                "oauth_org_not_allowed",
                "This organization isn't allowed to use Claude here.",
            ),
            (
                "billing_error",
                "Billing error — check your Claude plan or payment method.",
            ),
            (
                "rate_limit",
                "Claude usage limit reached — try again after the limit resets.",
            ),
            (
                "overloaded",
                "Claude is overloaded right now — try again shortly.",
            ),
            ("invalid_request", "The request was rejected as invalid."),
            ("model_not_found", "The selected model isn't available."),
            ("server_error", "Claude had a server error — try again."),
            (
                "max_output_tokens",
                "The reply hit the maximum output length.",
            ),
            ("unknown", "Claude returned an unspecified error."),
            ("brand_new_code", "Claude error: brand_new_code"),
        ];
        for (code, message) in cases {
            let line = format!(
                r#"{{"type":"assistant","message":{{"content":[]}},"error":"{code}","parent_tool_use_id":null}}"#
            );
            assert_eq!(
                one(&line),
                vec![SessionEvent::Error {
                    message: message.into(),
                    code: Some(code.into()),
                }],
                "mapping for {code}"
            );
        }
    }

    #[test]
    fn an_ask_user_question_call_is_still_an_ordinary_tool_call_in_the_transcript() {
        // The QuestionRequest comes off the CONTROL channel; the assistant
        // frame's own `tool_use` block stays a plain tool call so the
        // transcript keeps its chip.
        assert_eq!(
            one(fixtures::ASSISTANT_ASK_USER_QUESTION),
            vec![SessionEvent::ToolCall {
                id: "toolu_01VbzzqawEeJjviJQo3G5fkZ".into(),
                name: "AskUserQuestion".into(),
                input: json!({
                    "questions": [{
                        "question": "Which color do you prefer?",
                        "header": "Color",
                        "multiSelect": false,
                        "options": [
                            {"label": "Red", "description": "The color red"},
                            {"label": "Blue", "description": "The color blue"}
                        ]
                    }]
                }),
                parent_tool_use_id: None,
            }]
        );
    }

    #[test]
    fn tool_results_map_including_the_denied_and_answered_shapes() {
        assert_eq!(
            one(fixtures::USER_TOOL_RESULT),
            vec![SessionEvent::ToolResult {
                id: "toolu_01XBi6iRqmAPhVzA57VVYt2U".into(),
                // The recorded success frame has no `is_error` key at all.
                is_error: false,
                content: json!(
                    "File created successfully at: /Users/jacobposel/Documents/HQ/workspace/tmp/claude-spike/hello-allow.txt (file state is current in your context — no need to Read it back)"
                ),
                parent_tool_use_id: None,
            }]
        );
        assert_eq!(
            one(fixtures::USER_TOOL_RESULT_DENIED),
            vec![SessionEvent::ToolResult {
                id: "toolu_016hcS56bGt8sieB3DR9jAZ1".into(),
                is_error: true,
                content: json!(
                    "Spike: user denied this tool call. Explain what you would have done instead."
                ),
                parent_tool_use_id: None,
            }]
        );
        assert_eq!(
            one(fixtures::USER_TOOL_RESULT_ANSWERS),
            vec![SessionEvent::ToolResult {
                id: "toolu_01VbzzqawEeJjviJQo3G5fkZ".into(),
                is_error: false,
                content: json!(
                    "Your questions have been answered: \"Which color do you prefer?\"=\"Blue\". You can now continue with these answers in mind."
                ),
                parent_tool_use_id: None,
            }]
        );
        // A steer / interruption marker echoed on the user channel is not
        // conversation and must not appear in the transcript.
        assert!(one(fixtures::USER_INTERRUPT_TEXT).is_empty());
    }

    #[test]
    fn only_a_rejected_rate_limit_surfaces() {
        assert!(one(fixtures::RATE_LIMIT_ALLOWED).is_empty());
        assert_eq!(
            one(fixtures::RATE_LIMIT_REJECTED),
            vec![SessionEvent::RateLimit {
                message:
                    "Claude 5-hour limit reached — the turn was blocked. Try again after it resets."
                        .into(),
                resets_at: Some("1788321600".into()),
            }]
        );
        // An unknown window still reads sensibly, and a string epoch passes
        // through unchanged.
        assert_eq!(
            one(
                r#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"brand_new","resetsAt":"2026-09-02T00:00:00Z"}}"#
            ),
            vec![SessionEvent::RateLimit {
                message:
                    "Claude usage limit reached — the turn was blocked. Try again after it resets."
                        .into(),
                resets_at: Some("2026-09-02T00:00:00Z".into()),
            }]
        );
    }

    #[test]
    fn a_successful_result_yields_usage_then_a_success_turn_done() {
        assert_eq!(
            one(fixtures::RESULT_SUCCESS),
            vec![
                SessionEvent::Usage {
                    input_tokens: 18,
                    output_tokens: 231,
                    cost_usd: Some(0.120_235),
                    duration_ms: Some(27201),
                },
                SessionEvent::TurnDone {
                    status: DoneStatus::Success,
                    error: None,
                    session_id: Some("bda49ac8-be7a-402e-aa29-530eb37cad06".into()),
                },
            ]
        );
    }

    #[test]
    fn is_error_beats_a_success_subtype() {
        assert_eq!(
            one(fixtures::RESULT_AUTH_FAILURE),
            vec![
                SessionEvent::Usage {
                    input_tokens: 0,
                    output_tokens: 0,
                    cost_usd: Some(0.0),
                    duration_ms: Some(2418),
                },
                SessionEvent::TurnDone {
                    status: DoneStatus::Error,
                    error: Some(
                        "Failed to authenticate: OAuth session expired and could not be refreshed"
                            .into()
                    ),
                    session_id: Some("c34ee513-e375-415f-ae7b-1fb9a71b5953".into()),
                },
            ]
        );
    }

    #[test]
    fn real_result_errors_win_over_the_mapped_wording() {
        assert_eq!(
            one(fixtures::RESULT_MAX_TURNS),
            vec![
                SessionEvent::Usage {
                    input_tokens: 7,
                    output_tokens: 8,
                    cost_usd: Some(0.12),
                    duration_ms: Some(900),
                },
                SessionEvent::TurnDone {
                    status: DoneStatus::Error,
                    error: Some("hit the cap".into()),
                    session_id: Some("c34ee513-e375-415f-ae7b-1fb9a71b5953".into()),
                },
            ]
        );
    }

    #[test]
    fn known_failure_subtypes_fall_back_to_mapped_wording() {
        for (subtype, message) in [
            (
                "error_max_turns",
                "The run hit the maximum number of turns.",
            ),
            ("error_max_budget_usd", "The run hit its cost budget."),
            (
                "error_max_structured_output_retries",
                "The run exhausted its structured-output retries.",
            ),
            ("error_something_new", "The run ended with an error."),
        ] {
            let line = format!(
                r#"{{"type":"result","subtype":"{subtype}","is_error":true,"usage":{{}},"session_id":"s1"}}"#
            );
            assert_eq!(
                one(&line),
                vec![
                    SessionEvent::Usage {
                        input_tokens: 0,
                        output_tokens: 0,
                        cost_usd: None,
                        duration_ms: None,
                    },
                    SessionEvent::TurnDone {
                        status: DoneStatus::Error,
                        error: Some(message.into()),
                        session_id: Some("s1".into()),
                    },
                ],
                "wording for {subtype}"
            );
        }
    }

    #[test]
    fn internal_ede_diagnostics_never_reach_the_transcript() {
        // Without an interrupt this is a genuine failure — but its only
        // `errors` entry is CLI telemetry, so no error text is surfaced.
        assert_eq!(
            one(fixtures::RESULT_INTERRUPTED),
            vec![
                SessionEvent::Usage {
                    input_tokens: 0,
                    output_tokens: 0,
                    cost_usd: Some(0.0),
                    duration_ms: Some(36437),
                },
                SessionEvent::TurnDone {
                    status: DoneStatus::Error,
                    error: None,
                    session_id: Some("c551f5ce-a8ed-460e-8d94-3c17ffd83217".into()),
                },
            ]
        );
        // A diagnostic mixed with a real error keeps only the real one.
        let events = one(
            r#"{"type":"result","subtype":"error_during_execution","is_error":true,"usage":{},"session_id":"s1","errors":["[ede_diagnostic] result_type=user","the disk filled up"]}"#,
        );
        assert_eq!(
            events[1],
            SessionEvent::TurnDone {
                status: DoneStatus::Error,
                error: Some("the disk filled up".into()),
                session_id: Some("s1".into()),
            }
        );
    }

    #[test]
    fn an_interrupt_we_sent_closes_the_turn_as_interrupted() {
        let mut normalizer = ClaudeNormalizer::new();
        normalizer.mark_interrupted();
        let events =
            normalizer.normalize(parse_frame(fixtures::RESULT_INTERRUPTED).expect("parses"));
        assert_eq!(
            events[1],
            SessionEvent::TurnDone {
                status: DoneStatus::Interrupted,
                error: None,
                session_id: Some("c551f5ce-a8ed-460e-8d94-3c17ffd83217".into()),
            }
        );

        // The flag is one-shot: the NEXT turn ends on its own merits.
        let events = normalizer.normalize(parse_frame(fixtures::RESULT_SUCCESS).expect("parses"));
        assert_eq!(
            events[1],
            SessionEvent::TurnDone {
                status: DoneStatus::Success,
                error: None,
                session_id: Some("bda49ac8-be7a-402e-aa29-530eb37cad06".into()),
            }
        );
    }

    #[test]
    fn can_use_tool_becomes_a_permission_request() {
        assert_eq!(
            one(fixtures::CONTROL_CAN_USE_TOOL),
            vec![SessionEvent::PermissionRequest {
                request_id: "db52ed9a-0c32-46db-8ed8-d0a8531c7460".into(),
                tool_name: "Write".into(),
                input: json!({
                    "file_path": "/Users/jacobposel/Documents/HQ/workspace/tmp/claude-spike/hello-allow.txt",
                    "content": "hello"
                }),
                suggestions: json!([
                    {"type": "setMode", "mode": "acceptEdits", "destination": "session"}
                ]),
            }]
        );
    }

    #[test]
    fn ask_user_question_becomes_a_question_request() {
        assert_eq!(
            one(fixtures::CONTROL_ASK_USER_QUESTION),
            vec![SessionEvent::QuestionRequest {
                request_id: "9a1e5daf-f08e-4cc9-a2e5-5c527871b79b".into(),
                questions: vec![Question {
                    id: "q0".into(),
                    header: "Color".into(),
                    text: "Which color do you prefer?".into(),
                    options: vec![
                        QuestionOption {
                            label: "Red".into(),
                            description: Some("The color red".into()),
                        },
                        QuestionOption {
                            label: "Blue".into(),
                            description: Some("The color blue".into()),
                        },
                    ],
                    multi_select: false,
                }],
            }]
        );
    }

    #[test]
    fn control_responses_and_unknown_frames_are_silent() {
        assert!(one(fixtures::CONTROL_INTERRUPT_RECEIPT).is_empty());
        assert!(one(fixtures::CONTROL_INITIALIZE_RESPONSE).is_empty());
        assert!(one(
            r#"{"type":"control_request","request_id":"x","request":{"subtype":"interrupt"}}"#
        )
        .is_empty());
        assert!(one(r#"{"type":"mystery_frame"}"#).is_empty());
    }

    #[test]
    fn a_whole_recorded_turn_normalizes_to_the_expected_sequence() {
        let events = run(&[
            fixtures::SYSTEM_INIT,
            fixtures::SYSTEM_HOOK_STARTED,
            fixtures::SYSTEM_STATUS,
            fixtures::SYSTEM_THINKING_TOKENS,
            fixtures::STREAM_MESSAGE_START,
            fixtures::STREAM_BLOCK_START,
            fixtures::STREAM_THINKING_DELTA,
            fixtures::STREAM_SIGNATURE_DELTA,
            fixtures::STREAM_BLOCK_STOP,
            fixtures::ASSISTANT_THINKING,
            fixtures::STREAM_INPUT_JSON_DELTA,
            fixtures::ASSISTANT_TOOL_USE,
            fixtures::CONTROL_CAN_USE_TOOL,
            fixtures::USER_TOOL_RESULT,
            fixtures::RATE_LIMIT_ALLOWED,
            fixtures::STREAM_TEXT_DELTA,
            fixtures::ASSISTANT_TEXT,
            fixtures::STREAM_MESSAGE_STOP,
            fixtures::RESULT_SUCCESS,
        ]);

        let kinds: Vec<&str> = events
            .iter()
            .map(|e| match e {
                SessionEvent::Started { .. } => "started",
                SessionEvent::TextDelta { .. } => "textDelta",
                SessionEvent::ThinkingDelta { .. } => "thinkingDelta",
                SessionEvent::AssistantMessage { .. } => "assistantMessage",
                SessionEvent::ToolCall { .. } => "toolCall",
                SessionEvent::ToolResult { .. } => "toolResult",
                SessionEvent::PermissionRequest { .. } => "permissionRequest",
                SessionEvent::QuestionRequest { .. } => "questionRequest",
                SessionEvent::Usage { .. } => "usage",
                SessionEvent::RateLimit { .. } => "rateLimit",
                SessionEvent::TurnDone { .. } => "turnDone",
                SessionEvent::Error { .. } => "error",
                SessionEvent::Exited { .. } => "exited",
                SessionEvent::Truncated { .. } => "truncated",
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                "started",
                "thinkingDelta",
                "toolCall",
                "permissionRequest",
                "toolResult",
                "textDelta",
                "assistantMessage",
                "usage",
                "turnDone",
            ]
        );
    }
}

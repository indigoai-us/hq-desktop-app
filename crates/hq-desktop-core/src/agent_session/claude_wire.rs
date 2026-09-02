//! Claude Code CLI `stream-json` wire: argv construction, stdout frame
//! parsing, and stdin line building. Pure functions over `&str` /
//! [`serde_json::Value`] — no process, no I/O, no Tauri.
//!
//! Tolerant by construction: every field defaults and unknown frame types map
//! to [`Frame::Other`], so a newer CLI never breaks parsing. Shapes were
//! recorded against claude 2.1.247 (`--print --input-format stream-json
//! --output-format stream-json --verbose`).

use serde_json::{json, Map, Value};

use super::types::{
    PermissionMode, Question, QuestionAnswer, QuestionOption, SessionSpec, SlashCommand,
};

/// Build the exact argv (after the executable) for a Claude session.
///
/// `--permission-prompt-tool stdio` is undocumented (absent from
/// `claude --help`) but routes `can_use_tool` — and therefore
/// `AskUserQuestion` — onto the stdio control channel instead of a TTY prompt.
pub fn build_args(spec: &SessionSpec) -> Vec<String> {
    let mut args: Vec<String> = [
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        // `--verbose` is REQUIRED alongside `--print --output-format
        // stream-json`; without it the CLI exits with a usage error.
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        // Newer models emit no readable thinking text unless a summary is
        // asked for (raw reasoning stays provider-private).
        "--thinking-display",
        "summarized",
        "--permission-prompt-tool",
        "stdio",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();

    match spec.permission_mode {
        PermissionMode::Prompt => {
            args.push("--permission-mode".into());
            args.push("default".into());
        }
        PermissionMode::BypassAll => {
            args.push("--permission-mode".into());
            args.push("bypassPermissions".into());
            args.push("--dangerously-skip-permissions".into());
        }
    }

    // A fresh run pins the id we minted; a resume adopts the CLI's own id.
    // Passing both is rejected by the CLI.
    match &spec.resume {
        None => {
            args.push("--session-id".into());
            args.push(spec.session_id.clone());
        }
        Some(resume) => {
            args.push("--resume".into());
            args.push(resume.clone());
        }
    }

    if let Some(model) = &spec.model {
        args.push("--model".into());
        args.push(model.clone());
    }
    if let Some(effort) = &spec.effort {
        args.push("--effort".into());
        args.push(effort.clone());
    }
    args
}

/// One parsed stdout JSONL line.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    /// `{"type":"system", ...}` — `init`, `status`, `hook_*`, `task_*`.
    System {
        subtype: String,
        session_id: String,
        model: String,
        tools: Vec<String>,
        cwd: String,
        /// The whole frame; `init` carries far more than the hot fields
        /// (`slash_commands`, `capabilities`, `permissionMode`, `skills`, …).
        raw: Value,
    },
    /// A partial-message event (`--include-partial-messages`).
    StreamEvent {
        event: Value,
        parent_tool_use_id: Option<String>,
    },
    Assistant {
        message: Value,
        /// Terse assistant-level error code (`rate_limit`, `billing_error`, …).
        error: Option<String>,
        parent_tool_use_id: Option<String>,
    },
    User {
        message: Value,
        parent_tool_use_id: Option<String>,
    },
    /// `rate_limit_event` — the `rate_limit_info` object.
    RateLimitEvent {
        info: Value,
    },
    Result {
        subtype: String,
        /// Independent of `subtype`: recorded frames carry
        /// `subtype:"success"` WITH `is_error:true` (auth failure).
        is_error: bool,
        result: Option<String>,
        errors: Vec<String>,
        usage: Value,
        session_id: Option<String>,
        total_cost_usd: Option<f64>,
        duration_ms: Option<u64>,
    },
    /// CLI → client (`can_use_tool`).
    ControlRequest {
        request_id: String,
        subtype: String,
        request: Value,
    },
    /// The CLI's reply to a client control request (`initialize`, `interrupt`).
    ControlResponse {
        response: Value,
    },
    Other(Value),
}

fn string_at(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn opt_string_at(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn string_vec_at(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}

/// Parse one stdout JSONL line. Blank or unparseable ⇒ `None`.
pub fn parse_frame(line: &str) -> Option<Frame> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(frame_from_value(serde_json::from_str(trimmed).ok()?))
}

/// [`parse_frame`] for a value that is already parsed.
///
/// The runner's transport hands it a `serde_json::Value` (the stdio child
/// parses each line to bound and observe it), and re-serializing that back to a
/// string just to parse it again would double the cost of every frame — on a
/// transcript where a single tool result can be megabytes.
pub fn frame_from_value(value: Value) -> Frame {
    let parent = |v: &Value| opt_string_at(v, "parent_tool_use_id");
    let frame = match value.get("type").and_then(Value::as_str).unwrap_or("") {
        "system" => Frame::System {
            subtype: string_at(&value, "subtype"),
            session_id: string_at(&value, "session_id"),
            model: string_at(&value, "model"),
            tools: string_vec_at(&value, "tools"),
            cwd: string_at(&value, "cwd"),
            raw: value,
        },
        "stream_event" => Frame::StreamEvent {
            event: value.get("event").cloned().unwrap_or(Value::Null),
            parent_tool_use_id: parent(&value),
        },
        "assistant" => Frame::Assistant {
            message: value.get("message").cloned().unwrap_or(Value::Null),
            error: opt_string_at(&value, "error"),
            parent_tool_use_id: parent(&value),
        },
        "user" => Frame::User {
            message: value.get("message").cloned().unwrap_or(Value::Null),
            parent_tool_use_id: parent(&value),
        },
        "rate_limit_event" => Frame::RateLimitEvent {
            info: value.get("rate_limit_info").cloned().unwrap_or(Value::Null),
        },
        "result" => Frame::Result {
            subtype: string_at(&value, "subtype"),
            is_error: value
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            result: opt_string_at(&value, "result"),
            errors: value
                .get("errors")
                .and_then(Value::as_array)
                .map(|a| a.as_slice())
                .unwrap_or_default()
                .iter()
                .map(|e| match e {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect(),
            usage: value.get("usage").cloned().unwrap_or(Value::Null),
            session_id: opt_string_at(&value, "session_id"),
            total_cost_usd: value.get("total_cost_usd").and_then(Value::as_f64),
            duration_ms: value.get("duration_ms").and_then(Value::as_u64),
        },
        "control_request" => {
            let request = value.get("request").cloned().unwrap_or(Value::Null);
            Frame::ControlRequest {
                request_id: string_at(&value, "request_id"),
                subtype: string_at(&request, "subtype"),
                request,
            }
        }
        "control_response" => Frame::ControlResponse {
            response: value.get("response").cloned().unwrap_or(Value::Null),
        },
        _ => Frame::Other(value),
    };
    frame
}

/// A stdin user turn. Steering = another such line mid-run.
///
/// Returned WITHOUT a trailing newline — the writer adds the framing.
pub fn user_message_line(text: &str) -> String {
    json!({
        "type": "user",
        "message": { "role": "user", "content": text },
        "parent_tool_use_id": null,
    })
    .to_string()
}

/// A stdin user turn whose content is an array of blocks: attached images
/// first, then the text (the standard Anthropic image+text message shape).
/// Empty `images` degrades to the plain [`user_message_line`].
///
/// Each image is `(media_type, base64)` — raw base64, no data-URL prefix.
pub fn user_message_line_with_images(text: &str, images: &[(String, String)]) -> String {
    if images.is_empty() {
        return user_message_line(text);
    }
    let mut blocks: Vec<Value> = images
        .iter()
        .map(|(media_type, data)| {
            json!({
                "type": "image",
                "source": { "type": "base64", "media_type": media_type, "data": data },
            })
        })
        .collect();
    blocks.push(json!({ "type": "text", "text": text }));
    json!({
        "type": "user",
        "message": { "role": "user", "content": blocks },
        "parent_tool_use_id": null,
    })
    .to_string()
}

/// Success reply to a CLI control request (`can_use_tool` allow/deny payloads).
pub fn control_response_line(request_id: &str, response: Value) -> String {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": response,
        },
    })
    .to_string()
}

/// `can_use_tool` allow payload carrying the (possibly rewritten) tool input.
pub fn allow_response(updated_input: Value) -> Value {
    json!({ "behavior": "allow", "updatedInput": updated_input })
}

/// `can_use_tool` deny payload.
pub fn deny_response(message: &str) -> Value {
    json!({ "behavior": "deny", "message": message })
}

/// Client → CLI interrupt control request.
pub fn interrupt_request_line(request_id: &str) -> String {
    json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": "interrupt" },
    })
    .to_string()
}

/// Client → CLI `initialize` handshake: answered with the command catalog,
/// model list, account, and current permission mode. Sending it costs no turn.
pub fn initialize_request_line(request_id: &str) -> String {
    json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": "initialize" },
    })
    .to_string()
}

/// Slash commands out of an `initialize` control_response payload — the OUTER
/// `response` object, i.e. `response.response.commands[]` with
/// `{name, description, argumentHint}`.
pub fn parse_initialize_commands(response: &Value) -> Vec<SlashCommand> {
    response
        .get("response")
        .and_then(|r| r.get("commands"))
        .and_then(Value::as_array)
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|c| {
            let name = c.get("name").and_then(Value::as_str)?.trim();
            if name.is_empty() {
                return None;
            }
            Some(SlashCommand {
                name: name.to_owned(),
                description: c
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                argument_hint: c
                    .get("argumentHint")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|h| !h.is_empty())
                    .map(str::to_owned),
            })
        })
        .collect()
}

/// The `models[]` array out of an `initialize` control_response payload,
/// passed through verbatim (`value` / `displayName` / `supportedEffortLevels`
/// / … — the model picker owns the shape, not this layer).
pub fn parse_initialize_models(response: &Value) -> Vec<Value> {
    response
        .get("response")
        .and_then(|r| r.get("models"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Slash commands out of a `system:init` frame, where they arrive as bare
/// NAME STRINGS (`slash_commands[]`) with no description or argument hint.
/// The `initialize` handshake is the richer source; this is the zero-round-trip
/// fallback so the composer has something the instant a session starts.
pub fn parse_init_slash_commands(raw: &Value) -> Vec<SlashCommand> {
    raw.get("slash_commands")
        .and_then(Value::as_array)
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|c| match c {
            Value::String(name) => Some(SlashCommand {
                name: name.trim().to_owned(),
                description: String::new(),
                argument_hint: None,
            }),
            // Tolerate a future object form.
            other => other
                .get("name")
                .and_then(Value::as_str)
                .map(|name| SlashCommand {
                    name: name.trim().to_owned(),
                    description: other
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    argument_hint: other
                        .get("argumentHint")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|h| !h.is_empty())
                        .map(str::to_owned),
                }),
        })
        .filter(|c| !c.name.is_empty())
        .collect()
}

/// A decoded `can_use_tool` control request.
#[derive(Debug, Clone, PartialEq)]
pub struct CanUseTool {
    pub tool_name: String,
    pub input: Value,
    /// The CLI's suggested permission-rule updates, passed through.
    pub permission_suggestions: Value,
}

/// Decode a `control_request` body. `None` unless the subtype is
/// `can_use_tool`.
pub fn parse_can_use_tool(request: &Value) -> Option<CanUseTool> {
    if request.get("subtype").and_then(Value::as_str) != Some("can_use_tool") {
        return None;
    }
    Some(CanUseTool {
        tool_name: string_at(request, "tool_name"),
        input: request.get("input").cloned().unwrap_or(Value::Null),
        permission_suggestions: ["permission_suggestions", "permissionSuggestions"]
            .iter()
            .find_map(|k| request.get(*k))
            .cloned()
            .unwrap_or(Value::Null),
    })
}

/// Parse an `AskUserQuestion` tool input into [`Question`]s. Tolerant of
/// `header`/`title`, `question`/`prompt`, `multiSelect`/`multi_select`, and
/// options given as bare strings or `{label, description}` objects. A question
/// without an `id` gets an index-based one so answers stay addressable.
pub fn parse_ask_user_questions(input: &Value) -> Vec<Question> {
    input
        .get("questions")
        .and_then(Value::as_array)
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(index, q)| {
            let field =
                |keys: [&str; 2]| keys.iter().find_map(|k| q.get(*k).and_then(Value::as_str));
            Question {
                id: q
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("q{index}")),
                header: field(["header", "title"]).unwrap_or("Question").to_owned(),
                text: field(["question", "prompt"]).unwrap_or("").to_owned(),
                options: q
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|a| a.as_slice())
                    .unwrap_or_default()
                    .iter()
                    .map(|op| match op {
                        Value::String(s) => QuestionOption {
                            label: s.clone(),
                            description: None,
                        },
                        other => QuestionOption {
                            label: other
                                .get("label")
                                .or_else(|| other.get("value"))
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned(),
                            description: other
                                .get("description")
                                .and_then(Value::as_str)
                                .filter(|d| !d.is_empty())
                                .map(str::to_owned),
                        },
                    })
                    .collect(),
                multi_select: ["multiSelect", "multi_select"]
                    .iter()
                    .find_map(|k| q.get(*k).and_then(Value::as_bool))
                    .unwrap_or(false),
            }
        })
        .collect()
}

/// Merge answers back into the `AskUserQuestion` tool input for the allow
/// payload: an `answers` object keyed by question TEXT, single-select ⇒ a
/// string, multi-select ⇒ an array. The original input is preserved alongside.
pub fn answers_updated_input(
    original_input: &Value,
    answers: &[QuestionAnswer],
    questions: &[Question],
) -> Value {
    let mut updated = match original_input {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    let mut by_question = Map::new();
    for question in questions {
        let values: Vec<String> = answers
            .iter()
            .find(|a| a.question_id == question.id)
            .map(|a| a.values.clone())
            .unwrap_or_default();
        let value = if question.multi_select {
            Value::Array(values.into_iter().map(Value::String).collect())
        } else {
            Value::String(values.into_iter().next().unwrap_or_default())
        };
        by_question.insert(question.text.clone(), value);
    }
    updated.insert("answers".into(), Value::Object(by_question));
    Value::Object(updated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_session::fixtures;
    use crate::agent_session::types::SessionTool;

    fn spec(permission_mode: PermissionMode, resume: Option<&str>) -> SessionSpec {
        SessionSpec {
            session_id: "sess-1".into(),
            tool: SessionTool::Claude,
            cwd: "/work".into(),
            company: None,
            model: None,
            effort: None,
            resume: resume.map(str::to_owned),
            permission_mode,
        }
    }

    /// The flags every session gets, up to and including `--permission-mode`.
    const BASE_ARGS: [&str; 12] = [
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--thinking-display",
        "summarized",
        "--permission-prompt-tool",
        "stdio",
        "--permission-mode",
    ];

    fn expected(tail: &[&str]) -> Vec<String> {
        BASE_ARGS
            .iter()
            .chain(tail.iter())
            .map(|s| (*s).to_owned())
            .collect()
    }

    #[test]
    fn build_args_prompt_mode_pins_a_fresh_session_id() {
        assert_eq!(
            build_args(&spec(PermissionMode::Prompt, None)),
            expected(&["default", "--session-id", "sess-1"])
        );
    }

    #[test]
    fn build_args_bypass_mode_adds_the_skip_flag() {
        assert_eq!(
            build_args(&spec(PermissionMode::BypassAll, None)),
            expected(&[
                "bypassPermissions",
                "--dangerously-skip-permissions",
                "--session-id",
                "sess-1",
            ])
        );
    }

    #[test]
    fn build_args_resume_replaces_session_id_and_appends_model_and_effort() {
        let mut s = spec(PermissionMode::Prompt, Some("prev-session"));
        s.model = Some("opus[1m]".into());
        s.effort = Some("high".into());
        let args = build_args(&s);
        assert_eq!(
            args,
            expected(&[
                "default",
                "--resume",
                "prev-session",
                "--model",
                "opus[1m]",
                "--effort",
                "high",
            ])
        );
        // Passing both a resume and a fresh id is rejected by the CLI.
        assert!(!args.iter().any(|a| a == "--session-id"));
    }

    #[test]
    fn parses_the_recorded_init_frame() {
        match parse_frame(fixtures::SYSTEM_INIT).expect("parses") {
            Frame::System {
                subtype,
                session_id,
                model,
                tools,
                cwd,
                raw,
            } => {
                assert_eq!(subtype, "init");
                assert_eq!(session_id, "c34ee513-e375-415f-ae7b-1fb9a71b5953");
                assert_eq!(model, "claude-haiku-4-5-20251001");
                assert_eq!(tools, vec!["Task", "AskUserQuestion", "Bash"]);
                assert_eq!(cwd, "/Users/jacobposel/Documents/HQ");
                // The hot fields the normalizer reads straight off `raw`.
                assert_eq!(raw["permissionMode"], "default");
                assert_eq!(raw["capabilities"][0], "interrupt_receipt_v1");
                assert_eq!(raw["claude_code_version"], "2.1.247");

                // `slash_commands` are bare NAME STRINGS on the init frame.
                let commands = parse_init_slash_commands(&raw);
                assert_eq!(
                    commands.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
                    vec!["ask-andrew", "ask-hormozi"]
                );
                assert!(commands[0].description.is_empty());
                assert!(commands[0].argument_hint.is_none());
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn parse_init_slash_commands_tolerates_an_object_form_and_junk() {
        let commands = parse_init_slash_commands(&json!({
            "slash_commands": [
                {"name": "plan", "description": "d", "argumentHint": "<goal>"},
                {"name": "bare"},
                {"name": "  "},
                17
            ]
        }));
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0].argument_hint.as_deref(), Some("<goal>"));
        assert_eq!(commands[1].name, "bare");
        assert!(parse_init_slash_commands(&json!({})).is_empty());
    }

    #[test]
    fn parses_the_non_init_system_subtypes_the_cli_streams() {
        for (line, subtype) in [
            (fixtures::SYSTEM_STATUS, "status"),
            (fixtures::SYSTEM_HOOK_STARTED, "hook_started"),
            (fixtures::SYSTEM_HOOK_RESPONSE, "hook_response"),
            (fixtures::SYSTEM_HOOK_PROGRESS, "hook_progress"),
            (fixtures::SYSTEM_THINKING_TOKENS, "thinking_tokens"),
        ] {
            match parse_frame(line).expect("parses") {
                Frame::System { subtype: got, .. } => assert_eq!(got, subtype),
                other => panic!("unexpected frame for {subtype}: {other:?}"),
            }
        }
    }

    #[test]
    fn parses_every_recorded_stream_event_shape() {
        for (line, kind, delta_kind) in [
            (fixtures::STREAM_MESSAGE_START, "message_start", None),
            (fixtures::STREAM_BLOCK_START, "content_block_start", None),
            (
                fixtures::STREAM_TEXT_DELTA,
                "content_block_delta",
                Some("text_delta"),
            ),
            (
                fixtures::STREAM_THINKING_DELTA,
                "content_block_delta",
                Some("thinking_delta"),
            ),
            (
                fixtures::STREAM_SIGNATURE_DELTA,
                "content_block_delta",
                Some("signature_delta"),
            ),
            (
                fixtures::STREAM_INPUT_JSON_DELTA,
                "content_block_delta",
                Some("input_json_delta"),
            ),
            (fixtures::STREAM_BLOCK_STOP, "content_block_stop", None),
            (fixtures::STREAM_MESSAGE_DELTA, "message_delta", None),
            (fixtures::STREAM_MESSAGE_STOP, "message_stop", None),
        ] {
            match parse_frame(line).expect("parses") {
                Frame::StreamEvent {
                    event,
                    parent_tool_use_id,
                } => {
                    assert_eq!(event["type"], kind);
                    if let Some(delta_kind) = delta_kind {
                        assert_eq!(event["delta"]["type"], delta_kind);
                    }
                    // An explicit JSON `null` must read as None, not Some("").
                    assert_eq!(parent_tool_use_id, None);
                }
                other => panic!("unexpected frame for {kind}: {other:?}"),
            }
        }
        match parse_frame(fixtures::STREAM_TEXT_DELTA_SUBAGENT).expect("parses") {
            Frame::StreamEvent {
                parent_tool_use_id, ..
            } => assert_eq!(parent_tool_use_id.as_deref(), Some("toolu_parent")),
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn parses_assistant_text_thinking_tool_use_and_error_frames() {
        match parse_frame(fixtures::ASSISTANT_TEXT).expect("parses") {
            Frame::Assistant { message, error, .. } => {
                assert!(error.is_none());
                assert_eq!(message["content"][0]["type"], "text");
                assert_eq!(message["content"][0]["text"], "core.yaml\ndocs\nhook-tests");
            }
            other => panic!("unexpected frame: {other:?}"),
        }
        match parse_frame(fixtures::ASSISTANT_THINKING).expect("parses") {
            Frame::Assistant { message, .. } => {
                assert_eq!(message["content"][0]["type"], "thinking")
            }
            other => panic!("unexpected frame: {other:?}"),
        }
        match parse_frame(fixtures::ASSISTANT_TOOL_USE).expect("parses") {
            Frame::Assistant { message, .. } => {
                assert_eq!(message["content"][0]["type"], "tool_use");
                assert_eq!(message["content"][0]["name"], "Write");
                assert_eq!(
                    message["content"][0]["id"],
                    "toolu_01XBi6iRqmAPhVzA57VVYt2U"
                );
            }
            other => panic!("unexpected frame: {other:?}"),
        }
        match parse_frame(fixtures::ASSISTANT_AUTH_ERROR).expect("parses") {
            Frame::Assistant { error, .. } => {
                assert_eq!(error.as_deref(), Some("authentication_failed"))
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn parses_user_tool_result_frames_including_the_missing_is_error_key() {
        match parse_frame(fixtures::USER_TOOL_RESULT).expect("parses") {
            Frame::User { message, .. } => {
                let block = &message["content"][0];
                assert_eq!(block["type"], "tool_result");
                assert_eq!(block["tool_use_id"], "toolu_01XBi6iRqmAPhVzA57VVYt2U");
                // Recorded ground truth: success results omit `is_error`.
                assert!(block.get("is_error").is_none());
            }
            other => panic!("unexpected frame: {other:?}"),
        }
        match parse_frame(fixtures::USER_TOOL_RESULT_DENIED).expect("parses") {
            Frame::User { message, .. } => {
                assert_eq!(message["content"][0]["is_error"], true);
                assert!(message["content"][0]["content"]
                    .as_str()
                    .expect("deny text")
                    .contains("denied this tool call"));
            }
            other => panic!("unexpected frame: {other:?}"),
        }
        match parse_frame(fixtures::USER_INTERRUPT_TEXT).expect("parses") {
            Frame::User { message, .. } => {
                assert_eq!(message["content"][0]["type"], "text");
                assert_eq!(
                    message["content"][0]["text"],
                    "[Request interrupted by user]"
                );
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn parses_rate_limit_event_frames() {
        match parse_frame(fixtures::RATE_LIMIT_REJECTED).expect("parses") {
            Frame::RateLimitEvent { info } => {
                assert_eq!(info["status"], "rejected");
                assert_eq!(info["rateLimitType"], "five_hour");
                assert_eq!(info["resetsAt"], 1_788_321_600u64);
            }
            other => panic!("unexpected frame: {other:?}"),
        }
        match parse_frame(fixtures::RATE_LIMIT_ALLOWED).expect("parses") {
            Frame::RateLimitEvent { info } => assert_eq!(info["status"], "allowed"),
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn parses_the_recorded_result_frames() {
        // subtype says success, is_error says otherwise — both are recorded.
        match parse_frame(fixtures::RESULT_AUTH_FAILURE).expect("parses") {
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
                assert_eq!(subtype, "success");
                assert!(is_error);
                assert!(result
                    .expect("result text")
                    .starts_with("Failed to authenticate"));
                assert!(errors.is_empty());
                assert_eq!(usage["input_tokens"], 0);
                assert_eq!(
                    session_id.as_deref(),
                    Some("c34ee513-e375-415f-ae7b-1fb9a71b5953")
                );
                assert_eq!(total_cost_usd, Some(0.0));
                assert_eq!(duration_ms, Some(2418));
            }
            other => panic!("unexpected frame: {other:?}"),
        }
        match parse_frame(fixtures::RESULT_SUCCESS).expect("parses") {
            Frame::Result {
                subtype,
                is_error,
                usage,
                total_cost_usd,
                duration_ms,
                result,
                ..
            } => {
                assert_eq!(subtype, "success");
                assert!(!is_error);
                assert_eq!(usage["input_tokens"], 18);
                assert_eq!(usage["output_tokens"], 231);
                // The recorded `0.12023500000000001` is this exact f64.
                assert_eq!(total_cost_usd, Some(0.120_235));
                assert_eq!(duration_ms, Some(27201));
                assert_eq!(result.as_deref(), Some("core.yaml\ndocs\nhook-tests"));
            }
            other => panic!("unexpected frame: {other:?}"),
        }
        match parse_frame(fixtures::RESULT_INTERRUPTED).expect("parses") {
            Frame::Result {
                subtype,
                is_error,
                result,
                errors,
                ..
            } => {
                assert_eq!(subtype, "error_during_execution");
                assert!(is_error);
                assert!(result.is_none());
                assert_eq!(errors.len(), 1);
                assert!(errors[0].contains("[ede_diagnostic]"));
            }
            other => panic!("unexpected frame: {other:?}"),
        }
        match parse_frame(fixtures::RESULT_MAX_TURNS).expect("parses") {
            Frame::Result {
                subtype,
                is_error,
                errors,
                total_cost_usd,
                duration_ms,
                ..
            } => {
                assert_eq!(subtype, "error_max_turns");
                assert!(is_error);
                assert_eq!(errors, vec!["hit the cap".to_string()]);
                assert_eq!(total_cost_usd, Some(0.12));
                assert_eq!(duration_ms, Some(900));
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn parses_the_recorded_can_use_tool_requests() {
        match parse_frame(fixtures::CONTROL_CAN_USE_TOOL).expect("parses") {
            Frame::ControlRequest {
                request_id,
                subtype,
                request,
            } => {
                assert_eq!(request_id, "db52ed9a-0c32-46db-8ed8-d0a8531c7460");
                assert_eq!(subtype, "can_use_tool");
                let decoded = parse_can_use_tool(&request).expect("can_use_tool");
                assert_eq!(decoded.tool_name, "Write");
                assert_eq!(decoded.input["content"], "hello");
                assert_eq!(decoded.permission_suggestions[0]["type"], "setMode");
                assert_eq!(decoded.permission_suggestions[0]["mode"], "acceptEdits");
            }
            other => panic!("unexpected frame: {other:?}"),
        }
        match parse_frame(fixtures::CONTROL_ASK_USER_QUESTION).expect("parses") {
            Frame::ControlRequest { request, .. } => {
                let decoded = parse_can_use_tool(&request).expect("can_use_tool");
                assert_eq!(decoded.tool_name, "AskUserQuestion");
                assert_eq!(request["requires_user_interaction"], true);
                // No suggestions ride an AskUserQuestion request.
                assert!(decoded.permission_suggestions.is_null());
                let questions = parse_ask_user_questions(&decoded.input);
                assert_eq!(questions.len(), 1);
                assert_eq!(questions[0].header, "Color");
                assert_eq!(questions[0].text, "Which color do you prefer?");
                assert!(!questions[0].multi_select);
                assert_eq!(
                    questions[0].options,
                    vec![
                        QuestionOption {
                            label: "Red".into(),
                            description: Some("The color red".into())
                        },
                        QuestionOption {
                            label: "Blue".into(),
                            description: Some("The color blue".into())
                        },
                    ]
                );
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn the_recorded_ask_answer_round_trip_reproduces_the_line_we_sent() {
        // Ground truth: `ask.sent.jsonl` line 2, which the CLI accepted and
        // answered "Blue." to.
        let Frame::ControlRequest {
            request_id,
            request,
            ..
        } = parse_frame(fixtures::CONTROL_ASK_USER_QUESTION).expect("parses")
        else {
            panic!("expected a control request");
        };
        let decoded = parse_can_use_tool(&request).expect("can_use_tool");
        let questions = parse_ask_user_questions(&decoded.input);
        let answers = vec![QuestionAnswer {
            question_id: questions[0].id.clone(),
            values: vec!["Blue".into()],
        }];
        let updated = answers_updated_input(&decoded.input, &answers, &questions);
        let line = control_response_line(&request_id, allow_response(updated));
        let sent: Value = serde_json::from_str(&line).expect("json");
        assert_eq!(
            sent,
            json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": "9a1e5daf-f08e-4cc9-a2e5-5c527871b79b",
                    "response": {
                        "behavior": "allow",
                        "updatedInput": {
                            "questions": [{
                                "question": "Which color do you prefer?",
                                "header": "Color",
                                "options": [
                                    {"label": "Red", "description": "The color red"},
                                    {"label": "Blue", "description": "The color blue"}
                                ],
                                "multiSelect": false
                            }],
                            "answers": {"Which color do you prefer?": "Blue"}
                        }
                    }
                }
            })
        );
    }

    #[test]
    fn parses_control_responses() {
        match parse_frame(fixtures::CONTROL_INTERRUPT_RECEIPT).expect("parses") {
            Frame::ControlResponse { response } => {
                assert_eq!(response["request_id"], "int_1");
                assert_eq!(response["subtype"], "success");
                assert_eq!(response["response"]["still_queued"], json!([]));
            }
            other => panic!("unexpected frame: {other:?}"),
        }
        match parse_frame(fixtures::CONTROL_INITIALIZE_RESPONSE).expect("parses") {
            Frame::ControlResponse { response } => {
                assert_eq!(response["request_id"], "init_1");
                let commands = parse_initialize_commands(&response);
                // The blank-name entry is dropped.
                assert_eq!(commands.len(), 2);
                assert_eq!(commands[0].name, "ask-andrew");
                assert!(commands[0]
                    .description
                    .starts_with("Search locally indexed"));
                // An empty `argumentHint` collapses to None.
                assert!(commands[0].argument_hint.is_none());
                assert_eq!(commands[1].name, "conduct");
                assert_eq!(
                    commands[1].argument_hint.as_deref(),
                    Some("[agent] [task description] | status | off")
                );

                let models = parse_initialize_models(&response);
                assert_eq!(models.len(), 1);
                assert_eq!(models[0]["value"], "default");
                assert_eq!(models[0]["resolvedModel"], "claude-opus-5[1m]");
                assert_eq!(response["response"]["current_permission_mode"], "default");
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn control_request_that_is_not_can_use_tool_decodes_to_none() {
        assert!(parse_can_use_tool(&json!({"subtype": "interrupt"})).is_none());
        assert!(parse_can_use_tool(&Value::Null).is_none());
    }

    #[test]
    fn can_use_tool_accepts_the_camel_case_suggestions_key_too() {
        let decoded = parse_can_use_tool(&json!({
            "subtype": "can_use_tool",
            "tool_name": "Bash",
            "input": {"command": "ls"},
            "permissionSuggestions": [{"type": "addRules"}]
        }))
        .expect("can_use_tool");
        assert_eq!(decoded.permission_suggestions[0]["type"], "addRules");
    }

    #[test]
    fn unknown_blank_and_garbage_lines() {
        assert!(parse_frame("").is_none());
        assert!(parse_frame("   \n").is_none());
        assert!(parse_frame("not json").is_none());
        assert!(parse_frame("{oops").is_none());
        match parse_frame(r#"{"type":"mystery_frame","x":1}"#).expect("parses") {
            Frame::Other(v) => assert_eq!(v["x"], 1),
            other => panic!("unexpected frame: {other:?}"),
        }
        // A JSON line with no `type` is Other, not a panic.
        assert!(matches!(
            parse_frame(r#"{"hello":"world"}"#).expect("parses"),
            Frame::Other(_)
        ));
        // A truncated/half-written line is dropped, not misread.
        assert!(parse_frame(r#"{"type":"assistant","message":{"con"#).is_none());
    }

    #[test]
    fn user_message_line_shape() {
        let line = user_message_line("hi");
        assert!(!line.ends_with('\n'), "the writer owns the framing");
        assert_eq!(
            serde_json::from_str::<Value>(&line).expect("json"),
            json!({
                "type": "user",
                "message": {"role": "user", "content": "hi"},
                "parent_tool_use_id": null
            })
        );
    }

    #[test]
    fn user_message_line_with_images_puts_images_first() {
        let line =
            user_message_line_with_images("what is this?", &[("image/png".into(), "QUJD".into())]);
        assert!(!line.ends_with('\n'));
        assert_eq!(
            serde_json::from_str::<Value>(&line).expect("json"),
            json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [
                        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "QUJD"}},
                        {"type": "text", "text": "what is this?"}
                    ]
                },
                "parent_tool_use_id": null
            })
        );
        assert_eq!(
            user_message_line_with_images("hi", &[]),
            user_message_line("hi")
        );
    }

    #[test]
    fn control_response_and_decision_payload_shapes() {
        let line = control_response_line("req_1", allow_response(json!({"a": 1})));
        assert!(!line.ends_with('\n'));
        assert_eq!(
            serde_json::from_str::<Value>(&line).expect("json"),
            json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": "req_1",
                    "response": {"behavior": "allow", "updatedInput": {"a": 1}}
                }
            })
        );
        assert_eq!(
            deny_response("not allowed"),
            json!({"behavior": "deny", "message": "not allowed"})
        );
    }

    #[test]
    fn interrupt_and_initialize_request_shapes() {
        assert_eq!(
            serde_json::from_str::<Value>(&interrupt_request_line("int_1")).expect("json"),
            json!({
                "type": "control_request",
                "request_id": "int_1",
                "request": {"subtype": "interrupt"}
            })
        );
        assert_eq!(
            serde_json::from_str::<Value>(&initialize_request_line("init_1")).expect("json"),
            json!({
                "type": "control_request",
                "request_id": "init_1",
                "request": {"subtype": "initialize"}
            })
        );
    }

    #[test]
    fn parses_ask_user_questions_tolerantly() {
        let input = json!({
            "questions": [
                {
                    "header": "Choice",
                    "question": "Pick one",
                    "options": ["A", {"label": "B", "description": "second"}],
                    "multiSelect": false
                },
                {"title": "Alt", "prompt": "Pick many", "multi_select": true},
                {"id": "explicit", "header": "H", "question": "Q", "options": [{"value": "V"}]}
            ]
        });
        let questions = parse_ask_user_questions(&input);
        assert_eq!(questions.len(), 3);

        assert_eq!(questions[0].id, "q0");
        assert_eq!(questions[0].header, "Choice");
        assert_eq!(questions[0].text, "Pick one");
        assert!(!questions[0].multi_select);
        assert_eq!(
            questions[0].options,
            vec![
                QuestionOption {
                    label: "A".into(),
                    description: None
                },
                QuestionOption {
                    label: "B".into(),
                    description: Some("second".into())
                },
            ]
        );

        // `title`/`prompt`/`multi_select` spellings.
        assert_eq!(questions[1].id, "q1");
        assert_eq!(questions[1].header, "Alt");
        assert_eq!(questions[1].text, "Pick many");
        assert!(questions[1].multi_select);
        assert!(questions[1].options.is_empty());

        // An explicit id wins; `value` stands in for a missing `label`.
        assert_eq!(questions[2].id, "explicit");
        assert_eq!(questions[2].options[0].label, "V");

        // A missing or non-array `questions` yields nothing rather than panicking.
        assert!(parse_ask_user_questions(&json!({})).is_empty());
        assert!(parse_ask_user_questions(&json!({"questions": 3})).is_empty());
        // A question with no header at all still gets a usable one.
        let fallback = parse_ask_user_questions(&json!({"questions": [{}]}));
        assert_eq!(fallback[0].header, "Question");
        assert!(fallback[0].text.is_empty());
    }

    #[test]
    fn answers_are_keyed_by_question_text() {
        let input = json!({
            "questions": [
                {"header": "H", "question": "Pick one", "options": ["A", "B"]},
                {"header": "H2", "question": "Pick many", "options": ["X", "Y"], "multiSelect": true},
                {"header": "H3", "question": "Unanswered", "options": ["Z"]}
            ]
        });
        let questions = parse_ask_user_questions(&input);
        let answers = vec![
            QuestionAnswer {
                question_id: "q0".into(),
                values: vec!["B".into()],
            },
            QuestionAnswer {
                question_id: "q1".into(),
                values: vec!["X".into(), "Y".into()],
            },
        ];
        let updated = answers_updated_input(&input, &answers, &questions);
        assert_eq!(updated["answers"]["Pick one"], json!("B"));
        assert_eq!(updated["answers"]["Pick many"], json!(["X", "Y"]));
        // An unanswered single-select degrades to an empty string, never null.
        assert_eq!(updated["answers"]["Unanswered"], json!(""));
        // The original input is preserved alongside the answers.
        assert!(updated["questions"].is_array());

        // A non-object input still produces a well-formed allow payload.
        let updated = answers_updated_input(&Value::Null, &answers, &questions);
        assert_eq!(updated["answers"]["Pick one"], json!("B"));
    }
}

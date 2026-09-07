//! Pure session model types: the spec used to launch an agent CLI, and the
//! normalized [`SessionEvent`] stream every tool (Claude today, Codex next) is
//! reduced to.
//!
//! Wire contract: every type is `camelCase` on the wire and every enum that
//! carries variant data is INTERNALLY tagged on `kind`. A TypeScript mirror is
//! hand-written from these names, so the tags and field names here are
//! load-bearing — the round-trip tests below pin them.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Which agent CLI a session drives.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionTool {
    Claude,
    Codex,
}

/// How tool-permission requests are handled for a session.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    /// Ask the user (`--permission-mode default` + the stdio prompt tool).
    Prompt,
    /// Approve everything (`bypassPermissions`).
    BypassAll,
}

/// How a turn ended.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DoneStatus {
    Success,
    Error,
    Interrupted,
}

/// Coarse UI state of a session.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionPhase {
    Starting,
    Idle,
    Working,
    NeedsYou,
    Ended,
}

/// Everything needed to launch (or resume) one agent session. Pure data — no
/// process, no path resolution; the runner turns this into a child process.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSpec {
    /// Client-minted id. Used as `--session-id` on a fresh run.
    pub session_id: String,
    /// Provider-native title supplied when wrapping a resumed conversation.
    /// Fresh sessions derive this from their first visible operator prompt.
    #[serde(default)]
    pub title: Option<String>,
    pub tool: SessionTool,
    pub cwd: String,
    /// Active HQ company, when the session is bound to one.
    pub company: Option<String>,
    /// The company project this session works on — the project DIRECTORY
    /// slug under `companies/<co>/projects/`, which is also what its channel
    /// (`p-<slug>`) is named from. Optional and `default` on the wire so an
    /// older composer that never sends it still parses.
    #[serde(default)]
    pub project: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Existing CLI session id to resume; mutually exclusive with a fresh
    /// `--session-id`.
    pub resume: Option<String>,
    pub permission_mode: PermissionMode,
}

/// What the operator's composer pills say the NEXT turn should use.
///
/// Absolute, not a patch: a missing field is the user choosing the CLI's own
/// default ("Default" / "Auto"), which is a real choice and must be able to
/// clear a previous one. Only Codex can honour these mid-session (`turn/start`
/// takes `model` and `effort` per turn); Claude's driver drops them, because a
/// running `claude --print` cannot change either.
///
/// Changing a model or an effort NEVER forks the chat — only a company change
/// does, because a company is what binds the session's context.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnOverrides {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

/// One slash command offered by the CLI (composer autocomplete).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    pub argument_hint: Option<String>,
}

/// One selectable answer for a [`Question`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
}

/// A structured question the agent asked (Claude's `AskUserQuestion` tool).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: String,
    pub header: String,
    pub text: String,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
}

/// The user's answer to one [`Question`], by option label(s).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnswer {
    pub question_id: String,
    pub values: Vec<String>,
}

/// What the user chose for a [`SessionEvent::PermissionRequest`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PermissionDecision {
    /// Allow this call, unchanged.
    AllowOnce,
    /// Allow this call and remember the tool for the rest of the session.
    AllowSession,
    /// Allow with a rewritten tool input.
    Allow {
        updated_input: Value,
    },
    Deny {
        message: String,
    },
}

/// The normalized event stream. One agent CLI frame produces 0+ of these; the
/// UI and the journal consume nothing else.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SessionEvent {
    /// The session handshake landed (Claude's `system:init`).
    Started {
        session_id: String,
        tool: SessionTool,
        model: String,
        cwd: String,
        tools: Vec<String>,
        commands: Vec<SlashCommand>,
        /// The CLI's own permission-mode string (`default`, `bypassPermissions`).
        permission_mode: Option<String>,
        /// Protocol capabilities the CLI advertises (`interrupt_receipt_v1`, …).
        capabilities: Vec<String>,
    },
    /// A turn the OPERATOR sent.
    ///
    /// Not produced by the CLI — the app records its own side of the
    /// conversation as it writes it, so the replay buffer holds a dialogue
    /// rather than a monologue and a reopened session still shows what the
    /// user asked for.
    ///
    /// Only the count of attached images is kept. The bytes are megabytes of
    /// base64 that the ring would evict real transcript to hold, and the model
    /// has already seen them.
    UserMessage { text: String, image_count: u32 },
    /// A streamed fragment of assistant text.
    TextDelta {
        text: String,
        parent_tool_use_id: Option<String>,
    },
    /// A streamed fragment of (summarized) reasoning.
    ThinkingDelta { text: String },
    /// A COMPLETED assistant text block (arrives on the `assistant` frame,
    /// after the deltas that streamed it — subagents only ever get these).
    AssistantMessage {
        text: String,
        parent_tool_use_id: Option<String>,
    },
    ToolCall {
        id: String,
        name: String,
        input: Value,
        parent_tool_use_id: Option<String>,
    },
    ToolResult {
        id: String,
        is_error: bool,
        content: Value,
        parent_tool_use_id: Option<String>,
    },
    /// The CLI is blocked waiting for an allow/deny on a tool call.
    PermissionRequest {
        request_id: String,
        tool_name: String,
        input: Value,
        suggestions: Value,
    },
    /// The CLI is blocked waiting for structured answers.
    QuestionRequest {
        request_id: String,
        questions: Vec<Question>,
    },
    Usage {
        input_tokens: u64,
        output_tokens: u64,
        cost_usd: Option<f64>,
        duration_ms: Option<u64>,
    },
    /// A claude.ai usage window blocked the turn.
    RateLimit {
        message: String,
        resets_at: Option<String>,
    },
    /// A hook in the CLI's host reported text — HQ's policy injection at
    /// SessionStart, a checkpoint directive, a blocked tool's reason. Not
    /// transcript prose: the UI folds it into session state (the policies
    /// chip, the checkpoint prompt) and never draws a row for it.
    ///
    /// `hook_event` is the host's event name (`SessionStart`, Codex
    /// `sessionStart`); `hook_name` the host's own id for the hook run.
    /// `text` is capped at [`HOOK_NOTICE_TEXT_CAP`] bytes by the normalizers
    /// and otherwise verbatim.
    HookNotice {
        hook_event: String,
        hook_name: String,
        text: String,
    },
    TurnDone {
        status: DoneStatus,
        error: Option<String>,
        session_id: Option<String>,
    },
    Error {
        message: String,
        code: Option<String>,
    },
    /// The child process exited.
    Exited {
        code: Option<i32>,
        signal: Option<i32>,
    },
    /// Backpressure dropped `dropped` events.
    Truncated { dropped: u64 },
}

/// Longest [`SessionEvent::HookNotice`] text kept, in bytes. A SessionStart
/// in the HQ root runs a dozen hooks whose stdout can reach tens of kilobytes
/// (a plugin's whole guidance document); the replay ring must not spend its
/// budget on that, and the policy parser only needs the policy lines.
pub const HOOK_NOTICE_TEXT_CAP: usize = 8 * 1024;

/// Cap hook text at [`HOOK_NOTICE_TEXT_CAP`] bytes without splitting a
/// UTF-8 sequence. Nothing else is altered.
pub fn cap_hook_text(text: &str) -> String {
    if text.len() <= HOOK_NOTICE_TEXT_CAP {
        return text.to_owned();
    }
    let mut end = HOOK_NOTICE_TEXT_CAP;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn roundtrip(event: &SessionEvent) -> Value {
        let raw = serde_json::to_value(event).expect("serialize");
        let back: SessionEvent = serde_json::from_value(raw.clone()).expect("deserialize");
        assert_eq!(&back, event, "round-trip must be lossless");
        raw
    }

    fn sample_events() -> Vec<(&'static str, SessionEvent)> {
        vec![
            (
                "started",
                SessionEvent::Started {
                    session_id: "s1".into(),
                    tool: SessionTool::Claude,
                    model: "claude-haiku-4-5-20251001".into(),
                    cwd: "/x".into(),
                    tools: vec!["Bash".into()],
                    commands: vec![SlashCommand {
                        name: "plan".into(),
                        description: "Plan work".into(),
                        argument_hint: Some("<goal>".into()),
                    }],
                    permission_mode: Some("default".into()),
                    capabilities: vec!["interrupt_receipt_v1".into()],
                },
            ),
            (
                "userMessage",
                SessionEvent::UserMessage {
                    text: "do the thing".into(),
                    image_count: 2,
                },
            ),
            (
                "textDelta",
                SessionEvent::TextDelta {
                    text: "hi".into(),
                    parent_tool_use_id: None,
                },
            ),
            (
                "thinkingDelta",
                SessionEvent::ThinkingDelta { text: "hmm".into() },
            ),
            (
                "assistantMessage",
                SessionEvent::AssistantMessage {
                    text: "done".into(),
                    parent_tool_use_id: Some("toolu_1".into()),
                },
            ),
            (
                "toolCall",
                SessionEvent::ToolCall {
                    id: "toolu_1".into(),
                    name: "Bash".into(),
                    input: json!({"command": "ls"}),
                    parent_tool_use_id: None,
                },
            ),
            (
                "toolResult",
                SessionEvent::ToolResult {
                    id: "toolu_1".into(),
                    is_error: false,
                    content: json!("ok"),
                    parent_tool_use_id: None,
                },
            ),
            (
                "permissionRequest",
                SessionEvent::PermissionRequest {
                    request_id: "req_1".into(),
                    tool_name: "Bash".into(),
                    input: json!({"command": "rm -rf /"}),
                    suggestions: json!([]),
                },
            ),
            (
                "questionRequest",
                SessionEvent::QuestionRequest {
                    request_id: "req_2".into(),
                    questions: vec![Question {
                        id: "q0".into(),
                        header: "Choice".into(),
                        text: "Pick one".into(),
                        options: vec![QuestionOption {
                            label: "A".into(),
                            description: None,
                        }],
                        multi_select: false,
                    }],
                },
            ),
            (
                "usage",
                SessionEvent::Usage {
                    input_tokens: 12,
                    output_tokens: 34,
                    cost_usd: Some(0.5),
                    duration_ms: Some(2418),
                },
            ),
            (
                "rateLimit",
                SessionEvent::RateLimit {
                    message: "limit".into(),
                    resets_at: Some("1780000000".into()),
                },
            ),
            (
                "hookNotice",
                SessionEvent::HookNotice {
                    hook_event: "SessionStart".into(),
                    hook_name: "SessionStart:startup".into(),
                    text: "<policy-reminder>\n> Policy `x` applies here: y\n</policy-reminder>"
                        .into(),
                },
            ),
            (
                "turnDone",
                SessionEvent::TurnDone {
                    status: DoneStatus::Success,
                    error: None,
                    session_id: Some("s1".into()),
                },
            ),
            (
                "error",
                SessionEvent::Error {
                    message: "boom".into(),
                    code: Some("server_error".into()),
                },
            ),
            (
                "exited",
                SessionEvent::Exited {
                    code: Some(0),
                    signal: None,
                },
            ),
            ("truncated", SessionEvent::Truncated { dropped: 7 }),
        ]
    }

    #[test]
    fn every_session_event_variant_round_trips_with_a_camel_case_tag() {
        let samples = sample_events();
        // Guard against a variant being added to the enum without a sample.
        assert_eq!(samples.len(), 16, "one sample per SessionEvent variant");
        for (tag, event) in samples {
            let raw = roundtrip(&event);
            assert_eq!(raw["kind"], tag, "wire tag for {event:?}");
        }
    }

    #[test]
    fn hook_notice_fields_are_camel_case_and_the_cap_respects_char_boundaries() {
        let raw = serde_json::to_value(SessionEvent::HookNotice {
            hook_event: "SessionStart".into(),
            hook_name: "SessionStart:startup".into(),
            text: "t".into(),
        })
        .expect("serialize");
        assert_eq!(raw["kind"], "hookNotice");
        assert_eq!(raw["hookEvent"], "SessionStart");
        assert_eq!(raw["hookName"], "SessionStart:startup");
        assert!(raw.get("hook_event").is_none());

        assert_eq!(cap_hook_text("short"), "short");
        // Two-byte chars straddling the cap: the cut lands on a boundary and
        // the result is at most the cap.
        let long = "é".repeat(HOOK_NOTICE_TEXT_CAP);
        let capped = cap_hook_text(&long);
        assert!(capped.len() <= HOOK_NOTICE_TEXT_CAP);
        assert!(capped.len() >= HOOK_NOTICE_TEXT_CAP - 1);
        assert!(capped.chars().all(|c| c == 'é'));
        // Exactly at the cap is untouched.
        let exact = "a".repeat(HOOK_NOTICE_TEXT_CAP);
        assert_eq!(cap_hook_text(&exact), exact);
    }

    #[test]
    fn session_event_fields_are_camel_case_on_the_wire() {
        let raw = serde_json::to_value(SessionEvent::TextDelta {
            text: "hi".into(),
            parent_tool_use_id: Some("toolu_1".into()),
        })
        .expect("serialize");
        assert_eq!(raw["parentToolUseId"], "toolu_1");
        assert!(raw.get("parent_tool_use_id").is_none());

        let raw = serde_json::to_value(SessionEvent::UserMessage {
            text: "hi".into(),
            image_count: 3,
        })
        .expect("serialize");
        assert_eq!(raw["kind"], "userMessage");
        assert_eq!(raw["imageCount"], 3);
        assert!(raw.get("image_count").is_none());

        let raw = serde_json::to_value(SessionEvent::Usage {
            input_tokens: 1,
            output_tokens: 2,
            cost_usd: Some(0.25),
            duration_ms: Some(9),
        })
        .expect("serialize");
        assert_eq!(raw["inputTokens"], 1);
        assert_eq!(raw["outputTokens"], 2);
        assert_eq!(raw["costUsd"], 0.25);
        assert_eq!(raw["durationMs"], 9);

        let raw = serde_json::to_value(SessionEvent::ToolResult {
            id: "t".into(),
            is_error: true,
            content: json!("x"),
            parent_tool_use_id: None,
        })
        .expect("serialize");
        assert_eq!(raw["isError"], true);

        let raw = serde_json::to_value(SessionEvent::Started {
            session_id: "s1".into(),
            tool: SessionTool::Codex,
            model: "m".into(),
            cwd: "/x".into(),
            tools: vec![],
            commands: vec![],
            permission_mode: None,
            capabilities: vec![],
        })
        .expect("serialize");
        assert_eq!(raw["sessionId"], "s1");
        assert_eq!(raw["tool"], "codex");
        assert!(raw["permissionMode"].is_null());
    }

    #[test]
    fn permission_decision_variants_round_trip() {
        for (tag, decision) in [
            ("allowOnce", PermissionDecision::AllowOnce),
            ("allowSession", PermissionDecision::AllowSession),
            (
                "allow",
                PermissionDecision::Allow {
                    updated_input: json!({"command": "ls"}),
                },
            ),
            (
                "deny",
                PermissionDecision::Deny {
                    message: "nope".into(),
                },
            ),
        ] {
            let raw = serde_json::to_value(&decision).expect("serialize");
            assert_eq!(raw["kind"], tag);
            let back: PermissionDecision = serde_json::from_value(raw).expect("parse");
            assert_eq!(back, decision);
        }
        let raw = serde_json::to_value(PermissionDecision::Allow {
            updated_input: json!({}),
        })
        .expect("serialize");
        assert!(raw.get("updatedInput").is_some());
    }

    #[test]
    fn unit_enums_are_camel_case_scalars() {
        assert_eq!(serde_json::to_value(SessionTool::Claude).unwrap(), "claude");
        assert_eq!(serde_json::to_value(SessionTool::Codex).unwrap(), "codex");
        assert_eq!(
            serde_json::to_value(PermissionMode::BypassAll).unwrap(),
            "bypassAll"
        );
        assert_eq!(
            serde_json::to_value(PermissionMode::Prompt).unwrap(),
            "prompt"
        );
        for (tag, status) in [
            ("success", DoneStatus::Success),
            ("error", DoneStatus::Error),
            ("interrupted", DoneStatus::Interrupted),
        ] {
            let raw = serde_json::to_value(status).unwrap();
            assert_eq!(raw, tag);
            assert_eq!(serde_json::from_value::<DoneStatus>(raw).unwrap(), status);
        }
        for (tag, phase) in [
            ("starting", SessionPhase::Starting),
            ("idle", SessionPhase::Idle),
            ("working", SessionPhase::Working),
            ("needsYou", SessionPhase::NeedsYou),
            ("ended", SessionPhase::Ended),
        ] {
            let raw = serde_json::to_value(phase).unwrap();
            assert_eq!(raw, tag);
            assert_eq!(serde_json::from_value::<SessionPhase>(raw).unwrap(), phase);
        }
    }

    #[test]
    fn turn_overrides_round_trip_as_the_camel_case_pills_the_ui_sends() {
        let overrides = TurnOverrides {
            model: Some("gpt-5.6-codex".into()),
            effort: Some("xhigh".into()),
        };
        let raw = serde_json::to_value(&overrides).expect("serialize");
        assert_eq!(raw["model"], "gpt-5.6-codex");
        assert_eq!(raw["effort"], "xhigh");
        assert_eq!(
            serde_json::from_value::<TurnOverrides>(raw).expect("parse"),
            overrides
        );

        // "Default" / "Auto" is a real choice, so an absent field and an
        // explicit null both have to read as "the CLI's own default".
        assert_eq!(
            serde_json::from_value::<TurnOverrides>(json!({})).expect("parse"),
            TurnOverrides::default()
        );
        assert_eq!(
            serde_json::from_value::<TurnOverrides>(json!({"model": null, "effort": null}))
                .expect("parse"),
            TurnOverrides::default()
        );
    }

    #[test]
    fn session_spec_and_question_shapes_round_trip() {
        let spec = SessionSpec {
            session_id: "s1".into(),
            title: None,
            tool: SessionTool::Claude,
            cwd: "/x".into(),
            company: Some("indigo".into()),
            project: Some("launch".into()),
            model: Some("opus".into()),
            effort: Some("high".into()),
            resume: None,
            permission_mode: PermissionMode::Prompt,
        };
        let raw = serde_json::to_value(&spec).expect("serialize");
        assert_eq!(raw["sessionId"], "s1");
        assert_eq!(raw["permissionMode"], "prompt");
        assert_eq!(raw["project"], "launch");
        // A composer that predates the project binding omits the key entirely;
        // that must still parse as "no project" rather than fail the start.
        let mut legacy = raw.clone();
        legacy.as_object_mut().expect("object").remove("project");
        assert_eq!(
            serde_json::from_value::<SessionSpec>(legacy)
                .expect("parse")
                .project,
            None
        );
        assert!(raw["resume"].is_null());
        assert_eq!(
            serde_json::from_value::<SessionSpec>(raw).expect("parse"),
            spec
        );

        let question = Question {
            id: "q0".into(),
            header: "H".into(),
            text: "Pick".into(),
            options: vec![QuestionOption {
                label: "A".into(),
                description: Some("first".into()),
            }],
            multi_select: true,
        };
        let raw = serde_json::to_value(&question).expect("serialize");
        assert_eq!(raw["multiSelect"], true);
        assert_eq!(
            serde_json::from_value::<Question>(raw).expect("parse"),
            question
        );

        let answer = QuestionAnswer {
            question_id: "q0".into(),
            values: vec!["A".into()],
        };
        let raw = serde_json::to_value(&answer).expect("serialize");
        assert_eq!(raw["questionId"], "q0");
        assert_eq!(
            serde_json::from_value::<QuestionAnswer>(raw).expect("parse"),
            answer
        );

        let command = SlashCommand {
            name: "plan".into(),
            description: "d".into(),
            argument_hint: None,
        };
        let raw = serde_json::to_value(&command).expect("serialize");
        assert!(raw.get("argumentHint").is_some());
        assert_eq!(
            serde_json::from_value::<SlashCommand>(raw).expect("parse"),
            command
        );
    }
}

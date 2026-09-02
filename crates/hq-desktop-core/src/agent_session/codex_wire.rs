//! Request builders and result parsers for the Codex `app-server` JSON-RPC
//! protocol (verified against codex-cli 0.144.1).
//!
//! Pure: every function here takes and returns plain data, so the whole wire
//! contract is testable from the frames the spike recorded without a child
//! process anywhere near it. The driver in `commands/agent_session/codex.rs`
//! owns the transport; this module owns the shapes.
//!
//! # What the protocol actually looks like
//!
//! NDJSON JSON-RPC 2.0 over stdio, `codex app-server` with no args:
//!
//! 1. `initialize` → result; then the `initialized` NOTIFICATION (no id).
//! 2. `thread/start` (or `thread/resume`) → `{ thread: { id }, model,
//!    reasoningEffort, … }`. That thread id is the resume handle.
//! 3. `turn/start` → `{ turn: { id } }`, then a stream of notifications.
//! 4. Server→client REQUESTS (they carry an `id`) for approvals and questions;
//!    the client answers with a plain JSON-RPC response on the same id.
//!
//! Two things are load-bearing and easy to get wrong:
//!
//! - `initialized` is a notification. Sending it as a request wedges a client
//!   waiting for a response that never comes.
//! - `turn/steer` carries `expectedTurnId` as a PRECONDITION: it fails when the
//!   turn it names is no longer the active one. A rejected steer is therefore
//!   "you lost a race", not "your text was bad" — the driver re-queues it.

use serde_json::{json, Map, Value};

use super::types::{PermissionMode, Question, QuestionAnswer, QuestionOption, SlashCommand};

/// The client name Codex records on the thread and echoes in its user agent.
pub const CLIENT_NAME: &str = "hq-desktop";
/// The window title Codex shows for a client-driven thread.
pub const CLIENT_TITLE: &str = "HQ";

/// Reasoning summaries are requested as `auto` on every turn: without it the
/// thinking channel is silent, and a session that streams nothing while it
/// reasons reads as hung.
pub const SUMMARY_AUTO: &str = "auto";

// ─────────────────────────────────────────────────────────────────────────────
// Approval / sandbox policy
// ─────────────────────────────────────────────────────────────────────────────

/// The `(approvalPolicy, sandbox)` pair for a permission mode.
///
/// The two are one decision, not two: `on-request` with a permissive sandbox
/// never asks (the spike's `workspace-write` run wrote a file with no prompt),
/// and `never` with a restrictive sandbox fails commands with no way to
/// recover. Prompt mode therefore pairs `on-request` with `workspace-write` —
/// work inside the workspace runs, anything outside it asks — and bypass pairs
/// `never` with `danger-full-access`, which is what the user chose.
pub fn policy_for(mode: PermissionMode) -> (&'static str, &'static str) {
    match mode {
        PermissionMode::Prompt => ("on-request", "workspace-write"),
        PermissionMode::BypassAll => ("never", "danger-full-access"),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Requests
// ─────────────────────────────────────────────────────────────────────────────

/// `initialize` params. `experimentalApi` is what unlocks `skills/list`,
/// `turn/steer`, and the tool user-input requests.
pub fn initialize_params(client_version: &str) -> Value {
    json!({
        "clientInfo": {
            "name": CLIENT_NAME,
            "title": CLIENT_TITLE,
            "version": client_version,
        },
        "capabilities": { "experimentalApi": true },
    })
}

/// `thread/start` params.
pub fn thread_start_params(
    cwd: &str,
    approval_policy: &str,
    sandbox: &str,
    model: Option<&str>,
) -> Value {
    let mut params = Map::new();
    params.insert("cwd".into(), json!(cwd));
    params.insert("approvalPolicy".into(), json!(approval_policy));
    params.insert("sandbox".into(), json!(sandbox));
    if let Some(model) = model.map(str::trim).filter(|m| !m.is_empty()) {
        params.insert("model".into(), json!(model));
    }
    Value::Object(params)
}

/// `thread/resume` params: `thread/start` plus the thread to pick up.
pub fn thread_resume_params(
    thread_id: &str,
    cwd: &str,
    approval_policy: &str,
    sandbox: &str,
    model: Option<&str>,
) -> Value {
    let mut params = thread_start_params(cwd, approval_policy, sandbox, model);
    if let Some(map) = params.as_object_mut() {
        map.insert("threadId".into(), json!(thread_id));
    }
    params
}

/// One user turn's `input` array.
///
/// Images ride as the `Image` variant of Codex's `UserInput` enum
/// (`{ type: "image", imageUrl }`), which takes a data URL — the same encoding
/// the composer already holds them in, so nothing is written to disk.
pub fn user_input(text: &str, images: &[(String, String)]) -> Value {
    let mut items = Vec::with_capacity(1 + images.len());
    items.push(json!({ "type": "text", "text": text }));
    for (media_type, base64) in images {
        items.push(json!({
            "type": "image",
            "imageUrl": format!("data:{media_type};base64,{base64}"),
        }));
    }
    Value::Array(items)
}

/// `turn/start` params. `input` is the array [`user_input`] builds.
pub fn turn_start_params(
    thread_id: &str,
    input: Value,
    approval_policy: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> Value {
    let mut params = Map::new();
    params.insert("threadId".into(), json!(thread_id));
    params.insert("input".into(), input);
    params.insert("approvalPolicy".into(), json!(approval_policy));
    params.insert("summary".into(), json!(SUMMARY_AUTO));
    if let Some(model) = model.map(str::trim).filter(|m| !m.is_empty()) {
        params.insert("model".into(), json!(model));
    }
    if let Some(effort) = effort.map(str::trim).filter(|e| !e.is_empty()) {
        params.insert("effort".into(), json!(effort));
    }
    Value::Object(params)
}

/// `turn/steer` params: inject text into the turn named by `expected_turn_id`.
///
/// The id is a precondition the server checks, not a hint — see the module
/// docs for why a rejection is re-queued rather than surfaced.
pub fn turn_steer_params(thread_id: &str, expected_turn_id: &str, input: Value) -> Value {
    json!({
        "threadId": thread_id,
        "expectedTurnId": expected_turn_id,
        "input": input,
    })
}

/// `turn/interrupt` params.
pub fn turn_interrupt_params(thread_id: &str, turn_id: &str) -> Value {
    json!({ "threadId": thread_id, "turnId": turn_id })
}

/// The reply to `item/{commandExecution,fileChange}/requestApproval`.
///
/// Only `accept` / `decline` are sent. Codex also offers
/// `acceptWithExecpolicyAmendment` and `acceptForSession`, and both write a
/// durable allowance the user never asked a chat window for — the
/// session-scoped "allow for this session" choice is remembered in OUR
/// registry instead, which cannot outlive the session.
pub fn approval_reply(accept: bool) -> Value {
    json!({ "decision": if accept { "accept" } else { "decline" } })
}

/// The reply to `item/tool/requestUserInput`.
///
/// Answers are keyed by the question's WIRE id (which [`parse_user_input_request`]
/// stores in [`Question::id`]), and each is `{ answers: [label, …] }` — the
/// labels, not indices. A question with no answer still gets an entry, so the
/// server is never left waiting on a key it asked about.
pub fn user_input_reply(questions: &[Question], answers: &[QuestionAnswer]) -> Value {
    let mut by_id = Map::new();
    for question in questions {
        let labels: Vec<Value> = answers
            .iter()
            .find(|a| a.question_id == question.id)
            .map(|a| a.values.iter().cloned().map(Value::String).collect())
            .unwrap_or_default();
        by_id.insert(question.id.clone(), json!({ "answers": labels }));
    }
    json!({ "answers": Value::Object(by_id) })
}

// ─────────────────────────────────────────────────────────────────────────────
// Result parsing
// ─────────────────────────────────────────────────────────────────────────────

fn field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| value.get(*k))
}

fn str_field(value: &Value, keys: &[&str]) -> String {
    field(value, keys)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

/// What `thread/start` (or `thread/resume`) told us about the new thread.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ThreadStarted {
    /// The resume handle. Empty when the server answered with a shape we do
    /// not recognise, which the driver treats as a failed handshake.
    pub thread_id: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
}

/// Parse a `thread/start` / `thread/resume` result.
pub fn parse_thread_started(result: &Value) -> ThreadStarted {
    let thread_id = result
        .get("thread")
        .map(|t| str_field(t, &["id", "sessionId"]))
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| str_field(result, &["threadId", "id"]));
    ThreadStarted {
        thread_id,
        model: str_field(result, &["model"]),
        reasoning_effort: field(result, &["reasoningEffort", "reasoning_effort"])
            .and_then(Value::as_str)
            .filter(|e| !e.is_empty())
            .map(str::to_owned),
    }
}

/// The turn id out of a `turn/start` result.
pub fn parse_turn_started(result: &Value) -> Option<String> {
    let id = result
        .get("turn")
        .map(|t| str_field(t, &["id"]))
        .unwrap_or_else(|| str_field(result, &["turnId", "id"]));
    (!id.is_empty()).then_some(id)
}

/// Parse a `model/list` result into the catalog shape the composer's model
/// pill already reads for Claude: `{ value, displayName, description }`.
///
/// Codex's own rows carry more (`supportedReasoningEfforts`,
/// `defaultReasoningEffort`), which is passed through untouched — the pill
/// ignores what it does not know, and the effort ladder is the obvious next
/// consumer. `hidden` rows are dropped: they are internal aliases the picker
/// must not offer.
pub fn parse_model_list(result: &Value) -> Vec<Value> {
    result
        .get("data")
        .and_then(Value::as_array)
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|entry| entry.get("hidden").and_then(Value::as_bool) != Some(true))
        .filter_map(|entry| {
            let id = str_field(entry, &["id", "model"]);
            if id.is_empty() {
                return None;
            }
            let mut row = Map::new();
            row.insert("value".into(), json!(id));
            let display = str_field(entry, &["displayName", "display_name"]);
            row.insert(
                "displayName".into(),
                json!(if display.is_empty() { id } else { display }),
            );
            let description = str_field(entry, &["description"]);
            if !description.is_empty() {
                row.insert("description".into(), json!(description));
            }
            for key in ["supportedReasoningEfforts", "defaultReasoningEffort"] {
                if let Some(value) = entry.get(key) {
                    row.insert(key.into(), value.clone());
                }
            }
            Some(Value::Object(row))
        })
        .collect()
}

/// Parse a `skills/list` result into slash commands.
///
/// The result is GROUPED BY CWD — `{ data: [{ cwd, skills: [...] }] }` — not a
/// flat list, because one app server can serve several workspaces. Every
/// group is flattened, disabled skills are dropped, and the first spelling of
/// a name wins (the same skill can be visible from two roots).
pub fn parse_skills_list(result: &Value) -> Vec<SlashCommand> {
    let mut out: Vec<SlashCommand> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let groups = result
        .get("data")
        .and_then(Value::as_array)
        .map(|a| a.as_slice())
        .unwrap_or_default();

    for group in groups {
        // Tolerate a future flat form: a group that IS a skill.
        let skills: &[Value] = group
            .get("skills")
            .and_then(Value::as_array)
            .map(|a| a.as_slice())
            .unwrap_or(std::slice::from_ref(group));

        for skill in skills {
            if skill.get("enabled").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            let name = str_field(skill, &["name"]).trim().to_owned();
            if name.is_empty() || !seen.insert(name.clone()) {
                continue;
            }
            // `interface.shortDescription` is the one-liner the picker wants;
            // `description` is the model-facing paragraph.
            let short = skill
                .get("interface")
                .map(|i| str_field(i, &["shortDescription", "short_description"]))
                .unwrap_or_default();
            let description = if short.is_empty() {
                str_field(skill, &["description"])
            } else {
                short
            };
            out.push(SlashCommand {
                name,
                description,
                argument_hint: None,
            });
        }
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// Server→client requests
// ─────────────────────────────────────────────────────────────────────────────

/// A parsed approval request.
#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalRequest {
    /// `Bash` for a command, `Edit` for a file change — the tool NAMES the
    /// registry's session-scoped allow list keys on, and the UI labels with.
    pub tool_name: String,
    pub input: Value,
    /// `availableDecisions`, passed through for the UI to explain the choice.
    pub suggestions: Value,
}

/// Parse `item/commandExecution/requestApproval` or
/// `item/fileChange/requestApproval` params.
pub fn parse_approval_request(method: &str, params: &Value) -> ApprovalRequest {
    let reason = str_field(params, &["reason"]);
    let cwd = str_field(params, &["cwd"]);
    let suggestions = params
        .get("availableDecisions")
        .cloned()
        .unwrap_or(Value::Null);

    if method.contains("fileChange") {
        let changes = params.get("changes").cloned().unwrap_or(Value::Null);
        let mut input = Map::new();
        input.insert("changes".into(), changes);
        if !cwd.is_empty() {
            input.insert("cwd".into(), json!(cwd));
        }
        if !reason.is_empty() {
            input.insert("reason".into(), json!(reason));
        }
        if let Some(item_id) = params.get("itemId") {
            input.insert("itemId".into(), item_id.clone());
        }
        return ApprovalRequest {
            tool_name: "Edit".into(),
            input: Value::Object(input),
            suggestions,
        };
    }

    let mut input = Map::new();
    input.insert("command".into(), json!(command_text(params)));
    if !cwd.is_empty() {
        input.insert("cwd".into(), json!(cwd));
    }
    if !reason.is_empty() {
        input.insert("reason".into(), json!(reason));
    }
    for key in ["commandActions", "itemId"] {
        if let Some(value) = params.get(key) {
            input.insert(key.into(), value.clone());
        }
    }
    ApprovalRequest {
        tool_name: "Bash".into(),
        input: Value::Object(input),
        suggestions,
    }
}

/// `command` arrives as a string on the approval request and as argv on some
/// item shapes; both render as one line.
pub fn command_text(value: &Value) -> String {
    match value.get("command") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// Parse `item/tool/requestUserInput` params into questions.
///
/// [`Question::id`] holds the question's WIRE id, because that is the key the
/// answer must be posted back under. Questions with no id of their own get a
/// positional one, which is what the server falls back to reading too.
pub fn parse_user_input_request(params: &Value) -> Vec<Question> {
    params
        .get("questions")
        .and_then(Value::as_array)
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(index, raw)| {
            let id = {
                let id = str_field(raw, &["id", "questionId", "question_id"]);
                if id.is_empty() {
                    format!("q{index}")
                } else {
                    id
                }
            };
            let header = {
                let header = str_field(raw, &["header", "title", "label"]);
                if header.is_empty() {
                    "Codex question".to_owned()
                } else {
                    header
                }
            };
            Question {
                id,
                header,
                text: str_field(raw, &["question", "prompt", "text"]),
                options: raw
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|a| a.as_slice())
                    .unwrap_or_default()
                    .iter()
                    .map(|option| match option {
                        Value::String(label) => QuestionOption {
                            label: label.clone(),
                            description: None,
                        },
                        other => QuestionOption {
                            label: str_field(other, &["label", "value"]),
                            description: field(other, &["description"])
                                .and_then(Value::as_str)
                                .filter(|d| !d.is_empty())
                                .map(str::to_owned),
                        },
                    })
                    .collect(),
                multi_select: field(raw, &["multiSelect", "multi_select"])
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim frames from the spike recordings in
    /// `workspace/tmp/claude-spike/cx*.codex.jsonl` (codex-cli 0.144.1).
    const THREAD_START_RESULT: &str = r#"{"thread":{"id":"01a06218-e436-7963-827b-6103963b4320","sessionId":"01a06218-e436-7963-827b-6103963b4320","cwd":"/Users/jacobposel/Documents/HQ","cliVersion":"0.144.1","turns":[]},"model":"gpt-5.6-sol","modelProvider":"openai","serviceTier":"priority","cwd":"/Users/jacobposel/Documents/HQ","approvalPolicy":"on-request","sandbox":{"type":"readOnly","networkAccess":false},"reasoningEffort":"medium","multiAgentMode":"explicitRequestOnly"}"#;

    const TURN_START_RESULT: &str = r#"{"turn":{"id":"01a06218-f3a3-7f51-992d-618a3c6b3c6b","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":null,"completedAt":null,"durationMs":null}}"#;

    const APPROVAL_REQUEST: &str = r#"{"jsonrpc":"2.0","method":"item/commandExecution/requestApproval","id":0,"params":{"threadId":"01a0621b-5ea4-7861-8b05-cb169ee8d622","turnId":"01a0621b-6a72-7be1-a001-299e151f4302","itemId":"exec-6d0b851e-520f-474e-b7d8-3c8a65c99bb4","startedAtMs":1788352401007,"environmentId":"local","reason":"Allow creating the requested cx3-hello.txt file outside the read-only sandbox?","command":"/bin/zsh -lc 'echo hello > /Users/jacobposel/Documents/HQ/workspace/tmp/claude-spike/cx3-hello.txt'","cwd":"/Users/jacobposel/Documents/HQ","commandActions":[{"type":"unknown","command":"echo hello > /Users/jacobposel/Documents/HQ/workspace/tmp/claude-spike/cx3-hello.txt"}],"proposedExecpolicyAmendment":["/bin/zsh","-lc","echo hello"],"availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["/bin/zsh"]}},"cancel"]}}"#;

    const SKILLS_LIST_RESULT: &str = r#"{"data":[{"cwd":"/Users/jacobposel/Documents/HQ","skills":[{"name":"adapt","description":"Adapt designs to work across different screen sizes, devices, contexts, or platforms. Ensures consistent experience across varied environments.","interface":{"displayName":"Adapt","shortDescription":"Adapt designs to work across different screen sizes, devices, contexts, or platforms.","iconSmall":null},"path":"/Users/jacobposel/Documents/HQ/.claude/skills/adapt/SKILL.md","scope":"user","enabled":true},{"name":"adr","description":"Capture qualifying architecture decisions as ADRs in the right HQ or repo location.","interface":{"displayName":"adr","shortDescription":"Capture an Architectural Decision Record when the decision is durable, surprising, and trade-off driven."},"path":"/x/adr/SKILL.md","scope":"user","enabled":true},{"name":"off","description":"Disabled","enabled":false}]}]}"#;

    fn parse(raw: &str) -> Value {
        serde_json::from_str(raw).expect("fixture is valid JSON")
    }

    #[test]
    fn initialize_opts_into_the_experimental_api() {
        let params = initialize_params("0.9.1");
        assert_eq!(params["clientInfo"]["name"], CLIENT_NAME);
        assert_eq!(params["clientInfo"]["version"], "0.9.1");
        assert_eq!(params["capabilities"]["experimentalApi"], true);
    }

    #[test]
    fn permission_modes_map_to_the_policy_sandbox_pair_they_mean() {
        assert_eq!(
            policy_for(PermissionMode::Prompt),
            ("on-request", "workspace-write")
        );
        assert_eq!(
            policy_for(PermissionMode::BypassAll),
            ("never", "danger-full-access")
        );
    }

    #[test]
    fn thread_start_omits_a_model_it_was_not_given() {
        let params = thread_start_params("/hq", "on-request", "workspace-write", None);
        assert_eq!(params["cwd"], "/hq");
        assert_eq!(params["approvalPolicy"], "on-request");
        assert_eq!(params["sandbox"], "workspace-write");
        assert!(params.get("model").is_none(), "{params}");

        let params = thread_start_params("/hq", "never", "danger-full-access", Some("  "));
        assert!(params.get("model").is_none(), "blank is not a model");

        let params = thread_resume_params("t-1", "/hq", "on-request", "workspace-write", Some("m"));
        assert_eq!(params["threadId"], "t-1");
        assert_eq!(params["model"], "m");
    }

    #[test]
    fn a_turn_always_asks_for_reasoning_summaries() {
        let params = turn_start_params(
            "t-1",
            user_input("hi", &[]),
            "on-request",
            Some("gpt-5.6-sol"),
            Some("high"),
        );
        assert_eq!(params["threadId"], "t-1");
        assert_eq!(params["input"][0]["type"], "text");
        assert_eq!(params["input"][0]["text"], "hi");
        assert_eq!(params["summary"], "auto");
        assert_eq!(params["model"], "gpt-5.6-sol");
        assert_eq!(params["effort"], "high");

        let params = turn_start_params("t-1", user_input("hi", &[]), "never", None, None);
        assert!(params.get("model").is_none());
        assert!(params.get("effort").is_none());
    }

    #[test]
    fn images_ride_as_data_url_input_items() {
        let input = user_input("look", &[("image/png".into(), "QUJD".into())]);
        assert_eq!(input[0]["text"], "look");
        assert_eq!(input[1]["type"], "image");
        assert_eq!(input[1]["imageUrl"], "data:image/png;base64,QUJD");
    }

    #[test]
    fn steering_names_the_turn_it_expects() {
        let params = turn_steer_params("th-1", "tu-1", user_input("also this", &[]));
        assert_eq!(params["threadId"], "th-1");
        assert_eq!(params["expectedTurnId"], "tu-1");
        assert_eq!(params["input"][0]["text"], "also this");
        assert_eq!(
            turn_interrupt_params("th-1", "tu-1"),
            serde_json::json!({"threadId": "th-1", "turnId": "tu-1"})
        );
    }

    #[test]
    fn thread_and_turn_results_parse_from_the_recorded_frames() {
        let started = parse_thread_started(&parse(THREAD_START_RESULT));
        assert_eq!(started.thread_id, "01a06218-e436-7963-827b-6103963b4320");
        assert_eq!(started.model, "gpt-5.6-sol");
        assert_eq!(started.reasoning_effort.as_deref(), Some("medium"));

        assert_eq!(
            parse_turn_started(&parse(TURN_START_RESULT)).as_deref(),
            Some("01a06218-f3a3-7f51-992d-618a3c6b3c6b")
        );
        assert_eq!(parse_turn_started(&serde_json::json!({})), None);
    }

    #[test]
    fn skills_list_flattens_the_per_cwd_groups_and_drops_disabled_ones() {
        let commands = parse_skills_list(&parse(SKILLS_LIST_RESULT));
        assert_eq!(commands.len(), 2, "{commands:?}");
        assert_eq!(commands[0].name, "adapt");
        assert_eq!(
            commands[0].description,
            "Adapt designs to work across different screen sizes, devices, contexts, or platforms.",
            "the short description wins over the model-facing paragraph"
        );
        assert!(commands[0].argument_hint.is_none());
        assert!(
            !commands.iter().any(|c| c.name == "off"),
            "a disabled skill is not offered"
        );
    }

    #[test]
    fn model_list_is_reshaped_into_the_catalog_the_composer_already_reads() {
        let result = serde_json::json!({"data": [
            {
                "id": "gpt-5.6-sol",
                "displayName": "GPT-5.6-Sol",
                "description": "Balanced",
                "supportedReasoningEfforts": [{"reasoningEffort": "low"}, {"reasoningEffort": "high"}],
                "defaultReasoningEffort": "medium",
                "hidden": false
            },
            {"id": "internal-only", "displayName": "Nope", "hidden": true},
            {"displayName": "no id"}
        ]});
        let models = parse_model_list(&result);
        assert_eq!(models.len(), 1, "{models:?}");
        assert_eq!(models[0]["value"], "gpt-5.6-sol");
        assert_eq!(models[0]["displayName"], "GPT-5.6-Sol");
        assert_eq!(models[0]["description"], "Balanced");
        assert_eq!(models[0]["defaultReasoningEffort"], "medium");
        assert_eq!(models[0]["supportedReasoningEfforts"][1]["reasoningEffort"], "high");
    }

    #[test]
    fn a_recorded_command_approval_parses_into_a_bash_request() {
        let frame = parse(APPROVAL_REQUEST);
        let request = parse_approval_request(
            frame["method"].as_str().unwrap(),
            &frame["params"],
        );
        assert_eq!(request.tool_name, "Bash");
        assert!(request.input["command"]
            .as_str()
            .unwrap()
            .contains("echo hello"));
        assert_eq!(request.input["cwd"], "/Users/jacobposel/Documents/HQ");
        assert!(request.input["reason"]
            .as_str()
            .unwrap()
            .contains("read-only sandbox"));
        assert_eq!(request.suggestions[0], "accept");
    }

    #[test]
    fn a_file_change_approval_parses_into_an_edit_request() {
        let params = serde_json::json!({
            "itemId": "f1",
            "reason": "Write outside the workspace?",
            "changes": [{"path": "/tmp/a.rs", "kind": "update"}],
            "availableDecisions": ["accept", "cancel"]
        });
        let request = parse_approval_request("item/fileChange/requestApproval", &params);
        assert_eq!(request.tool_name, "Edit");
        assert_eq!(request.input["changes"][0]["path"], "/tmp/a.rs");
        assert_eq!(request.input["reason"], "Write outside the workspace?");
    }

    #[test]
    fn the_reply_we_send_for_an_approval_is_the_documented_decision_object() {
        assert_eq!(approval_reply(true), serde_json::json!({"decision": "accept"}));
        assert_eq!(
            approval_reply(false),
            serde_json::json!({"decision": "decline"})
        );
    }

    #[test]
    fn user_input_questions_keep_their_wire_id_and_answer_by_label() {
        let params = serde_json::json!({"questions": [
            {
                "id": "q_lang",
                "header": "Language",
                "question": "Which one?",
                "options": [{"label": "Rust", "description": "fast"}, "Go"],
                "multiSelect": true
            },
            {"question": "Anything else?"}
        ]});
        let questions = parse_user_input_request(&params);
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].id, "q_lang");
        assert_eq!(questions[0].header, "Language");
        assert_eq!(questions[0].options[0].label, "Rust");
        assert_eq!(questions[0].options[0].description.as_deref(), Some("fast"));
        assert_eq!(questions[0].options[1].label, "Go");
        assert!(questions[0].multi_select);
        assert_eq!(questions[1].id, "q1", "a question with no id gets a positional one");
        assert_eq!(questions[1].header, "Codex question");

        let reply = user_input_reply(
            &questions,
            &[QuestionAnswer {
                question_id: "q_lang".into(),
                values: vec!["Rust".into()],
            }],
        );
        assert_eq!(reply["answers"]["q_lang"]["answers"][0], "Rust");
        assert_eq!(
            reply["answers"]["q1"]["answers"],
            serde_json::json!([]),
            "an unanswered question still gets a key, so the server is never left waiting"
        );
    }
}

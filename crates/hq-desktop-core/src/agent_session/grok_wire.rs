//! Request builders and result parsers for Grok Build's ACP stdio server
//! (`grok --no-auto-update agent --no-leader stdio`).
//!
//! Pure: every function takes and returns plain data so the wire contract is
//! testable without a child. The driver in `commands/agent_session/grok.rs`
//! owns the transport; this module owns the shapes.
//!
//! Grok speaks Agent Client Protocol v1 (JSON-RPC 2.0 over NDJSON stdio):
//!
//! 1. `initialize` → result; Grok does not wait for an `initialized` notice.
//! 2. `session/new` (or `session/load`) → `{ sessionId, models, … }`.
//! 3. Optional `session/set_model` when the session advertises a first-class
//!    `models` state (Grok Build today) rather than a `configOptions` model
//!    select.
//! 4. `session/prompt` owns a turn; `session/update` notifications are the
//!    transcript; `_x.ai/session/prompt_complete` is the authoritative turn
//!    end (the prompt RPC can hang after the turn really finished).
//! 5. Server→client `session/request_permission` blocks until a JSON-RPC
//!    response on the same id.

use serde_json::{json, Map, Value};

use super::types::{PermissionDecision, SlashCommand};

/// The client name Grok records on the session.
pub const CLIENT_NAME: &str = "hq-desktop";
/// The window title Grok shows for a client-driven session.
pub const CLIENT_TITLE: &str = "HQ";

/// ACP protocol version Grok Build speaks today.
pub const PROTOCOL_VERSION: u64 = 1;

/// argv that puts `grok` into ACP-serving mode.
///
/// Flag placement verified against grok 1.0.4+ in HQ Sessions: `--no-auto-update`
/// is top-level (before the subcommand) and skips the launch-time update check;
/// `--no-leader` lives on `agent` so this child never attaches to a shared
/// `~/.grok/leader.sock` (a wedged TUI leader reads as total silence).
pub const ACP_ARGS: [&str; 4] = ["--no-auto-update", "agent", "--no-leader", "stdio"];

/// `initialize` params. fs/terminal capabilities are declined: Grok falls
/// back to its own tools, which is what in-app sessions want.
pub fn initialize_params(client_version: &str) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "clientInfo": {
            "name": CLIENT_NAME,
            "title": CLIENT_TITLE,
            "version": client_version,
        },
        "clientCapabilities": {
            "fs": { "readTextFile": false, "writeTextFile": false },
            "terminal": false,
        },
    })
}

/// `session/new` params.
pub fn session_new_params(cwd: &str) -> Value {
    json!({ "cwd": cwd, "mcpServers": [] })
}

/// `session/load` params — resume an existing Grok session by its ACP id.
pub fn session_load_params(cwd: &str, session_id: &str) -> Value {
    json!({ "cwd": cwd, "mcpServers": [], "sessionId": session_id })
}

/// `session/set_model` params.
pub fn session_set_model_params(session_id: &str, model_id: &str) -> Value {
    json!({ "sessionId": session_id, "modelId": model_id })
}

/// `session/set_config_option` params (effort rides `thought_level`).
pub fn session_set_config_option_params(session_id: &str, config_id: &str, value: &str) -> Value {
    json!({
        "sessionId": session_id,
        "configId": config_id,
        "value": value,
    })
}

/// `session/cancel` params. This is a notification, not a request.
pub fn session_cancel_params(session_id: &str) -> Value {
    json!({ "sessionId": session_id })
}

/// One user turn's ACP `prompt` array: text plus optional image blocks.
pub fn prompt_blocks(text: &str, images: &[(String, String)]) -> Value {
    let mut blocks = Vec::with_capacity(1 + images.len());
    blocks.push(json!({ "type": "text", "text": text }));
    for (media_type, base64) in images {
        blocks.push(json!({
            "type": "image",
            "mimeType": media_type,
            "data": base64,
        }));
    }
    Value::Array(blocks)
}

/// `session/prompt` params. `prompt_id` rides `_meta` so Grok's
/// `_x.ai/session/prompt_complete` notification can be matched exactly.
pub fn session_prompt_params(
    session_id: &str,
    text: &str,
    images: &[(String, String)],
    prompt_id: Option<&str>,
) -> Value {
    let mut params = Map::new();
    params.insert("sessionId".into(), json!(session_id));
    params.insert("prompt".into(), prompt_blocks(text, images));
    if let Some(id) = prompt_id {
        params.insert("_meta".into(), json!({ "promptId": id, "requestId": id }));
    }
    Value::Object(params)
}

/// Parse a user line back into (text, images). `agent_session_send` puts the
/// already-built prompt array on the wire as JSON so attachments survive the
/// string-shaped [`Outbound::Line`]. A plain string is treated as text.
pub fn prompt_from_line(line: &str) -> (String, Vec<(String, String)>) {
    match serde_json::from_str::<Value>(line) {
        Ok(Value::Array(blocks)) => {
            let mut text = String::new();
            let mut images = Vec::new();
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(piece) = block.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(piece);
                        }
                    }
                    Some("image") => {
                        let media = block
                            .get("mimeType")
                            .or_else(|| block.get("mediaType"))
                            .and_then(Value::as_str)
                            .unwrap_or("image/png");
                        if let Some(data) = block.get("data").and_then(Value::as_str) {
                            images.push((media.to_owned(), data.to_owned()));
                        }
                    }
                    _ => {}
                }
            }
            (text, images)
        }
        _ => (line.to_owned(), Vec::new()),
    }
}

/// The JSON-RPC id of a server→client request, as the string the registry
/// keys a parked request on.
pub fn request_key(id: &Value) -> String {
    match id {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// `sessionId` from a `session/new` / `session/load` result.
pub fn parse_session_id(result: &Value) -> String {
    result
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

/// Current model id from a session result, when advertised.
pub fn parse_current_model(result: &Value) -> String {
    result
        .get("models")
        .and_then(|models| models.get("currentModelId"))
        .and_then(Value::as_str)
        .or_else(|| result.get("model").and_then(Value::as_str))
        .unwrap_or("")
        .to_owned()
}

/// `thought_level` config option id, when the session advertises one.
pub fn thought_level_config_id(session: &Value) -> Option<String> {
    session
        .get("configOptions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|option| option.get("category").and_then(Value::as_str) == Some("thought_level"))
        .and_then(|option| option.get("id").and_then(Value::as_str))
        .map(str::to_owned)
}

/// Whether Grok should be told `session/set_model` for `requested`.
///
/// Config-option agents apply the model through `session/set_config_option`;
/// Grok Build currently advertises only the first-class `models` state.
pub fn first_class_model_change(session: &Value, requested: Option<&str>) -> Option<String> {
    let requested = requested.filter(|id| !id.is_empty())?;
    let has_model_config = session
        .get("configOptions")
        .and_then(Value::as_array)
        .is_some_and(|options| {
            options.iter().any(|option| {
                option.get("type").and_then(Value::as_str) == Some("select")
                    && option.get("category").and_then(Value::as_str) == Some("model")
            })
        });
    if has_model_config {
        return None;
    }
    let models = session.get("models")?;
    let available: Vec<&str> = models
        .get("availableModels")
        .and_then(Value::as_array)
        .map(|rows| rows.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|row| row.get("modelId").and_then(Value::as_str))
        .collect();
    if available.is_empty() || !available.contains(&requested) {
        return None;
    }
    if models.get("currentModelId").and_then(Value::as_str) == Some(requested) {
        return None;
    }
    Some(requested.to_owned())
}

/// Model catalog rows in the shape the composer's pill already reads:
/// `{ value, displayName, description, supportedEffortLevels }`.
pub fn parse_models_from_session(session: &Value) -> Vec<Value> {
    let ladder = thought_level_ladder(session);
    if let Some(rows) = config_option_models(session, &ladder) {
        if !rows.is_empty() {
            return rows;
        }
    }
    session
        .get("models")
        .and_then(|models| models.get("availableModels"))
        .and_then(Value::as_array)
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|row| {
            let id = row.get("modelId").and_then(Value::as_str)?;
            Some(catalog_row(
                id,
                row.get("name").and_then(Value::as_str),
                row.get("description").and_then(Value::as_str),
                efforts_for_model(id, &ladder),
            ))
        })
        .collect()
}

fn config_option_models(session: &Value, ladder: &[String]) -> Option<Vec<Value>> {
    let options = session.get("configOptions")?.as_array()?;
    let model = options.iter().find(|option| {
        option.get("type").and_then(Value::as_str) == Some("select")
            && option.get("category").and_then(Value::as_str) == Some("model")
    })?;
    let rows = model.get("options")?.as_array()?;
    let parsed: Vec<Value> = rows
        .iter()
        .filter_map(|row| {
            let id = row.get("value").and_then(Value::as_str)?;
            if id.eq_ignore_ascii_case("default") {
                return None;
            }
            Some(catalog_row(
                id,
                row.get("name").and_then(Value::as_str),
                row.get("description").and_then(Value::as_str),
                efforts_for_model(id, ladder),
            ))
        })
        .collect();
    Some(parsed)
}

fn thought_level_ladder(session: &Value) -> Vec<String> {
    session
        .get("configOptions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|option| option.get("category").and_then(Value::as_str) == Some("thought_level"))
        .and_then(|option| option.get("options").and_then(Value::as_array))
        .into_iter()
        .flatten()
        .filter_map(|row| row.get("value").and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn efforts_for_model(id: &str, ladder: &[String]) -> Vec<String> {
    if !ladder.is_empty() {
        return ladder.to_vec();
    }
    default_efforts_for(id)
        .iter()
        .map(|value| (*value).to_owned())
        .collect()
}

/// Courtesy effort ladder when the wire advertised none. Grok 4.6 added
/// `xhigh`; earlier ids stay on low/medium/high.
pub fn default_efforts_for(id: &str) -> &'static [&'static str] {
    let lower = id.to_ascii_lowercase();
    if lower.contains("grok-4.6")
        || lower.contains("grok-4.7")
        || lower.contains("grok-5")
        || lower.contains("grok-4-6")
    {
        &["low", "medium", "high", "xhigh"]
    } else {
        &["low", "medium", "high"]
    }
}

fn catalog_row(
    id: &str,
    name: Option<&str>,
    description: Option<&str>,
    efforts: Vec<String>,
) -> Value {
    let mut row = Map::new();
    row.insert("value".into(), json!(id));
    row.insert(
        "displayName".into(),
        json!(name.filter(|name| !name.is_empty()).unwrap_or(id)),
    );
    if let Some(description) = description.filter(|text| !text.is_empty()) {
        row.insert("description".into(), json!(description));
    }
    if !efforts.is_empty() {
        row.insert("supportedEffortLevels".into(), json!(efforts));
    }
    Value::Object(row)
}

/// Parse `grok models` stdout into the same catalog rows the composer reads.
///
/// Live CLI output (grok 1.0.24):
///
/// ```text
/// You are logged in with grok.com.
///
/// Default model: grok-4.6
///
/// Available models:
///   * grok-4.6 (default)
///   - grok-4.5
/// ```
pub fn parse_models_cli(output: &str) -> Vec<Value> {
    let mut models = Vec::new();
    let mut in_list = false;
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("Available models:") {
            in_list = true;
            continue;
        }
        if !in_list {
            continue;
        }
        let rest = trimmed
            .strip_prefix("* ")
            .or_else(|| trimmed.strip_prefix("- "))
            .or_else(|| trimmed.strip_prefix("• "))
            .unwrap_or("");
        if rest.is_empty() {
            continue;
        }
        let id = rest
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_matches(|c| c == '(' || c == ')' || c == ',');
        if id.is_empty() {
            continue;
        }
        let efforts: Vec<String> = default_efforts_for(id)
            .iter()
            .map(|value| (*value).to_owned())
            .collect();
        models.push(catalog_row(id, Some(&friendly_grok_label(id)), None, efforts));
    }
    models
}

fn friendly_grok_label(id: &str) -> String {
    let mut label = id.replace('-', " ");
    if let Some(rest) = label.strip_prefix("grok ") {
        label = format!("Grok {rest}");
    } else if let Some(c) = label.chars().next() {
        label = format!("{}{}", c.to_uppercase(), &label[c.len_utf8()..]);
    }
    label
}

/// Login probe against `grok models` stdout/stderr.
///
/// `Ok(true)` / `Ok(false)` are definite; `Err` means the CLI said something
/// we cannot classify (treat as a probe error, not a signed-out state).
pub fn login_status_from_models(success: bool, stdout: &[u8], stderr: &[u8]) -> Result<bool, ()> {
    let combined = [stdout, stderr]
        .iter()
        .map(|stream| String::from_utf8_lossy(stream))
        .collect::<Vec<_>>()
        .join("\n");
    let lower = combined.to_ascii_lowercase();
    if lower.contains("you are logged in") {
        return Ok(true);
    }
    if lower.contains("not logged in") || lower.contains("not signed in") {
        return Ok(false);
    }
    if success && parse_models_cli(&combined).iter().any(|row| {
        row.get("value")
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with("grok-"))
    }) {
        return Ok(true);
    }
    Err(())
}

/// Slash commands advertised on initialize or `available_commands_update`.
pub fn parse_commands(value: Option<&Value>) -> Vec<SlashCommand> {
    value
        .and_then(Value::as_array)
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|command| {
            let name = command.get("name").and_then(Value::as_str).unwrap_or("");
            (!name.is_empty()).then(|| SlashCommand {
                name: name.to_owned(),
                description: command
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                argument_hint: command
                    .get("input")
                    .and_then(|input| input.get("hint"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
        })
        .collect()
}

/// Depth-limited scan for an `availableCommands` array.
pub fn scan_available_commands(value: &Value) -> Vec<SlashCommand> {
    fn scan(value: &Value, depth: u8) -> Option<&Value> {
        if depth == 0 {
            return None;
        }
        let obj = value.as_object()?;
        if let Some(cmds) = obj.get("availableCommands").filter(|c| c.is_array()) {
            return Some(cmds);
        }
        obj.values().find_map(|child| scan(child, depth - 1))
    }
    parse_commands(scan(value, 4))
}

/// Options on a `session/request_permission` request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionOption {
    pub option_id: String,
    pub kind: String,
}

pub fn parse_permission_options(params: &Value) -> Vec<PermissionOption> {
    params
        .get("options")
        .and_then(Value::as_array)
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
        .collect()
}

fn option_by_kind<'a>(options: &'a [PermissionOption], kind: &str) -> Option<&'a str> {
    options
        .iter()
        .find(|option| option.kind == kind)
        .map(|option| option.option_id.as_str())
}

/// JSON-RPC result that answers `session/request_permission`.
pub fn permission_reply(options: &[PermissionOption], decision: &PermissionDecision) -> Value {
    let selected = match decision {
        PermissionDecision::AllowSession => option_by_kind(options, "allow_always")
            .or_else(|| option_by_kind(options, "allow_once"))
            .or_else(|| options.first().map(|option| option.option_id.as_str())),
        PermissionDecision::AllowOnce | PermissionDecision::Allow { .. } => {
            option_by_kind(options, "allow_once")
                .or_else(|| option_by_kind(options, "allow_always"))
                .or_else(|| options.first().map(|option| option.option_id.as_str()))
        }
        PermissionDecision::Deny { .. } => option_by_kind(options, "reject_once")
            .or_else(|| option_by_kind(options, "reject_always")),
    };
    match selected {
        Some(option_id) => json!({
            "outcome": { "outcome": "selected", "optionId": option_id }
        }),
        None => json!({ "outcome": { "outcome": "cancelled" } }),
    }
}

/// Tool name shown on a permission card: grok-native `_meta` name, else title.
pub fn permission_tool_name(params: &Value) -> String {
    let tool_call = params.get("toolCall").unwrap_or(params);
    tool_call
        .get("_meta")
        .and_then(|meta| meta.get("x.ai/tool"))
        .and_then(|tool| tool.get("name"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .or_else(|| tool_call.get("title").and_then(Value::as_str))
        .or_else(|| tool_call.get("kind").and_then(Value::as_str))
        .unwrap_or("tool")
        .to_owned()
}

pub fn permission_tool_input(params: &Value) -> Value {
    let tool_call = params.get("toolCall").unwrap_or(params);
    tool_call
        .get("rawInput")
        .cloned()
        .unwrap_or(Value::Null)
}

/// `stopReason` on a settled `session/prompt` result.
pub fn prompt_stop_reason(result: &Value) -> Option<&str> {
    result.get("stopReason").and_then(Value::as_str)
}

/// Per-turn token usage from a prompt result's `usage` or `_meta`.
pub fn usage_from_prompt(result: &Value) -> Option<(u64, u64)> {
    let usage = result.get("usage").or_else(|| result.get("_meta"))?;
    let count = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| usage.get(*key))
            .and_then(Value::as_u64)
    };
    let input = count(&["inputTokens", "input_tokens"]);
    let output = count(&["outputTokens", "output_tokens"]);
    (input.is_some() || output.is_some()).then_some((input.unwrap_or(0), output.unwrap_or(0)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::PermissionDecision;

    #[test]
    fn initialize_declines_fs_and_terminal() {
        let params = initialize_params("1.2.3");
        assert_eq!(params["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(params["clientInfo"]["name"], CLIENT_NAME);
        assert_eq!(params["clientCapabilities"]["terminal"], false);
        assert_eq!(
            params["clientCapabilities"]["fs"]["readTextFile"],
            false
        );
    }

    #[test]
    fn prompt_blocks_carry_text_and_images() {
        let blocks = prompt_blocks("look", &[("image/png".into(), "QUJD".into())]);
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[0]["text"], "look");
        assert_eq!(blocks[1]["mimeType"], "image/png");
        assert_eq!(blocks[1]["data"], "QUJD");
        let line = blocks.to_string();
        let (text, images) = prompt_from_line(&line);
        assert_eq!(text, "look");
        assert_eq!(images, vec![("image/png".into(), "QUJD".into())]);
        assert_eq!(prompt_from_line("plain text").0, "plain text");
    }

    #[test]
    fn session_prompt_stamps_prompt_id_for_grok_complete() {
        let params = session_prompt_params("s1", "hi", &[], Some("p-9"));
        assert_eq!(params["sessionId"], "s1");
        assert_eq!(params["_meta"]["promptId"], "p-9");
    }

    #[test]
    fn grok_models_cli_parses_live_1_0_24_output() {
        let output = "\
You are logged in with grok.com.\n\n\
Default model: grok-4.6\n\n\
Available models:\n\
  * grok-4.6 (default)\n\
  - grok-4.5\n";
        let models = parse_models_cli(output);
        assert_eq!(models[0]["value"], "grok-4.6");
        assert_eq!(models[0]["displayName"], "Grok 4.6");
        assert_eq!(
            models[0]["supportedEffortLevels"],
            json!(["low", "medium", "high", "xhigh"])
        );
        assert_eq!(models[1]["value"], "grok-4.5");
        assert_eq!(
            models[1]["supportedEffortLevels"],
            json!(["low", "medium", "high"])
        );
        assert!(login_status_from_models(true, output.as_bytes(), b"").unwrap());
        assert!(!login_status_from_models(false, b"", b"Not logged in. Run `grok login`.\n").unwrap());
        assert!(!login_status_from_models(
            false,
            b"",
            b"Not signed in. Run `grok login` to authenticate.\n"
        )
        .unwrap());
        assert!(login_status_from_models(true, b"garbage", b"huh").is_err());
    }

    #[test]
    fn first_class_models_use_session_set_model() {
        let session = json!({
            "models": {
                "currentModelId": "grok-4.6",
                "availableModels": [
                    { "modelId": "grok-4.6", "name": "Grok 4.6" },
                    { "modelId": "grok-4.5", "name": "Grok 4.5", "description": "coding" },
                ],
            },
        });
        assert_eq!(
            first_class_model_change(&session, Some("grok-4.5")).as_deref(),
            Some("grok-4.5")
        );
        assert_eq!(first_class_model_change(&session, Some("grok-4.6")), None);
        assert_eq!(first_class_model_change(&session, Some("unknown")), None);
        let catalog = parse_models_from_session(&session);
        assert_eq!(catalog[0]["displayName"], "Grok 4.6");
        assert_eq!(catalog[1]["description"], "coding");
    }

    #[test]
    fn permission_reply_picks_allow_always_for_session_and_cancels_without_reject() {
        let options = vec![
            PermissionOption {
                option_id: "once".into(),
                kind: "allow_once".into(),
            },
            PermissionOption {
                option_id: "always".into(),
                kind: "allow_always".into(),
            },
        ];
        let allow_session = permission_reply(&options, &PermissionDecision::AllowSession);
        assert_eq!(allow_session["outcome"]["optionId"], "always");
        let allow_once = permission_reply(&options, &PermissionDecision::AllowOnce);
        assert_eq!(allow_once["outcome"]["optionId"], "once");
        let deny = permission_reply(
            &options,
            &PermissionDecision::Deny {
                message: "nope".into(),
            },
        );
        assert_eq!(deny["outcome"]["outcome"], "cancelled");
    }

    #[test]
    fn acp_args_keep_no_auto_update_before_the_subcommand() {
        assert_eq!(
            ACP_ARGS,
            ["--no-auto-update", "agent", "--no-leader", "stdio"]
        );
    }
}

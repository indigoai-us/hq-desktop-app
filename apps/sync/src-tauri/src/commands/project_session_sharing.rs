//! Future-only channel transcript publication. The durable outbox is outside
//! the synced HQ tree. A missing enrollment is PRIVATE, including old resumes.
use std::{collections::HashMap, path::PathBuf, sync::{Mutex, OnceLock}, time::Duration};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use hq_desktop_core::{agent_session::types::{SessionEvent, SessionSpec}, session_share::redact_secrets};
use super::{cognito, sync::resolve_vault_api_url};

#[derive(Clone, Serialize, Deserialize)]
struct Message { role: String, text: String }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Outbox {
    version: u8,
    account: String,
    channel_id: String,
    company_uid: String,
    project: String,
    session_id: String,
    native_id: Option<String>,
    tool: String,
    title: String,
    sent: usize,
    registered: bool,
    pending: Vec<Message>,
    #[serde(default)]
    in_flight: Option<Value>,
}

fn actors() -> &'static Mutex<HashMap<String, UnboundedSender<SessionEvent>>> {
    static ACTORS: OnceLock<Mutex<HashMap<String, UnboundedSender<SessionEvent>>>> = OnceLock::new();
    ACTORS.get_or_init(Default::default)
}

fn account(tokens: &cognito::CognitoTokens) -> Result<String, String> {
    cognito::decode_id_token_claims(tokens.id_token.as_deref().ok_or("Sign in to share project sessions")?)?
        .sub.filter(|id| !id.is_empty()).ok_or("Sign in to share project sessions".into())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() < 150 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The explicit account-owned enrollment is the channel authority, including
/// after a restart when the sidebar uses the provider-native session ID.
pub async fn attach_channel_bindings(app: &tauri::AppHandle, links: &mut [hq_desktop_core::session_links::ProjectLink]) {
    let Ok(Some(tokens)) = cognito::get_tokens().await else { return; };
    let Ok(account_id) = account(&tokens) else { return; };
    if !valid_id(&account_id) { return; }
    let Ok(base) = app.path().app_local_data_dir() else { return; };
    let bindings = tokio::time::timeout(Duration::from_secs(2), tokio::task::spawn_blocking(move || {
        let mut bindings = HashMap::new();
        let Ok(entries) = std::fs::read_dir(base.join("project-session-outbox-v1").join(&account_id)) else { return bindings; };
        for entry in entries.filter_map(Result::ok) {
            if entry.path().extension().is_none_or(|ext| ext != "json") { continue; }
            let Ok(raw) = std::fs::read(entry.path()) else { continue; };
            let Ok(row) = serde_json::from_slice::<Outbox>(&raw) else { continue; };
            add_channel_binding(&mut bindings, &row, &account_id);
        }
        bindings
    })).await.ok().and_then(Result::ok).unwrap_or_default();
    for link in links {
        for session in &mut link.sessions {
            session.channel_id = bindings.get(&(link.project.clone(), session.tool.clone(), session.session_id.clone())).cloned();
        }
    }
}

fn add_channel_binding(bindings: &mut HashMap<(String, String, String), String>, row: &Outbox, account: &str) {
    if row.version != 1 || row.account != account { return; }
    bindings.insert((row.project.clone(), row.tool.clone(), row.session_id.clone()), row.channel_id.clone());
    if let Some(native) = &row.native_id {
        bindings.insert((row.project.clone(), row.tool.clone(), native.clone()), row.channel_id.clone());
    }
}

fn matches_resume(row: &Outbox, account: &str, company: &str, project: &str, tool: &str, native: &str) -> bool {
    row.version == 1 && row.account == account && row.company_uid == company && row.project == project
        && row.tool == tool && row.native_id.as_deref() == Some(native)
}

async fn request(method: reqwest::Method, channel_id: &str, session_id: Option<&str>,
    body: Option<&Value>, after: Option<&str>, expected_account: Option<&str>) -> Result<Value, String> {
    if !valid_id(channel_id) || session_id.is_some_and(|id| !valid_id(id)) { return Err("Invalid session reference".into()); }
    let tokens = cognito::get_valid_tokens().await?;
    if let Some(expected) = expected_account {
        if account(&tokens)? != expected { return Err("Session belongs to another signed-in account".into()); }
    }
    let base = resolve_vault_api_url()?;
    let mut url = format!("{}/v1/notify/channels/{channel_id}/sessions", base.trim_end_matches('/'));
    if let Some(id) = session_id { url.push('/'); url.push_str(id); }
    let mut call = crate::util::client_info::build_client().request(method, url)
        .bearer_auth(&tokens.access_token).timeout(Duration::from_secs(12));
    if let Some(body) = body { call = call.json(body); }
    if let Some(after) = after { call = call.query(&[("after", after)]); }
    let response = call.send().await.map_err(|_| "Project session connection failed".to_string())?;
    let status = response.status();
    if !status.is_success() { return Err(format!("Project session unavailable ({})", status.as_u16())); }
    response.json().await.map_err(|_| "Invalid project session response".into())
}

#[tauri::command]
pub async fn project_sessions_read(channel_id: String, session_id: Option<String>, after: Option<String>) -> Result<Value, String> {
    request(reqwest::Method::GET, &channel_id, session_id.as_deref(), None, after.as_deref(), None).await
}

fn save(path: &PathBuf, state: &Outbox) -> Result<(), String> {
    use std::io::Write;
    let mut sanitized = state.clone();
    sanitize_titles(&mut sanitized);
    let bytes = serde_json::to_vec(&sanitized).map_err(|e| e.to_string())?;
    let temp = path.with_extension("pending");
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|e| e.to_string())?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    std::fs::rename(temp, path).map_err(|e| e.to_string())
}

/// No transcript scan/backfill. Only a new channel launch can mint enrollment;
/// resuming uses its existing native-id enrollment or remains private.
pub async fn prepare(app: &tauri::AppHandle, spec: &SessionSpec, channel_id: Option<&str>) -> Result<(), String> {
    let Some(project) = spec.project.as_deref().filter(|p| !p.is_empty()) else { return Ok(()); };
    let Some(company) = spec.company.as_deref() else { return Ok(()); };
    if spec.resume.is_none() && channel_id.is_none() { return Ok(()); }
    let tokens = cognito::get_tokens().await?.ok_or("Sign in to share project sessions")?;
    let account = account(&tokens)?;
    if !valid_id(&account) { return Err("Invalid signed-in account".into()); }
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?
        .join("project-session-outbox-v1").join(&account);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let hq = hq_desktop_core::workspaces::resolve_hq_folder_path()?;
    let Some(company_uid) = super::session_share_channel::company_cloud_uid(&hq, company) else { return Ok(()); };
    let tool = match spec.tool { hq_desktop_core::agent_session::types::SessionTool::Claude => "claude", _ => "codex" };
    let state = if let Some(resume) = spec.resume.as_deref() {
        std::fs::read_dir(&dir).map_err(|e| e.to_string())?.filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|e| e == "json"))
            .filter_map(|entry| std::fs::read(entry.path()).ok())
            .filter_map(|raw| serde_json::from_slice::<Outbox>(&raw).ok())
            .find(|row| matches_resume(row, &account, &company_uid, project, tool, resume))
    } else {
        channel_id.filter(|id| valid_id(id)).map(|channel_id| Outbox { version: 1, account, channel_id: channel_id.into(), company_uid, project: project.into(),
            session_id: spec.session_id.clone(), native_id: None, tool: tool.into(), title: "New session".into(),
            sent: 0, registered: false, pending: Vec::new(), in_flight: None })
    };
    let Some(state) = state else { return Ok(()); };
    let path = dir.join(format!("{}.json", state.session_id));
    start_actor(app, state, path, &spec.session_id)
}

fn start_actor(app: &tauri::AppHandle, mut state: Outbox, path: PathBuf, app_id: &str) -> Result<(), String> {
    // Resume and recovery may load outboxes written before title redaction.
    sanitize_titles(&mut state);
    let (tx, mut rx) = unbounded_channel();
    {
        let mut actors = actors().lock().map_err(|_| "Session sharing unavailable")?;
        if let Some(existing) = actors.get(&state.session_id).cloned() {
            actors.insert(app_id.into(), existing);
            return Ok(());
        }
        save(&path, &state)?;
        actors.insert(state.session_id.clone(), tx.clone());
        actors.insert(app_id.into(), tx);
    }
    let app_id = app_id.to_string();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut dirty = !state.registered || state.in_flight.is_some();
        let mut failures = 0u32;
        let mut retry_at = tokio::time::Instant::now();
        let mut last_error = String::new();
        loop {
            tokio::select! {
                event = rx.recv() => {
                    let Some(event) = event else { break; };
                    match event {
                        SessionEvent::Started { session_id, .. } => state.native_id = Some(session_id),
                        SessionEvent::UserMessage { text, .. } => {
                            let text = visible_prompt(&text);
                            if state.title == "New session" && !text.is_empty() { state.title = shared_title(&text); }
                            append_text(&mut state.pending, "user", &text);
                        },
                        SessionEvent::AssistantMessage { text, parent_tool_use_id: None } => append_text(&mut state.pending, "assistant", &text),
                        _ => continue,
                    }
                    dirty = true;
                    // Persist before any network side effect. A failed write never publishes an unrecorded batch.
                    if save(&path, &state).is_err() { continue; }
                },
                _ = interval.tick(), if dirty || !state.pending.is_empty() => {
                    if tokio::time::Instant::now() < retry_at { continue; }
                    if save(&path, &state).is_err() {
                        let error = "Could not save the project sharing queue";
                        if last_error != error {
                            use tauri::Emitter;
                            let _ = app.emit_to(crate::commands::desktop_alt::WINDOW_LABEL, "project-session:sharing-status", json!({ "sessionId": app_id, "error": error }));
                            last_error = error.into();
                        }
                        continue;
                    }
                    match flush(&mut state, &path).await {
                        Ok(()) => {
                            dirty = false; failures = 0; last_error.clear();
                            let _ = save(&path, &state);
                            use tauri::Emitter;
                            let _ = app.emit_to(crate::commands::desktop_alt::WINDOW_LABEL, "project-session:sharing-status", json!({ "sessionId": app_id, "error": null }));
                        },
                        Err(error) => {
                            failures = (failures + 1).min(6);
                            retry_at = tokio::time::Instant::now() + Duration::from_secs(5 * (1u64 << failures));
                            if error != last_error {
                                use tauri::Emitter;
                                let _ = app.emit_to(crate::commands::desktop_alt::WINDOW_LABEL, "project-session:sharing-status", json!({ "sessionId": app_id, "error": error }));
                                last_error = error;
                            }
                        }
                    }
                }
            }
        }
    });
    Ok(())
}

/// Recover only explicit enrollments, including a queued last answer after a
/// crash. Signing into another account never uploads the previous account's data.
pub fn start_recovery(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            let Ok(Some(tokens)) = cognito::get_tokens().await else { continue; };
            let Ok(account_id) = account(&tokens) else { continue; };
            if !valid_id(&account_id) { continue; }
            let Ok(base) = app.path().app_local_data_dir() else { continue; };
            let Ok(entries) = std::fs::read_dir(base.join("project-session-outbox-v1").join(&account_id)) else { continue; };
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if path.extension().is_none_or(|ext| ext != "json") { continue; }
                let Ok(raw) = std::fs::read(&path) else { continue; };
                let Ok(state) = serde_json::from_slice::<Outbox>(&raw) else { continue; };
                if state.version != 1 || state.account != account_id || !valid_id(&state.session_id) { continue; }
                if state.registered && state.pending.is_empty() && state.in_flight.is_none() { continue; }
                let id = state.session_id.clone();
                let _ = start_actor(&app, state, path, &id);
            }
        }
    });
}

pub fn observe(session_id: &str, event: &SessionEvent) {
    if !matches!(event, SessionEvent::Started { .. } | SessionEvent::UserMessage { .. }
        | SessionEvent::AssistantMessage { parent_tool_use_id: None, .. }) { return; }
    if let Ok(actors) = actors().lock() {
        if let Some(tx) = actors.get(session_id) { let _ = tx.send(event.clone()); }
    }
}

fn visible_prompt(raw: &str) -> String {
    if hq_desktop_core::sessions::codex::is_injected_user_context(raw) { return String::new(); }
    // Attached context is not a message the operator typed. Never republish files
    // or meeting text merely because it was supplied to the local model.
    let visible = raw.split("<hq-context").next().unwrap_or("");
    visible.lines().filter(|line| !line.trim_start().starts_with("/startwork ")).collect::<Vec<_>>().join("\n").trim().to_string()
}

fn append_text(messages: &mut Vec<Message>, role: &str, raw: &str) {
    let text = redact_secrets(raw.trim());
    let mut chunk = String::new();
    for ch in text.chars() {
        if chunk.len() + ch.len_utf8() > 16_000 { messages.push(Message { role: role.into(), text: std::mem::take(&mut chunk) }); }
        chunk.push(ch);
    }
    if !chunk.is_empty() { messages.push(Message { role: role.into(), text: chunk }); }
}

fn shared_title(raw: &str) -> String {
    // Detect credentials before truncation can cut off their identifying suffix.
    let mut redacted = redact_secrets(raw);
    // The common redactor treats REDACTED after `password=` as another value.
    // Collapse only nested replacement markers so repeated saves/retries stay
    // byte-identical without exempting any credential from secret detection.
    while redacted.contains("[[REDACTED]]") {
        redacted = redacted.replace("[[REDACTED]]", "[REDACTED]");
    }
    redacted.chars().take(120).collect()
}

fn sanitize_titles(state: &mut Outbox) {
    state.title = shared_title(&state.title);
    if let Some(batch) = state.in_flight.as_mut() {
        if let Some(title) = batch.get("title").and_then(Value::as_str) {
            batch["title"] = json!(shared_title(title));
        }
    }
}

fn registration_body(state: &Outbox) -> Value {
    json!({
        "sessionId": state.session_id, "title": shared_title(&state.title), "tool": state.tool,
        "visibility": "project-members-v1", "companyUid": state.company_uid, "projectId": state.project
    })
}

async fn flush(state: &mut Outbox, path: &PathBuf) -> Result<(), String> {
    sanitize_titles(state);
    if !state.registered {
        let response = request(reqwest::Method::POST, &state.channel_id, None, Some(&registration_body(state)), None, Some(&state.account)).await?;
        if response["companyUid"].as_str() != Some(&state.company_uid) || response["projectId"].as_str() != Some(&state.project) {
            return Err("Project channel does not match the session".into());
        }
        state.registered = true;
    }
    freeze_batch(state);
    save(path, state)?;
    let batch = state.in_flight.as_ref().ok_or("Missing upload batch")?;
    let response = request(reqwest::Method::PUT, &state.channel_id, Some(&state.session_id), Some(batch), None, Some(&state.account)).await?;
    acknowledge(state, &response)
}

fn freeze_batch(state: &mut Outbox) {
    sanitize_titles(state);
    if state.in_flight.is_none() {
        let count = state.pending.len().min(24);
        state.in_flight = Some(json!({ "title": state.title, "from": state.sent, "messages": &state.pending[..count] }));
    }
}

fn acknowledge(state: &mut Outbox, response: &Value) -> Result<(), String> {
    let batch = state.in_flight.as_ref().ok_or("Missing upload batch")?;
    let count = batch["messages"].as_array().ok_or("Invalid upload batch")?.len();
    if count > state.pending.len() || response["nextSequence"].as_u64() != Some((state.sent + count) as u64) {
        return Err("Transcript acknowledgement mismatch".into());
    }
    state.pending.drain(..count);
    state.sent += count;
    state.in_flight = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn excludes_hidden_context_and_startwork() {
        assert_eq!(visible_prompt("<skill>private</skill>"), "");
        assert_eq!(visible_prompt("/startwork indigo project\nHello\n<hq-context>private</hq-context>"), "Hello");
    }
    #[test] fn long_unicode_answers_are_losslessly_chunked() {
        let text = "你好".repeat(10_000);
        let mut messages = vec![];
        append_text(&mut messages, "assistant", &text);
        assert!(messages.iter().all(|m| m.text.len() <= 16_000));
        assert_eq!(messages.iter().map(|m| m.text.as_str()).collect::<String>(), text);
    }
    fn outbox() -> Outbox {
        Outbox { version: 1, account: "owner".into(), channel_id: "channel".into(), company_uid: "company".into(), project: "launch".into(),
            session_id: "session".into(), native_id: Some("native".into()), tool: "codex".into(), title: "Launch".into(), sent: 0,
            registered: true, pending: vec![Message { role: "user".into(), text: "First".into() }], in_flight: None }
    }
    #[test] fn titles_redact_before_truncation_and_before_registration_or_batch_upload() {
        // A token beginning near the boundary would evade prefix matching if
        // the original prompt were truncated to 120 characters first.
        let secret = ["sk", "-", &"a".repeat(40)].concat();
        let prompt = format!("{}{}", "x ".repeat(52), secret);
        let expected: String = redact_secrets(&prompt).chars().take(120).collect();
        assert_eq!(shared_title(&prompt), expected);
        assert!(!expected.contains("sk-"));
        let mut state = outbox();
        state.title = prompt;
        assert_eq!(registration_body(&state)["title"], expected);
        freeze_batch(&mut state);
        assert_eq!(state.title, expected);
        assert_eq!(state.in_flight.as_ref().unwrap()["title"], expected);
    }
    #[test] fn legacy_outbox_titles_are_scrubbed_on_recovery_and_persistence() {
        let mut legacy = outbox();
        legacy.title = "Use password=example-private-value".into();
        legacy.in_flight = Some(json!({ "title": legacy.title, "from": 0, "messages": legacy.pending }));
        let raw = serde_json::to_vec(&legacy).unwrap();
        let mut restored: Outbox = serde_json::from_slice(&raw).unwrap();
        let expected = shared_title(&legacy.title);
        assert!(!expected.contains("example-private-value"));
        sanitize_titles(&mut restored);
        assert_eq!(restored.title, expected);
        assert_eq!(restored.in_flight.as_ref().unwrap()["title"], expected);
        let sanitized = serde_json::to_vec(&restored).unwrap();
        sanitize_titles(&mut restored);
        freeze_batch(&mut restored);
        assert_eq!(serde_json::to_vec(&restored).unwrap(), sanitized);
        assert_eq!(restored.in_flight.as_ref().unwrap()["messages"], legacy.in_flight.as_ref().unwrap()["messages"]);
        assert_eq!(restored.in_flight.as_ref().unwrap()["from"], 0);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("outbox.json");
        save(&path, &legacy).unwrap();
        let persisted = std::fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&persisted).contains("example-private-value"));
        let persisted: Outbox = serde_json::from_slice(&persisted).unwrap();
        assert_eq!(persisted.title, expected);
        assert_eq!(persisted.in_flight.as_ref().unwrap()["title"], expected);
    }
    #[test] fn channel_binding_survives_native_id_transition_without_crossing_account_project_or_provider() {
        let mut bindings = HashMap::new();
        let row = outbox();
        add_channel_binding(&mut bindings, &row, "other");
        assert!(bindings.is_empty());
        add_channel_binding(&mut bindings, &row, "owner");
        for id in ["session", "native"] {
            assert_eq!(bindings.get(&("launch".into(), "codex".into(), id.into())), Some(&"channel".to_string()));
            assert!(!bindings.contains_key(&("other".into(), "codex".into(), id.into())));
            assert!(!bindings.contains_key(&("launch".into(), "claude".into(), id.into())));
        }
    }
    #[test] fn resume_requires_the_original_account_company_project_tool_and_native_id() {
        let row = outbox();
        assert!(matches_resume(&row, "owner", "company", "launch", "codex", "native"));
        for fields in [["other", "company", "launch", "codex", "native"],
            ["owner", "other", "launch", "codex", "native"], ["owner", "company", "other", "codex", "native"],
            ["owner", "company", "launch", "claude", "native"], ["owner", "company", "launch", "codex", "old-private"]] {
            assert!(!matches_resume(&row, fields[0], fields[1], fields[2], fields[3], fields[4]));
        }
    }
    #[test] fn lost_ack_retries_identical_batch_after_restart_and_new_messages() {
        let mut state = outbox();
        freeze_batch(&mut state);
        let original = state.in_flight.clone();
        let mut restored: Outbox = serde_json::from_slice(&serde_json::to_vec(&state).unwrap()).unwrap();
        append_text(&mut restored.pending, "assistant", "Second");
        restored.title = "Updated title".into();
        freeze_batch(&mut restored);
        assert_eq!(restored.in_flight, original);
        acknowledge(&mut restored, &json!({"nextSequence": 1})).unwrap();
        assert_eq!(restored.pending.len(), 1);
        assert_eq!(restored.pending[0].text, "Second");
        freeze_batch(&mut restored);
        assert_eq!(restored.in_flight.as_ref().unwrap()["from"], 1);
    }
    #[test] fn invalid_ack_never_discards_unsent_text() {
        let mut state = outbox();
        freeze_batch(&mut state);
        assert!(acknowledge(&mut state, &json!({"nextSequence": 100})).is_err());
        assert_eq!(state.pending.len(), 1);
        assert_eq!(state.sent, 0);
        assert!(state.in_flight.is_some());
    }
}

//! Thin Tauri command wrappers for the local **Agency** surface.
//!
//! The pure data shapes and helpers live in `hq_desktop_core::agency`; this
//! module keeps the Tauri command registration surface stable.

use hq_desktop_core::agency::{
    agency_root, child_dirs, cksum, classify_message, inbox_ready, is_within, now_iso,
    parse_options, read_jsonl, read_status_map, resolve_hq_folder,
};
pub use hq_desktop_core::agency::{AgencyWorker, AgencyTeam, AgencyQuestion, AgencyMessage};

/// List every agency team under `workspace/agency/<company>/<team>/`, each with
/// its `(worker, instance)` rows + status + ready flag. Empty (not an error)
/// when nothing is provisioned.
#[tauri::command]
pub async fn list_agency_teams() -> Result<Vec<AgencyTeam>, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("agency reader requires a signed-in user".to_string());
    }
    let root = agency_root(&resolve_hq_folder());
    let mut teams = Vec::new();
    for company in child_dirs(&root) {
        let cdir = root.join(&company);
        for team in child_dirs(&cdir) {
            let tdir = cdir.join(&team);
            let status = read_status_map(&tdir.join("status.json"));
            let mut workers = Vec::new();
            for worker in child_dirs(&tdir) {
                let wdir = tdir.join(&worker);
                for instance in child_dirs(&wdir) {
                    let inbox = wdir.join(&instance).join("chat.jsonl");
                    let wstat = status.get(&worker).and_then(|w| w.get(&instance));
                    let field = |key: &str, default: &str| {
                        wstat
                            .and_then(|i| i.get(key))
                            .and_then(|v| v.as_str())
                            .unwrap_or(default)
                            .to_string()
                    };
                    workers.push(AgencyWorker {
                        worker: worker.clone(),
                        ready: inbox_ready(&inbox),
                        status: field("status", "unknown"),
                        started_at: field("started_at", ""),
                        updated_at: field("updated_at", ""),
                        instance,
                    });
                }
            }
            teams.push(AgencyTeam {
                company: company.clone(),
                team,
                workers,
            });
        }
    }
    Ok(teams)
}

/// List the team-manager's PENDING questions across all teams — `ASK:` lines in
/// each team-liaison inbox whose `[ans:<cksum>]` has not yet been written into
/// the matching team-manager inbox.
#[tauri::command]
pub async fn list_agency_questions() -> Result<Vec<AgencyQuestion>, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("agency reader requires a signed-in user".to_string());
    }
    let root = agency_root(&resolve_hq_folder());
    let mut out = Vec::new();
    for company in child_dirs(&root) {
        let cdir = root.join(&company);
        for team in child_dirs(&cdir) {
            let tdir = cdir.join(&team);
            let liaison = tdir.join("team-liaison").join("main").join("chat.jsonl");
            let manager_text =
                std::fs::read_to_string(tdir.join("team-manager").join("main").join("chat.jsonl"))
                    .unwrap_or_default();
            for o in read_jsonl(&liaison) {
                let role = o.get("role").and_then(|v| v.as_str()).unwrap_or("");
                let from = o.get("from").and_then(|v| v.as_str()).unwrap_or("");
                let text = o.get("text").and_then(|v| v.as_str()).unwrap_or("");
                if role == "user" && from == "manager" {
                    if let Some(q) = text.strip_prefix("ASK: ") {
                        let id = cksum(q.as_bytes()).to_string();
                        if !manager_text.contains(&format!("[ans:{id}]")) {
                            out.push(AgencyQuestion {
                                company: company.clone(),
                                team: team.clone(),
                                id,
                                question: q.to_string(),
                                ts: o
                                    .get("ts")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                options: parse_options(&o),
                            });
                        }
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Answer a pending question — append `ANSWER: <answer> [ans:<id>]` to the
/// team-manager inbox (the same line `liaison.sh answer` writes), idempotently.
/// `id` is the dedup id from `list_agency_questions`. Path-guarded so a crafted
/// company/team can't escape the agency root.
#[tauri::command]
pub async fn answer_agency_question(
    company: String,
    team: String,
    id: String,
    answer: String,
) -> Result<String, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("answering requires a signed-in user".to_string());
    }
    let root = agency_root(&resolve_hq_folder());
    let manager = root
        .join(&company)
        .join(&team)
        .join("team-manager")
        .join("main")
        .join("chat.jsonl");
    if !is_within(&root, &manager) {
        return Err("invalid team path".to_string());
    }
    let existing = std::fs::read_to_string(&manager).unwrap_or_default();
    if existing.contains(&format!("[ans:{id}]")) {
        return Ok("already-answered".to_string());
    }
    if let Some(parent) = manager.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Append-only, matching chat.sh: one compact JSON line to the manager inbox.
    let line = serde_json::json!({
        "role": "user",
        "from": "liaison",
        "text": format!("ANSWER: {answer} [ans:{id}]"),
        "ts": now_iso(),
    });
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&manager)
        .map_err(|e| e.to_string())?;
    writeln!(
        f,
        "{}",
        serde_json::to_string(&line).map_err(|e| e.to_string())?
    )
    .map_err(|e| e.to_string())?;
    Ok("delivered".to_string())
}

/// The Manager ⇄ Liaison conversation for one team — both inboxes merged and
/// sorted chronologically — so the operator can read the full context behind a
/// pending question. Path-guarded; empty (not an error) when nothing exists.
#[tauri::command]
pub async fn list_agency_chat(company: String, team: String) -> Result<Vec<AgencyMessage>, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("agency chat requires a signed-in user".to_string());
    }
    let root = agency_root(&resolve_hq_folder());
    let tdir = root.join(&company).join(&team);
    if !is_within(&root, &tdir) {
        return Err("invalid team path".to_string());
    }
    let mut msgs = Vec::new();
    for owner in ["team-manager", "team-liaison"] {
        let inbox = tdir.join(owner).join("main").join("chat.jsonl");
        for line in read_jsonl(&inbox) {
            let m = classify_message(owner, &line);
            if !m.text.trim().is_empty() {
                msgs.push(m);
            }
        }
    }
    // Chronological by ISO ts (lexical sort is correct for the `…Z` format);
    // stable so same-timestamp lines keep their per-inbox order.
    msgs.sort_by(|a, b| a.ts.cmp(&b.ts));
    Ok(msgs)
}

/// Post an operator message straight into the team-manager inbox — the same
/// chat.jsonl transport the manager's `listen` loop consumes — so the operator
/// can talk to the team directly. Path-guarded; rejects an empty body.
#[tauri::command]
pub async fn send_agency_message(
    company: String,
    team: String,
    text: String,
) -> Result<String, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("sending requires a signed-in user".to_string());
    }
    let body = text.trim();
    if body.is_empty() {
        return Err("empty message".to_string());
    }
    let root = agency_root(&resolve_hq_folder());
    let manager = root
        .join(&company)
        .join(&team)
        .join("team-manager")
        .join("main")
        .join("chat.jsonl");
    if !is_within(&root, &manager) {
        return Err("invalid team path".to_string());
    }
    if let Some(parent) = manager.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Append-only, matching chat.sh `user`/`say`: one compact JSON line.
    let line = serde_json::json!({
        "role": "user",
        "from": "operator",
        "text": body,
        "ts": now_iso(),
    });
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&manager)
        .map_err(|e| e.to_string())?;
    writeln!(
        f,
        "{}",
        serde_json::to_string(&line).map_err(|e| e.to_string())?
    )
    .map_err(|e| e.to_string())?;
    Ok("sent".to_string())
}

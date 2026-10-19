//! The first-run import report: what the tree step's scan found, written to
//! `<hq>/workspace/imports/<YYYY-MM-DDTHH-MM-SS>/report.json` so the
//! daily-brief skill's `latest_import()` and the desktop's welcome view read
//! the same file.
//!
//! The desktop writes it at the end of the tree step from whichever scan ran
//! (the native session scan, or the `hq import scan` fallback), in one shape.
//! It holds counts, times, harness ids and project names only. Names that look
//! like a path or a credential are dropped here as well as in the UI. No
//! transcript content and no path is ever written.
//!
//! The write is atomic: a temp file in the report's own folder is written,
//! synced and renamed into place, so a reader never sees half a report.

use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::commands::install_directory::existing_hq_path;

/// `source` on every report the desktop writes.
pub const REPORT_SOURCE: &str = "desktop-tree-step";
/// The folder under the HQ root that holds one folder per import.
const IMPORTS_DIR: &str = "workspace/imports";
const REPORT_FILE: &str = "report.json";
/// The existing report counts, in the contract's order.
pub const COUNT_KEYS: [&str; 12] = [
    "plans",
    "commands",
    "skills",
    "hooks",
    "policies",
    "agents",
    "claude_md",
    "settings_fragments",
    "mcp_servers",
    "knowledge_dirs",
    "claude_repos",
    "conversations",
];
/// The harness ids a report may list.
const TOOLS: [&str; 3] = ["claude-code", "codex", "cursor"];
const PROJECT_MAX: usize = 10;
const PROJECT_NAME_MAX: usize = 80;
/// A report bigger than this is not read back.
const READ_MAX_BYTES: u64 = 256 * 1024;

/// Session counts and times, as the scan that ran found them.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct ImportReportSessionsInput {
    #[serde(default)]
    pub total: u64,
    #[serde(default)]
    pub claude: u64,
    #[serde(default)]
    pub codex: u64,
    /// 0 when no Cursor workspace was scanned.
    #[serde(default)]
    pub cursor: u64,
    /// Distinct days with a session; null when the scan could not tell.
    #[serde(default)]
    pub days_seen: Option<u32>,
    /// Unix ms of the oldest and newest session.
    #[serde(default)]
    pub first_at: Option<u64>,
    #[serde(default)]
    pub last_at: Option<u64>,
}

/// What the UI hands over at the end of the tree step.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct ImportReportInput {
    #[serde(default)]
    pub sessions: ImportReportSessionsInput,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub projects: Vec<String>,
    /// Any of the 12 count keys; others are ignored, missing ones are 0.
    #[serde(default)]
    pub counts: Map<String, Value>,
}

/// A project name the report may hold: one line, no path, no credential shape.
fn safe_project_name(name: &str) -> Option<String> {
    let t = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() || t.chars().count() > PROJECT_NAME_MAX || name.chars().any(char::is_control) {
        return None;
    }
    if t.contains('/') || t.contains('\\') || t.starts_with('~') {
        return None;
    }
    let bytes = t.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return None;
    }
    let lower = t.to_ascii_lowercase();
    const CREDENTIAL_PREFIXES: [&str; 9] =
        ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "sk-ant-", "sk-proj-", "xox"];
    if CREDENTIAL_PREFIXES.iter().any(|p| lower.contains(p))
        || lower.contains("akia")
            && t.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| w.len() == 20 && w.starts_with("AKIA"))
    {
        return None;
    }
    Some(t)
}

fn iso(ms: Option<u64>) -> Value {
    ms.and_then(|ms| i64::try_from(ms).ok())
        .and_then(DateTime::<Utc>::from_timestamp_millis)
        .map(|t| Value::String(t.to_rfc3339_opts(SecondsFormat::Secs, true)))
        .unwrap_or(Value::Null)
}

fn count_of(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

/// The report body, in the contract's shape and key order.
pub fn report_value(input: &ImportReportInput, folder: &str, now: DateTime<Utc>) -> Value {
    let mut counts = Map::new();
    for key in COUNT_KEYS {
        counts.insert(key.to_string(), json!(count_of(input.counts.get(key))));
    }
    let wanted: BTreeSet<&str> = input.tools.iter().map(String::as_str).collect();
    let tools: Vec<&str> = TOOLS.iter().copied().filter(|t| wanted.contains(t)).collect();
    let mut seen = BTreeSet::new();
    let projects: Vec<String> = input
        .projects
        .iter()
        .filter_map(|p| safe_project_name(p))
        .filter(|p| seen.insert(p.to_lowercase()))
        .take(PROJECT_MAX)
        .collect();
    let s = &input.sessions;
    json!({
        "scan_id": format!("desktop-{folder}"),
        "counts": counts,
        "categories": {},
        "discovery": { "ok": true, "errors": [] },
        "sessions": {
            "total": s.total,
            "claude": s.claude,
            "codex": s.codex,
            "cursor": s.cursor,
            "days_seen": s.days_seen,
            "first_at": iso(s.first_at),
            "last_at": iso(s.last_at),
        },
        "tools": tools,
        "projects": projects,
        "source": REPORT_SOURCE,
        "written_at": now.to_rfc3339_opts(SecondsFormat::Secs, true),
    })
}

/// A free folder for this import: the UTC second, then `-2`, `-3` … when an
/// import already took that second.
fn new_import_folder(imports: &Path, now: DateTime<Utc>) -> Result<(String, PathBuf), String> {
    let stamp = now.format("%Y-%m-%dT%H-%M-%S").to_string();
    for n in 1..=100u32 {
        let name = if n == 1 { stamp.clone() } else { format!("{stamp}-{n}") };
        let dir = imports.join(&name);
        match fs::create_dir(&dir) {
            Ok(()) => return Ok((name, dir)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("could not create the import folder: {}", e.kind())),
        }
    }
    Err("no free import folder for this second".into())
}

/// Write the report under `hq_root` and return its path relative to the root.
pub fn write_import_report_in(hq_root: &Path, input: &ImportReportInput, now: DateTime<Utc>) -> Result<String, String> {
    let imports = hq_root.join(IMPORTS_DIR);
    fs::create_dir_all(&imports).map_err(|e| format!("could not create workspace/imports: {}", e.kind()))?;
    let (folder, dir) = new_import_folder(&imports, now)?;
    let body = serde_json::to_string_pretty(&report_value(input, &folder, now)).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".{REPORT_FILE}.{}.tmp", std::process::id()));
    let target = dir.join(REPORT_FILE);
    let written = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.write_all(b"\n")?;
        f.sync_all()?;
        fs::rename(&tmp, &target)
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        let _ = fs::remove_dir(&dir);
        return Err(format!("could not write the import report: {}", e.kind()));
    }
    Ok(format!("{IMPORTS_DIR}/{folder}/{REPORT_FILE}"))
}

/// True for an import folder name: `YYYY-MM-DDTHH-MM-SS`, maybe with a `-N` suffix.
fn is_import_folder(name: &str) -> bool {
    let b = name.as_bytes();
    if b.len() < 19 {
        return false;
    }
    let shape = b"dddd-dd-ddTdd-dd-dd";
    let stamp_ok = shape.iter().zip(&b[..19]).all(|(s, c)| match s {
        b'd' => c.is_ascii_digit(),
        other => other == c,
    });
    stamp_ok && (b.len() == 19 || (b[19] == b'-' && b.len() > 20 && b[20..].iter().all(u8::is_ascii_digit)))
}

/// The sort key for an import folder: the stamp, then the suffix as a number.
fn folder_order(name: &str) -> (String, u32) {
    let suffix = name.get(20..).and_then(|s| s.parse().ok()).unwrap_or(1);
    (name[..19].to_string(), suffix)
}

/// The newest import report under `hq_root` (by folder name), with only the
/// contract's fields, or None when there is none or it cannot be read.
pub fn latest_import_report_in(hq_root: &Path) -> Option<Value> {
    let imports = hq_root.join(IMPORTS_DIR);
    let mut folders: Vec<String> = fs::read_dir(&imports)
        .ok()?
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| is_import_folder(n))
        .collect();
    folders.sort_by_key(|n| std::cmp::Reverse(folder_order(n)));
    for name in folders {
        let path = imports.join(&name).join(REPORT_FILE);
        let Ok(meta) = fs::metadata(&path) else { continue };
        if !meta.is_file() || meta.len() > READ_MAX_BYTES {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let Ok(Value::Object(report)) = serde_json::from_str::<Value>(&text) else { continue };
        let mut kept = Map::new();
        for key in ["scan_id", "counts", "discovery", "sessions", "tools", "projects", "source", "written_at"] {
            if let Some(v) = report.get(key) {
                kept.insert(key.to_string(), v.clone());
            }
        }
        return Some(Value::Object(kept));
    }
    None
}

/// Write the first-run import report into the HQ folder. Errors when there is
/// no HQ folder yet (the folder is never created here).
#[tauri::command]
pub async fn import_report_write(input: ImportReportInput) -> Result<String, String> {
    let Some(hq_root) = existing_hq_path() else {
        return Err("no_hq".into());
    };
    let result = tokio::task::spawn_blocking(move || write_import_report_in(Path::new(&hq_root), &input, Utc::now()))
        .await
        .map_err(|e| e.to_string())?;
    let outcome = if result.is_ok() { "written" } else { "failed" };
    crate::util::logfile::log("import-report", &format!("write {outcome}"));
    result
}

/// The newest import report in the HQ folder, or null.
#[tauri::command]
pub async fn import_report_latest() -> Option<Value> {
    let hq_root = existing_hq_path()?;
    tokio::task::spawn_blocking(move || latest_import_report_in(Path::new(&hq_root))).await.ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn native_input() -> ImportReportInput {
        let mut counts = Map::new();
        counts.insert("mcp_servers".into(), json!(2));
        counts.insert("claude_repos".into(), json!(6));
        counts.insert("not_a_key".into(), json!(9));
        ImportReportInput {
            sessions: ImportReportSessionsInput {
                total: 402,
                claude: 371,
                codex: 31,
                cursor: 0,
                days_seen: Some(37),
                first_at: Some(at("2026-08-30T14:02:11Z").timestamp_millis() as u64),
                last_at: Some(at("2026-10-19T07:58:40Z").timestamp_millis() as u64),
            },
            tools: vec!["codex".into(), "claude-code".into(), "vim".into()],
            projects: vec![
                "hq".into(),
                "hq-desktop-app".into(),
                "/Users/pat/code/secret".into(),
                "~/code/x".into(),
                "C:\\Users\\pat\\x".into(),
                "repos\\private\\y".into(),
                format!("ghp_{}", "a".repeat(30)),
                "line\nbreak".into(),
                "HQ".into(),
                "billing-api".into(),
            ],
            counts,
        }
    }

    #[test]
    fn import_report_has_the_contract_shape_and_no_paths() {
        let root = tempfile::tempdir().unwrap();
        let now = at("2026-10-19T08:12:30Z");
        let rel = write_import_report_in(root.path(), &native_input(), now).unwrap();
        assert_eq!(rel, "workspace/imports/2026-10-19T08-12-30/report.json");

        let text = fs::read_to_string(root.path().join(&rel)).unwrap();
        let report: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            report,
            json!({
                "scan_id": "desktop-2026-10-19T08-12-30",
                "counts": {
                    "plans": 0, "commands": 0, "skills": 0, "hooks": 0, "policies": 0, "agents": 0,
                    "claude_md": 0, "settings_fragments": 0, "mcp_servers": 2, "knowledge_dirs": 0,
                    "claude_repos": 6, "conversations": 0
                },
                "categories": {},
                "discovery": { "ok": true, "errors": [] },
                "sessions": {
                    "total": 402, "claude": 371, "codex": 31, "cursor": 0, "days_seen": 37,
                    "first_at": "2026-08-30T14:02:11Z", "last_at": "2026-10-19T07:58:40Z"
                },
                "tools": ["claude-code", "codex"],
                "projects": ["hq", "hq-desktop-app", "billing-api"],
                "source": "desktop-tree-step",
                "written_at": "2026-10-19T08:12:30Z"
            })
        );
        // Key order follows the contract.
        let keys: Vec<&String> = report.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            ["scan_id", "counts", "categories", "discovery", "sessions", "tools", "projects", "source", "written_at"]
        );
        // No path, home folder or credential reached the file.
        for bad in ["/Users", "~/", "C:\\", "\\\\", "repos\\", "ghp_", "secret"] {
            assert!(!text.contains(bad), "report holds {bad:?}");
        }
        assert!(!text.contains(&root.path().to_string_lossy().to_string()));
    }

    #[test]
    fn import_report_write_is_atomic_and_leaves_no_temp_file() {
        let root = tempfile::tempdir().unwrap();
        let now = Utc.with_ymd_and_hms(2026, 10, 19, 8, 12, 30).unwrap();
        let first = write_import_report_in(root.path(), &native_input(), now).unwrap();
        // A second import in the same second gets its own folder; nothing is overwritten.
        let second = write_import_report_in(root.path(), &ImportReportInput::default(), now).unwrap();
        assert_eq!(second, "workspace/imports/2026-10-19T08-12-30-2/report.json");
        assert_ne!(first, second);

        for rel in [&first, &second] {
            let dir = root.path().join(rel).parent().unwrap().to_path_buf();
            let names: Vec<String> =
                fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
            assert_eq!(names, vec!["report.json".to_string()], "only the report remains in {}", dir.display());
        }
        // The first report is intact after the second write.
        let report: Value = serde_json::from_str(&fs::read_to_string(root.path().join(&first)).unwrap()).unwrap();
        assert_eq!(report["sessions"]["total"], 402);
    }

    #[test]
    fn import_report_with_unknown_days_keeps_the_same_shape() {
        // The hq-cli fallback knows totals and per-tool counts but not days or times.
        let input = ImportReportInput {
            sessions: ImportReportSessionsInput { total: 12, claude: 12, ..Default::default() },
            tools: vec!["claude-code".into()],
            ..Default::default()
        };
        let report = report_value(&input, "2026-10-19T08-12-30", at("2026-10-19T08:12:30Z"));
        assert_eq!(
            report["sessions"],
            json!({ "total": 12, "claude": 12, "codex": 0, "cursor": 0, "days_seen": null, "first_at": null, "last_at": null })
        );
        let native = report_value(&native_input(), "x", at("2026-10-19T08:12:30Z"));
        let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(keys(&report), keys(&native));
        assert_eq!(keys(&report["sessions"]), keys(&native["sessions"]));
        assert_eq!(keys(&report["counts"]), keys(&native["counts"]));
    }

    #[test]
    fn import_report_latest_reads_the_newest_folder_and_only_contract_fields() {
        let root = tempfile::tempdir().unwrap();
        assert!(latest_import_report_in(root.path()).is_none());

        write_import_report_in(root.path(), &native_input(), at("2026-10-18T08:00:00Z")).unwrap();
        let mut newer = native_input();
        newer.sessions.total = 7;
        write_import_report_in(root.path(), &newer, at("2026-10-19T08:00:00Z")).unwrap();
        let mut newest = native_input();
        newest.sessions.total = 9;
        write_import_report_in(root.path(), &newest, at("2026-10-19T08:00:00Z")).unwrap();
        // Not an import folder: ignored even though it sorts last.
        let stray = root.path().join("workspace/imports/zzz");
        fs::create_dir_all(&stray).unwrap();
        fs::write(stray.join("report.json"), r#"{"sessions":{"total":1}}"#).unwrap();

        let latest = latest_import_report_in(root.path()).unwrap();
        assert_eq!(latest["sessions"]["total"], 9);
        assert!(latest.get("categories").is_none());
        assert_eq!(latest["source"], "desktop-tree-step");

        // An older /import-context report (no sessions block, categories with paths) reads back without categories.
        let old = root.path().join("workspace/imports/2026-10-20T00-00-00");
        fs::create_dir_all(&old).unwrap();
        fs::write(
            old.join("report.json"),
            r#"{"scan_id":"s1","counts":{"conversations":12},"categories":{"plans":["/Users/pat/x.md"]},"discovery":{"ok":true,"errors":[]}}"#,
        )
        .unwrap();
        let latest = latest_import_report_in(root.path()).unwrap();
        assert_eq!(latest, json!({ "scan_id": "s1", "counts": { "conversations": 12 }, "discovery": { "ok": true, "errors": [] } }));
    }

    #[test]
    fn import_folder_names_and_order() {
        assert!(is_import_folder("2026-10-19T08-12-30"));
        assert!(is_import_folder("2026-10-19T08-12-30-12"));
        assert!(!is_import_folder("2026-10-19T08-12-30-"));
        assert!(!is_import_folder("2026-10-19 08-12-30"));
        assert!(!is_import_folder("latest"));
        let mut names = vec!["2026-10-19T08-12-30-10", "2026-10-19T08-12-30", "2026-10-19T08-12-30-2"];
        names.sort_by_key(|n| std::cmp::Reverse(folder_order(n)));
        assert_eq!(names, ["2026-10-19T08-12-30-10", "2026-10-19T08-12-30-2", "2026-10-19T08-12-30"]);
    }
}

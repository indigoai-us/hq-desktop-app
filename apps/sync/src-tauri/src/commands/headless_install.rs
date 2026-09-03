//! Headless dependency install — the unattended entry point the VM install
//! matrix drives (`workspace/e2e-mac/matrix` in HQ).
//!
//! When the process starts with `HQ_HEADLESS_INSTALL_DEPS=<out.json>` set, the
//! app skips its UI entirely, runs the exact same `install_deps` orchestrator the
//! onboarding wizard calls, streams every `install:progress` line to stdout,
//! probes each registry entry afterwards, writes a machine-readable result to
//! `<out.json>`, and exits (0 = every required dep installed, 1 = otherwise).
//!
//! This exists so the dependency engine can be tested on a truly fresh macOS VM
//! without a human clicking through Cognito sign-in — the wizard's auth wall is
//! the reason no automated fresh-install run existed before.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Listener};

use super::install_deps::{self, InstallProgress};

pub const ENV_VAR: &str = "HQ_HEADLESS_INSTALL_DEPS";

#[derive(Serialize)]
struct ProbeResult {
    id: &'static str,
    binary: &'static str,
    optional: bool,
    installed: bool,
    version: Option<String>,
    path: Option<PathBuf>,
}

#[derive(Serialize)]
struct HeadlessResult {
    schema: u32,
    app_version: String,
    started_at: String,
    finished_at: String,
    duration_secs: u64,
    ok: bool,
    error: Option<String>,
    probes: Vec<ProbeResult>,
    progress_lines: usize,
}

/// If the headless env var is present, run the flow and exit the process.
/// Returns `true` when headless mode was engaged so `setup` can return early.
pub fn maybe_run(app: &AppHandle) -> bool {
    let out = match std::env::var(ENV_VAR) {
        Ok(v) if !v.trim().is_empty() => PathBuf::from(v),
        _ => return false,
    };
    eprintln!("[headless-install] engaged; result -> {}", out.display());

    let counter = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter_l = counter.clone();
    app.listen("install:progress", move |event| {
        counter_l.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        match serde_json::from_str::<InstallProgress>(event.payload()) {
            Ok(p) => println!("[{}] {}", p.handle, p.line.trim_end()),
            Err(_) => println!("{}", event.payload()),
        }
    });

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        let started_at = now_iso();
        let outcome = install_deps::install_deps(handle.clone()).await;

        let probes: Vec<ProbeResult> = install_deps::dependency_registry()
            .into_iter()
            .map(|(id, binary, optional)| {
                let st = install_deps::check_dep_impl(binary, None);
                ProbeResult {
                    id,
                    binary,
                    optional,
                    installed: st.installed,
                    version: st.version,
                    path: st.path,
                }
            })
            .collect();

        let required_missing: Vec<&str> = probes
            .iter()
            .filter(|p| !p.optional && !p.installed)
            .map(|p| p.id)
            .collect();

        let mut error = outcome.err();
        if error.is_none() && !required_missing.is_empty() {
            error = Some(format!(
                "install_deps reported Ok but required deps do not probe as installed: {}",
                required_missing.join(", ")
            ));
        }

        let result = HeadlessResult {
            schema: 1,
            app_version: handle.package_info().version.to_string(),
            started_at,
            finished_at: now_iso(),
            duration_secs: started.elapsed().as_secs(),
            ok: error.is_none(),
            error,
            probes,
            progress_lines: counter.load(std::sync::atomic::Ordering::Relaxed),
        };

        let code = if result.ok { 0 } else { 1 };
        match serde_json::to_string_pretty(&result) {
            Ok(json) => {
                if let Some(parent) = out.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Err(e) = std::fs::write(&out, json) {
                    eprintln!("[headless-install] failed to write {}: {e}", out.display());
                }
            }
            Err(e) => eprintln!("[headless-install] serialize failed: {e}"),
        }
        eprintln!(
            "[headless-install] done ok={} in {}s",
            result.ok, result.duration_secs
        );
        handle.exit(code);
    });
    true
}

fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Minimal UTC ISO-8601 without pulling a datetime crate.
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // civil-from-days (Howard Hinnant)
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_iso_is_utc_iso8601() {
        let s = now_iso();
        assert_eq!(s.len(), 20, "{s}");
        assert!(s.ends_with('Z') && s.as_bytes()[10] == b'T', "{s}");
        assert!(s.starts_with("20"), "{s}");
    }

    #[test]
    fn registry_exposes_required_core_deps() {
        let reg = install_deps::dependency_registry();
        let ids: Vec<&str> = reg.iter().map(|(id, _, _)| *id).collect();
        for want in ["node", "qmd", "hq-cli", "git", "yq"] {
            assert!(ids.contains(&want), "missing {want} in {ids:?}");
        }
        let required: Vec<&str> = reg.iter().filter(|(_, _, opt)| !opt).map(|(id, _, _)| *id).collect();
        assert!(required.contains(&"qmd") && required.contains(&"hq-cli"));
    }

    #[test]
    fn result_serialises_with_stable_schema() {
        let r = HeadlessResult {
            schema: 1,
            app_version: "0.0.0".into(),
            started_at: now_iso(),
            finished_at: now_iso(),
            duration_secs: 1,
            ok: false,
            error: Some("x".into()),
            probes: vec![ProbeResult { id: "qmd", binary: "qmd", optional: false, installed: false, version: None, path: None }],
            progress_lines: 0,
        };
        let v: serde_json::Value = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
        assert_eq!(v["schema"], 1);
        assert_eq!(v["probes"][0]["id"], "qmd");
        assert_eq!(v["ok"], false);
    }
}

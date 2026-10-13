//! Package management surface — a thin wrapper over the `hq` CLI's pack
//! lifecycle (`hq packs list/update/uninstall`) plus the registry package
//! listing (`hq packages list`).
//!
//! Design: the CLI owns all the real logic (symlink wiring, archive, update
//! probing). This module just resolves the `hq` binary + the user's HQ folder,
//! shells out, and relays results/progress to the caller. Mirrors the
//! resolution pattern in `hq_core_update.rs`.
//!
//! These commands back the unified desktop-alt **Library → Installed** surface
//! (`src/desktop-alt/panels/InstalledPacksPanel.svelte`). US-009 removed the old
//! standalone Packages window and its `PendingPackages` handshake state; the
//! old lifecycle command names remain only as compatibility shims that route
//! callers into the in-Library tab.
//!
//! Commands:
//!   * `list_packages`          — read-only snapshot (content packs + registry)
//!   * `list_packages_cached`   — last-known snapshot from `~/.hq/sync-packs-cache.json`
//!   * `check_package_updates`  — slower probe; emits `packages:updates`
//!   * `install_package`        — stream `hq install <source>` progress
//!   * `update_package`         — stream `hq packs update <name>`
//!   * `uninstall_package`      — `hq packs uninstall <name> --yes --json`
//!   * `pack_deep_link_catalog_name` — display name for an `hq-desktop://pack/{slug}`
//!     confirmation sheet (catalog, then registry; `None` falls back to the slug)
//!   * `install_pack_from_deep_link` — stream `hq packages install <slug> --start-bot`
//!     and report the bot the CLI started (`bot: <name>` line)

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::commands::config::{read_hq_config_lenient, MenubarPrefs};
use crate::deep_link::is_valid_pack_slug;
use crate::util::hq_resolver;
use crate::util::logfile::log;
use crate::util::paths;

/// Offset from app launch before the first pack-update check fires. 20s keeps
/// it out of lockstep with the app updater (10s) and CLI updater (15s).
// Staggered against version_gate (90s), hq_cli_update (4m), hq_core_state (12m).
const INITIAL_DELAY: Duration = Duration::from_secs(8 * 60);

/// Re-check cadence. Pack update probing may hit the network per installed
/// pack, so keep it on the same 6h background rhythm as the other updaters.
const CHECK_INTERVAL: Duration = Duration::from_secs(21600);

/// Payload emitted when installed content packs have newer upstream versions.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackUpdateInfo {
    pub count: usize,
    pub names: Vec<String>,
}

/// Resolve the user's HQ folder using the standard 4-tier resolver, the same
/// way every other CLI-spawning command in this app does.
fn resolve_hq_folder() -> PathBuf {
    let menubar_prefs: Option<MenubarPrefs> = paths::menubar_json_path()
        .ok()
        .filter(|p| p.exists())
        .and_then(|p| std::fs::read_to_string(&p).ok())
        .and_then(|s| serde_json::from_str(&s).ok());
    let config = read_hq_config_lenient().ok().flatten();
    paths::resolve_hq_folder(
        config.as_ref().and_then(|c| c.hq_folder_path.as_deref()),
        menubar_prefs.as_ref().and_then(|p| p.hq_path.as_deref()),
    )
}

/// Run `hq <args>` in the HQ folder and return parsed stdout JSON.
///
/// `HQ_NO_UPDATE_CHECK=1` is set so the CLI's version gate never tries to
/// auto-update mid-call (which would race the command we asked for).
async fn run_hq_json(args: &[&str]) -> Result<Value, String> {
    let invocation = resolve_packages_hq();
    let _npx_guard = invocation.npx_serial_guard().await;
    let folder = resolve_hq_folder();
    let mut cmd = invocation.command();
    let output = cmd
        .args(args)
        // `hq` is a `#!/usr/bin/env node` script; a Dock/launchd-spawned app
        // gets a minimal PATH where `env` can't find node (exit 127). Hand it
        // the same enriched PATH the sync runner uses. See util::paths.
        .env("PATH", paths::child_path())
        .current_dir(&folder)
        .env("HQ_NO_UPDATE_CHECK", "1")
        .env("HQ_ROOT", &folder)
        .output()
        .await
        .map_err(|e| {
            format!(
                "spawn `hq {}` ({}): {e}",
                args.join(" "),
                invocation.label()
            )
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "`hq {}` exited {}: {}",
            args.join(" "),
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim())
        .map_err(|e| format!("parse `hq {}` JSON: {e}", args.join(" ")))
}

/// Resolve `hq` for package lifecycle commands.
///
/// Package commands do not depend on the cloud-provisioning capabilities
/// checked by the shared resolver. Prefer any discoverable local CLI here so a
/// valid `hq packs` installation never becomes network/cache-dependent merely
/// because it lacks an unrelated cloud command. Only a genuinely missing CLI
/// uses the shared pinned-npx self-heal path.
fn resolve_packages_hq() -> hq_resolver::HqInvocation {
    let local = paths::resolve_bin("hq");
    if local == "hq" {
        hq_resolver::resolve_hq()
    } else {
        hq_resolver::HqInvocation::Local(local)
    }
}

/// Summarize `hq packs list --json --check-updates` into the tiny popover
/// payload. Only literal JSON `true` counts: `false`, `null`, missing fields,
/// malformed rows, and unnamed rows are ignored so a partial CLI payload never
/// creates a noisy banner.
pub(crate) fn pack_update_summary(packs_view: &serde_json::Value) -> PackUpdateInfo {
    let names: Vec<String> = packs_view
        .get("installed")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter(|entry| entry.get("updateAvailable").and_then(|v| v.as_bool()) == Some(true))
        .filter_map(|entry| entry.get("name").and_then(|v| v.as_str()))
        .map(str::to_string)
        .collect();
    PackUpdateInfo {
        count: names.len(),
        names,
    }
}

/// Reconcile the CLI's pack-compatibility flags with the canonical HQ Core
/// metadata used by the titlebar and Settings.
///
/// `hq packs list` is allowed to lag the desktop app's layout/version support.
/// In particular, older CLI builds can either miss v15's `core/core.yaml` or
/// apply general SemVer prerelease exclusion to a compatibility *floor*:
/// `15.0.69-beta.3` then incorrectly fails `>=12.0.0`. Pack requirements are
/// feature floors, not release-channel selectors, so a prerelease tag's numeric
/// core version is authoritative unless the requirement itself names a
/// prerelease.
fn reconcile_hq_core_compatibility(packs_view: &mut Value, local_version: Option<&str>) {
    let Some(local_version) = local_version
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let Ok(current) =
        semver::Version::parse(local_version.strip_prefix('v').unwrap_or(local_version))
    else {
        return;
    };
    let Some(view) = packs_view.as_object_mut() else {
        return;
    };

    view.insert(
        "hqVersion".to_string(),
        Value::String(local_version.to_string()),
    );

    let Some(installed) = view.get_mut("installed").and_then(Value::as_array_mut) else {
        return;
    };
    for pack in installed {
        let Some(requirement) = pack
            .get("requiresHqCore")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Ok(requirement) = semver::VersionReq::parse(requirement) else {
            continue;
        };

        let satisfied = if requirement.matches(&current) {
            true
        } else if current.pre.is_empty()
            || requirement
                .comparators
                .iter()
                .any(|comparator| !comparator.pre.is_empty())
        {
            false
        } else {
            // General SemVer matching excludes prereleases unless the range
            // names one explicitly. For HQ Core feature floors, compare the
            // same numeric release without its channel suffix.
            requirement.matches(&semver::Version::new(
                current.major,
                current.minor,
                current.patch,
            ))
        };

        if let Some(pack) = pack.as_object_mut() {
            pack.insert("hqCoreSatisfied".to_string(), Value::Bool(satisfied));
        }
    }
}

async fn check_pack_updates_once(app: &AppHandle) -> Result<Option<PackUpdateInfo>, String> {
    let packs_view = run_hq_json(&["packs", "list", "--json", "--check-updates"]).await?;
    let info = pack_update_summary(&packs_view);
    if info.count > 0 {
        log(
            "pack-update",
            &format!(
                "{} pack update(s) available: {}",
                info.count,
                info.names.join(", ")
            ),
        );
        let _ = app.emit("pack-update:available", &info);
        Ok(Some(info))
    } else {
        log("pack-update", "no pack updates available");
        let _ = app.emit("pack-update:cleared", ());
        Ok(None)
    }
}

/// Combined view returned to the Packages window: the content-pack lifecycle
/// payload plus the (best-effort) registry payload. Registry is `null` when
/// the user is offline or not entitled — the window renders content packs
/// regardless.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PackagesView {
    packs: Value,
    registry: Option<Value>,
    error: Option<String>,
}

async fn gather_packages(check_updates: bool) -> PackagesView {
    let packs_args: Vec<&str> = if check_updates {
        vec!["packs", "list", "--json", "--check-updates"]
    } else {
        vec!["packs", "list", "--json"]
    };
    let (packs, error) = match run_hq_json(&packs_args).await {
        Ok(mut value) => {
            let local_version = hq_desktop_core::hq_version::get_local_version();
            reconcile_hq_core_compatibility(&mut value, local_version.as_deref());
            (value, None)
        }
        Err(e) => (Value::Null, Some(e)),
    };
    // Registry listing is best-effort: it needs auth + network and may be
    // empty/offline. Never let it fail the whole view.
    let registry = run_hq_json(&["packages", "list", "--json"]).await.ok();
    PackagesView {
        packs,
        registry,
        error,
    }
}

/// Serialize a `PackagesView` snapshot for the on-disk popover cache.
fn serialize_packages_cache(view: &PackagesView) -> Result<String, String> {
    serde_json::to_string(view).map_err(|e| e.to_string())
}

/// Parse a cache-file body. `None` means missing-equivalent (corrupt / not an object).
fn parse_packages_cache(raw: &str) -> Option<Value> {
    serde_json::from_str::<Value>(raw.trim())
        .ok()
        .filter(Value::is_object)
}

fn write_packages_cache_at(path: &Path, body: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create cache dir: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("write cache tmp: {e}")
    })?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("commit cache: {e}")
    })
}

/// Best-effort persist of a successful packs snapshot. Never fails the caller.
fn write_packages_cache(view: &PackagesView) {
    if view.packs.is_null() {
        return;
    }
    let body = match serialize_packages_cache(view) {
        Ok(body) => body,
        Err(e) => {
            log("packs-cache", &format!("serialize failed: {e}"));
            return;
        }
    };
    let path = match paths::packs_cache_json_path() {
        Ok(path) => path,
        Err(e) => {
            log("packs-cache", &format!("path resolve failed: {e}"));
            return;
        }
    };
    if let Err(e) = write_packages_cache_at(&path, &body) {
        log("packs-cache", &format!("write failed: {e}"));
    }
}

fn read_packages_cache() -> Option<Value> {
    let path = match paths::packs_cache_json_path() {
        Ok(path) => path,
        Err(e) => {
            log("packs-cache", &format!("path resolve failed: {e}"));
            return None;
        }
    };
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            log("packs-cache", &format!("read failed: {e}"));
            return None;
        }
    };
    match parse_packages_cache(&raw) {
        Some(value) => Some(value),
        None => {
            log("packs-cache", "corrupt cache; deleting");
            let _ = fs::remove_file(&path);
            None
        }
    }
}

fn spawn_refresh_packages_cache() {
    tauri::async_runtime::spawn(async {
        let view = gather_packages(false).await;
        write_packages_cache(&view);
    });
}

/// Read-only snapshot for the Packages window. Fast path — no update probing.
#[tauri::command]
pub async fn list_packages() -> Result<Value, String> {
    let view = gather_packages(false).await;
    write_packages_cache(&view);
    serde_json::to_value(view).map_err(|e| e.to_string())
}

/// Instant last-known `list_packages` snapshot. `Ok(None)` when missing or corrupt.
#[tauri::command]
pub async fn list_packages_cached() -> Result<Option<Value>, String> {
    Ok(read_packages_cache())
}

/// Slower probe (network per pack). Emits `packages:updates` with the fresh
/// view so the window can show an "updates available" badge without blocking
/// the initial render.
#[tauri::command]
pub async fn check_package_updates(app: AppHandle) -> Result<(), String> {
    let view = gather_packages(true).await;
    let value = serde_json::to_value(view).map_err(|e| e.to_string())?;
    let _ = app.emit("packages:updates", value);
    Ok(())
}

/// On-demand hydration for the popover's pack-update banner. The background
/// checker emits the same events, but this closes the gap where the popover
/// opened after the last 6h tick or missed the launch-time event.
#[tauri::command]
pub async fn check_pack_update(app: AppHandle) -> Result<Option<PackUpdateInfo>, String> {
    check_pack_updates_once(&app).await
}

/// Legacy standalone Packages-window IPC. Installed packs live in the
/// desktop-alt Library surface; route via typed WindowRouter (US-004).
#[tauri::command]
pub async fn open_packages_window(app: AppHandle) -> Result<(), String> {
    crate::commands::desktop_alt::open_destination(
        app,
        crate::commands::desktop_alt::DesktopDestination::LibraryInstalled,
    )
    .await
}

/// Legacy ready-handshake for the retired Packages window. The unified
/// Installed panel self-fetches with `list_packages`, so there is no stashed
/// payload to return.
#[tauri::command]
pub fn packages_window_ready() -> Option<Value> {
    None
}

/// Stream a long-running `hq` mutation, relaying its output to the window as
/// `packages:progress` lines and a terminal `packages:complete` /
/// `packages:error`. Used by install / update. Returns the stdout lines so a
/// caller can read a structured result out of them (the deep-link install
/// reads the `bot: <name>` line).
async fn stream_hq(
    app: &AppHandle,
    op: &str,
    name: &str,
    args: Vec<String>,
) -> Result<Vec<String>, String> {
    let invocation = resolve_packages_hq();
    let _npx_guard = invocation.npx_serial_guard().await;
    let folder = resolve_hq_folder();
    log(
        "packages",
        &format!(
            "stream `hq {}` via {} (op={op}, name={name})",
            args.join(" "),
            invocation.label()
        ),
    );
    let _update_guard = crate::commands::process::begin_update_sensitive_operation()?;
    let mut cmd = invocation.command();
    let mut child = cmd
        .args(&args)
        // node-shebang PATH fix — see run_hq_json.
        .env("PATH", paths::child_path())
        .current_dir(&folder)
        .env("HQ_NO_UPDATE_CHECK", "1")
        .env("HQ_ROOT", &folder)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!(
                "spawn `hq {}` ({}): {e}",
                args.join(" "),
                invocation.label()
            )
        })?;

    // Relay both streams as progress lines. `hq install` prints human progress
    // to stdout/stderr; we surface every line so the window shows live status.
    let captured = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let stdout_task = child.stdout.take().map(|out| {
        let app = app.clone();
        let op = op.to_string();
        let name = name.to_string();
        let captured = captured.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(
                    "packages:progress",
                    serde_json::json!({ "op": op, "name": name, "line": line }),
                );
                let mut captured = captured.lock().unwrap_or_else(|p| p.into_inner());
                if captured.len() < CAPTURED_STDOUT_LINE_CAP {
                    captured.push(line);
                }
            }
        })
    });
    if let Some(err) = child.stderr.take() {
        let app = app.clone();
        let op = op.to_string();
        let name = name.to_string();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(
                    "packages:progress",
                    serde_json::json!({ "op": op, "name": name, "line": line }),
                );
            }
        });
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("await `hq {}`: {e}", args.join(" ")))?;
    if let Some(task) = stdout_task {
        let _ = task.await;
    }

    if status.success() {
        let _ = app.emit(
            "packages:complete",
            serde_json::json!({ "op": op, "name": name }),
        );
        let lines = std::mem::take(&mut *captured.lock().unwrap_or_else(|p| p.into_inner()));
        Ok(lines)
    } else {
        let msg = format!(
            "`hq {}` exited {}",
            args.join(" "),
            status.code().unwrap_or(-1)
        );
        let _ = app.emit(
            "packages:error",
            serde_json::json!({ "op": op, "name": name, "message": msg }),
        );
        Err(msg)
    }
}

/// Upper bound on stdout lines kept for the caller of [`stream_hq`]. The
/// window already received every line as a progress event; this copy exists
/// only to read a structured result (one `bot:` line) out of the output.
const CAPTURED_STDOUT_LINE_CAP: usize = 2000;

/// Construct exact native CLI arguments for an install intent. Kept separate
/// from process spawning so registry routing has a direct regression test.
fn install_package_args(source: &str, registry: bool) -> Vec<String> {
    if registry {
        vec!["packages".into(), "install".into(), source.into()]
    } else {
        vec!["install".into(), source.into(), "--allow-hooks".into()]
    }
}

/// Install a pack. `registry=true` routes to the entitlement-gated registry
/// flow (`hq packages install <slug>`); otherwise the content-pack flow
/// (`hq install <source> --allow-hooks`). `--allow-hooks` avoids a blocking
/// prompt — the window warns the user when a pack contributes hooks.
#[tauri::command]
pub async fn install_package(
    app: AppHandle,
    source: String,
    registry: Option<bool>,
) -> Result<(), String> {
    let args = install_package_args(&source, registry.unwrap_or(false));
    stream_hq(&app, "install", &source, args).await?;
    spawn_refresh_packages_cache();
    Ok(())
}

/// Update an installed content pack (re-install latest).
#[tauri::command]
pub async fn update_package(app: AppHandle, name: String) -> Result<(), String> {
    let args = vec![
        "packs".into(),
        "update".into(),
        name.clone(),
        "--yes".into(),
    ];
    stream_hq(&app, "update", &name, args).await?;
    spawn_refresh_packages_cache();
    Ok(())
}

/// Update every selected installed content pack sequentially. The named form
/// (`hq packs update <name> --yes`) forces a clean re-sync for that pack, which
/// is more reliable than the bare aggregate command when quarantine messaging
/// tells the user to repair a specific stale pack.
#[tauri::command]
pub async fn update_packs(app: AppHandle, names: Vec<String>) -> Result<(), String> {
    for name in names {
        let args = vec![
            "packs".into(),
            "update".into(),
            name.clone(),
            "--yes".into(),
        ];
        stream_hq(&app, "update", &name, args).await?;
    }
    spawn_refresh_packages_cache();
    Ok(())
}

/// Uninstall a content pack. Returns the structured uninstall result so the
/// window can show what was unlinked / archived. The CLI runs the symlink
/// un-wire + archive + re-scan; the app fires the suggested heavier side
/// effects (a sync/reindex) on its own cadence.
#[tauri::command]
pub async fn uninstall_package(name: String) -> Result<Value, String> {
    let _update_guard = crate::commands::process::begin_update_sensitive_operation()?;
    let value = run_hq_json(&["packs", "uninstall", &name, "--yes", "--json"]).await?;
    spawn_refresh_packages_cache();
    Ok(value)
}

// ── hq-desktop://pack/{slug} (US-005) ─────────────────────────────────────────

/// Op name the deep-link install streams under, so the confirmation sheet can
/// pick its own `packages:progress` lines out of the shared event.
const PACK_DEEP_LINK_OP: &str = "pack-deep-link";

/// `hq packages install` prints this line when `--start-bot` started a bot
/// (contract section 7). The value is a bot handle, `^[a-z0-9-]{2,32}$`.
const INSTALL_BOT_LINE_PREFIX: &str = "bot:";

/// Request timeout for the registry name lookup. It only decorates a sheet, so
/// a slow registry falls back to the slug quickly.
const REGISTRY_NAME_TIMEOUT: Duration = Duration::from_secs(5);

/// Bot handle named by the install output, if any. Reads the LAST `bot:` line
/// so a restarted bot (contract: "existing bot with that name: restart it")
/// still resolves, and refuses anything that is not a plain bot handle.
pub(crate) fn bot_name_from_install_output<S: AsRef<str>>(lines: &[S]) -> Option<String> {
    lines
        .iter()
        .rev()
        .map(|line| line.as_ref().trim())
        .filter_map(|line| line.strip_prefix(INSTALL_BOT_LINE_PREFIX))
        .map(str::trim)
        .find(|name| is_valid_bot_handle(name))
        .map(str::to_string)
}

fn is_valid_bot_handle(value: &str) -> bool {
    (2..=32).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn string_field<'a>(entry: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .filter_map(|key| entry.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
}

/// Whether a catalog row names `slug`: by `slug`/`name`, or by a `source`
/// whose last path segment is the slug (`github:org/repo#packages/<slug>`).
fn catalog_entry_matches_slug(entry: &Value, slug: &str) -> bool {
    if string_field(entry, &["slug", "name"]).is_some_and(|value| value == slug) {
        return true;
    }
    string_field(entry, &["source"]).is_some_and(|source| {
        source
            .rsplit(|c| c == '/' || c == '#' || c == ':')
            .next()
            .is_some_and(|tail| tail == slug)
    })
}

/// Display name for `slug` from an `hq packages list --json` view, if the
/// catalog carries one. Searches the installed, available and registry rows;
/// a row that only has a `name` equal to the slug is not a display name.
pub(crate) fn catalog_display_name(view: &Value, slug: &str) -> Option<String> {
    const ROW_SETS: [&str; 4] = ["installed", "available", "registry", "packages"];
    ROW_SETS
        .iter()
        .filter_map(|key| view.get(*key).and_then(Value::as_array))
        .flatten()
        .filter(|entry| catalog_entry_matches_slug(entry, slug))
        .filter_map(|entry| string_field(entry, &["displayName", "display_name", "title"]))
        .map(str::to_string)
        .next()
}

/// First `url:` under `sources:` in `packages/sources.yaml` — the registry the
/// CLI itself installs from (hq-cli `getRegistryUrl`). A scanner rather than a
/// YAML parse: the file is two lines deep and this must never fail loudly.
pub(crate) fn registry_url_from_sources_yaml(contents: &str) -> Option<String> {
    contents
        .lines()
        .map(str::trim)
        .filter_map(|line| line.strip_prefix("- url:").or_else(|| line.strip_prefix("url:")))
        .map(|value| value.trim().trim_matches(|c| c == '"' || c == '\''))
        .find(|value| value.starts_with("https://") || value.starts_with("http://"))
        .map(|value| value.trim_end_matches('/').to_string())
}

/// `package.name` from a registry `GET /packages/{slug}` body.
pub(crate) fn registry_package_name(body: &Value) -> Option<String> {
    body.get("package")
        .and_then(|package| string_field(package, &["displayName", "display_name", "name"]))
        .map(str::to_string)
}

async fn registry_display_name(folder: &Path, slug: &str) -> Option<String> {
    let sources = fs::read_to_string(folder.join("packages").join("sources.yaml")).ok()?;
    let base = registry_url_from_sources_yaml(&sources)?;
    let url = format!("{base}/packages/{slug}");
    let client = reqwest::Client::builder()
        .default_headers(crate::util::client_info::client_headers())
        .timeout(REGISTRY_NAME_TIMEOUT)
        .build()
        .ok()?;
    let response = client.get(&url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    registry_package_name(&body)
}

/// Display name for the `hq-desktop://pack/{slug}` confirmation sheet: the
/// local catalog first (`hq packages list --json`), then the registry the CLI
/// installs from. `Ok(None)` means "show the slug"; nothing here is fatal.
#[tauri::command]
pub async fn pack_deep_link_catalog_name(slug: String) -> Result<Option<String>, String> {
    if !is_valid_pack_slug(&slug) {
        return Err("Not a valid pack slug.".to_string());
    }
    match run_hq_json(&["packages", "list", "--json"]).await {
        Ok(view) => {
            if let Some(name) = catalog_display_name(&view, &slug) {
                return Ok(Some(name));
            }
        }
        Err(error) => log("pack-deep-link", &format!("catalog list unavailable: {error}")),
    }
    let folder = resolve_hq_folder();
    Ok(registry_display_name(&folder, &slug).await)
}

/// Result of a deep-link pack install: the bot the CLI started, when it did.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackDeepLinkInstallResult {
    pub slug: String,
    pub bot_name: Option<String>,
}

/// Exact argv for the deep-link install (contract section 5).
fn pack_deep_link_install_args(slug: &str) -> Vec<String> {
    vec![
        "packages".into(),
        "install".into(),
        slug.into(),
        "--start-bot".into(),
    ]
}

/// Run `hq packages install {slug} --start-bot` for a confirmed
/// `hq-desktop://pack/{slug}` target, streaming progress as
/// `packages:progress` (op `pack-deep-link`), and report the bot named in the
/// install output. Only called after the person pressed Add in the sheet.
#[tauri::command]
pub async fn install_pack_from_deep_link(
    app: AppHandle,
    slug: String,
) -> Result<PackDeepLinkInstallResult, String> {
    if !is_valid_pack_slug(&slug) {
        return Err("Not a valid pack slug.".to_string());
    }
    let lines = stream_hq(&app, PACK_DEEP_LINK_OP, &slug, pack_deep_link_install_args(&slug)).await?;
    spawn_refresh_packages_cache();
    let bot_name = bot_name_from_install_output(&lines);
    log(
        "pack-deep-link",
        &format!(
            "installed {slug}; bot={}",
            bot_name.as_deref().unwrap_or("<none>")
        ),
    );
    Ok(PackDeepLinkInstallResult { slug, bot_name })
}

/// Background loop: first check 20s after launch, then every 6h. Unlike the
/// CLI updater, this never auto-runs the update — pack updates can be heavier
/// and should stay user-initiated from the banner.
pub fn setup_pack_update_checker(app: &AppHandle) {
    if !crate::scratch_build::launch_side_effect_allowed("pack update checker") {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(INITIAL_DELAY).await;
        loop {
            match check_pack_updates_once(&handle).await {
                Ok(_) => {}
                Err(e) => log("pack-update", &format!("background check failed: {e}")),
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_prerelease_core_clears_stale_pack_floor_failures() {
        let mut view = serde_json::json!({
            "hqVersion": null,
            "installed": [
                {
                    "name": "design",
                    "requiresHqCore": ">=12.0.0",
                    "hqCoreSatisfied": false
                },
                {
                    "name": "engineering",
                    "requiresHqCore": ">=14.2.0",
                    "hqCoreSatisfied": false
                },
                {
                    "name": "future",
                    "requiresHqCore": ">=16.0.0",
                    "hqCoreSatisfied": true
                }
            ]
        });

        reconcile_hq_core_compatibility(&mut view, Some("15.0.69-beta.3"));

        assert_eq!(view["hqVersion"], "15.0.69-beta.3");
        assert_eq!(view["installed"][0]["hqCoreSatisfied"], true);
        assert_eq!(view["installed"][1]["hqCoreSatisfied"], true);
        assert_eq!(view["installed"][2]["hqCoreSatisfied"], false);
    }

    #[test]
    fn compatibility_reconciliation_preserves_cli_results_without_canonical_evidence() {
        let original = serde_json::json!({
            "hqVersion": "13.0.0",
            "installed": [
                {
                    "name": "unknown-range",
                    "requiresHqCore": "workspace:*",
                    "hqCoreSatisfied": false
                },
                {
                    "name": "no-requirement",
                    "hqCoreSatisfied": true
                }
            ]
        });
        let mut no_local_version = original.clone();
        let mut invalid_local_version = original.clone();

        reconcile_hq_core_compatibility(&mut no_local_version, None);
        reconcile_hq_core_compatibility(&mut invalid_local_version, Some("not-a-version"));

        assert_eq!(no_local_version, original);
        assert_eq!(invalid_local_version, original);
    }

    #[test]
    fn pack_update_summary_counts_true_update_flags_only() {
        let view = serde_json::json!({
            "installed": [
                { "name": "a", "updateAvailable": true },
                { "name": "b", "updateAvailable": false },
                { "name": "c", "updateAvailable": null },
                { "name": "d", "updateAvailable": true }
            ]
        });

        let info = pack_update_summary(&view);

        assert_eq!(info.count, 2);
        assert_eq!(info.names, vec!["a".to_string(), "d".to_string()]);
    }

    #[test]
    fn pack_update_summary_tolerates_missing_or_empty_installed() {
        assert_eq!(pack_update_summary(&serde_json::json!({})).count, 0);
        assert_eq!(
            pack_update_summary(&serde_json::json!({ "installed": [] })).count,
            0
        );
    }

    #[test]
    fn deep_link_install_argv_is_exactly_the_contract_shape() {
        assert_eq!(
            pack_deep_link_install_args("agency-kit"),
            vec!["packages", "install", "agency-kit", "--start-bot"],
        );
    }

    #[test]
    fn bot_name_is_read_from_the_last_valid_bot_line() {
        let lines = [
            "Installing hq-pack-agency-kit 0.3.0",
            "  bot: not a handle!",
            "bot: agency-guide",
            "done",
        ];
        assert_eq!(
            bot_name_from_install_output(&lines).as_deref(),
            Some("agency-guide")
        );
        assert_eq!(
            bot_name_from_install_output(&["bot:agency-guide  "]).as_deref(),
            Some("agency-guide")
        );
        assert!(bot_name_from_install_output(&["installed", "Bot: Agency"]).is_none());
        assert!(bot_name_from_install_output(&["bot: ../x"]).is_none());
        assert!(bot_name_from_install_output::<&str>(&[]).is_none());
    }

    #[test]
    fn catalog_display_name_matches_slug_name_or_source_tail() {
        let view = serde_json::json!({
            "installed": [
                { "name": "hq-pack-client-service", "displayName": "Client Service" }
            ],
            "available": [
                {
                    "source": "github:indigoai-us/hq-packages#packages/hq-pack-agency-kit",
                    "display_name": "Agency Kit"
                },
                { "source": "github:indigoai-us/hq-packages#packages/hq-pack-gstack" }
            ],
            "registry": [ { "slug": "hq-pack-design", "title": "Design" } ]
        });
        assert_eq!(
            catalog_display_name(&view, "hq-pack-agency-kit").as_deref(),
            Some("Agency Kit")
        );
        assert_eq!(
            catalog_display_name(&view, "hq-pack-client-service").as_deref(),
            Some("Client Service")
        );
        assert_eq!(
            catalog_display_name(&view, "hq-pack-design").as_deref(),
            Some("Design")
        );
        // A row with no display name is not a name: the sheet shows the slug.
        assert!(catalog_display_name(&view, "hq-pack-gstack").is_none());
        assert!(catalog_display_name(&view, "unknown").is_none());
        assert!(catalog_display_name(&serde_json::json!(null), "x").is_none());
    }

    #[test]
    fn registry_url_comes_from_the_first_source() {
        let yaml = "sources:\n  - name: hq\n    url: https://registry.example.com/v1/\n  - url: https://other.example.com\n";
        assert_eq!(
            registry_url_from_sources_yaml(yaml).as_deref(),
            Some("https://registry.example.com/v1")
        );
        assert!(registry_url_from_sources_yaml("sources: []").is_none());
        assert!(registry_url_from_sources_yaml("url: ftp://nope").is_none());
        assert_eq!(
            registry_package_name(&serde_json::json!({
                "package": { "slug": "agency-kit", "name": "Agency Kit" }
            }))
            .as_deref(),
            Some("Agency Kit")
        );
        assert!(registry_package_name(&serde_json::json!({ "package": {} })).is_none());
    }

    #[test]
    fn registry_install_uses_the_native_packages_command_with_a_plain_slug() {
        assert_eq!(
            install_package_args("hq-pack-engineering", true),
            vec!["packages", "install", "hq-pack-engineering"],
        );
        assert_eq!(
            install_package_args("registry:hq-pack-engineering", false),
            vec!["install", "registry:hq-pack-engineering", "--allow-hooks"],
        );
    }

    #[test]
    fn packages_cache_round_trips_a_packages_view() {
        let view = PackagesView {
            packs: serde_json::json!({
                "installed": [
                    { "name": "engineering", "version": "1.4.0" }
                ]
            }),
            registry: Some(serde_json::json!({ "offline": false })),
            error: None,
        };

        let encoded = serialize_packages_cache(&view).expect("serialize");
        let parsed = parse_packages_cache(&encoded).expect("round-trip");

        assert_eq!(parsed["packs"]["installed"][0]["name"], "engineering");
        assert_eq!(parsed["packs"]["installed"][0]["version"], "1.4.0");
        assert_eq!(parsed["registry"]["offline"], false);
        assert!(parsed["error"].is_null());
    }

    #[test]
    fn packages_cache_parse_yields_none_for_corrupt_json() {
        assert!(parse_packages_cache("not-json").is_none());
        assert!(parse_packages_cache("{").is_none());
        assert!(parse_packages_cache("").is_none());
        assert!(parse_packages_cache("[]").is_none());
        assert!(parse_packages_cache("null").is_none());
    }
}

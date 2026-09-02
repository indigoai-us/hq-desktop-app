//! Local filesystem and public hq-desktop-core command owner.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::Utc;
use hq_engine_protocol::method;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::orchestration::SessionOrchestrationState;
use crate::{to_value, CancellationFlag, EngineDomainEvent, EngineError, EngineEventBus};

pub(crate) const IMPLEMENTED_METHODS: &[&str] = &[
    method::CONFIG_GET,
    method::LEGACY_GET_CONFIG,
    method::AUTH_STATE,
    method::WORKSPACES_LIST,
    method::SYNC_STATUS,
    method::LEGACY_GET_SYNC_STATUS,
    method::PROJECTS_LIST,
    method::LEGACY_GET_LOCAL_PROJECTS,
    method::GET_LOCAL_PROJECT_PRD,
    method::GET_LOCAL_PROJECT_README,
    method::GET_LOCAL_COMPANY_GOALS,
    method::GET_COMPANY_CRM_PROJECTION,
    method::SET_LOCAL_PROJECT_STATUS,
    method::SET_LOCAL_STORY_PASSES,
    method::GET_LIBRARY_ROOT,
    method::GET_LIBRARY_COMPANY,
    method::GET_LIBRARY_WORKER_DETAIL,
    method::GET_LIBRARY_SKILL_DETAIL,
    method::GET_COMPANY_FILE_TREE,
    method::GET_COMPANY_FILE_CONTENT,
    method::LIST_HQ_DIR,
    method::SESSIONS_LIST,
    method::LIST_LOCAL_CLAUDE_SESSIONS,
    method::LIST_LOCAL_CODEX_SESSIONS,
    method::GET_HQ_VERSION,
    method::HAS_STORED_TOKEN,
    method::DAEMON_STATUS,
    method::GET_SETTINGS,
    method::SAVE_SETTINGS,
    method::CREATE_DIRECTORY,
    method::CHECK_WRITABLE,
    method::DETECT_HQ,
    method::RESOLVE_HQ_PATH,
    method::SET_HQ_INSTALL_PATH,
    method::WRITE_MENUBAR_HQ_PATH,
    method::WRITE_FILE,
    method::MAKE_DIR,
    method::READ_TEXT_FILE,
    method::CREATE_SYMLINK,
    method::DESKTOP_ALT_ENABLED,
    method::DESKTOP_ALT_IS_ADMIN,
    method::GET_LIFECYCLE_STATE,
    method::IS_FIRST_RUN,
    method::SHOULD_SHOW_AUTO_SYNC_NOTICE,
    method::MARK_FIRST_RUN_COMPLETE,
    method::MARK_AUTO_SYNC_NOTICE_SHOWN,
    method::WRITE_MENUBAR_TELEMETRY_PREF,
    method::GET_STAGING_SOURCE,
    method::GET_USE_STAGING_SOURCE,
    method::SET_STAGING_SOURCE,
    method::DEVICE_FINGERPRINT,
    method::READ_INSTALL_MANIFEST,
    method::RECORD_STEP_START,
    method::RECORD_STEP_OK,
    method::RECORD_STEP_FAILURE,
    method::RECORD_DEPENDENCIES,
    method::RECORD_PACKS,
    method::RECORD_IMPORT,
    method::RECORD_INSTALL_COMPLETE,
    method::CHECK_AI_TOOLS,
    method::DETECT_AI_TOOLS,
    method::LIST_SESSION_HISTORY,
    method::LIST_AGENT_SESSIONS,
    method::IS_INDIGO_USER,
    method::PERSONALIZE_HQ,
    method::GIT_INIT,
    method::GIT_PROBE_USER,
    method::IS_PRIMARY_INSTANCE,
    method::RECHECK_PRIMARY_INSTANCE,
    method::SET_HQ_CLI_UPDATE_DISMISSED,
    method::LIST_AGENCY_TEAMS,
    method::LIST_AGENCY_QUESTIONS,
    method::LIST_AGENCY_CHAT,
    method::ANSWER_AGENCY_QUESTION,
    method::SEND_AGENCY_MESSAGE,
];

#[derive(Debug, Clone)]
pub struct CoreBackend {
    hq_root_override: Option<PathBuf>,
    claude_projects_override: Option<PathBuf>,
    codex_root_override: Option<PathBuf>,
    menubar_path_override: Option<PathBuf>,
    identity_email_override: Option<Option<String>>,
    launch_kind: hq_desktop_core::first_run::LaunchKind,
    lifecycle_state: &'static str,
    enforce_feature_gate: bool,
    manifest_lock: Arc<Mutex<()>>,
    settings_lock: Arc<Mutex<()>>,
    ai_tools_cache: Arc<OnceLock<Value>>,
    git_config_override: Option<PathBuf>,
    event_bus: EngineEventBus,
    session_orchestration: Arc<SessionOrchestrationState>,
    external_sync_progress_watcher: Option<Arc<super::node::ExternalSyncProgressWatcher>>,
    managed_processes: Arc<super::node::ManagedProcessRegistry>,
}

impl Default for CoreBackend {
    fn default() -> Self {
        let menubar_path = hq_desktop_core::paths::menubar_json_path().ok();
        let menubar = menubar_path
            .as_deref()
            .map(hq_desktop_core::first_run::read_menubar_obj)
            .unwrap_or_default();
        let launch_kind = hq_desktop_core::first_run::classify_from_map(&menubar);
        let hq_root = hq_desktop_core::workspaces::resolve_hq_folder_path().ok();
        let config_valid = hq_desktop_core::config::read_hq_config_lenient()
            .ok()
            .flatten()
            .is_some();
        let has_auth = hq_desktop_core::cognito::read_tokens_from_file()
            .ok()
            .flatten()
            .is_some_and(|tokens| !tokens.access_token.trim().is_empty());
        let lifecycle_state = classify_lifecycle_snapshot(
            hq_root.as_deref(),
            menubar_path.as_deref(),
            &menubar,
            config_valid,
            has_auth,
        );
        let event_bus = EngineEventBus::default();
        let external_sync_progress_watcher = Some(
            super::node::start_external_sync_progress_watcher(event_bus.clone()),
        );
        Self {
            hq_root_override: None,
            claude_projects_override: None,
            codex_root_override: None,
            menubar_path_override: None,
            identity_email_override: None,
            launch_kind,
            lifecycle_state,
            enforce_feature_gate: true,
            manifest_lock: Arc::new(Mutex::new(())),
            settings_lock: Arc::new(Mutex::new(())),
            ai_tools_cache: Arc::new(OnceLock::new()),
            git_config_override: None,
            event_bus,
            session_orchestration: Arc::new(SessionOrchestrationState::default()),
            external_sync_progress_watcher,
            managed_processes: Arc::new(super::node::ManagedProcessRegistry::default()),
        }
    }
}

impl CoreBackend {
    /// Construct a backend with explicit roots. This is useful for isolated
    /// tests and deterministic preview processes; production uses `default()`.
    pub fn with_roots(
        hq_root: impl Into<PathBuf>,
        claude_projects: impl Into<PathBuf>,
        codex_root: impl Into<PathBuf>,
    ) -> Self {
        let hq_root = hq_root.into();
        let menubar_path = hq_root.join(".hq").join("menubar.json");
        let git_config_override = hq_root.join(".hq").join("test-gitconfig");
        let menubar = hq_desktop_core::first_run::read_menubar_obj(&menubar_path);
        let launch_kind = hq_desktop_core::first_run::classify_from_map(&menubar);
        let lifecycle_state = classify_lifecycle_snapshot(
            Some(&hq_root),
            Some(&menubar_path),
            &menubar,
            false,
            false,
        );
        Self {
            menubar_path_override: Some(menubar_path),
            hq_root_override: Some(hq_root),
            claude_projects_override: Some(claude_projects.into()),
            codex_root_override: Some(codex_root.into()),
            identity_email_override: Some(None),
            launch_kind,
            lifecycle_state,
            enforce_feature_gate: false,
            manifest_lock: Arc::new(Mutex::new(())),
            settings_lock: Arc::new(Mutex::new(())),
            ai_tools_cache: Arc::new(OnceLock::new()),
            git_config_override: Some(git_config_override),
            event_bus: EngineEventBus::default(),
            session_orchestration: Arc::new(SessionOrchestrationState::default()),
            external_sync_progress_watcher: None,
            managed_processes: Arc::new(super::node::ManagedProcessRegistry::default()),
        }
    }

    /// Override the decoded identity for an isolated preview/test backend.
    pub fn with_identity_email(mut self, email: Option<&str>) -> Self {
        self.identity_email_override = Some(
            email
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
        );
        self
    }

    pub(crate) fn hq_root(&self) -> Result<PathBuf, EngineError> {
        self.hq_root_override.clone().map_or_else(
            || {
                hq_desktop_core::workspaces::resolve_hq_folder_path()
                    .map_err(|message| EngineError::new("hq_root_unavailable", message, false))
            },
            Ok,
        )
    }

    pub(crate) fn claude_projects_root(&self) -> PathBuf {
        self.claude_projects_override
            .clone()
            .unwrap_or_else(hq_desktop_core::sessions::claude::claude_projects_dir)
    }

    pub(crate) fn codex_root(&self) -> PathBuf {
        self.codex_root_override
            .clone()
            .unwrap_or_else(hq_desktop_core::sessions::codex::codex_dir)
    }

    pub(crate) fn menubar_path(&self) -> Result<PathBuf, EngineError> {
        self.menubar_path_override.clone().map_or_else(
            || {
                hq_desktop_core::paths::menubar_json_path().map_err(|message| {
                    EngineError::new("settings_path_unavailable", message, false)
                })
            },
            Ok,
        )
    }

    pub(crate) fn identity_email(&self) -> Result<Option<String>, EngineError> {
        self.identity_email_override
            .clone()
            .map_or_else(read_identity_email, Ok)
    }

    pub fn event_bus(&self) -> EngineEventBus {
        self.event_bus.clone()
    }

    pub(crate) fn shutdown_external_sync_progress_watcher(&self) {
        if let Some(watcher) = &self.external_sync_progress_watcher {
            watcher.shutdown();
        }
    }

    pub(crate) fn managed_processes(&self) -> Arc<super::node::ManagedProcessRegistry> {
        Arc::clone(&self.managed_processes)
    }

    pub(crate) fn shutdown_managed_processes(&self) {
        self.managed_processes.shutdown();
    }

    pub(crate) fn session_orchestration_state(&self) -> &SessionOrchestrationState {
        &self.session_orchestration
    }

    pub(crate) fn record_sync_activity(&self, event_name: &str, payload: &Value) {
        use hq_desktop_core::events::{EVENT_SYNC_NEW_FILES, EVENT_SYNC_PROGRESS};

        match event_name {
            EVENT_SYNC_PROGRESS => {
                let Ok(progress) = serde_json::from_value::<
                    hq_desktop_core::events::SyncProgressEvent,
                >(payload.clone()) else {
                    return;
                };
                let entry = hq_desktop_core::activity::ActivityEntry {
                    company: progress.company.clone(),
                    path: progress.path.clone(),
                    bytes: progress.bytes,
                    direction: hq_desktop_core::activity::direction_for(&progress),
                    author: progress.author.clone(),
                    is_new: None,
                    at: hq_desktop_core::activity::now_millis(),
                };
                self.session_orchestration.append_activity(entry.clone());
                self.emit_domain_event(
                    None,
                    "activity:append",
                    to_value(entry).unwrap_or_default(),
                );
            }
            EVENT_SYNC_NEW_FILES => {
                let Ok(new_files) = serde_json::from_value::<
                    hq_desktop_core::events::SyncNewFilesEvent,
                >(payload.clone()) else {
                    return;
                };
                let activity = self.session_orchestration.reconcile_new_files(&new_files);
                self.emit_domain_event(
                    None,
                    "activity:list",
                    to_value(activity).unwrap_or_default(),
                );
            }
            _ => {}
        }
    }

    pub fn emit_domain_event(
        &self,
        request_id: Option<String>,
        name: impl Into<String>,
        data: Value,
    ) -> usize {
        self.event_bus
            .emit(EngineDomainEvent::new(request_id, name, data))
    }

    fn install_manifest_path(&self) -> Result<PathBuf, EngineError> {
        self.menubar_path()?
            .parent()
            .map(|parent| parent.join("install-manifest.json"))
            .ok_or_else(|| {
                EngineError::new(
                    "install_manifest_path_unavailable",
                    "Could not resolve the app configuration directory",
                    false,
                )
            })
    }

    fn install_manifest_install_path(&self) -> Result<String, EngineError> {
        self.hq_root_override.as_ref().map_or_else(
            || resolve_install_path(&self.menubar_path()?),
            |root| Ok(root.to_string_lossy().into_owned()),
        )
    }

    fn device_fingerprint(&self) -> Result<String, EngineError> {
        let _guard = self.manifest_lock.lock().map_err(|_| {
            core_command_error(
                "device_fingerprint",
                "Local state lock was poisoned".to_string(),
            )
        })?;
        let path = self.menubar_path()?;
        let menubar = hq_desktop_core::first_run::read_menubar_obj(&path);
        if let Some(machine_id) = menubar
            .get("machineId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|machine_id| !machine_id.is_empty())
        {
            return Ok(machine_id.to_string());
        }
        let machine_id = uuid::Uuid::new_v4().to_string();
        hq_desktop_core::first_run::merge_menubar_flags(
            &path,
            &[("machineId", Value::String(machine_id.clone()))],
        )
        .map_err(|message| core_command_error("device_fingerprint", message))?;
        Ok(machine_id)
    }

    fn read_install_manifest(&self) -> Result<InstallManifest, EngineError> {
        let _guard = self.manifest_lock.lock().map_err(|_| {
            core_command_error(
                "read_install_manifest",
                "Local state lock was poisoned".to_string(),
            )
        })?;
        Ok(read_manifest_from_path(
            &self.install_manifest_path()?,
            self.install_manifest_install_path()?,
            installer_version(),
        ))
    }

    fn update_install_manifest<F>(
        &self,
        method: &str,
        mutate: F,
    ) -> Result<InstallManifest, EngineError>
    where
        F: FnOnce(&mut InstallManifest),
    {
        let _guard = self
            .manifest_lock
            .lock()
            .map_err(|_| core_command_error(method, "Local state lock was poisoned".to_string()))?;
        let path = self.install_manifest_path()?;
        let install_path = self.install_manifest_install_path()?;
        let version = installer_version();
        let mut manifest = read_manifest_from_path(&path, install_path.clone(), version.clone());
        manifest.install_path = install_path;
        manifest.installer_version = version;
        mutate(&mut manifest);
        write_manifest_to_path(&path, &manifest, method)?;
        Ok(manifest)
    }

    fn git_command(&self) -> Command {
        let mut command = Command::new(hq_desktop_core::paths::resolve_bin("git"));
        command.env("PATH", hq_desktop_core::paths::child_path());
        if let Some(config) = &self.git_config_override {
            command
                .env("GIT_CONFIG_GLOBAL", config)
                .env("GIT_CONFIG_NOSYSTEM", "1");
        }
        command
    }

    fn run_git(&self, args: &[OsString], method: &str) -> Result<Output, EngineError> {
        let output =
            self.git_command().args(args).output().map_err(|error| {
                core_command_error(method, format!("Failed to spawn git: {error}"))
            })?;
        if output.status.success() {
            Ok(output)
        } else {
            Err(core_command_error(
                method,
                format_git_failure(args, &output),
            ))
        }
    }

    fn read_global_git_config(
        &self,
        key: &str,
        method: &str,
    ) -> Result<Option<String>, EngineError> {
        let args = [
            OsString::from("config"),
            OsString::from("--global"),
            OsString::from(key),
        ];
        let output = self.git_command().args(&args).output().map_err(|error| {
            core_command_error(
                method,
                format!("Failed to spawn git config --global {key}: {error}"),
            )
        })?;
        if !output.status.success() && output.status.code() == Some(1) {
            return Ok(None);
        }
        if !output.status.success() {
            return Err(core_command_error(
                method,
                format_git_failure(&args, &output),
            ));
        }
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok((!value.is_empty()).then_some(value))
    }
}

impl CoreBackend {
    pub(crate) fn execute_local(
        &self,
        method: &str,
        params: &Value,
        cancellation: &CancellationFlag,
    ) -> Result<Value, EngineError> {
        cancellation.check()?;
        let params = params.as_object().ok_or_else(|| {
            EngineError::new(
                "invalid_params",
                format!("`{method}` params must be a JSON object"),
                false,
            )
        })?;
        if method == method::WORKSPACES_LIST
            && params
                .get("includeCloud")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            return Err(EngineError::new(
                "capability_not_implemented",
                "`workspaces.list` currently supports local discovery only",
                false,
            ));
        }
        if self.enforce_feature_gate && requires_desktop_feature_gate(method) {
            require_desktop_feature_access(self.identity_email()?.as_deref())?;
        }
        let value = match method {
            method::CONFIG_GET => {
                let config = hq_desktop_core::config::read_hq_config_lenient()
                    .map_err(|message| EngineError::new("config_read_failed", message, false))?;
                json!({
                    "source": "local",
                    "config": config,
                })
            }
            method::LEGACY_GET_CONFIG => {
                let config = hq_desktop_core::config::read_hq_config_lenient()
                    .map_err(|message| EngineError::new("config_read_failed", message, false))?;
                let hq_root = self.hq_root()?;
                match config {
                    Some(config) => json!({
                        "configured": true,
                        "companySlug": config.company_slug,
                        "companyUid": config.company_uid,
                        "personUid": config.person_uid,
                        "role": config.role,
                        "bucketName": config.bucket_name,
                        "vaultApiUrl": config.vault_api_url,
                        "hqFolderPath": hq_root.to_string_lossy(),
                        "error": null,
                    }),
                    None => {
                        let config_exists = hq_desktop_core::paths::config_json_path()
                            .map(|path| path.exists())
                            .unwrap_or(false);
                        json!({
                            "configured": false,
                            "companySlug": null,
                            "companyUid": null,
                            "personUid": null,
                            "role": null,
                            "bucketName": null,
                            "vaultApiUrl": null,
                            "hqFolderPath": hq_root.to_string_lossy(),
                            "error": if config_exists {
                                "~/.hq/config.json is present but doesn't match HqConfig."
                            } else {
                                "HQ is not configured. Please run hq-installer to complete setup."
                            },
                        })
                    }
                }
            }
            method::AUTH_STATE => {
                let tokens =
                    hq_desktop_core::cognito::read_tokens_from_file().map_err(|message| {
                        EngineError::new("auth_state_read_failed", message, false)
                    })?;
                let has_stored_tokens = tokens.is_some();
                let authenticated = tokens
                    .as_ref()
                    .is_some_and(|tokens| !hq_desktop_core::cognito::is_expired(tokens));
                let expires_at = tokens
                    .as_ref()
                    .map(hq_desktop_core::cognito::expires_at_iso);
                json!({
                    "source": "local",
                    "authenticated": authenticated,
                    "hasStoredTokens": has_stored_tokens,
                    "expiresAt": expires_at,
                    "refreshPerformed": false,
                })
            }
            method::WORKSPACES_LIST => {
                let hq_root = self.hq_root()?;
                let (entries, manifest_error) =
                    hq_desktop_core::workspaces::discover_local_companies(&hq_root);
                let workspaces: Vec<Value> = entries
                    .into_iter()
                    .map(|entry| {
                        json!({
                            "slug": entry.slug,
                            "displayName": entry.display_name,
                            "path": entry.path.to_string_lossy(),
                            "exists": entry.dir_exists,
                            "cloudUid": entry.cloud_uid,
                            "bucketName": entry.bucket_name,
                            "source": "local",
                        })
                    })
                    .collect();
                json!({
                    "source": "local",
                    "hqFolderPath": hq_root.to_string_lossy(),
                    "workspaces": workspaces,
                    "manifestError": manifest_error,
                })
            }
            method::SYNC_STATUS => {
                let hq_root = self.hq_root()?;
                let journal_path = hq_root.join(".hq-sync-journal.json");
                let status = if journal_path.exists() {
                    hq_desktop_core::status::try_journal_status(&hq_root.to_string_lossy())
                        .map_err(|message| {
                            EngineError::new("sync_status_read_failed", message, false)
                        })?
                } else {
                    hq_desktop_core::status::default_status()
                };
                to_value(status)?
            }
            method::LEGACY_GET_SYNC_STATUS => {
                let hq_root = self.hq_root()?;
                let status =
                    hq_desktop_core::status::try_journal_status(&hq_root.to_string_lossy())
                        .unwrap_or_else(|_| hq_desktop_core::status::default_status());
                to_value(status)?
            }
            method::PROJECTS_LIST | method::LEGACY_GET_LOCAL_PROJECTS => {
                let hq_root = self.hq_root()?;
                let projects = hq_desktop_core::projects_local::scan_local_projects(&hq_root);
                to_value(projects)?
            }
            method::GET_LOCAL_PROJECT_PRD => {
                let hq_root = self.hq_root()?;
                let prd_path = required_string(params, "prdPath", method)?;
                let prd = hq_desktop_core::projects_local::read_project_prd(&hq_root, prd_path)
                    .map_err(|message| core_command_error(method, message))?;
                to_value(prd)?
            }
            method::GET_LOCAL_PROJECT_README => {
                let hq_root = self.hq_root()?;
                let prd_path = required_string(params, "prdPath", method)?;
                let readme =
                    hq_desktop_core::projects_local::read_project_readme(&hq_root, prd_path)
                        .map_err(|message| core_command_error(method, message))?;
                to_value(readme)?
            }
            method::GET_LOCAL_COMPANY_GOALS => {
                let hq_root = self.hq_root()?;
                let company_slug = required_string(params, "companySlug", method)?;
                let goals =
                    hq_desktop_core::projects_local::read_company_goals(&hq_root, company_slug)
                        .map_err(|message| core_command_error(method, message))?;
                to_value(goals)?
            }
            method::GET_COMPANY_CRM_PROJECTION => {
                let hq_root = self.hq_root()?;
                let company_slug = required_string(params, "companySlug", method)?;
                hq_desktop_core::projects_local::read_crm_projection(&hq_root, company_slug)
                    .map_err(|message| core_command_error(method, message))?
            }
            method::SET_LOCAL_PROJECT_STATUS => {
                let hq_root = self.hq_root()?;
                let board_path = required_string(params, "boardPath", method)?;
                let project_id = required_string(params, "projectId", method)?;
                let status = required_string(params, "status", method)?;
                hq_desktop_core::projects_local::write_project_status(
                    &hq_root, board_path, project_id, status,
                )
                .map_err(|message| core_command_error(method, message))?;
                Value::Null
            }
            method::SET_LOCAL_STORY_PASSES => {
                let hq_root = self.hq_root()?;
                let prd_path = required_string(params, "prdPath", method)?;
                let story_id = required_string(params, "storyId", method)?;
                let passes = required_bool(params, "passes", method)?;
                hq_desktop_core::projects_local::write_story_passes(
                    &hq_root, prd_path, story_id, passes,
                )
                .map_err(|message| core_command_error(method, message))?;
                Value::Null
            }
            method::GET_LIBRARY_ROOT => {
                let hq_root = self.hq_root()?;
                to_value(hq_desktop_core::library_local::scan_root_library(&hq_root))?
            }
            method::GET_LIBRARY_COMPANY => {
                let hq_root = self.hq_root()?;
                let company_slug = required_string(params, "companySlug", method)?;
                let library =
                    hq_desktop_core::library_local::scan_company_library(&hq_root, company_slug)
                        .map_err(|message| core_command_error(method, message))?;
                to_value(library)?
            }
            method::GET_LIBRARY_WORKER_DETAIL => {
                let hq_root = self.hq_root()?;
                let worker_path = required_string(params, "workerPath", method)?;
                let detail =
                    hq_desktop_core::library_local::read_worker_detail(&hq_root, worker_path)
                        .map_err(|message| core_command_error(method, message))?;
                to_value(detail)?
            }
            method::GET_LIBRARY_SKILL_DETAIL => {
                let hq_root = self.hq_root()?;
                let skill_path = required_string(params, "skillPath", method)?;
                let detail =
                    hq_desktop_core::library_local::read_skill_detail(&hq_root, skill_path)
                        .map_err(|message| core_command_error(method, message))?;
                to_value(detail)?
            }
            method::GET_COMPANY_FILE_TREE => {
                let hq_root = self.hq_root()?;
                let slug = required_string(params, "slug", method)?;
                let tree = hq_desktop_core::desktop_alt::build_file_tree(&hq_root, slug)
                    .map_err(|message| core_command_error(method, message))?;
                to_value(tree)?
            }
            method::GET_COMPANY_FILE_CONTENT => {
                let hq_root = self.hq_root()?;
                let path = required_string(params, "path", method)?;
                let content = hq_desktop_core::desktop_alt::read_file_content(&hq_root, path)
                    .map_err(|message| core_command_error(method, message))?;
                to_value(content)?
            }
            method::LIST_HQ_DIR => {
                let hq_root = self.hq_root()?;
                let rel_path = string_param(params, "relPath", method, true)?;
                let entries = hq_desktop_core::desktop_alt::list_dir_entries(&hq_root, rel_path)
                    .map_err(|message| core_command_error(method, message))?;
                to_value(entries)?
            }
            method::SESSIONS_LIST => {
                let now = SystemTime::now();
                let hq_root = self.hq_root().ok();
                let mut sessions = hq_desktop_core::sessions::claude::scan_claude_sessions(
                    &self.claude_projects_root(),
                    hq_root.as_deref(),
                    now,
                );
                sessions.extend(hq_desktop_core::sessions::codex::scan_codex_sessions(
                    &self.codex_root(),
                    now,
                ));
                sessions.sort_by(|left, right| {
                    right
                        .last_activity_at
                        .cmp(&left.last_activity_at)
                        .then_with(|| left.id.cmp(&right.id))
                });
                to_value(sessions)?
            }
            method::LIST_LOCAL_CLAUDE_SESSIONS => {
                let hq_root = self.hq_root().ok();
                let sessions = hq_desktop_core::sessions::claude::scan_claude_sessions(
                    &self.claude_projects_root(),
                    hq_root.as_deref(),
                    SystemTime::now(),
                );
                to_value(sessions)?
            }
            method::LIST_LOCAL_CODEX_SESSIONS => {
                let sessions = hq_desktop_core::sessions::codex::scan_codex_sessions(
                    &self.codex_root(),
                    SystemTime::now(),
                );
                to_value(sessions)?
            }
            method::GET_HQ_VERSION => {
                let version = match self.hq_root_override.as_deref() {
                    Some(root) => read_hq_version_at(root),
                    None => hq_desktop_core::hq_version::get_local_version(),
                };
                to_value(version)?
            }
            method::HAS_STORED_TOKEN => {
                let has_stored_token = hq_desktop_core::cognito::read_tokens_from_file()
                    .map_err(|message| EngineError::new("has_stored_token_failed", message, false))?
                    .is_some_and(|tokens| !tokens.access_token.trim().is_empty());
                to_value(has_stored_token)?
            }
            method::DAEMON_STATUS => {
                let hq_root = self.hq_root()?;
                let hq_root = hq_root.to_string_lossy();
                let status =
                    if let Some(daemon) = hq_desktop_core::daemon::read_daemon_json(&hq_root) {
                        let pid = daemon
                            .pid
                            .or_else(|| hq_desktop_core::daemon::read_pid_file(&hq_root));
                        hq_desktop_core::daemon::DaemonStatus {
                            running: pid
                                .map(hq_desktop_core::daemon::is_pid_alive)
                                .unwrap_or(false),
                            pid,
                            started_at: daemon.started_at,
                            watch_path: daemon.watch_path,
                            source: "daemon_json".to_string(),
                        }
                    } else if let Some(pid) = hq_desktop_core::daemon::read_pid_file(&hq_root) {
                        hq_desktop_core::daemon::DaemonStatus {
                            running: hq_desktop_core::daemon::is_pid_alive(pid),
                            pid: Some(pid),
                            started_at: None,
                            watch_path: None,
                            source: "pid_file".to_string(),
                        }
                    } else {
                        hq_desktop_core::daemon::DaemonStatus {
                            running: false,
                            pid: None,
                            started_at: None,
                            watch_path: None,
                            source: "none".to_string(),
                        }
                    };
                to_value(status)?
            }
            method::GET_SETTINGS => {
                let prefs = read_settings(&self.menubar_path()?)?;
                to_value(prefs)?
            }
            method::SAVE_SETTINGS => {
                let _guard = self.settings_lock.lock().map_err(|_| {
                    core_command_error(
                        method::SAVE_SETTINGS,
                        "Settings lock was poisoned".to_string(),
                    )
                })?;
                let prefs = params.get("prefs").cloned().ok_or_else(|| {
                    EngineError::new(
                        "invalid_params",
                        "`save_settings` requires object param `prefs`",
                        false,
                    )
                })?;
                let prefs: hq_desktop_core::config::MenubarPrefs = serde_json::from_value(prefs)
                    .map_err(|error| {
                        EngineError::new(
                            "invalid_params",
                            format!("`save_settings` prefs are invalid: {error}"),
                            false,
                        )
                    })?;
                save_settings(&self.menubar_path()?, &prefs)?;
                Value::Null
            }
            method::CREATE_DIRECTORY => {
                let parent = required_string(params, "parent", method)?;
                let name = required_string(params, "name", method)?.trim();
                if name.contains('/') || name.contains('\\') {
                    return Err(EngineError::new(
                        "invalid_params",
                        "Folder name cannot contain path separators",
                        false,
                    ));
                }
                let parent = expand_tilde(parent);
                if !parent.exists() {
                    return Err(core_command_error(
                        method,
                        format!("Parent directory does not exist: {}", parent.display()),
                    ));
                }
                let target = parent.join(name);
                let already_existed = target.exists();
                if already_existed && !target.is_dir() {
                    return Err(core_command_error(
                        method,
                        format!("{} exists but is a file, not a folder", target.display()),
                    ));
                }
                if !already_existed {
                    std::fs::create_dir_all(&target).map_err(|error| {
                        core_command_error(
                            method,
                            format!("Failed to create {}: {error}", target.display()),
                        )
                    })?;
                }
                let non_empty = std::fs::read_dir(&target)
                    .map(|mut entries| entries.next().is_some())
                    .unwrap_or(false);
                json!({
                    "path": target.to_string_lossy(),
                    "already_existed": already_existed,
                    "non_empty": non_empty,
                })
            }
            method::CHECK_WRITABLE => {
                let path = expand_tilde(required_string(params, "path", method)?);
                to_value(check_writable(&path))?
            }
            method::DETECT_HQ => {
                let path = expand_tilde(required_string(params, "path", method)?);
                let exists = path.exists();
                let is_hq = exists
                    && (path.join("companies/manifest.yaml").exists()
                        || path.join(".claude/CLAUDE.md").exists());
                let non_empty = path.is_dir()
                    && std::fs::read_dir(&path)
                        .map(|mut entries| entries.next().is_some())
                        .unwrap_or(false);
                json!({
                    "exists": exists,
                    "isHq": is_hq,
                    "nonEmpty": non_empty,
                })
            }
            method::RESOLVE_HQ_PATH => to_value(resolve_install_path(&self.menubar_path()?)?)?,
            method::SET_HQ_INSTALL_PATH | method::WRITE_MENUBAR_HQ_PATH => {
                let key = if method == method::WRITE_MENUBAR_HQ_PATH {
                    "hqPath"
                } else {
                    "path"
                };
                let path = required_string(params, key, method)?;
                persist_install_path(&self.menubar_path()?, path)?;
                Value::Null
            }
            method::MAKE_DIR => {
                let root = PathBuf::from(required_string(params, "installRoot", method)?);
                let path =
                    guarded_install_path(required_string(params, "path", method)?, &root, method)?;
                std::fs::create_dir_all(&path).map_err(|error| {
                    core_command_error(
                        method,
                        format!("failed to create directory {}: {error}", path.display()),
                    )
                })?;
                Value::Null
            }
            method::WRITE_FILE => {
                let root = PathBuf::from(required_string(params, "installRoot", method)?);
                let path = guarded_install_entry_path(
                    required_string(params, "path", method)?,
                    &root,
                    method,
                )?;
                let contents: Vec<u8> =
                    serde_json::from_value(params.get("contents").cloned().ok_or_else(|| {
                        EngineError::new(
                            "invalid_params",
                            "`write_file` requires byte-array param `contents`",
                            false,
                        )
                    })?)
                    .map_err(|error| {
                        EngineError::new(
                            "invalid_params",
                            format!("`write_file` param `contents` must be a byte array: {error}"),
                            false,
                        )
                    })?;
                let mode = params
                    .get("mode")
                    .filter(|value| !value.is_null())
                    .map(|value| {
                        value
                            .as_u64()
                            .and_then(|mode| u32::try_from(mode).ok())
                            .ok_or_else(|| {
                                EngineError::new(
                                    "invalid_params",
                                    "`write_file` param `mode` must be a u32",
                                    false,
                                )
                            })
                    })
                    .transpose()?;
                atomic_write_file(&path, &contents, mode, method)?;
                Value::Null
            }
            method::READ_TEXT_FILE => {
                let root = PathBuf::from(required_string(params, "installRoot", method)?);
                let path =
                    guarded_install_path(required_string(params, "path", method)?, &root, method)?;
                let text = std::fs::read_to_string(&path).map_err(|error| {
                    core_command_error(
                        method,
                        format!("failed to read file {}: {error}", path.display()),
                    )
                })?;
                to_value(text)?
            }
            method::CREATE_SYMLINK => {
                let root = PathBuf::from(required_string(params, "root", method)?);
                let link = guarded_install_entry_path(
                    required_string(params, "linkPath", method)?,
                    &root,
                    method,
                )?;
                let target = required_string(params, "target", method)?;
                guard_symlink_target(target, &link, &root, method)?;
                create_symlink(target, &link, method)?;
                Value::Null
            }
            method::DESKTOP_ALT_ENABLED => to_value(hq_desktop_core::feature_gate::email_present(
                self.identity_email()?.as_deref(),
            ))?,
            method::DESKTOP_ALT_IS_ADMIN => to_value(
                hq_desktop_core::feature_gate::is_allowed_email(self.identity_email()?.as_deref()),
            )?,
            method::GET_LIFECYCLE_STATE => to_value(self.lifecycle_state)?,
            method::IS_FIRST_RUN => {
                to_value(self.launch_kind == hq_desktop_core::first_run::LaunchKind::FirstRun)?
            }
            method::SHOULD_SHOW_AUTO_SYNC_NOTICE => {
                let show =
                    if self.launch_kind != hq_desktop_core::first_run::LaunchKind::ExistingUpdate {
                        false
                    } else {
                        let menubar =
                            hq_desktop_core::first_run::read_menubar_obj(&self.menubar_path()?);
                        !hq_desktop_core::first_run::notice_shown_in_map(&menubar)
                            && menubar
                                .get("realtimeSync")
                                .and_then(Value::as_bool)
                                .unwrap_or(true)
                    };
                to_value(show)?
            }
            method::MARK_FIRST_RUN_COMPLETE => {
                hq_desktop_core::first_run::merge_menubar_flags(
                    &self.menubar_path()?,
                    &[
                        ("firstRunCompleted", Value::Bool(true)),
                        ("autoSyncNoticeShown", Value::Bool(true)),
                        ("realtimeSync", Value::Bool(true)),
                        ("personalSyncEnabled", Value::Bool(true)),
                    ],
                )
                .map_err(|message| core_command_error(method, message))?;
                Value::Null
            }
            method::MARK_AUTO_SYNC_NOTICE_SHOWN => {
                hq_desktop_core::first_run::merge_menubar_flags(
                    &self.menubar_path()?,
                    &[
                        ("autoSyncNoticeShown", Value::Bool(true)),
                        ("firstRunCompleted", Value::Bool(true)),
                    ],
                )
                .map_err(|message| core_command_error(method, message))?;
                Value::Null
            }
            method::WRITE_MENUBAR_TELEMETRY_PREF => {
                let enabled = required_bool(params, "enabled", method)?;
                hq_desktop_core::first_run::merge_menubar_flags(
                    &self.menubar_path()?,
                    &[("telemetryEnabled", Value::Bool(enabled))],
                )
                .map_err(|message| core_command_error(method, message))?;
                Value::Null
            }
            method::GET_STAGING_SOURCE | method::GET_USE_STAGING_SOURCE => {
                let menubar = hq_desktop_core::first_run::read_menubar_obj(&self.menubar_path()?);
                to_value(
                    menubar
                        .get("stagingSource")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )?
            }
            method::SET_STAGING_SOURCE => {
                let enabled = required_bool(params, "enabled", method)?;
                hq_desktop_core::first_run::merge_menubar_flags(
                    &self.menubar_path()?,
                    &[("stagingSource", Value::Bool(enabled))],
                )
                .map_err(|message| core_command_error(method, message))?;
                to_value(enabled)?
            }
            method::DEVICE_FINGERPRINT => to_value(self.device_fingerprint()?)?,
            method::READ_INSTALL_MANIFEST => to_value(self.read_install_manifest()?)?,
            method::RECORD_STEP_START => {
                let step_id = required_string(params, "stepId", method)?.to_string();
                let manifest = self.update_install_manifest(method, |manifest| {
                    let now = now_iso();
                    let entry = manifest
                        .steps
                        .entry(step_id)
                        .or_insert_with(StepRecord::pending);
                    if !matches!(entry.status, ItemStatus::Running) || entry.started_at.is_none() {
                        entry.started_at = Some(now);
                    }
                    entry.status = ItemStatus::Running;
                    entry.completed_at = None;
                    entry.error = None;
                })?;
                to_value(manifest)?
            }
            method::RECORD_STEP_OK => {
                let step_id = required_string(params, "stepId", method)?.to_string();
                let manifest = self.update_install_manifest(method, |manifest| {
                    let now = now_iso();
                    let entry = manifest
                        .steps
                        .entry(step_id)
                        .or_insert_with(StepRecord::pending);
                    if entry.started_at.is_none() {
                        entry.started_at = Some(now.clone());
                    }
                    if !matches!(entry.status, ItemStatus::Ok) || entry.completed_at.is_none() {
                        entry.completed_at = Some(now);
                    }
                    entry.status = ItemStatus::Ok;
                    entry.error = None;
                })?;
                to_value(manifest)?
            }
            method::RECORD_STEP_FAILURE => {
                let step_id = required_string(params, "stepId", method)?.to_string();
                let error = required_string(params, "error", method)?.to_string();
                let manifest = self.update_install_manifest(method, |manifest| {
                    let now = now_iso();
                    let entry = manifest
                        .steps
                        .entry(step_id.clone())
                        .or_insert_with(StepRecord::pending);
                    if entry.started_at.is_none() {
                        entry.started_at = Some(now.clone());
                    }
                    entry.status = ItemStatus::Failed;
                    entry.completed_at = Some(now.clone());
                    entry.error = Some(error.clone());
                    append_failure_once(manifest, &step_id, &error, now);
                })?;
                to_value(manifest)?
            }
            method::RECORD_DEPENDENCIES => {
                let dependencies: BTreeMap<String, DependencyInput> =
                    deserialize_param(params, "dependencies", method)?;
                let manifest = self.update_install_manifest(method, |manifest| {
                    for (name, record) in dependencies {
                        manifest.dependencies.insert(
                            name,
                            DependencyRecord {
                                status: record.status,
                                version: record.version,
                                error: record.error,
                                updated_at: now_iso(),
                            },
                        );
                    }
                })?;
                to_value(manifest)?
            }
            method::RECORD_PACKS => {
                let packs: BTreeMap<String, PackInput> =
                    deserialize_param(params, "packs", method)?;
                let manifest = self.update_install_manifest(method, |manifest| {
                    for (name, record) in packs {
                        manifest.packs.insert(
                            name,
                            PackRecord {
                                status: record.status,
                                error: record.error,
                                updated_at: now_iso(),
                            },
                        );
                    }
                })?;
                to_value(manifest)?
            }
            method::RECORD_IMPORT => {
                let import: ImportInput = deserialize_param(params, "import", method)?;
                let manifest = self.update_install_manifest(method, |manifest| {
                    manifest.import = Some(ImportRecord {
                        codex_applied: import.codex_applied,
                        discovery_ok: import.discovery_ok,
                        claude_counts: import.claude_counts,
                        total_claude_artifacts: import.total_claude_artifacts,
                        updated_at: now_iso(),
                    });
                })?;
                to_value(manifest)?
            }
            method::RECORD_INSTALL_COMPLETE => {
                let manifest = self.update_install_manifest(method, |manifest| {
                    if manifest.completed_at.is_none() {
                        manifest.completed_at = Some(now_iso());
                    }
                })?;
                to_value(manifest)?
            }
            method::CHECK_AI_TOOLS | method::DETECT_AI_TOOLS => self
                .ai_tools_cache
                .get_or_init(|| {
                    serde_json::to_value(detect_ai_tools())
                        .expect("the fixed AI tools response always serializes")
                })
                .clone(),
            method::LIST_SESSION_HISTORY => {
                let workspace = self.hq_root()?.join("workspace");
                to_value(hq_desktop_core::sessions::history::derive_history(
                    &workspace,
                ))?
            }
            method::LIST_AGENT_SESSIONS => {
                let now = SystemTime::now();
                let hq_root = self.hq_root()?;
                let claude = hq_desktop_core::sessions::claude::scan_claude_sessions(
                    &self.claude_projects_root(),
                    Some(&hq_root),
                    now,
                );
                let codex =
                    hq_desktop_core::sessions::codex::scan_codex_sessions(&self.codex_root(), now);
                let sessions = hq_desktop_core::sessions::merge_sessions(
                    claude,
                    codex,
                    scan_running_agents(),
                    now,
                );
                let history =
                    hq_desktop_core::sessions::history::derive_history(&hq_root.join("workspace"));
                json!({
                    "sessions": sessions,
                    "history": history,
                })
            }
            method::IS_INDIGO_USER => to_value(hq_desktop_core::feature_gate::is_allowed_email(
                self.identity_email()?.as_deref(),
            ))?,
            method::PERSONALIZE_HQ => {
                personalize_hq(&self.hq_root()?, method)?;
                Value::Null
            }
            method::GIT_PROBE_USER => {
                let name = self.read_global_git_config("user.name", method)?;
                let email = self.read_global_git_config("user.email", method)?;
                if name.is_none() && email.is_none() {
                    Value::Null
                } else {
                    json!({"name": name, "email": email})
                }
            }
            method::GIT_INIT => {
                let path = optional_trimmed_string(params, "path", method)?
                    .map(PathBuf::from)
                    .map_or_else(|| self.hq_root(), Ok)?;
                let name = match optional_trimmed_string(params, "name", method)? {
                    Some(name) => Some(name.to_string()),
                    None => self.read_global_git_config("user.name", method)?,
                };
                let email = match optional_trimmed_string(params, "email", method)? {
                    Some(email) => Some(email.to_string()),
                    None => self.read_global_git_config("user.email", method)?,
                };
                self.run_git(
                    &[OsString::from("init"), path.as_os_str().to_os_string()],
                    method,
                )?;
                if let Some(name) = name {
                    self.run_git(
                        &[
                            OsString::from("-C"),
                            path.as_os_str().to_os_string(),
                            OsString::from("config"),
                            OsString::from("user.name"),
                            OsString::from(name),
                        ],
                        method,
                    )?;
                }
                if let Some(email) = email {
                    self.run_git(
                        &[
                            OsString::from("-C"),
                            path.as_os_str().to_os_string(),
                            OsString::from("config"),
                            OsString::from("user.email"),
                            OsString::from(email),
                        ],
                        method,
                    )?;
                }
                to_value(format!("initialised {}", path.to_string_lossy()))?
            }
            method::IS_PRIMARY_INSTANCE | method::RECHECK_PRIMARY_INSTANCE => to_value(true)?,
            method::SET_HQ_CLI_UPDATE_DISMISSED => {
                let version = required_string(params, "version", method)?;
                hq_desktop_core::first_run::merge_menubar_flags(
                    &self.menubar_path()?,
                    &[(
                        hq_desktop_core::hq_cli_update::DISMISSED_VERSION_KEY,
                        Value::String(version.to_string()),
                    )],
                )
                .map_err(|message| core_command_error(method, message))?;
                Value::Null
            }
            method::LIST_AGENCY_TEAMS => to_value(list_agency_teams(&self.hq_root()?))?,
            method::LIST_AGENCY_QUESTIONS => to_value(list_agency_questions(&self.hq_root()?))?,
            method::LIST_AGENCY_CHAT => {
                let company = required_string(params, "company", method)?;
                let team = required_string(params, "team", method)?;
                to_value(list_agency_chat(&self.hq_root()?, company, team, method)?)?
            }
            method::ANSWER_AGENCY_QUESTION => {
                let company = required_string(params, "company", method)?;
                let team = required_string(params, "team", method)?;
                let id = required_string(params, "id", method)?;
                let answer = required_string(params, "answer", method)?;
                let _guard = self.manifest_lock.lock().map_err(|_| {
                    core_command_error(method, "Local state lock was poisoned".to_string())
                })?;
                to_value(answer_agency_question(
                    &self.hq_root()?,
                    company,
                    team,
                    id,
                    answer,
                    method,
                )?)?
            }
            method::SEND_AGENCY_MESSAGE => {
                let company = required_string(params, "company", method)?;
                let team = required_string(params, "team", method)?;
                let text = required_string(params, "text", method)?;
                let _guard = self.manifest_lock.lock().map_err(|_| {
                    core_command_error(method, "Local state lock was poisoned".to_string())
                })?;
                to_value(send_agency_message(
                    &self.hq_root()?,
                    company,
                    team,
                    text,
                    method,
                )?)?
            }
            _ => {
                return Err(EngineError::new(
                    "method_not_found",
                    format!("Method `{method}` is not implemented"),
                    false,
                ));
            }
        };
        cancellation.check()?;
        Ok(value)
    }
}

const INSTALL_MANIFEST_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ItemStatus {
    Pending,
    Running,
    Ok,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StepRecord {
    status: ItemStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl StepRecord {
    fn pending() -> Self {
        Self {
            status: ItemStatus::Pending,
            started_at: None,
            completed_at: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DependencyRecord {
    status: ItemStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PackRecord {
    status: ItemStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ImportRecord {
    codex_applied: bool,
    discovery_ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    claude_counts: Option<BTreeMap<String, u64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    total_claude_artifacts: Option<u64>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct FailureRecord {
    stage: String,
    message: String,
    ts: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detail: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct InstallManifest {
    schema_version: u8,
    installer_version: String,
    install_path: String,
    started_at: String,
    completed_at: Option<String>,
    steps: BTreeMap<String, StepRecord>,
    dependencies: BTreeMap<String, DependencyRecord>,
    packs: BTreeMap<String, PackRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    import: Option<ImportRecord>,
    failures: Vec<FailureRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DependencyInput {
    status: ItemStatus,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackInput {
    status: ItemStatus,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportInput {
    codex_applied: bool,
    discovery_ok: bool,
    #[serde(default)]
    claude_counts: Option<BTreeMap<String, u64>>,
    #[serde(default)]
    total_claude_artifacts: Option<u64>,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn installer_version() -> String {
    option_env!("APP_VERSION")
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .to_string()
}

fn empty_install_manifest(install_path: String, installer_version: String) -> InstallManifest {
    InstallManifest {
        schema_version: INSTALL_MANIFEST_SCHEMA_VERSION,
        installer_version,
        install_path,
        started_at: now_iso(),
        completed_at: None,
        steps: BTreeMap::new(),
        dependencies: BTreeMap::new(),
        packs: BTreeMap::new(),
        import: None,
        failures: Vec::new(),
    }
}

fn read_manifest_from_path(
    path: &Path,
    install_path: String,
    installer_version: String,
) -> InstallManifest {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return empty_install_manifest(install_path, installer_version);
    };
    let Ok(parsed) = serde_json::from_str::<InstallManifest>(&raw) else {
        return empty_install_manifest(install_path, installer_version);
    };
    if parsed.schema_version != INSTALL_MANIFEST_SCHEMA_VERSION {
        return empty_install_manifest(install_path, installer_version);
    }
    parsed
}

fn write_manifest_to_path(
    path: &Path,
    manifest: &InstallManifest,
    method: &str,
) -> Result<(), EngineError> {
    let body = serde_json::to_string_pretty(manifest).map_err(|error| {
        core_command_error(method, format!("serialize install manifest: {error}"))
    })? + "\n";
    atomic_write_file(path, body.as_bytes(), None, method)
}

fn append_failure_once(
    manifest: &mut InstallManifest,
    stage: &str,
    message: &str,
    timestamp: String,
) {
    let duplicate = manifest
        .failures
        .last()
        .is_some_and(|last| last.stage == stage && last.message == message);
    if !duplicate {
        manifest.failures.push(FailureRecord {
            stage: stage.to_string(),
            message: message.to_string(),
            ts: timestamp,
            detail: None,
        });
    }
}

fn format_git_failure(args: &[OsString], output: &Output) -> String {
    let argv = args
        .iter()
        .map(|argument| argument.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ");
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let mut detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "no output".to_string()
    };
    if detail.chars().count() > 2_000 {
        detail = detail.chars().take(2_000).collect();
        detail.push_str("...");
    }
    format!(
        "git {argv} failed with status {}: {detail}",
        output.status.code().unwrap_or(-1)
    )
}

#[derive(Debug, Clone, Serialize)]
struct AiTools {
    claude_cli: bool,
    claude_desktop: bool,
    codex_cli: bool,
    codex_desktop: bool,
    grok_cli: bool,
    any: bool,
}

fn detect_ai_tools() -> AiTools {
    let probes =
        ["claude", "codex", "grok"].map(|binary| std::thread::spawn(move || cli_runnable(binary)));
    let [claude_cli, codex_cli, grok_cli] = probes.map(|probe| probe.join().unwrap_or(false));
    let home_app = |name: &str| {
        hq_desktop_core::paths::home_dir()
            .is_some_and(|home| home.join("Applications").join(name).exists())
    };
    let claude_desktop = Path::new("/Applications/Claude.app").exists() || home_app("Claude.app");
    let codex_desktop = Path::new("/Applications/Codex.app").exists() || home_app("Codex.app");
    let any = claude_cli || claude_desktop || codex_cli || codex_desktop || grok_cli;
    AiTools {
        claude_cli,
        claude_desktop,
        codex_cli,
        codex_desktop,
        grok_cli,
        any,
    }
}

fn cli_runnable(binary: &str) -> bool {
    let resolved = hq_desktop_core::paths::resolve_bin(binary);
    let mut command = Command::new(resolved);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command_success_with_timeout(command, Duration::from_secs(4))
}

fn command_success_with_timeout(mut command: Command, timeout: Duration) -> bool {
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return false,
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return false;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn scan_running_agents() -> hq_desktop_core::sessions::liveness::RunningAgents {
    let output = Command::new("pgrep")
        .args(["-fl", "claude|codex"])
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default();
    hq_desktop_core::sessions::liveness::classify_processes(&output)
}

fn personalize_hq(hq_root: &Path, method: &str) -> Result<(), EngineError> {
    let settings = hq_root.join("personal").join("settings");
    let workers = hq_root.join("personal").join("workers");
    for directory in [&settings, &workers] {
        std::fs::create_dir_all(directory).map_err(|error| {
            core_command_error(
                method,
                format!("failed to create {}: {error}", directory.display()),
            )
        })?;
    }
    let cognito = settings.join("cognito.json");
    if !cognito.exists() {
        atomic_write_file(&cognito, b"{}\n", None, method)?;
    }
    for path in [settings.join(".gitkeep"), workers.join(".gitkeep")] {
        if !path.exists() {
            atomic_write_file(&path, b"", None, method)?;
        }
    }
    Ok(())
}

fn list_agency_teams(hq_root: &Path) -> Vec<hq_desktop_core::agency::AgencyTeam> {
    use hq_desktop_core::agency::{
        agency_root, child_dirs, inbox_ready, read_status_map, AgencyTeam, AgencyWorker,
    };

    let root = agency_root(hq_root);
    let mut teams = Vec::new();
    for company in child_dirs(&root) {
        let company_dir = root.join(&company);
        for team in child_dirs(&company_dir) {
            let team_dir = company_dir.join(&team);
            let status = read_status_map(&team_dir.join("status.json"));
            let mut workers = Vec::new();
            for worker in child_dirs(&team_dir) {
                let worker_dir = team_dir.join(&worker);
                for instance in child_dirs(&worker_dir) {
                    let inbox = worker_dir.join(&instance).join("chat.jsonl");
                    let worker_status = status.get(&worker).and_then(|row| row.get(&instance));
                    let field = |key: &str, default: &str| {
                        worker_status
                            .and_then(|row| row.get(key))
                            .and_then(Value::as_str)
                            .unwrap_or(default)
                            .to_string()
                    };
                    workers.push(AgencyWorker {
                        worker: worker.clone(),
                        instance,
                        status: field("status", "unknown"),
                        ready: inbox_ready(&inbox),
                        started_at: field("started_at", ""),
                        updated_at: field("updated_at", ""),
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
    teams
}

fn list_agency_questions(hq_root: &Path) -> Vec<hq_desktop_core::agency::AgencyQuestion> {
    use hq_desktop_core::agency::{
        agency_root, child_dirs, cksum, parse_options, read_jsonl, AgencyQuestion,
    };

    let root = agency_root(hq_root);
    let mut questions = Vec::new();
    for company in child_dirs(&root) {
        let company_dir = root.join(&company);
        for team in child_dirs(&company_dir) {
            let team_dir = company_dir.join(&team);
            let liaison = team_dir
                .join("team-liaison")
                .join("main")
                .join("chat.jsonl");
            let manager_text = std::fs::read_to_string(
                team_dir
                    .join("team-manager")
                    .join("main")
                    .join("chat.jsonl"),
            )
            .unwrap_or_default();
            for line in read_jsonl(&liaison) {
                let role = line.get("role").and_then(Value::as_str).unwrap_or("");
                let from = line.get("from").and_then(Value::as_str).unwrap_or("");
                let text = line.get("text").and_then(Value::as_str).unwrap_or("");
                if role == "user" && from == "manager" {
                    if let Some(question) = text.strip_prefix("ASK: ") {
                        let id = cksum(question.as_bytes()).to_string();
                        if !manager_text.contains(&format!("[ans:{id}]")) {
                            questions.push(AgencyQuestion {
                                company: company.clone(),
                                team: team.clone(),
                                id,
                                question: question.to_string(),
                                ts: line
                                    .get("ts")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                                options: parse_options(&line),
                            });
                        }
                    }
                }
            }
        }
    }
    questions
}

fn list_agency_chat(
    hq_root: &Path,
    company: &str,
    team: &str,
    method: &str,
) -> Result<Vec<hq_desktop_core::agency::AgencyMessage>, EngineError> {
    use hq_desktop_core::agency::{agency_root, classify_message, is_within, read_jsonl};

    let root = agency_root(hq_root);
    let team_dir = root.join(company).join(team);
    if !is_within(&root, &team_dir) {
        return Err(core_command_error(method, "invalid team path".to_string()));
    }
    let mut messages = Vec::new();
    for owner in ["team-manager", "team-liaison"] {
        let inbox = team_dir.join(owner).join("main").join("chat.jsonl");
        for line in read_jsonl(&inbox) {
            let message = classify_message(owner, &line);
            if !message.text.trim().is_empty() {
                messages.push(message);
            }
        }
    }
    messages.sort_by(|left, right| left.ts.cmp(&right.ts));
    Ok(messages)
}

fn answer_agency_question(
    hq_root: &Path,
    company: &str,
    team: &str,
    id: &str,
    answer: &str,
    method: &str,
) -> Result<&'static str, EngineError> {
    use hq_desktop_core::agency::{agency_root, is_within, now_iso};

    let root = agency_root(hq_root);
    let manager = root
        .join(company)
        .join(team)
        .join("team-manager")
        .join("main")
        .join("chat.jsonl");
    if !is_within(&root, &manager) {
        return Err(core_command_error(method, "invalid team path".to_string()));
    }
    let existing = std::fs::read_to_string(&manager).unwrap_or_default();
    if existing.contains(&format!("[ans:{id}]")) {
        return Ok("already-answered");
    }
    append_agency_line(
        &manager,
        json!({
            "role": "user",
            "from": "liaison",
            "text": format!("ANSWER: {answer} [ans:{id}]"),
            "ts": now_iso(),
        }),
        method,
    )?;
    Ok("delivered")
}

fn send_agency_message(
    hq_root: &Path,
    company: &str,
    team: &str,
    text: &str,
    method: &str,
) -> Result<&'static str, EngineError> {
    use hq_desktop_core::agency::{agency_root, is_within, now_iso};

    let body = text.trim();
    if body.is_empty() {
        return Err(core_command_error(method, "empty message".to_string()));
    }
    let root = agency_root(hq_root);
    let manager = root
        .join(company)
        .join(team)
        .join("team-manager")
        .join("main")
        .join("chat.jsonl");
    if !is_within(&root, &manager) {
        return Err(core_command_error(method, "invalid team path".to_string()));
    }
    append_agency_line(
        &manager,
        json!({
            "role": "user",
            "from": "operator",
            "text": body,
            "ts": now_iso(),
        }),
        method,
    )?;
    Ok("sent")
}

fn append_agency_line(path: &Path, value: Value, method: &str) -> Result<(), EngineError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            core_command_error(
                method,
                format!("failed to create {}: {error}", parent.display()),
            )
        })?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| {
            core_command_error(
                method,
                format!("failed to open {}: {error}", path.display()),
            )
        })?;
    writeln!(
        file,
        "{}",
        serde_json::to_string(&value)
            .map_err(|error| core_command_error(method, error.to_string()))?
    )
    .map_err(|error| {
        core_command_error(
            method,
            format!("failed to append {}: {error}", path.display()),
        )
    })
}

fn required_string<'a>(
    params: &'a serde_json::Map<String, Value>,
    key: &str,
    method: &str,
) -> Result<&'a str, EngineError> {
    string_param(params, key, method, false)
}

fn string_param<'a>(
    params: &'a serde_json::Map<String, Value>,
    key: &str,
    method: &str,
    allow_empty: bool,
) -> Result<&'a str, EngineError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| allow_empty || !value.trim().is_empty())
        .ok_or_else(|| {
            EngineError::new(
                "invalid_params",
                format!("`{method}` requires string param `{key}`"),
                false,
            )
        })
}

fn required_bool(
    params: &serde_json::Map<String, Value>,
    key: &str,
    method: &str,
) -> Result<bool, EngineError> {
    params.get(key).and_then(Value::as_bool).ok_or_else(|| {
        EngineError::new(
            "invalid_params",
            format!("`{method}` requires boolean param `{key}`"),
            false,
        )
    })
}

fn deserialize_param<T: DeserializeOwned>(
    params: &serde_json::Map<String, Value>,
    key: &str,
    method: &str,
) -> Result<T, EngineError> {
    let value = params.get(key).cloned().ok_or_else(|| {
        EngineError::new(
            "invalid_params",
            format!("`{method}` requires param `{key}`"),
            false,
        )
    })?;
    serde_json::from_value(value).map_err(|error| {
        EngineError::new(
            "invalid_params",
            format!("`{method}` param `{key}` has an invalid shape: {error}"),
            false,
        )
    })
}

fn optional_trimmed_string<'a>(
    params: &'a serde_json::Map<String, Value>,
    key: &str,
    method: &str,
) -> Result<Option<&'a str>, EngineError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok((!value.trim().is_empty()).then_some(value.trim())),
        Some(_) => Err(EngineError::new(
            "invalid_params",
            format!("`{method}` param `{key}` must be a string or null"),
            false,
        )),
    }
}

fn read_hq_version_at(hq_root: &std::path::Path) -> Option<String> {
    let canonical = hq_root.join("core").join("core.yaml");
    let legacy = hq_root.join("core.yaml");
    let path = if canonical.is_file() {
        canonical
    } else {
        legacy
    };
    let bytes = std::fs::read(path).ok()?;
    let yaml: serde_yaml::Value = serde_yaml::from_slice(&bytes).ok()?;
    yaml.get("hqVersion")
        .and_then(serde_yaml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn empty_menubar_prefs() -> hq_desktop_core::config::MenubarPrefs {
    hq_desktop_core::config::MenubarPrefs {
        hq_path: None,
        sync_on_launch: None,
        notifications: None,
        start_at_login: None,
        autostart_daemon: None,
        realtime_sync: None,
        personal_sync_enabled: None,
        instant_sync: None,
        drift_staging_repo: None,
        share_notifications: None,
        dm_notifications: None,
        cli_auto_update: None,
        auto_update: None,
        staging_channel: None,
        release_channel: None,
        meeting_detect_notify: None,
        default_recording_company_uid: None,
        telemetry_enabled: None,
        widget_enabled: None,
        widget_display: None,
    }
}

fn apply_settings_defaults(
    prefs: hq_desktop_core::config::MenubarPrefs,
) -> hq_desktop_core::config::MenubarPrefs {
    let meeting = prefs
        .meeting_detect_notify
        .unwrap_or_else(hq_desktop_core::settings::default_meeting_detect_notify);
    let default_platforms = || {
        ["zoom", "meet", "teams", "slack", "webex"]
            .into_iter()
            .map(str::to_string)
            .collect()
    };
    hq_desktop_core::config::MenubarPrefs {
        hq_path: prefs.hq_path,
        sync_on_launch: Some(prefs.sync_on_launch.unwrap_or(true)),
        notifications: Some(prefs.notifications.unwrap_or(true)),
        start_at_login: Some(prefs.start_at_login.unwrap_or(true)),
        autostart_daemon: Some(prefs.autostart_daemon.unwrap_or(false)),
        realtime_sync: Some(prefs.realtime_sync.unwrap_or(true)),
        personal_sync_enabled: Some(prefs.personal_sync_enabled.unwrap_or(true)),
        instant_sync: Some(prefs.instant_sync.unwrap_or(true)),
        drift_staging_repo: prefs.drift_staging_repo,
        share_notifications: Some(prefs.share_notifications.unwrap_or(true)),
        dm_notifications: Some(prefs.dm_notifications.unwrap_or(true)),
        cli_auto_update: Some(prefs.cli_auto_update.unwrap_or(true)),
        auto_update: Some(prefs.auto_update.unwrap_or(true)),
        staging_channel: Some(prefs.staging_channel.unwrap_or(true)),
        release_channel: prefs.release_channel,
        meeting_detect_notify: Some(hq_desktop_core::config::MeetingDetectNotifyPrefs {
            enabled: Some(meeting.enabled.unwrap_or(true)),
            platforms: Some(meeting.platforms.unwrap_or_else(default_platforms)),
        }),
        default_recording_company_uid: prefs.default_recording_company_uid,
        telemetry_enabled: Some(prefs.telemetry_enabled.unwrap_or(true)),
        widget_enabled: Some(
            prefs
                .widget_enabled
                .unwrap_or(cfg!(not(target_os = "windows"))),
        ),
        widget_display: prefs.widget_display,
    }
}

fn read_settings(path: &Path) -> Result<hq_desktop_core::config::MenubarPrefs, EngineError> {
    let prefs = if path.exists() {
        let contents = std::fs::read_to_string(path).map_err(|error| {
            EngineError::new(
                "get_settings_failed",
                format!("Failed to read menubar.json: {error}"),
                false,
            )
        })?;
        serde_json::from_str(&contents).map_err(|error| {
            EngineError::new(
                "get_settings_failed",
                format!("Failed to parse menubar.json: {error}"),
                false,
            )
        })?
    } else {
        empty_menubar_prefs()
    };
    Ok(apply_settings_defaults(prefs))
}

fn save_settings(
    path: &Path,
    prefs: &hq_desktop_core::config::MenubarPrefs,
) -> Result<(), EngineError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            core_command_error(
                method::SAVE_SETTINGS,
                format!("Failed to create config directory: {error}"),
            )
        })?;
    }
    let existing = path
        .exists()
        .then(|| std::fs::read_to_string(path).ok())
        .flatten();
    let body = hq_desktop_core::settings::merge_prefs_over_existing(prefs, existing.as_deref())
        .map_err(|message| core_command_error(method::SAVE_SETTINGS, message))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("menubar.json");
    let tmp = path.with_file_name(format!(
        ".{file_name}.tmp.{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let commit = (|| {
        let mut staged = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        staged.write_all(body.as_bytes())?;
        staged.sync_all()?;
        drop(staged);
        std::fs::rename(&tmp, path)
    })();
    commit.map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        core_command_error(
            method::SAVE_SETTINGS,
            format!("Failed to write menubar.json: {error}"),
        )
    })
}

fn expand_tilde(value: &str) -> PathBuf {
    let home = hq_desktop_core::paths::home_dir();
    if value == "~" {
        return home.unwrap_or_else(|| PathBuf::from(value));
    }
    value.strip_prefix("~/").map_or_else(
        || PathBuf::from(value),
        |rest| {
            home.map(|home| home.join(rest))
                .unwrap_or_else(|| PathBuf::from(value))
        },
    )
}

fn persist_install_path(menubar_path: &Path, value: &str) -> Result<(), EngineError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(EngineError::new(
            "invalid_params",
            "Install path cannot be empty",
            false,
        ));
    }
    let path = expand_tilde(value);
    hq_desktop_core::first_run::merge_menubar_flags(
        menubar_path,
        &[("hqPath", Value::String(path.to_string_lossy().into_owned()))],
    )
    .map_err(|message| core_command_error(method::SET_HQ_INSTALL_PATH, message))
}

fn resolve_install_path(menubar_path: &Path) -> Result<String, EngineError> {
    let stored = hq_desktop_core::first_run::read_menubar_obj(menubar_path)
        .get("hqPath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(expand_tilde);
    let path = match stored {
        Some(path) => path,
        None => hq_desktop_core::paths::home_dir()
            .map(|home| home.join("hq"))
            .ok_or_else(|| {
                EngineError::new(
                    "resolve_hq_path_failed",
                    "Could not determine home directory",
                    false,
                )
            })?,
    };
    if path.exists() && !path.is_dir() {
        return Err(core_command_error(
            method::RESOLVE_HQ_PATH,
            format!("{} exists but is a file, not a folder", path.display()),
        ));
    }
    if !path.exists() {
        std::fs::create_dir_all(&path).map_err(|error| {
            core_command_error(
                method::RESOLVE_HQ_PATH,
                format!("Failed to create {}: {error}", path.display()),
            )
        })?;
    }
    let canonical = path.canonicalize().unwrap_or(path);
    Ok(canonical.to_string_lossy().into_owned())
}

fn check_writable(path: &Path) -> bool {
    if path.exists() && !path.is_dir() {
        return false;
    }
    if std::fs::create_dir_all(path).is_err() {
        return false;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let probe = path.join(format!(
        ".hq-desktop-write-probe-{}-{nonce}",
        std::process::id()
    ));
    let writable = std::fs::File::create(&probe)
        .and_then(|mut file| file.write_all(b"ok"))
        .is_ok();
    let _ = std::fs::remove_file(probe);
    writable
}

fn guarded_install_path(value: &str, root: &Path, command: &str) -> Result<PathBuf, EngineError> {
    let path = Path::new(value);
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    if !hq_desktop_core::desktop_alt::is_within(root, &candidate) {
        return Err(core_command_error(
            command,
            format!(
                "refusing path outside install root: {}",
                candidate.display()
            ),
        ));
    }

    let resolved_root = resolve_path_allow_missing(root, command)?;
    let resolved_candidate = resolve_path_allow_missing(&candidate, command)?;
    if resolved_candidate.starts_with(&resolved_root) {
        Ok(resolved_candidate)
    } else {
        Err(core_command_error(
            command,
            format!(
                "refusing filesystem-resolved path outside install root: {}",
                resolved_candidate.display()
            ),
        ))
    }
}

fn guarded_install_entry_path(
    value: &str,
    root: &Path,
    command: &str,
) -> Result<PathBuf, EngineError> {
    let path = Path::new(value);
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    if !hq_desktop_core::desktop_alt::is_within(root, &candidate) {
        return Err(core_command_error(
            command,
            format!(
                "refusing path outside install root: {}",
                candidate.display()
            ),
        ));
    }

    let normalized = hq_desktop_core::desktop_alt::lexically_normalize(&candidate);
    let name = normalized.file_name().ok_or_else(|| {
        core_command_error(
            command,
            format!("path must name an entry inside the install root: {value}"),
        )
    })?;
    let parent = normalized.parent().ok_or_else(|| {
        core_command_error(
            command,
            format!("path has no parent inside the install root: {value}"),
        )
    })?;
    let resolved_root = resolve_path_allow_missing(root, command)?;
    let resolved_parent = resolve_path_allow_missing(parent, command)?;
    if !resolved_parent.starts_with(&resolved_root) {
        return Err(core_command_error(
            command,
            format!(
                "refusing filesystem-resolved parent outside install root: {}",
                resolved_parent.display()
            ),
        ));
    }
    Ok(resolved_parent.join(name))
}

fn resolve_path_allow_missing(path: &Path, command: &str) -> Result<PathBuf, EngineError> {
    const MAX_SYMLINKS: usize = 40;

    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| {
                core_command_error(
                    command,
                    format!("failed to resolve current directory: {error}"),
                )
            })?
            .join(path)
    };
    let mut current = hq_desktop_core::desktop_alt::lexically_normalize(&absolute);
    let mut missing = Vec::<OsString>::new();
    let mut followed_symlinks = 0;

    loop {
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                followed_symlinks += 1;
                if followed_symlinks > MAX_SYMLINKS {
                    return Err(core_command_error(
                        command,
                        format!("too many symlinks while resolving {}", path.display()),
                    ));
                }
                let target = std::fs::read_link(&current).map_err(|error| {
                    core_command_error(
                        command,
                        format!("failed to resolve symlink {}: {error}", current.display()),
                    )
                })?;
                current = if target.is_absolute() {
                    target
                } else {
                    current.parent().unwrap_or(Path::new("/")).join(target)
                };
                for component in missing.iter().rev() {
                    current.push(component);
                }
                missing.clear();
                current = hq_desktop_core::desktop_alt::lexically_normalize(&current);
            }
            Ok(_) => {
                let mut resolved = std::fs::canonicalize(&current).map_err(|error| {
                    core_command_error(
                        command,
                        format!("failed to resolve {}: {error}", current.display()),
                    )
                })?;
                for component in missing.iter().rev() {
                    resolved.push(component);
                }
                return Ok(hq_desktop_core::desktop_alt::lexically_normalize(&resolved));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = current.file_name().ok_or_else(|| {
                    core_command_error(
                        command,
                        format!("failed to resolve missing path {}", path.display()),
                    )
                })?;
                missing.push(name.to_os_string());
                current = current
                    .parent()
                    .ok_or_else(|| {
                        core_command_error(
                            command,
                            format!("failed to resolve parent of {}", path.display()),
                        )
                    })?
                    .to_path_buf();
            }
            Err(error) => {
                return Err(core_command_error(
                    command,
                    format!("failed to inspect {}: {error}", current.display()),
                ));
            }
        }
    }
}

fn atomic_write_file(
    path: &Path,
    contents: &[u8],
    mode: Option<u32>,
    command: &str,
) -> Result<(), EngineError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            core_command_error(
                command,
                format!("failed to create parent directory: {error}"),
            )
        })?;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("tmp.{}.{nonce}", std::process::id()));
    std::fs::write(&tmp, contents).map_err(|error| {
        core_command_error(command, format!("failed to write temp file: {error}"))
    })?;
    std::fs::rename(&tmp, path).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        core_command_error(
            command,
            format!("failed to commit file {}: {error}", path.display()),
        )
    })?;
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode & 0o7777)).map_err(
            |error| core_command_error(command, format!("failed to set file permissions: {error}")),
        )?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    Ok(())
}

fn guard_symlink_target(
    target: &str,
    link: &Path,
    root: &Path,
    command: &str,
) -> Result<(), EngineError> {
    let resolved = if Path::new(target).is_absolute() {
        PathBuf::from(target)
    } else {
        link.parent().unwrap_or(root).join(target)
    };
    let resolved_root = resolve_path_allow_missing(root, command)?;
    let resolved_target = resolve_path_allow_missing(&resolved, command)?;
    if resolved_target.starts_with(&resolved_root) {
        Ok(())
    } else {
        Err(core_command_error(
            command,
            format!(
                "refusing filesystem-resolved symlink target outside install root: {}",
                resolved_target.display()
            ),
        ))
    }
}

#[cfg(unix)]
fn create_symlink(target: &str, link: &Path, command: &str) -> Result<(), EngineError> {
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            core_command_error(command, format!("failed to create parent dir: {error}"))
        })?;
    }
    if std::fs::symlink_metadata(link).is_ok() {
        std::fs::remove_file(link).map_err(|error| {
            core_command_error(
                command,
                format!("failed to replace existing entry at {link:?}: {error}"),
            )
        })?;
    }
    std::os::unix::fs::symlink(target, link).map_err(|error| {
        core_command_error(
            command,
            format!("failed to create symlink {link:?} -> {target:?}: {error}"),
        )
    })
}

#[cfg(not(unix))]
fn create_symlink(_target: &str, _link: &Path, command: &str) -> Result<(), EngineError> {
    Err(core_command_error(
        command,
        "symlink creation is not implemented on this platform".to_string(),
    ))
}

fn core_command_error(method: &str, message: String) -> EngineError {
    EngineError::new(format!("{method}_failed"), message, false)
}

fn requires_desktop_feature_gate(method: &str) -> bool {
    matches!(
        method,
        method::LEGACY_GET_LOCAL_PROJECTS
            | method::GET_LOCAL_PROJECT_PRD
            | method::GET_LOCAL_PROJECT_README
            | method::GET_LOCAL_COMPANY_GOALS
            | method::GET_COMPANY_CRM_PROJECTION
            | method::SET_LOCAL_PROJECT_STATUS
            | method::SET_LOCAL_STORY_PASSES
            | method::GET_LIBRARY_ROOT
            | method::GET_LIBRARY_COMPANY
            | method::GET_LIBRARY_WORKER_DETAIL
            | method::GET_LIBRARY_SKILL_DETAIL
            | method::GET_COMPANY_FILE_TREE
            | method::GET_COMPANY_FILE_CONTENT
            | method::LIST_HQ_DIR
    )
}

fn read_identity_email() -> Result<Option<String>, EngineError> {
    let tokens = hq_desktop_core::cognito::read_tokens_from_file()
        .map_err(|message| EngineError::new("auth_state_read_failed", message, false))?;
    Ok(tokens
        .and_then(|tokens| tokens.id_token)
        .filter(|token| !token.trim().is_empty())
        .and_then(|token| {
            hq_desktop_core::cognito::decode_id_token_claims(&token)
                .ok()
                .and_then(|claims| claims.email)
        }))
}

fn require_desktop_feature_access(email: Option<&str>) -> Result<(), EngineError> {
    if hq_desktop_core::feature_gate::email_present(email) {
        Ok(())
    } else {
        Err(EngineError::new(
            "auth_required",
            "This local desktop command requires a signed-in user",
            false,
        ))
    }
}

fn classify_lifecycle_snapshot(
    hq_root: Option<&Path>,
    menubar_path: Option<&Path>,
    menubar: &serde_json::Map<String, Value>,
    config_valid: bool,
    has_auth: bool,
) -> &'static str {
    let (install_completed, first_run_completed, had_machine_id) =
        hq_desktop_core::lifecycle::menubar_flags(menubar);
    let hq_root_valid = hq_root
        .map(hq_desktop_core::lifecycle::hq_root_valid)
        .unwrap_or(false);
    let install_in_progress = menubar_path
        .and_then(Path::parent)
        .map(|parent| parent.join("install-manifest.json"))
        .map(|path| install_manifest_in_progress(&path))
        .unwrap_or(false);
    let verdict = hq_desktop_core::lifecycle::classify_lifecycle(
        hq_desktop_core::lifecycle::LifecycleInputs {
            install_completed,
            first_run_completed,
            had_machine_id,
            config_valid,
            hq_root_valid,
            has_auth,
            install_in_progress,
        },
    );
    match verdict.state {
        hq_desktop_core::lifecycle::LifecycleState::NeedsInstall => "NeedsInstall",
        hq_desktop_core::lifecycle::LifecycleState::InstallResume => "InstallResume",
        hq_desktop_core::lifecycle::LifecycleState::NeedsAuthForInstall => "NeedsAuthForInstall",
        hq_desktop_core::lifecycle::LifecycleState::InstalledFirstRun => "InstalledFirstRun",
        hq_desktop_core::lifecycle::LifecycleState::InstalledLegacyUpdate => {
            "InstalledLegacyUpdate"
        }
        hq_desktop_core::lifecycle::LifecycleState::SteadyState => "SteadyState",
    }
}

fn install_manifest_in_progress(path: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(manifest) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    if manifest
        .get("completedAt")
        .is_some_and(|value| !value.is_null())
    {
        return false;
    }
    manifest
        .get("steps")
        .and_then(Value::as_object)
        .is_some_and(|steps| {
            steps.values().any(|step| {
                matches!(
                    step.get("status").and_then(Value::as_str),
                    Some("running" | "failed")
                )
            })
        })
}

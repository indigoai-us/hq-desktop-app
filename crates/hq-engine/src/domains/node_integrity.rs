use std::fs::{self, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::EngineError;

pub(super) fn parse_locked_paths(yaml: &str) -> Result<Vec<String>, EngineError> {
    let mut in_rules = false;
    let mut in_locked = false;
    let mut paths = Vec::new();

    for raw_line in yaml.lines() {
        let line = raw_line.trim_end_matches('\r');
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - trimmed.len();
        if indent == 0 {
            in_rules = trimmed.starts_with("rules:");
            in_locked = false;
            continue;
        }
        if !in_rules {
            continue;
        }
        if indent == 2 {
            in_locked = trimmed.starts_with("locked:");
            continue;
        }
        if !in_locked {
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("- ") {
            paths.push(
                value
                    .trim()
                    .trim_matches(|character| character == '"' || character == '\'')
                    .to_string(),
            );
        } else {
            in_locked = false;
        }
    }

    if paths.is_empty() {
        Err(EngineError::new(
            "invalid_core_manifest",
            "rules.locked is empty or unparseable",
            false,
        ))
    } else {
        Ok(paths)
    }
}

fn sha256_file(path: &Path) -> Result<String, EngineError> {
    let file = fs::File::open(path).map_err(|error| {
        EngineError::new(
            "checksum_failed",
            format!("Could not open {}: {error}", path.display()),
            false,
        )
    })?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut hasher = Sha256::new();
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        let count = reader.read(&mut chunk).map_err(|error| {
            EngineError::new(
                "checksum_failed",
                format!("Could not read {}: {error}", path.display()),
                false,
            )
        })?;
        if count == 0 {
            break;
        }
        hasher.update(&chunk[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn collect_regular_files(
    root: &Path,
    current: &Path,
    files: &mut Vec<(String, PathBuf)>,
) -> Result<(), EngineError> {
    let entries = fs::read_dir(current).map_err(|error| {
        EngineError::new(
            "checksum_failed",
            format!("Could not read directory {}: {error}", current.display()),
            false,
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            EngineError::new(
                "checksum_failed",
                format!("Could not read a directory entry: {error}"),
                false,
            )
        })?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            EngineError::new(
                "checksum_failed",
                format!("Could not inspect {}: {error}", path.display()),
                false,
            )
        })?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_regular_files(root, &path, files)?;
        } else if metadata.is_file() {
            let relative = path.strip_prefix(root).map_err(|error| {
                EngineError::new(
                    "checksum_failed",
                    format!("Could not relativize {}: {error}", path.display()),
                    false,
                )
            })?;
            files.push((
                relative.to_string_lossy().replace('\\', "/"),
                path.to_path_buf(),
            ));
        }
    }
    Ok(())
}

fn sha256_directory(path: &Path) -> Result<String, EngineError> {
    let mut files = Vec::new();
    collect_regular_files(path, path, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut manifest = Sha256::new();
    for (relative, absolute) in files {
        manifest.update(sha256_file(&absolute)?.as_bytes());
        manifest.update(b"  ");
        manifest.update(relative.as_bytes());
        manifest.update(b"\n");
    }
    Ok(format!("{:x}", manifest.finalize()))
}

fn splice_checksums(source: &str, entries: &[(String, String)], updated_at: &str) -> String {
    let mut output = String::with_capacity(source.len() + entries.len() * 96);
    let mut skipping_checksums = false;
    let mut replaced_updated_at = false;
    for raw_line in source.lines() {
        let trimmed = raw_line.trim_start();
        let indent = raw_line.len() - trimmed.len();
        if !replaced_updated_at && indent == 0 && trimmed.starts_with("updatedAt:") {
            output.push_str("updatedAt: \"");
            output.push_str(updated_at);
            output.push_str("\"\n");
            replaced_updated_at = true;
            continue;
        }
        if skipping_checksums {
            if indent > 0 || trimmed.is_empty() {
                continue;
            }
            skipping_checksums = false;
        }
        if indent == 0 && trimmed.starts_with("checksums:") {
            skipping_checksums = true;
            continue;
        }
        output.push_str(raw_line);
        output.push('\n');
    }
    if !replaced_updated_at {
        output.push_str("updatedAt: \"");
        output.push_str(updated_at);
        output.push_str("\"\n");
    }
    output.push_str("checksums:\n");
    for (path, hash) in entries {
        output.push_str("  ");
        output.push_str(path);
        output.push_str(": ");
        output.push_str(hash);
        output.push('\n');
    }
    output
}

pub(super) fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), EngineError> {
    let parent = path.parent().ok_or_else(|| {
        EngineError::new(
            "atomic_write_failed",
            format!("Target has no parent: {}", path.display()),
            false,
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        EngineError::new(
            "atomic_write_failed",
            format!("Could not create {}: {error}", parent.display()),
            false,
        )
    })?;
    let filename = path.file_name().ok_or_else(|| {
        EngineError::new(
            "atomic_write_failed",
            format!("Target has no filename: {}", path.display()),
            false,
        )
    })?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        filename.to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| {
                EngineError::new(
                    "atomic_write_failed",
                    format!("Could not create {}: {error}", temporary.display()),
                    false,
                )
            })?;
        file.write_all(bytes).map_err(|error| {
            EngineError::new(
                "atomic_write_failed",
                format!("Could not write {}: {error}", temporary.display()),
                false,
            )
        })?;
        file.sync_all().map_err(|error| {
            EngineError::new(
                "atomic_write_failed",
                format!("Could not flush {}: {error}", temporary.display()),
                false,
            )
        })?;
        fs::rename(&temporary, path).map_err(|error| {
            EngineError::new(
                "atomic_write_failed",
                format!(
                    "Could not replace {} with {}: {error}",
                    path.display(),
                    temporary.display()
                ),
                false,
            )
        })
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

pub(super) fn compute_checksums_at(install_root: &Path) -> Result<Value, EngineError> {
    let yaml_path = install_root.join("core/core.yaml");
    let source = fs::read_to_string(&yaml_path).map_err(|error| {
        EngineError::new(
            "compute_checksums_failed",
            format!("Could not read {}: {error}", yaml_path.display()),
            false,
        )
    })?;
    let locked = parse_locked_paths(&source)?;
    let mut entries = Vec::new();
    let mut missing = Vec::new();
    for raw in locked {
        if raw == "core/core.yaml" {
            continue;
        }
        let key = raw.trim_end_matches('/').to_string();
        let absolute = install_root.join(&key);
        let metadata = match fs::symlink_metadata(&absolute) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(key);
                continue;
            }
            Err(error) => {
                return Err(EngineError::new(
                    "compute_checksums_failed",
                    format!("Could not inspect {}: {error}", absolute.display()),
                    false,
                ));
            }
        };
        let hash = if metadata.is_file() {
            sha256_file(&absolute)?
        } else if metadata.is_dir() {
            sha256_directory(&absolute)?
        } else {
            missing.push(key);
            continue;
        };
        entries.push((key, hash));
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    missing.sort();
    let updated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let rendered = splice_checksums(&source, &entries, &updated_at);
    atomic_write_bytes(&yaml_path, rendered.as_bytes()).map_err(|error| {
        EngineError::new("compute_checksums_failed", error.message, error.retryable)
    })?;

    Ok(json!({
        "entries": entries
            .iter()
            .map(|(path, hash)| json!({"path":path,"hash":hash}))
            .collect::<Vec<_>>(),
        "missing": missing,
        "updatedAt": updated_at
    }))
}

pub(super) fn settings_json_with_env_path(
    settings_json: &str,
    new_path: &str,
) -> Result<String, EngineError> {
    let mut document = serde_json::from_str::<Value>(settings_json).map_err(|error| {
        EngineError::new(
            "configure_claude_settings_path_failed",
            format!("settings.json is not valid JSON: {error}"),
            false,
        )
    })?;
    let object = document.as_object_mut().ok_or_else(|| {
        EngineError::new(
            "configure_claude_settings_path_failed",
            "settings.json root is not an object",
            false,
        )
    })?;
    let env = object
        .entry("env")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let env = env.as_object_mut().ok_or_else(|| {
        EngineError::new(
            "configure_claude_settings_path_failed",
            "settings.json 'env' is not an object",
            false,
        )
    })?;
    env.insert("PATH".to_string(), Value::String(new_path.to_string()));
    let mut rendered = serde_json::to_string_pretty(&document).map_err(|error| {
        EngineError::new(
            "configure_claude_settings_path_failed",
            format!("Could not serialize settings.json: {error}"),
            false,
        )
    })?;
    rendered.push('\n');
    Ok(rendered)
}

pub(super) fn validate_locked_restore_path(
    path: &str,
    locked: &[String],
) -> Result<PathBuf, EngineError> {
    let candidate = Path::new(path);
    if candidate.as_os_str().is_empty()
        || candidate.is_absolute()
        || candidate.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(EngineError::new(
            "restore_from_upstream_failed",
            format!("Path {path:?} is not a safe relative path"),
            false,
        ));
    }
    let normalized = candidate.to_string_lossy().replace('\\', "/");
    let in_scope = locked.iter().any(|raw| {
        let locked_path = raw.trim_end_matches('/');
        if raw.ends_with('/') {
            normalized == locked_path || normalized.starts_with(&format!("{locked_path}/"))
        } else {
            normalized == locked_path
        }
    });
    if !in_scope {
        return Err(EngineError::new(
            "restore_from_upstream_failed",
            format!("Path {path:?} is not in rules.locked scope"),
            false,
        ));
    }
    Ok(PathBuf::from(normalized))
}

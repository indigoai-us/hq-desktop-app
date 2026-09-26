use serde::Deserialize;
use std::io;
use std::path::Path;

const STAMP_MARKER: &str = "[baseline_persistence_stamp ";
const MAX_YAML_KEYS: usize = 12;
const MAX_YAML_KEY_LENGTH: usize = 64;

#[derive(Debug, Deserialize)]
struct LocalCoreYaml {
    #[serde(default)]
    replaced_from_source: Option<LocalSourceStamp>,
    #[serde(default)]
    replaced_from_staging: Option<LocalSourceStamp>,
}

#[derive(Debug, Deserialize)]
struct LocalSourceStamp {
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    last_sync_sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReadableLocalSourceStamp {
    pub(crate) source: String,
    pub(crate) commit: String,
    pub(crate) key: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalSourceStampError {
    pub(crate) state: String,
    pub(crate) key: &'static str,
    pub(crate) yaml_top_level_keys: String,
}

impl LocalSourceStampError {
    pub(crate) fn marker(&self) -> String {
        format!(
            "{STAMP_MARKER}state={} key={} yaml_keys={}]",
            self.state, self.key, self.yaml_top_level_keys
        )
    }
}

impl ReadableLocalSourceStamp {
    pub(crate) fn marker(&self) -> String {
        format!(
            "{STAMP_MARKER}state=stamp_available key={} yaml_keys=none]",
            self.key
        )
    }
}

/// Read the stamp while preserving the reason it could not be used. The
/// injected reader keeps filesystem failures testable without changing the
/// production path, which still uses `std::fs::read`.
pub(crate) fn read_local_source_stamp_with<F>(
    hq_folder: &Path,
    mut read: F,
) -> Result<ReadableLocalSourceStamp, LocalSourceStampError>
where
    F: FnMut(&Path) -> io::Result<Vec<u8>>,
{
    let canonical = hq_folder.join("core").join("core.yaml");
    let legacy = hq_folder.join("core.yaml");
    let bytes = match read(&canonical) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => match read(&legacy) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(stamp_error("core_yaml_missing", "none", "none"));
            }
            Err(error) => {
                return Err(stamp_error(
                    &format!("core_yaml_read_error({})", io_error_kind_name(error.kind())),
                    "none",
                    "none",
                ));
            }
        },
        Err(error) => {
            return Err(stamp_error(
                &format!("core_yaml_read_error({})", io_error_kind_name(error.kind())),
                "none",
                "none",
            ));
        }
    };

    let yaml: serde_yaml::Value = serde_yaml::from_slice(&bytes)
        .map_err(|_| stamp_error("core_yaml_parse_error", "none", "none"))?;
    let yaml_top_level_keys = bounded_yaml_top_level_keys(&yaml);
    let yaml_stamp_key = yaml.as_mapping().map_or("none", |mapping| {
        if mapping.contains_key(&serde_yaml::Value::String(
            "replaced_from_source".to_string(),
        )) {
            "replaced_from_source"
        } else if mapping.contains_key(&serde_yaml::Value::String(
            "replaced_from_staging".to_string(),
        )) {
            "replaced_from_staging"
        } else {
            "none"
        }
    });
    let parsed: LocalCoreYaml = serde_yaml::from_value(yaml).map_err(|_| {
        stamp_error(
            "core_yaml_parse_error",
            yaml_stamp_key,
            &yaml_top_level_keys,
        )
    })?;

    let (key, stamp) = if let Some(stamp) = parsed.replaced_from_source {
        ("replaced_from_source", stamp)
    } else if let Some(stamp) = parsed.replaced_from_staging {
        ("replaced_from_staging", stamp)
    } else {
        return Err(stamp_error(
            "stamp_block_missing",
            "none",
            &yaml_top_level_keys,
        ));
    };

    let source = stamp
        .source
        .map(|source| source.trim().to_string())
        .filter(|source| !source.is_empty())
        .ok_or_else(|| stamp_error("stamp_source_missing", key, &yaml_top_level_keys))?;
    let commit = stamp
        .last_sync_sha
        .map(|commit| commit.trim().to_string())
        .filter(|commit| !commit.is_empty())
        .ok_or_else(|| stamp_error("stamp_commit_missing", key, &yaml_top_level_keys))?;

    Ok(ReadableLocalSourceStamp {
        source,
        commit,
        key,
    })
}

pub(crate) fn read_local_source_stamp(
    hq_folder: &Path,
) -> Result<ReadableLocalSourceStamp, LocalSourceStampError> {
    read_local_source_stamp_with(hq_folder, |path| std::fs::read(path))
}

pub(crate) fn local_source_stamp(hq_folder: &Path) -> Option<(String, String)> {
    // Keep the legacy Option reader's path-selection semantics for callers
    // that do not need a typed failure. The rescue-reporting call sites use
    // `read_local_source_stamp` directly for detailed diagnosis.
    let canonical = hq_folder.join("core").join("core.yaml");
    let legacy = hq_folder.join("core.yaml");
    let bytes = std::fs::read(if canonical.is_file() {
        canonical
    } else {
        legacy
    })
    .ok()?;
    let parsed: LocalCoreYaml = serde_yaml::from_slice(&bytes).ok()?;
    let stamp = parsed
        .replaced_from_source
        .or(parsed.replaced_from_staging)?;
    let source = stamp.source?.trim().to_string();
    let commit = stamp.last_sync_sha?.trim().to_string();
    (!source.is_empty() && !commit.is_empty()).then_some((source, commit))
}

pub(crate) fn available_stamp_marker(key: &'static str) -> String {
    format!("{STAMP_MARKER}state=stamp_available key={key} yaml_keys=none]")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PersistenceStampTags {
    pub(crate) state: String,
    pub(crate) outcome: &'static str,
    pub(crate) key: &'static str,
    pub(crate) yaml_top_level_keys: String,
}

pub(crate) fn persistence_stamp_tags_from_detail(detail: &str) -> PersistenceStampTags {
    let marker = detail
        .rfind(STAMP_MARKER)
        .and_then(|start| detail[start..].split(']').next());
    let field = |name: &str| {
        marker
            .and_then(|marker| {
                marker
                    .split_ascii_whitespace()
                    .find_map(|field| field.strip_prefix(&format!("{name}=")))
            })
            .unwrap_or("unknown")
    };

    let state = bounded_stamp_state(field("state"));
    let key = match field("key") {
        "replaced_from_source" => "replaced_from_source",
        "replaced_from_staging" => "replaced_from_staging",
        _ => "none",
    };
    let yaml_top_level_keys = bounded_marker_yaml_keys(field("yaml_keys"));
    let outcome = if detail.contains("[baseline_persistence_diagnostics ") {
        "io_failure"
    } else if state != "unknown" && state != "stamp_available" {
        "stamp_unreadable"
    } else if detail.contains("baseline refresh pending")
        || detail.contains("baseline refresh failed")
    {
        "refresh_pending"
    } else {
        "stamp_unreadable"
    };

    PersistenceStampTags {
        state,
        outcome,
        key,
        yaml_top_level_keys,
    }
}

fn stamp_error(state: &str, key: &'static str, yaml_top_level_keys: &str) -> LocalSourceStampError {
    LocalSourceStampError {
        state: state.to_string(),
        key,
        yaml_top_level_keys: bounded_marker_yaml_keys(yaml_top_level_keys),
    }
}

fn io_error_kind_name(kind: io::ErrorKind) -> &'static str {
    match kind {
        io::ErrorKind::NotFound => "not_found",
        io::ErrorKind::PermissionDenied => "permission_denied",
        io::ErrorKind::AlreadyExists => "already_exists",
        io::ErrorKind::InvalidInput => "invalid_input",
        io::ErrorKind::InvalidData => "invalid_data",
        io::ErrorKind::TimedOut => "timed_out",
        io::ErrorKind::Interrupted => "interrupted",
        io::ErrorKind::UnexpectedEof => "unexpected_eof",
        io::ErrorKind::WouldBlock => "would_block",
        io::ErrorKind::WriteZero => "write_zero",
        _ => "other",
    }
}

fn bounded_stamp_state(value: &str) -> String {
    match value {
        "stamp_available"
        | "core_yaml_missing"
        | "core_yaml_parse_error"
        | "stamp_block_missing"
        | "stamp_source_missing"
        | "stamp_commit_missing" => value.to_string(),
        _ => value
            .strip_prefix("core_yaml_read_error(")
            .and_then(|kind| kind.strip_suffix(')'))
            .filter(|kind| {
                matches!(
                    *kind,
                    "not_found"
                        | "permission_denied"
                        | "already_exists"
                        | "invalid_input"
                        | "invalid_data"
                        | "timed_out"
                        | "interrupted"
                        | "unexpected_eof"
                        | "would_block"
                        | "write_zero"
                        | "other"
                )
            })
            .map(|kind| format!("core_yaml_read_error({kind})"))
            .unwrap_or_else(|| "unknown".to_string()),
    }
}

fn bounded_yaml_top_level_keys(value: &serde_yaml::Value) -> String {
    let Some(mapping) = value.as_mapping() else {
        return "none".to_string();
    };
    let mut keys = mapping
        .keys()
        .filter_map(serde_yaml::Value::as_str)
        .filter(|key| {
            !key.is_empty()
                && key
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || "_.-".contains(character))
        })
        .map(|key| key.chars().take(MAX_YAML_KEY_LENGTH).collect::<String>())
        .take(MAX_YAML_KEYS)
        .collect::<Vec<_>>();
    keys.sort();
    keys.dedup();
    if keys.is_empty() {
        "none".to_string()
    } else {
        keys.join(",")
    }
}

fn bounded_marker_yaml_keys(value: &str) -> String {
    if value == "none" || value == "unknown" {
        return "none".to_string();
    }
    let mut keys = value
        .split(',')
        .filter(|key| {
            !key.is_empty()
                && key.chars().count() <= MAX_YAML_KEY_LENGTH
                && key
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || "_.-".contains(character))
        })
        .take(MAX_YAML_KEYS)
        .map(str::to_string)
        .collect::<Vec<_>>();
    keys.sort();
    keys.dedup();
    if keys.is_empty() {
        "none".to_string()
    } else {
        keys.join(",")
    }
}

#[cfg(test)]
mod tests {
    use super::{
        local_source_stamp, persistence_stamp_tags_from_detail, read_local_source_stamp_with,
    };
    use std::io;

    fn write_canonical_stamp(root: &std::path::Path, yaml: &str) {
        let path = root.join("core/core.yaml");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, yaml).unwrap();
    }

    fn tags_for_failure(root: &std::path::Path) -> super::PersistenceStampTags {
        let failure = super::read_local_source_stamp(root).unwrap_err();
        persistence_stamp_tags_from_detail(&format!(
            "core update applied but baseline persistence failed: {}",
            failure.marker()
        ))
    }

    #[test]
    fn missing_core_yaml_reports_stamp_unreadable_and_missing_key() {
        let temp = tempfile::tempdir().unwrap();
        let tags = tags_for_failure(temp.path());
        assert_eq!(tags.state, "core_yaml_missing");
        assert_eq!(tags.outcome, "stamp_unreadable");
        assert_eq!(tags.key, "none");
    }

    #[test]
    fn core_yaml_read_error_reports_bounded_io_kind() {
        let temp = tempfile::tempdir().unwrap();
        write_canonical_stamp(temp.path(), "replaced_from_source: {}\n");
        let failure = read_local_source_stamp_with(temp.path(), |_| {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        })
        .unwrap_err();
        let tags = persistence_stamp_tags_from_detail(&failure.marker());
        assert_eq!(tags.state, "core_yaml_read_error(permission_denied)");
        assert_eq!(tags.outcome, "stamp_unreadable");
        assert_eq!(tags.key, "none");
    }

    #[test]
    fn malformed_core_yaml_reports_parse_error() {
        let temp = tempfile::tempdir().unwrap();
        write_canonical_stamp(temp.path(), "replaced_from_source: [\n");
        let tags = tags_for_failure(temp.path());
        assert_eq!(tags.state, "core_yaml_parse_error");
        assert_eq!(tags.outcome, "stamp_unreadable");
        assert_eq!(tags.key, "none");
    }

    #[test]
    fn typed_yaml_parse_error_reports_only_bounded_top_level_key_names() {
        let temp = tempfile::tempdir().unwrap();
        write_canonical_stamp(
            temp.path(),
            "version: secret-value\nreplaced_from_source: []\n",
        );
        let tags = tags_for_failure(temp.path());
        assert_eq!(tags.state, "core_yaml_parse_error");
        assert_eq!(tags.outcome, "stamp_unreadable");
        assert_eq!(tags.key, "replaced_from_source");
        assert_eq!(tags.yaml_top_level_keys, "replaced_from_source,version");
        assert!(!tags.yaml_top_level_keys.contains("secret-value"));
    }

    #[test]
    fn missing_stamp_blocks_report_the_keys_that_are_present() {
        let temp = tempfile::tempdir().unwrap();
        write_canonical_stamp(temp.path(), "version: 1\nsource: example\n");
        let tags = tags_for_failure(temp.path());
        assert_eq!(tags.state, "stamp_block_missing");
        assert_eq!(tags.outcome, "stamp_unreadable");
        assert_eq!(tags.key, "none");
        assert_eq!(tags.yaml_top_level_keys, "source,version");
    }

    #[test]
    fn missing_stamp_source_is_distinguished() {
        let temp = tempfile::tempdir().unwrap();
        write_canonical_stamp(temp.path(), "replaced_from_source:\n  last_sync_sha: abc\n");
        let tags = tags_for_failure(temp.path());
        assert_eq!(tags.state, "stamp_source_missing");
        assert_eq!(tags.outcome, "stamp_unreadable");
        assert_eq!(tags.key, "replaced_from_source");
    }

    #[test]
    fn missing_stamp_commit_is_distinguished() {
        let temp = tempfile::tempdir().unwrap();
        write_canonical_stamp(
            temp.path(),
            "replaced_from_staging:\n  source: example/repo\n",
        );
        let tags = tags_for_failure(temp.path());
        assert_eq!(tags.state, "stamp_commit_missing");
        assert_eq!(tags.outcome, "stamp_unreadable");
        assert_eq!(tags.key, "replaced_from_staging");
    }

    #[test]
    fn pending_baseline_detail_reports_refresh_pending_and_selected_stamp_key() {
        let temp = tempfile::tempdir().unwrap();
        write_canonical_stamp(
            temp.path(),
            "replaced_from_staging:\n  source: example/repo\n  last_sync_sha: abc\n",
        );
        let stamp = local_source_stamp(temp.path()).unwrap();
        assert_eq!(stamp.0, "example/repo");
        let marker = super::read_local_source_stamp(temp.path())
            .unwrap()
            .marker();
        let tags = persistence_stamp_tags_from_detail(&format!(
            "core update applied; baseline refresh pending at abc {marker}"
        ));
        assert_eq!(tags.state, "stamp_available");
        assert_eq!(tags.outcome, "refresh_pending");
        assert_eq!(tags.key, "replaced_from_staging");
    }

    #[test]
    fn io_diagnostic_suffix_keeps_io_outcome_and_stamp_tags_are_bounded() {
        let detail = "baseline persistence failed [baseline_persistence_diagnostics write_path=write_temp error_kind=other directory_state=directory target_state=missing temp_state=missing permission_state=not_denied disk_state=not_storage_full concurrent_writer=no_evidence] [baseline_persistence_stamp state=stamp_available key=replaced_from_source yaml_keys=none]";
        let tags = persistence_stamp_tags_from_detail(detail);
        assert_eq!(tags.outcome, "io_failure");
        assert_eq!(tags.state, "stamp_available");
        assert_eq!(tags.key, "replaced_from_source");
        let noisy = (0..20)
            .map(|index| format!("key{index}"))
            .collect::<Vec<_>>()
            .join(",");
        let noisy = format!(
            "[baseline_persistence_stamp state=stamp_block_missing key=none yaml_keys={noisy},bad%key]"
        );
        let tags = persistence_stamp_tags_from_detail(&noisy);
        assert_eq!(tags.yaml_top_level_keys.split(',').count(), 12);
        assert!(!tags.yaml_top_level_keys.contains("bad%key"));
        assert!(tags.yaml_top_level_keys.len() <= 12 * 64 + 11);
    }
}
